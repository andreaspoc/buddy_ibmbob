"""Authenticated opaque audio forwarding over the same WSS origin as Buddy.

Only encrypted audio packets and public ECDH keys cross this relay. Audio packets
are PostgreSQL notifications, never stored rows or AI/model input.
"""
from __future__ import annotations
import asyncio
import base64
from contextlib import suppress
import json
import os
import time
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4
import psycopg
from psycopg.types.json import Jsonb
from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from app import job_queue

CHANNEL = 'bob_community_audio'
FRAME_BYTES = 4124  # 2048 PCM16 samples + 12-byte nonce + 16-byte authentication tag.


class PublicAudioKey(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kty: Literal['EC']
    crv: Literal['P-256']
    x: str = Field(pattern=r'^[A-Za-z0-9_-]{43}$')
    y: str = Field(pattern=r'^[A-Za-z0-9_-]{43}$')


class AudioHello(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_id: UUID
    public_key: PublicAudioKey


def schema(db):
    db.execute("ALTER TABLE people_chat.bob_voice_calls ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'webrtc' CHECK(transport IN ('webrtc','websocket'))")
    for role in ('caller','callee'):
        db.execute(f'ALTER TABLE people_chat.bob_voice_calls ADD COLUMN IF NOT EXISTS {role}_audio_id UUID')
        db.execute(f'ALTER TABLE people_chat.bob_voice_calls ADD COLUMN IF NOT EXISTS {role}_audio_key JSONB')


def transport():
    value=os.getenv('PEOPLE_AUDIO_TRANSPORT','websocket')
    if value not in ('webrtc','websocket'):raise ValueError('Unsupported calling transport')
    return value


def authorize(db, username, client_id, call_id, *, lock=False):
    from .community_calls import read_call
    row=read_call(db,call_id,username,lock)
    role='caller' if row['caller']==username else 'callee'
    if row['status'] not in ('accepted','active') or row['transport']!='websocket':raise HTTPException(409,'The voice call is not ready for audio')
    if str(row[role+'_client'])!=str(client_id):raise HTTPException(403,'This call belongs to another browser tab')
    return row,role


def attach(username, client_id, call_id, audio_id, public_key):
    with job_queue._connect() as db:
        row,role=authorize(db,username,client_id,call_id,lock=True)
        if row[role+'_audio_id'] is not None:raise HTTPException(409,'Audio is already connected in this tab')
        db.execute(f'UPDATE people_chat.bob_voice_calls SET {role}_audio_id=%s,{role}_audio_key=%s WHERE id=%s',(audio_id,Jsonb(public_key),call_id))
        db.execute('SELECT pg_notify(%s,%s)',(CHANNEL,json.dumps({'kind':'ready','call_id':str(call_id)})))
        return role


def peer_key(username, client_id, call_id, audio_id):
    with job_queue._connect() as db:
        row,role=authorize(db,username,client_id,call_id)
        if str(row[role+'_audio_id'])!=str(audio_id):raise HTTPException(403,'Audio session changed')
        other='callee' if role=='caller' else 'caller'
        return row[other+'_audio_key']


def detach(username, client_id, call_id, audio_id):
    from .community_calls import end
    with job_queue._connect() as db:
        row=db.execute('SELECT * FROM people_chat.bob_voice_calls WHERE id=%s AND (caller=%s OR callee=%s) FOR UPDATE',(call_id,username,username)).fetchone()
        if not row:return
        role='caller' if row['caller']==username else 'callee'
        if str(row[role+'_client'])==str(client_id) and str(row[role+'_audio_id'])==str(audio_id) and row['status']!='ended':end(db,row,'disconnected')
        db.execute(f'UPDATE people_chat.bob_voice_calls SET {role}_audio_id=NULL,{role}_audio_key=NULL WHERE id=%s',(call_id,))


def register(router, current_user):
    @router.websocket('/calls/{call_id}/audio')
    async def audio_socket(socket: WebSocket, call_id: UUID):
        origin=socket.headers.get('origin')
        if not origin or urlsplit(origin).netloc!=socket.headers.get('host'):
            await socket.close(code=1008);return
        tasks=[];username=None;client_id=None;audio_id=uuid4();attached=False
        send_lock=asyncio.Lock()
        async def send(value):
            async with send_lock:
                if isinstance(value,bytes):await socket.send_bytes(value)
                else:await socket.send_json(value)
        try:
            user=await current_user(socket);username=user['username']
            await socket.accept()
            raw=await asyncio.wait_for(socket.receive_text(),timeout=8)
            if len(raw)>2048:raise WebSocketDisconnect(1009)
            hello=AudioHello.model_validate_json(raw);client_id=hello.client_id
            # Subscribe before attaching so neither participant can miss the key-exchange notification.
            async with await psycopg.AsyncConnection.connect(os.environ['DATABASE_URL'],autocommit=True) as listener, await psycopg.AsyncConnection.connect(os.environ['DATABASE_URL'],autocommit=True) as writer:
                await listener.execute('LISTEN '+CHANNEL)
                from .community_calls import CHANNEL as state_channel
                await listener.execute('LISTEN '+state_channel)
                role=await asyncio.to_thread(attach,username,client_id,call_id,audio_id,hello.public_key.model_dump());attached=True
                await send({'type':'audio_ready','role':role})
                known=None
                async def send_peer_key():
                    nonlocal known
                    key=await asyncio.to_thread(peer_key,username,client_id,call_id,audio_id)
                    if key and key!=known:
                        known=key;await send({'type':'audio_peer','public_key':key})
                await send_peer_key()
                async def receive():
                    window=time.monotonic();count=0;last_check=window
                    while True:
                        frame=await asyncio.wait_for(socket.receive(),timeout=20)
                        if frame['type']=='websocket.disconnect':raise WebSocketDisconnect()
                        packet=frame.get('bytes')
                        if packet is None or len(packet)!=FRAME_BYTES:raise WebSocketDisconnect(1009)
                        now=time.monotonic()
                        if now-window>=5:window=now;count=0
                        count+=1
                        if count>100:raise WebSocketDisconnect(1008)
                        if now-last_check>5:
                            await current_user(socket)
                            await asyncio.to_thread(peer_key,username,client_id,call_id,audio_id)
                            last_check=now
                        payload=json.dumps({'kind':'audio','call_id':str(call_id),'sender':role,'data':base64.b64encode(packet).decode()},separators=(',',':'))
                        await writer.execute('SELECT pg_notify(%s,%s)',(CHANNEL,payload))
                async def receive_notifications():
                    last_check=time.monotonic()
                    while True:
                        pending=[]
                        async for event in listener.notifies(timeout=5,stop_after=1):pending.append(event)
                        for event in pending:
                            value=json.loads(event.payload)
                            if value.get('call_id')!=str(call_id):continue
                            if event.channel==state_channel:
                                await asyncio.to_thread(peer_key,username,client_id,call_id,audio_id)
                            elif value.get('kind')=='ready':await send_peer_key()
                            elif value.get('kind')=='audio' and value.get('sender')!=role:
                                packet=base64.b64decode(value['data'],validate=True)
                                if len(packet)==FRAME_BYTES:await send(packet)
                        # Recheck login/membership while waiting for the other person's microphone.
                        if time.monotonic()-last_check>=5:
                            await current_user(socket)
                            await asyncio.to_thread(peer_key,username,client_id,call_id,audio_id)
                            last_check=time.monotonic()
                tasks=[asyncio.create_task(receive()),asyncio.create_task(receive_notifications())]
                try:
                    done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                    for task in done:task.result()
                finally:
                    for task in tasks:task.cancel()
                    await asyncio.gather(*tasks,return_exceptions=True)
                    tasks=[]
        except (HTTPException,ValueError,ValidationError,WebSocketDisconnect,RuntimeError,TimeoutError):pass
        finally:
            for task in tasks:task.cancel()
            if tasks:await asyncio.gather(*tasks,return_exceptions=True)
            if attached:await asyncio.to_thread(detach,username,client_id,call_id,audio_id)
            with suppress(RuntimeError,WebSocketDisconnect):await socket.close()
