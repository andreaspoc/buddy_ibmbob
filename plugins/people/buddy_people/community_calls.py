"""Owner-authenticated WebRTC signaling. Audio, SDP and ICE are never stored."""
from __future__ import annotations
from app.branding import brand_text
import asyncio
import base64
import hashlib
import hmac
from contextlib import suppress
import json
import os
import time
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4
import psycopg
from psycopg.types.json import Jsonb
from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from app import job_queue

CHANNEL = 'bob_community_calls'


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_voice_calls (
        id UUID PRIMARY KEY, room_id BIGINT NOT NULL REFERENCES people_chat.bob_chat_rooms(id) ON DELETE CASCADE,
        caller TEXT NOT NULL, callee TEXT NOT NULL, caller_client UUID NOT NULL, callee_client UUID,
        status TEXT NOT NULL CHECK(status IN ('ringing','accepted','active','ended')),
        caller_connected BOOLEAN NOT NULL DEFAULT false, callee_connected BOOLEAN NOT NULL DEFAULT false,
        caller_seen TIMESTAMPTZ NOT NULL DEFAULT now(), callee_seen TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
        reason TEXT, CHECK(caller<>callee))''')
    db.execute('ALTER TABLE people_chat.bob_chat_messages ADD COLUMN IF NOT EXISTS voice_call_id UUID')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS bob_chat_message_voice_call ON people_chat.bob_chat_messages(voice_call_id)')
    # Restore recent missed calls to the conversation history once, including calls
    # that ended while the recipient was signed out.
    for row in db.execute("""SELECT * FROM people_chat.bob_voice_calls c
            WHERE status='ended' AND accepted_at IS NULL
            AND reason IN ('timeout','cancelled','disconnected','hangup')
            AND ended_at>=now()-interval '30 days'
            AND NOT EXISTS (SELECT 1 FROM people_chat.bob_chat_messages m WHERE m.voice_call_id=c.id)
            ORDER BY ended_at""").fetchall():
        record_missed_call(db, row)
    db.execute("ALTER TABLE people_chat.bob_voice_calls ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb")
    from .community_call_audio import schema as audio_schema
    audio_schema(db)
    db.execute("CREATE INDEX IF NOT EXISTS bob_voice_active_users ON people_chat.bob_voice_calls(caller,callee) WHERE status<>'ended'")


class Connectivity(BaseModel):
    model_config = ConfigDict(extra='forbid')
    connection_state: Literal['new','connecting','connected','disconnected','failed','closed']
    ice_state: Literal['new','checking','connected','completed','disconnected','failed','closed']
    gathering_state: Literal['new','gathering','complete']
    local_candidate_types: list[Literal['host','srflx','prflx','relay']] = Field(max_length=4)
    ice_error_codes: list[Annotated[int, Field(ge=100,le=999)]] = Field(max_length=8)


class Signal(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['start','accept','decline','end','offer','answer','ice','connected','ping']
    room_id: int | None = Field(default=None, ge=1, le=9223372036854775807)
    call_id: UUID | None = None
    sdp: str | None = Field(default=None, max_length=6000)
    candidate: dict | None = None
    diagnostics: Connectivity | None = None
    reason: Literal['hangup','declined','cancelled','connection_failed','media_error','timeout'] | None = None

    @model_validator(mode='after')
    def bounded(self):
        fields = self.model_fields_set - {'action'}
        allowed = {'start': {'room_id'}, 'ping': set(), 'accept': {'call_id'}, 'decline': {'call_id'},
                   'end': {'call_id','reason','diagnostics'}, 'offer': {'call_id','sdp'}, 'answer': {'call_id','sdp'},
                   'ice': {'call_id','candidate'}, 'connected': {'call_id'}}[self.action]
        if fields - allowed or self.action == 'start' and self.room_id is None or self.action not in ('start','ping') and self.call_id is None:
            raise ValueError('Invalid call signal')
        if self.action in ('offer','answer'):
            if not self.sdp or not self.sdp.startswith('v=0') or '\nm=audio ' not in self.sdp or '\nm=video ' in self.sdp or '\nm=application ' in self.sdp:
                raise ValueError('Only voice SDP is supported')
        if self.action == 'ice':
            candidate = self.candidate
            if not isinstance(candidate, dict) or not set(candidate) <= {'candidate','sdpMid','sdpMLineIndex','usernameFragment'}:
                raise ValueError('Invalid ICE candidate')
            if not isinstance(candidate.get('candidate'), str) or len(candidate['candidate']) > 1800:
                raise ValueError('Invalid ICE candidate')
            if candidate.get('sdpMid') is not None and (not isinstance(candidate['sdpMid'], str) or len(candidate['sdpMid']) > 32):
                raise ValueError('Invalid ICE media ID')
            if candidate.get('sdpMLineIndex') is not None and (type(candidate['sdpMLineIndex']) is not int or not 0 <= candidate['sdpMLineIndex'] <= 8):
                raise ValueError('Invalid ICE media index')
            if candidate.get('usernameFragment') is not None and (not isinstance(candidate['usernameFragment'], str) or len(candidate['usernameFragment']) > 256):
                raise ValueError('Invalid ICE username')
        return self


def ice_servers(username=None):
    """Administrator-provided STUN/TURN only; no undisclosed public relay dependency."""
    values = json.loads(os.getenv('PEOPLE_ICE_SERVERS', '[]'))
    if not isinstance(values, list) or len(values) > 8:
        raise ValueError('Invalid voice ICE configuration')
    turn_urls = json.loads(os.getenv('PEOPLE_TURN_URLS', '[]'))
    if turn_urls:
        key = os.getenv('PEOPLE_TURN_SECRET', '')
        if not username or not isinstance(turn_urls, list) or len(key) < 32 or any(not isinstance(url,str) or not url.startswith(('turn:','turns:')) for url in turn_urls):
            raise ValueError('Authenticated voice relay is not configured correctly')
        # Fresh credentials per invitation, valid beyond the maximum call duration.
        temporary_user = str(int(time.time()) + 13*3600) + ':' + hashlib.sha256(username.encode()).hexdigest()[:24]  # noqa: S4790
        password = base64.b64encode(hmac.new(key.encode(),temporary_user.encode(),hashlib.sha1).digest()).decode()  # noqa: S4790
        values = [*values, {'urls':turn_urls,'username':temporary_user,'credential':password}]
    result = []
    for item in values:
        if not isinstance(item, dict) or not set(item) <= {'urls','username','credential'}:
            raise ValueError('Invalid voice ICE server')
        urls = [item.get('urls')] if isinstance(item.get('urls'), str) else item.get('urls')
        if not isinstance(urls, list) or not urls or len(urls) > 8 or any(not isinstance(url, str) or len(url)>1000 or not url.startswith(('stun:','stuns:','turn:','turns:')) or any(c.isspace() for c in url) for url in urls):
            raise ValueError('Invalid voice ICE URL')
        if any(key in item and (not isinstance(item[key], str) or len(item[key])>2000) for key in ('username','credential')):
            raise ValueError('Invalid voice ICE credentials')
        result.append(item)
    return result


def notify(db, call_id):
    db.execute('SELECT pg_notify(%s,%s)', (CHANNEL, json.dumps({'kind':'state','call_id':str(call_id)})))


def record_missed_call(db, row):
    if row['accepted_at'] is not None or row['reason'] not in {'timeout','cancelled','disconnected','hangup'}:
        return
    message = db.execute("""INSERT INTO people_chat.bob_chat_messages
        (room_id,sender,body,created_at,voice_call_id)
        VALUES (%s,%s,'Missed voice call',%s,%s)
        ON CONFLICT (voice_call_id) DO NOTHING RETURNING id""",
        (row['room_id'], row['caller'], row['ended_at'], row['id'])).fetchone()
    if message:
        from .community import changed
        changed(db, row['room_id'], message['id'])


def end(db, row, reason):
    ended = db.execute("UPDATE people_chat.bob_voice_calls SET status='ended',reason=%s,ended_at=now() WHERE id=%s AND status<>'ended' RETURNING *", (reason,row['id'])).fetchone()
    if ended: record_missed_call(db, ended)
    notify(db,row['id'])


def expire(db, username):
    rows = db.execute('''UPDATE people_chat.bob_voice_calls SET status='ended',reason='timeout',ended_at=now()
        WHERE (caller=%s OR callee=%s) AND status<>'ended' AND (
        (status='ringing' AND created_at<now()-interval '45 seconds') OR
        (status='accepted' AND accepted_at<now()-interval '45 seconds') OR
        caller_seen<now()-interval '60 seconds' OR
        (callee_client IS NOT NULL AND callee_seen<now()-interval '60 seconds') OR
        created_at<now()-interval '12 hours') RETURNING *''',(username,username)).fetchall()
    for row in rows:
        record_missed_call(db, row)
        notify(db,row['id'])


def read_call(db, call_id, username, lock=False):
    row = db.execute('SELECT * FROM people_chat.bob_voice_calls WHERE id=%s AND (caller=%s OR callee=%s)'+(' FOR UPDATE' if lock else ''),(call_id,username,username)).fetchone()
    if not row:
        raise HTTPException(404,'Voice call not found')
    memberships = db.execute('SELECT username FROM people_chat.bob_chat_members WHERE room_id=%s AND username=ANY(%s)',(row['room_id'],[row['caller'],row['callee']])).fetchall()
    if len(memberships) != 2 and row['status'] != 'ended':
        end(db,row,'access_removed')
        row = {**row, 'status':'ended', 'reason':'access_removed'}
    return row


def public_call(db, row, username, client_id):
    from .community import display_name_sql
    names = db.execute(f'''SELECT u.username,{display_name_sql('u.username')} AS name FROM users u
        LEFT JOIN bob_user_profiles p ON p.username=u.username WHERE u.username=ANY(%s)''',([row['caller'],row['callee']],)).fetchall()
    names = {r['username']:r['name'] for r in names}
    role = 'caller' if row['caller']==username else 'callee'
    owned = str(row[role+'_client'])==str(client_id)
    return {'type':'call_state','call':{'id':str(row['id']),'room_id':row['room_id'],'status':row['status'],
        'role':role,'owned':owned,'caller':row['caller'],'callee':row['callee'],
        'caller_name':names.get(row['caller'],'Member'),'callee_name':names.get(row['callee'],'Member'),
        'reason':row['reason'],'created_at':row['created_at'].isoformat(),
        'ring_remaining_ms':max(0,min(45000,int((row['created_at'].timestamp()+45-time.time())*1000))),
        'transport':row['transport'],
        'accepted_at':row['accepted_at'].isoformat() if row['accepted_at'] else None}}


def state(username, client_id, call_id):
    with job_queue._connect() as db:
        row=read_call(db,call_id,username)
        return public_call(db,row,username,client_id)


def heartbeat(username, client_id):
    with job_queue._connect() as db:
        expire(db,username)
        db.execute("UPDATE people_chat.bob_voice_calls SET caller_seen=now() WHERE caller=%s AND caller_client=%s AND status<>'ended'",(username,client_id))
        db.execute("UPDATE people_chat.bob_voice_calls SET callee_seen=now() WHERE callee=%s AND callee_client=%s AND status<>'ended'",(username,client_id))
        rows=db.execute("SELECT id FROM people_chat.bob_voice_calls WHERE (caller=%s OR callee=%s) AND status<>'ended'",(username,username)).fetchall()
        result=[]
        for row in rows:
            try: result.append(public_call(db,read_call(db,row['id'],username),username,client_id))
            except HTTPException: pass
        return result


def disconnect(username, client_id):
    with job_queue._connect() as db:
        rows=db.execute("SELECT * FROM people_chat.bob_voice_calls WHERE (caller=%s AND caller_client=%s OR callee=%s AND callee_client=%s) AND status<>'ended' FOR UPDATE",(username,client_id,username,client_id)).fetchall()
        for row in rows:end(db,row,'disconnected')


def handle(username, client_id, signal):
    from . import community as c
    with job_queue._connect() as db:
        expire(db,username)
        if signal.action=='start':
            c.member(db,signal.room_id,username)
            room=db.execute('SELECT kind FROM people_chat.bob_chat_rooms WHERE id=%s',(signal.room_id,)).fetchone()
            peers=db.execute('SELECT username FROM people_chat.bob_chat_members WHERE room_id=%s AND username<>%s',(signal.room_id,username)).fetchall()
            if not room or room['kind']!='direct' or len(peers)!=1:
                raise HTTPException(422,'Voice calls are available in direct conversations')
            callee=peers[0]['username']
            for person in sorted([username,callee]):db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('people-call:'+person,))
            expire(db,callee)
            if db.execute("SELECT 1 FROM people_chat.bob_voice_calls WHERE status<>'ended' AND (caller=ANY(%s) OR callee=ANY(%s))",([username,callee],[username,callee])).fetchone():
                raise HTTPException(409,'You or this member are already in a voice call')
            call_id=uuid4()
            from .community_call_audio import transport
            row=db.execute("INSERT INTO people_chat.bob_voice_calls(id,room_id,caller,callee,caller_client,status,transport) VALUES(%s,%s,%s,%s,%s,'ringing',%s) RETURNING *",(call_id,signal.room_id,username,callee,client_id,transport())).fetchone()
            notify(db,call_id)
            return public_call(db,row,username,client_id)
        row=read_call(db,signal.call_id,username,True)
        if row['status']=='ended':return public_call(db,row,username,client_id)
        role='caller' if row['caller']==username else 'callee'
        owned=str(row[role+'_client'])==str(client_id)
        if signal.action in ('accept','decline'):
            if role!='callee' or row['status']!='ringing':raise HTTPException(409,'This invitation is no longer available')
            if signal.action=='decline':end(db,row,'declined')
            else:
                db.execute("UPDATE people_chat.bob_voice_calls SET status='accepted',callee_client=%s,callee_seen=now(),accepted_at=now() WHERE id=%s",(client_id,row['id']))
                notify(db,row['id'])
        else:
            incoming_end = role=='callee' and row['status']=='ringing' and signal.action=='end' and signal.reason in {'timeout','cancelled','media_error','connection_failed'}
            if not owned and not incoming_end:raise HTTPException(403,'This call belongs to another browser tab')
            if signal.action=='end':
                if signal.diagnostics is not None and owned:
                    db.execute('UPDATE people_chat.bob_voice_calls SET diagnostics=jsonb_set(diagnostics,ARRAY[%s],%s,true) WHERE id=%s',(role,Jsonb(signal.diagnostics.model_dump()),row['id']))
                if row['status']!='ended':end(db,row,signal.reason or 'hangup')
            elif row['status'] not in ('accepted','active'):
                raise HTTPException(409,'Accept the call before connecting audio')
            elif signal.action=='connected':
                column='caller_connected' if role=='caller' else 'callee_connected'
                db.execute(f'UPDATE people_chat.bob_voice_calls SET {column}=true WHERE id=%s',(row['id'],))
                db.execute("UPDATE people_chat.bob_voice_calls SET status='active' WHERE id=%s AND caller_connected AND callee_connected",(row['id'],))
                notify(db,row['id'])
            else:
                if signal.action=='offer' and role!='caller' or signal.action=='answer' and role!='callee':raise HTTPException(403,'Invalid voice negotiation role')
                target=row['callee_client'] if role=='caller' else row['caller_client']
                payload={'kind':'signal','call_id':str(row['id']),'target':str(target),'action':signal.action,
                         **({'sdp':signal.sdp} if signal.sdp is not None else {'candidate':signal.candidate})}
                raw=json.dumps(payload,separators=(',',':'))
                if len(raw.encode())>7400:raise HTTPException(422,'Voice negotiation message is too large')
                db.execute('SELECT pg_notify(%s,%s)',(CHANNEL,raw))
                return None
        row=db.execute('SELECT * FROM people_chat.bob_voice_calls WHERE id=%s',(row['id'],)).fetchone()
        return public_call(db,row,username,client_id)


def register(router, current_user):
    @router.websocket('/calls/ws')
    async def voice_socket(socket: WebSocket):
        origin=socket.headers.get('origin')
        if not origin or urlsplit(origin).netloc!=socket.headers.get('host'):
            await socket.close(code=1008);return
        try:
            user=await current_user(socket)
            from .community import ensure_schema
            await asyncio.to_thread(ensure_schema)
            from .community_call_audio import transport
            servers=ice_servers(user['username']) if transport()=='webrtc' else []
        except (HTTPException,ValueError):
            await socket.close(code=1008);return
        supports_audio=socket.query_params.get('audio')=='1'
        update_message=brand_text('Buddy calling has been updated. Reload Buddy once to enable calls over port 443.')
        username=user['username'];client_id=uuid4();send_lock=asyncio.Lock()
        await socket.accept()
        async def send(value):
            async with send_lock:await socket.send_json(value)
        async def receive():
            window=time.monotonic();count=0
            while True:
                raw=await socket.receive_text()
                if len(raw)>8192:raise WebSocketDisconnect(1009)
                now=time.monotonic()
                if now-window>5:window=now;count=0
                count+=1
                if count>100:raise WebSocketDisconnect(1008)
                await current_user(socket)
                try:
                    signal=Signal.model_validate_json(raw)
                    if signal.action=='ping':
                        for value in await asyncio.to_thread(heartbeat,username,client_id):
                            if supports_audio or value['call']['transport']!='websocket':await send(value)
                    else:
                        if signal.action in ('start','accept') and transport()=='websocket' and not supports_audio:
                            raise HTTPException(409,update_message)
                        if signal.action in ('start','accept'):
                            await send({'type':'call_ready','ice_servers':ice_servers(username) if transport()=='webrtc' else [],'client_id':str(client_id),'audio_transport':transport()})
                        value=await asyncio.to_thread(handle,username,client_id,signal)
                        if value:await send(value)
                except (ValueError,ValidationError):await send({'type':'call_error','message':'Unsupported voice call message'})
                except HTTPException as exc:await send({'type':'call_error','message':exc.detail})
        async def listen(db):
            while True:
                pending=[]
                async for event in db.notifies(timeout=15,stop_after=1):pending.append(event)
                await current_user(socket)
                for event in pending:
                    try:
                        value=json.loads(event.payload)
                        if value.get('kind')=='signal' and value.get('target')!=str(client_id):continue
                        current=await asyncio.to_thread(state,username,client_id,UUID(value['call_id']))
                        if current['call']['transport']=='websocket' and not supports_audio:
                            await send({'type':'call_error','message':update_message});continue
                        if value.get('kind')=='state':await send(current)
                        elif current['call']['owned'] and current['call']['status'] in ('accepted','active'):
                            await send({'type':'call_signal','call_id':value['call_id'],'action':value['action'],**({'sdp':value['sdp']} if 'sdp' in value else {'candidate':value['candidate']})})
                    except (ValueError,KeyError,HTTPException):continue
                await send({'type':'call_ping'})
        tasks=[]
        try:
            async with await psycopg.AsyncConnection.connect(os.environ['DATABASE_URL'],autocommit=True) as db:
                await db.execute('LISTEN '+CHANNEL)
                await send({'type':'call_ready','ice_servers':servers,'client_id':str(client_id),'audio_transport':transport()})
                if transport()=='websocket' and not supports_audio:
                    await send({'type':'call_error','message':update_message})
                else:
                    for value in await asyncio.to_thread(heartbeat,username,client_id):await send(value)
                tasks=[asyncio.create_task(receive()),asyncio.create_task(listen(db))]
                done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                for task in done:task.result()
        except (WebSocketDisconnect,RuntimeError,HTTPException):pass
        finally:
            for task in tasks:task.cancel()
            if tasks:await asyncio.gather(*tasks,return_exceptions=True)
            await asyncio.to_thread(disconnect,username,client_id)
            with suppress(RuntimeError,WebSocketDisconnect):await socket.close()
