"""Explicit, selected-message-only Bob assistance in member conversations."""
from app.branding import brand_text
import hashlib
import json
from fastapi import Depends, HTTPException, Response
from pydantic import BaseModel, Field, model_validator
from psycopg.types.json import Jsonb
from buddy_people import community_away
from app import job_queue
from app.agent_budget import RunBudget


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_bob_context (
        room_id BIGINT REFERENCES people_chat.bob_chat_rooms(id) ON DELETE CASCADE,
        username TEXT NOT NULL,instructions TEXT NOT NULL DEFAULT '',PRIMARY KEY(room_id,username))''')


def inbox_instructions(db, room_id, username):
    row = db.execute('SELECT instructions FROM people_chat.bob_chat_bob_context WHERE room_id=%s AND username=%s',
                     (room_id, username)).fetchone()
    return (row or {}).get('instructions', '')


class InboxSettings(BaseModel):
    instructions: str = Field(default='', max_length=4000)


class AskBob(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    message_ids: list[int] = Field(min_length=1, max_length=20)

    @model_validator(mode='after')
    def validate_selection(self):
        self.prompt = self.prompt.strip()
        if not self.prompt or any(i <= 0 for i in self.message_ids):
            raise ValueError('Ask a question and select existing messages')
        self.message_ids = list(dict.fromkeys(self.message_ids))
        return self


def fingerprint(text):
    return hashlib.sha256(community_away.normalize(text).encode()).digest()


def selected(db, room_id, ids, lock=False):
    from buddy_people.community import display_name_sql
    rows = db.execute(f'''SELECT msg.id,msg.body,msg.shared,{display_name_sql('msg.sender')} AS sender_name
        FROM people_chat.bob_chat_messages msg LEFT JOIN bob_user_profiles p ON p.username=msg.sender
        WHERE msg.room_id=%s AND msg.id=ANY(%s) ORDER BY msg.id
        {"FOR UPDATE OF msg" if lock else ""}''', (room_id, ids)).fetchall()
    if {row['id'] for row in rows} != set(ids):
        raise HTTPException(404, 'Selected message not found')
    context = []
    for row in rows:
        item = {'sender': row['sender_name'], 'text': row['body'][:20000]}
        shared = row.get('shared') or {}
        # Only copied, already shared text is allowed; never resolve source IDs or paths.
        item['shared'] = {key: shared[key][:20000] for key in ('title', 'body')
                          if isinstance(shared.get(key), str)}
        context.append(item)
    if len(json.dumps(context, ensure_ascii=False)) > 60000:
        raise HTTPException(422, 'Select fewer or shorter messages')
    return context


def register(router, current_user, same_origin):
    from buddy_people import community as c

    @router.get('/rooms/{room_id}/bob-settings')
    def get_settings(room_id: int, response: Response, user=Depends(current_user)):
        response.headers['Cache-Control'] = 'no-store'
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db, room_id, user['username'])
            return {'instructions': inbox_instructions(db, room_id, user['username'])}

    @router.put('/rooms/{room_id}/bob-settings', dependencies=[Depends(same_origin)])
    def put_settings(room_id: int, body: InboxSettings, user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db, room_id, user['username'], True)
            db.execute('''INSERT INTO people_chat.bob_chat_bob_context(room_id,username,instructions) VALUES (%s,%s,%s)
                ON CONFLICT(room_id,username) DO UPDATE SET instructions=excluded.instructions''',
                (room_id, user['username'], body.instructions.strip()))
        return {'instructions': body.instructions.strip()}

    @router.post('/rooms/{room_id}/bob', dependencies=[Depends(same_origin)])
    async def ask(room_id: int, body: AskBob, response: Response, user=Depends(current_user)):
        response.headers['Cache-Control'] = 'no-store'
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db, room_id, user['username'])
            context = selected(db, room_id, body.message_ids)
            instructions = inbox_instructions(db, room_id, user['username'])
            identity = db.execute(f'''SELECT {c.display_name_sql('u.username')} AS name FROM users u
                LEFT JOIN bob_user_profiles p ON p.username=u.username WHERE u.username=%s''',
                (user['username'],)).fetchone()
            room = db.execute('SELECT kind,name FROM people_chat.bob_chat_rooms WHERE id=%s', (room_id,)).fetchone()
            context_info = {'sender_name': context[-1]['sender'], 'recipient_name': (identity or {}).get('name', 'Member'),
                            'conversation_kind': room['kind'], 'conversation_name': room['name'] if room['kind'] != 'direct' else ''}
            # Unselected text is used locally only to reject repeats, never sent to Bob.
            previous = {fingerprint(row['body']) for row in db.execute('''SELECT body
                FROM people_chat.bob_chat_messages WHERE room_id=%s AND shared->>'kind'='bob'
                ORDER BY id DESC LIMIT 10''', (room_id,)).fetchall()}
        reply = None
        rejected = []
        budget = RunBudget(user['username'])
        try:
            for _ in range(2):
                candidate = await community_away.generate(
                    json.dumps({'selected_messages': context, 'requester_instructions': instructions}, ensure_ascii=False),
                    body.prompt, rejected, purpose='collaboration', context_info=context_info, budget=budget)
                if fingerprint(candidate) not in previous:
                    reply = candidate
                    break
                # This newly generated candidate contains only authorized context.
                rejected = [candidate]
        except Exception:
            raise HTTPException(503, brand_text('People Buddy could not generate a reply. Nothing was sent.'))
        if not reply:
            raise HTTPException(503, brand_text('People Buddy repeated a recent reply. Nothing was sent. Please try again.'))
        with job_queue._connect() as db:
            c.member(db, room_id, user['username'], True)
            current = selected(db, room_id, body.message_ids, True)
            if current != context:
                raise HTTPException(409, 'Selected messages changed. Review your selection and try again.')
            profile = db.execute(f'''SELECT {c.display_name_sql('u.username')} AS name FROM users u
                LEFT JOIN bob_user_profiles p ON p.username=u.username WHERE u.username=%s''',
                (user['username'],)).fetchone()
            shared = {'kind': 'bob', 'title': brand_text('People Buddy reply'), 'context_count': len(context),
                      'requested_by': (profile or {}).get('name', 'Member')}
            row = db.execute('''INSERT INTO people_chat.bob_chat_messages(room_id,sender,body,automated,shared)
                VALUES (%s,%s,%s,true,%s) RETURNING id''',
                (room_id, user['username'], reply, Jsonb(shared))).fetchone()
            for source_id in body.message_ids:
                db.execute('INSERT INTO people_chat.bob_chat_dependencies(source_id,derived_id) VALUES (%s,%s) ON CONFLICT DO NOTHING',
                           (source_id, row['id']))
            c.changed(db, room_id)
        return {'id': row['id'], 'reply': reply}
