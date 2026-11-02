"""Authenticated member conversations, channel subscriptions and durable unread state."""
import asyncio
import os
import json
import hashlib
from psycopg.types.json import Jsonb
from contextlib import suppress
from urllib.parse import urlsplit
import psycopg
from fastapi import WebSocket, WebSocketDisconnect
from threading import Lock
from typing import Literal
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Query, Form, File, UploadFile, Response, Request
from pydantic import BaseModel, Field, model_validator
from app.auth import current_user
from app import job_queue, notes

async def same_origin(request: Request):
    origin = request.headers.get('origin')
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin and urlsplit(origin).netloc != request.headers.get('host'):
        raise HTTPException(403, 'Cross-origin writes are not allowed')


router = APIRouter(prefix='/api/community', tags=['community'])
_lock = Lock()
_ready = False
def changed(db, room_id=0, message_id=None):
    # PostgreSQL delivers notifications only after the enclosing write commits.
    db.execute("SELECT pg_notify('bob_community_events',%s)", (json.dumps({'room_id':room_id,'message_id':message_id}) if message_id is not None else str(room_id),))


MAX_FILE = 20 * 1024 * 1024


def ensure_schema():
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        with job_queue._connect() as db:
            db.execute('CREATE SCHEMA IF NOT EXISTS "people_chat"')
            db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_community_schema'))")
            db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_rooms (
                id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('direct','channel')),
                name TEXT NOT NULL, direct_key TEXT UNIQUE, creator TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute("ALTER TABLE people_chat.bob_chat_rooms ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open' CHECK (visibility IN ('open','private'))")
            db.execute("UPDATE people_chat.bob_chat_rooms SET visibility='private' WHERE kind='direct' AND visibility<>'private'")
            db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_members (
                room_id BIGINT REFERENCES people_chat.bob_chat_rooms(id) ON DELETE CASCADE,
                username TEXT NOT NULL, last_read BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY(room_id,username))''')
            # Historical last_read also included background fetches. Start explicit
            # visible-message acknowledgements separately so they cannot imply Seen.
            db.execute('ALTER TABLE people_chat.bob_chat_members ADD COLUMN IF NOT EXISTS last_seen BIGINT NOT NULL DEFAULT 0')
            db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_messages (
                id BIGSERIAL PRIMARY KEY, room_id BIGINT NOT NULL REFERENCES people_chat.bob_chat_rooms(id) ON DELETE CASCADE,
                sender TEXT NOT NULL, body TEXT NOT NULL, filename TEXT, content BYTEA,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_chat_messages_room ON people_chat.bob_chat_messages(room_id,id)')
            db.execute('CREATE INDEX IF NOT EXISTS bob_chat_members_user ON people_chat.bob_chat_members(username,room_id)')
            from buddy_people.community_away import schema
            schema(db)
            notes.ensure_schema()
            from buddy_people.community_collaboration import schema as collaboration_schema
            collaboration_schema(db)
            from buddy_people.community_bob import schema as bob_schema
            bob_schema(db)
            from buddy_people.community_calls import schema as calls_schema
            calls_schema(db)
        _ready = True


def member(db, room_id, username, lock=False):
    row = db.execute('SELECT * FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s' + (' FOR UPDATE' if lock else ''), (room_id, username)).fetchone()
    if not row:
        raise HTTPException(404, 'Conversation not found or subscription required')
    return row


class RoomCreate(BaseModel):
    kind: Literal['direct', 'channel']
    peer: str | None = Field(default=None, max_length=200)
    name: str = Field(default='', max_length=80)
    visibility: Literal['open', 'private'] = 'open'
    members: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode='after')
    def validate_room(self):
        self.name = self.name.strip()
        if self.kind == 'channel' and not self.name:
            raise ValueError('Enter a channel name')
        if self.kind == 'direct' and not self.peer:
            raise ValueError('Select a member')
        if self.kind == 'direct':
            self.visibility = 'private'
            if self.members:
                raise ValueError('Select one peer for a direct conversation')
        elif self.visibility == 'open' and self.members:
            raise ValueError('Open channels cannot specify invited members')
        return self


def display_name_sql(username):
    # Profile names are authoritative; opaque identity keys and emails are not labels.
    # username is an internal SQL column expression, never request input.
    return f"""COALESCE(CASE WHEN btrim(p.display_name) <> ''
        AND p.display_name NOT LIKE 'kc-%%' AND position('@' in p.display_name)=0
        THEN p.display_name END,
        CASE WHEN {username} LIKE 'kc-%%' OR position('@' in {username})>0
        THEN 'Member' ELSE {username} END)"""


@router.get('/members')
def members(user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        return db.execute(f'''SELECT u.username,{display_name_sql('u.username')} AS display_name
            FROM users u LEFT JOIN bob_user_profiles p ON p.username=u.username
            WHERE u.username<>%s ORDER BY display_name,u.username''', (user['username'],)).fetchall()


@router.get('/rooms')
def rooms(response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    ensure_schema()
    with job_queue._connect() as db:
        from buddy_people.community_collaboration import notifications_paused
        paused = notifications_paused(db,user['username'])
        rows = db.execute(f'''SELECT r.id,r.kind,r.visibility,r.creator=%s AS is_owner,
            COALESCE((SELECT mode FROM people_chat.bob_chat_notification_preferences pref WHERE pref.room_id=r.id AND pref.username=%s),'all') AS notification_mode,
            (SELECT count(*) FROM people_chat.bob_chat_members audience WHERE audience.room_id=r.id) AS member_count,CASE WHEN r.kind='direct' THEN
            COALESCE((SELECT {display_name_sql('m.username')} FROM people_chat.bob_chat_members m
                LEFT JOIN bob_user_profiles p ON p.username=m.username
                WHERE m.room_id=r.id AND m.username<>%s LIMIT 1),r.name) ELSE r.name END AS name,
            own.username IS NOT NULL AS subscribed,
            (SELECT count(*) FROM people_chat.bob_chat_messages msg WHERE msg.room_id=r.id
                AND msg.sender<>%s AND NOT EXISTS (SELECT 1 FROM people_chat.bob_chat_message_seen seen WHERE seen.message_id=msg.id AND seen.username=own.username)) AS unread_count,
            notifiable.id AS notification_incoming_id,notifiable.sender_name AS notification_sender_name,
            incoming.id AS latest_incoming_id,incoming.sender_name AS latest_incoming_sender_name,incoming.automated AS latest_incoming_automated
            FROM people_chat.bob_chat_rooms r LEFT JOIN people_chat.bob_chat_members own ON own.room_id=r.id AND own.username=%s
            LEFT JOIN LATERAL (
                SELECT msg.id,msg.automated,{display_name_sql('msg.sender')} AS sender_name
                FROM people_chat.bob_chat_messages msg LEFT JOIN bob_user_profiles p ON p.username=msg.sender
                WHERE msg.room_id=r.id AND own.username IS NOT NULL AND msg.sender<>%s
                ORDER BY msg.id DESC LIMIT 1
            ) incoming ON true
            LEFT JOIN LATERAL (
                SELECT msg.id,{display_name_sql('msg.sender')} AS sender_name
                FROM people_chat.bob_chat_messages msg LEFT JOIN bob_user_profiles p ON p.username=msg.sender
                LEFT JOIN people_chat.bob_chat_notification_preferences pref ON pref.room_id=r.id AND pref.username=own.username
                WHERE msg.room_id=r.id AND own.username IS NOT NULL AND msg.sender<>own.username
                AND msg.voice_call_id IS NULL
                AND COALESCE(pref.mode,'all')<>'muted'
                AND (COALESCE(pref.mode,'all')<>'mentions' OR msg.mentions ? own.username)
                ORDER BY msg.id DESC LIMIT 1
            ) notifiable ON true
            WHERE (r.kind='channel' AND r.visibility='open') OR own.username IS NOT NULL ORDER BY r.id DESC''',
            (user['username'],)*6).fetchall()
        return [{**row,'notifications_paused':paused} for row in rows]


@router.post('/rooms', dependencies=[Depends(same_origin)])
def create_room(body: RoomCreate, user=Depends(current_user)):
    ensure_schema()
    username = user['username']
    with job_queue._connect() as db:
        key = None
        audience = [username]
        if body.kind == 'direct':
            if body.peer == username or not db.execute('SELECT 1 FROM users WHERE username=%s', (body.peer,)).fetchone():
                raise HTTPException(422, 'Select another registered member')
            pair = sorted([username, body.peer])
            key = hashlib.sha256(repr(pair).encode()).hexdigest()
            audience = pair
        elif body.visibility == 'private':
            invited = sorted(set(body.members) - {username})
            if not invited:
                raise HTTPException(422, 'Select at least one other member')
            registered = db.execute('SELECT username FROM users WHERE username=ANY(%s)', (invited,)).fetchall()
            if {row['username'] for row in registered} != set(invited):
                raise HTTPException(422, 'Select registered members only')
            audience += invited
        room = db.execute('''INSERT INTO people_chat.bob_chat_rooms(kind,name,direct_key,creator,visibility) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT(direct_key) DO UPDATE SET direct_key=excluded.direct_key RETURNING id''',
            (body.kind, body.name, key, username, body.visibility)).fetchone()
        for who in audience:
            db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s) ON CONFLICT DO NOTHING', (room['id'], who))
        changed(db, room['id'] if body.visibility == 'private' else 0)
    return room


@router.post('/rooms/{room_id}/subscribe', dependencies=[Depends(same_origin)])
def subscribe(room_id: int, user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        if not db.execute("SELECT 1 FROM people_chat.bob_chat_rooms WHERE id=%s AND kind='channel' AND visibility='open'", (room_id,)).fetchone():
            raise HTTPException(404, 'Channel not found')
        db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s) ON CONFLICT DO NOTHING', (room_id, user['username']))
        changed(db, room_id)
    return {'subscribed': True}


@router.delete('/rooms/{room_id}/subscribe', dependencies=[Depends(same_origin)])
def unsubscribe(room_id: int, user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'], True)
        if not db.execute("SELECT 1 FROM people_chat.bob_chat_rooms WHERE id=%s AND kind='channel'", (room_id,)).fetchone():
            raise HTTPException(422, 'Direct conversations cannot be unsubscribed')
        db.execute('DELETE FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s', (room_id, user['username']))
        changed(db, room_id)
    return {'subscribed': False}


@router.get('/rooms/{room_id}/members')
def room_members(room_id: int, response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'])
        return db.execute(f'''SELECT m.username,{display_name_sql('m.username')} AS display_name
            FROM people_chat.bob_chat_members m LEFT JOIN bob_user_profiles p ON p.username=m.username
            WHERE m.room_id=%s ORDER BY display_name,m.username''', (room_id,)).fetchall()


def message_snapshot(db, room_id, username, after=0, exact_id=None):
    rows = db.execute(f'''SELECT msg.id,msg.sender,{display_name_sql('msg.sender')} AS sender_name,
            msg.body,msg.filename,msg.created_at,msg.voice_call_id,msg.automated,msg.mentions,msg.parent_id,msg.pinned,msg.shared,octet_length(msg.content) AS size FROM people_chat.bob_chat_messages msg
            LEFT JOIN bob_user_profiles p ON p.username=msg.sender
            WHERE msg.room_id=%s AND msg.id>%s AND (%s::bigint IS NULL OR msg.id=%s) ORDER BY msg.id LIMIT 200''', (room_id, after, exact_id, exact_id)).fetchall()
    from buddy_people.community_collaboration import enrich
    rows = enrich(db, rows, username)
    return [{**{k: v for k, v in row.items() if k not in ('filename','size')},
             'attachment': {'id': row['id'], 'filename': row['filename'], 'size': row.get('size')} if row['filename'] else None} for row in rows]


@router.get('/rooms/{room_id}/messages')
def messages(room_id: int, response: Response, after: int = Query(0, ge=0), user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'])
        return message_snapshot(db, room_id, user['username'], after)


class ReadAcknowledgement(BaseModel):
    message_id: int | None = Field(default=None,gt=0)
    message_ids: list[int] | None = Field(default=None,min_length=1,max_length=200)

    @model_validator(mode='after')
    def valid_ids(self):
        if self.message_ids is None and self.message_id is None: raise ValueError('Select visible messages')
        if self.message_ids is not None and any(i<=0 for i in self.message_ids): raise ValueError('Invalid message ID')
        return self


@router.post('/rooms/{room_id}/read', dependencies=[Depends(same_origin)])
def mark_read(room_id: int, body: ReadAcknowledgement, user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        own = member(db, room_id, user['username'], True)
        ids=sorted(set(body.message_ids or [body.message_id]))
        existing=db.execute('SELECT id FROM people_chat.bob_chat_messages WHERE room_id=%s AND id=ANY(%s)',(room_id,ids)).fetchall()
        if {r['id'] for r in existing}!=set(ids): raise HTTPException(404,'Message not found')
        if body.message_ids is None:
            inserted=db.execute('''INSERT INTO people_chat.bob_chat_message_seen(message_id,username)
                SELECT id,%s FROM people_chat.bob_chat_messages WHERE room_id=%s AND id<=%s
                ON CONFLICT DO NOTHING RETURNING message_id''',(user['username'],room_id,body.message_id)).fetchall()
        else:
            inserted=db.execute('''INSERT INTO people_chat.bob_chat_message_seen(message_id,username)
                SELECT unnest(%s::bigint[]),%s ON CONFLICT DO NOTHING RETURNING message_id''',(ids,user['username'])).fetchall()
        last_read=max(own['last_read'],max(ids))
        last_seen=max(own['last_seen'],max(ids))
        if last_read!=own['last_read'] or last_seen!=own['last_seen']:
            db.execute('UPDATE people_chat.bob_chat_members SET last_read=%s,last_seen=%s WHERE room_id=%s AND username=%s',
                       (last_read,last_seen,room_id,user['username']))
        if inserted: changed(db,room_id)
    return {'last_read': last_read, 'last_seen': last_seen}


@router.get('/rooms/{room_id}/receipts')
def receipts(room_id: int, response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'])
        # Keep the receipt API field stable, but expose only explicit acknowledgements.
        return db.execute(f'''SELECT m.username,{display_name_sql('m.username')} AS display_name,m.last_seen AS last_read,
            COALESCE((SELECT jsonb_agg(seen.message_id) FROM people_chat.bob_chat_message_seen seen JOIN people_chat.bob_chat_messages msg ON msg.id=seen.message_id
                WHERE seen.username=m.username AND msg.room_id=m.room_id),'[]'::jsonb) AS seen_message_ids
            FROM people_chat.bob_chat_members m LEFT JOIN bob_user_profiles p ON p.username=m.username
            WHERE m.room_id=%s ORDER BY display_name,m.username''', (room_id,)).fetchall()


@router.post('/rooms/{room_id}/messages', dependencies=[Depends(same_origin)])
def send(room_id: int, body: str = Form('', max_length=20000), note_id: int | None = Form(None),
         file: UploadFile | None = File(None), user=Depends(current_user), parent_id: int | None = Form(None), mention_ids: str = Form('[]')):
    ensure_schema()
    if note_id is not None:
        notes.ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'], True)
        from buddy_people.community_collaboration import message_in_room
        if not isinstance(parent_id, int):
            parent_id = None
        if parent_id is not None:
            message_in_room(db, room_id, parent_id)
        if not isinstance(mention_ids,str): mention_ids='[]'
        try:
            mentions=json.loads(mention_ids)
            if not isinstance(mentions,list) or len(mentions)>100 or any(not isinstance(who,str) or len(who)>200 for who in mentions): raise ValueError()
            mentions=sorted(set(mentions))
        except (ValueError,TypeError): raise HTTPException(422,'Select valid mentioned members')
        if mentions:
            audience=db.execute('SELECT username FROM people_chat.bob_chat_members WHERE room_id=%s AND username=ANY(%s)',(room_id,mentions)).fetchall()
            if {r['username'] for r in audience}!=set(mentions): raise HTTPException(422,'Mention conversation members only')
        shared = None
        copy_of_id = None
        body = body.strip()
        if note_id is not None:
            note = db.execute('SELECT title,body,community_message_id FROM bob_notes WHERE id=%s AND username=%s FOR SHARE', (note_id, user['username'])).fetchone()
            if not note:
                raise HTTPException(404, 'Note not found')
            copy_of_id = note.get('community_message_id')
            if copy_of_id is not None and not db.execute('SELECT id FROM people_chat.bob_chat_messages WHERE id=%s FOR SHARE',(copy_of_id,)).fetchone():
                raise HTTPException(404,'Original shared message was deleted')
            shared = {'kind':'note','title':note['title'],'body':note['body'][:20000],'snapshot':True}
            body = '\n\n'.join(filter(None, [body, 'Shared note: ' + note['title'], note['body']]))
        content = None
        filename = None
        if file:
            filename = (file.filename or 'attachment').replace('\\', '/').split('/')[-1][:200]
            content = file.file.read(MAX_FILE + 1)
            if len(content) > MAX_FILE:
                raise HTTPException(413, 'Files must be 20 MB or smaller')
        if not body and content is None:
            raise HTTPException(422, 'Write a message or attach a file or note')
        row = db.execute('''INSERT INTO people_chat.bob_chat_messages(room_id,sender,body,filename,content,parent_id,shared,mentions,copy_of_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id''', (room_id, user['username'], body, filename, content,parent_id,Jsonb(shared) if shared else None,Jsonb(mentions),copy_of_id)).fetchone()
        from buddy_people.community_away import enqueue
        enqueue(db, room_id, row['id'], user['username'])
        changed(db, room_id, row['id'])
        saved = message_snapshot(db, room_id, user['username'], exact_id=row['id'])
    return saved[0] if saved else row


@router.delete('/rooms/{room_id}/messages/{message_id}', dependencies=[Depends(same_origin)])
def delete_message(room_id: int, message_id: int, user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'], True)
        from buddy_people.community_collaboration import purge_message
        return purge_message(db,room_id,message_id,user['username'])


@router.get('/rooms/{room_id}/attachments/{attachment_id}')
def attachment(room_id: int, attachment_id: int, user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        member(db, room_id, user['username'])
        row = db.execute('SELECT filename,content FROM people_chat.bob_chat_messages WHERE room_id=%s AND id=%s AND filename IS NOT NULL', (room_id, attachment_id)).fetchone()
        if not row:
            raise HTTPException(404, 'Attachment not found')
    return Response(bytes(row['content']), media_type='application/octet-stream', headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(row['filename'], safe=''),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})


@router.websocket('/ws')
async def socket_updates(socket: WebSocket):
    origin = socket.headers.get('origin')
    if origin and urlsplit(origin).netloc != socket.headers.get('host'):
        await socket.close(code=1008)
        return
    try:
        user = await current_user(socket)
    except HTTPException:
        await socket.close(code=1008)
        return
    from starlette.concurrency import run_in_threadpool
    await run_in_threadpool(ensure_schema)
    await socket.accept()
    try:
        # A dedicated LISTEN connection works across API workers and processes.
        async with await psycopg.AsyncConnection.connect(os.environ['DATABASE_URL'], autocommit=True) as db:
            await db.execute('LISTEN bob_community_events')
            await db.execute('LISTEN bob_community_typing')
            while True:
                pending = []
                # Consume/close the generator before querying this connection:
                # psycopg holds its connection lock while the generator yields.
                async for event in db.notifies(timeout=25, stop_after=1):
                    pending.append(event)
                for event in pending:
                    if event.channel == 'bob_community_typing':
                        try:
                            signal = json.loads(event.payload)
                            room_id = int(signal['room_id'])
                        except (ValueError, KeyError, TypeError):
                            continue
                        if signal.get('username') == user['username']:
                            continue
                        await current_user(socket)
                        cursor = await db.execute('SELECT 1 FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s', (room_id, user['username']))
                        if await cursor.fetchone():
                            # Recheck the sender too: revoked membership invalidates pending signals.
                            cursor = await db.execute('SELECT 1 FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s', (room_id, signal.get('username')))
                            if await cursor.fetchone():
                                await socket.send_json(signal)
                        continue
                    update = json.loads(event.payload)
                    room_id = int(update['room_id'] if isinstance(update, dict) else update)
                    message_id = update.get('message_id') if isinstance(update, dict) else None
                    if room_id:
                        cursor = await db.execute('SELECT 1 FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s', (room_id, user['username']))
                        if not await cursor.fetchone():
                            continue
                    if message_id is not None and socket.query_params.get('messages') == '1':
                        # Resolve an authoritative, recipient-scoped message; notification payloads carry IDs only.
                        def delivered_message():
                            with job_queue._connect() as snapshot_db:
                                member(snapshot_db, room_id, user['username'])
                                return message_snapshot(snapshot_db, room_id, user['username'], exact_id=message_id)
                        snapshot = await run_in_threadpool(delivered_message)
                        if snapshot:
                            from fastapi.encoders import jsonable_encoder
                            await socket.send_json({'type':'message','room_id':room_id,'message':jsonable_encoder(snapshot[0])})
                    else:
                        await socket.send_json({'type':'refresh','room_id':room_id})
                # Revalidate expiry and logout while a browser keeps its socket open.
                await current_user(socket)
                await socket.send_json({'type': 'ping'})
    except (WebSocketDisconnect, RuntimeError, HTTPException):
        with suppress(RuntimeError, WebSocketDisconnect):
            await socket.close(code=1008)


from buddy_people.community_away import register as register_away
register_away(router, current_user, same_origin)

from buddy_people.community_collaboration import register as register_collaboration
register_collaboration(router, current_user, same_origin)

from buddy_people.community_bob import register as register_bob
register_bob(router, current_user, same_origin)

from buddy_people.community_typing import register as register_typing
register_typing(router, current_user, same_origin)

from buddy_people.community_calls import register as register_calls
register_calls(router, current_user)

from buddy_people.community_call_audio import register as register_call_audio
register_call_audio(router, current_user)
