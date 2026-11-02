"""Explicit conversation sharing and member-scoped collaboration tools."""
from pathlib import PurePosixPath
from typing import Literal
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pydantic import model_validator
from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb
from app import job_queue


def schema(db):
    seen_exists=db.execute("SELECT to_regclass('people_chat.bob_chat_message_seen') AS name").fetchone()['name'] is not None
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_message_seen (
        message_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE,
        username TEXT NOT NULL,PRIMARY KEY(message_id,username))''')
    if not seen_exists:
        db.execute('''INSERT INTO people_chat.bob_chat_message_seen(message_id,username)
        SELECT msg.id,m.username FROM people_chat.bob_chat_members m JOIN people_chat.bob_chat_messages msg ON msg.room_id=m.room_id
        WHERE msg.id<=m.last_seen ON CONFLICT DO NOTHING''')
    db.execute('ALTER TABLE people_chat.bob_chat_messages ADD COLUMN IF NOT EXISTS copy_of_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE')
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_dependencies (
        source_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE,
        derived_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE,
        PRIMARY KEY(source_id,derived_id))''')
    db.execute("ALTER TABLE people_chat.bob_chat_messages ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb")
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_notification_settings (
        username TEXT PRIMARY KEY,quiet_enabled BOOLEAN NOT NULL DEFAULT false,
        start TEXT NOT NULL DEFAULT '22:00',"end" TEXT NOT NULL DEFAULT '08:00',timezone TEXT NOT NULL DEFAULT 'UTC')''')
    db.execute('ALTER TABLE people_chat.bob_chat_messages ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE SET NULL')
    db.execute('ALTER TABLE people_chat.bob_chat_messages ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false')
    db.execute('ALTER TABLE people_chat.bob_chat_messages ADD COLUMN IF NOT EXISTS shared JSONB')
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_reactions (
        message_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE,
        username TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(message_id,username,emoji))''')
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_tasks (
        id BIGSERIAL PRIMARY KEY,room_id BIGINT NOT NULL REFERENCES people_chat.bob_chat_rooms(id) ON DELETE CASCADE,
        message_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE SET NULL,
        creator TEXT NOT NULL,assignee TEXT NOT NULL,title TEXT NOT NULL,due_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('ALTER TABLE people_chat.bob_chat_tasks DROP CONSTRAINT IF EXISTS bob_chat_tasks_message_id_fkey')
    db.execute('ALTER TABLE people_chat.bob_chat_tasks ADD CONSTRAINT bob_chat_tasks_message_id_fkey FOREIGN KEY(message_id) REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE')
    db.execute('ALTER TABLE bob_notes ADD COLUMN IF NOT EXISTS community_message_id BIGINT REFERENCES people_chat.bob_chat_messages(id) ON DELETE CASCADE')
    db.execute('''CREATE TABLE IF NOT EXISTS people_chat.bob_chat_notification_preferences (
        room_id BIGINT REFERENCES people_chat.bob_chat_rooms(id) ON DELETE CASCADE,username TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('all','mentions','muted')), PRIMARY KEY(room_id,username))''')



def purge_message(db,room_id,message_id,username):
    # Lock the authorized source first. Descendants are app-managed copies, not
    # independently owned private source notes or manually exported documents.
    source=db.execute('SELECT id FROM people_chat.bob_chat_messages WHERE room_id=%s AND id=%s AND sender=%s FOR UPDATE',(room_id,message_id,username)).fetchone()
    if not source: raise HTTPException(404,'Message not found')
    rows=db.execute('''WITH RECURSIVE descendants(id) AS (
        SELECT %s::bigint UNION
        SELECT edge.derived_id FROM descendants d JOIN (
            SELECT copy_of_id AS source_id,id AS derived_id FROM people_chat.bob_chat_messages WHERE copy_of_id IS NOT NULL
            UNION SELECT source_id,derived_id FROM people_chat.bob_chat_dependencies
        ) edge ON edge.source_id=d.id
    ) SELECT msg.id,msg.room_id FROM people_chat.bob_chat_messages msg JOIN descendants d ON d.id=msg.id
    FOR UPDATE OF msg''',(message_id,)).fetchall()
    ids=[r['id'] for r in rows]
    db.execute('DELETE FROM people_chat.bob_chat_away_jobs WHERE trigger_id=ANY(%s)',(ids,))
    db.execute('DELETE FROM people_chat.bob_chat_messages WHERE id=ANY(%s)',(ids,))
    from buddy_people.community import changed
    for room in {r['room_id'] for r in rows}: changed(db,room)
    return {'deleted':message_id}


def message_in_room(db, room_id, message_id):
    row = db.execute('SELECT * FROM people_chat.bob_chat_messages WHERE room_id=%s AND id=%s FOR SHARE', (room_id,message_id)).fetchone()
    if not row:
        raise HTTPException(404, 'Message not found')
    return row


def enrich(db, rows, username):
    if not rows:
        return rows
    ids = [row['id'] for row in rows]
    reactions = db.execute('''SELECT message_id,emoji,count(*) AS count,bool_or(username=%s) AS mine
        FROM people_chat.bob_chat_reactions WHERE message_id=ANY(%s) GROUP BY message_id,emoji''',(username,ids)).fetchall()
    tasks = db.execute('SELECT * FROM people_chat.bob_chat_tasks WHERE message_id=ANY(%s) ORDER BY id',(ids,)).fetchall()
    for row in rows:
        row['reactions'] = [{k:v for k,v in r.items() if k!='message_id'} for r in reactions if r['message_id']==row['id']]
        row['tasks'] = [t for t in tasks if t['message_id']==row['id']]
    return rows


class Share(BaseModel):
    kind: Literal['note','artifact','text']
    note_id: int | None = None
    session_id: str | None = Field(None,max_length=200)
    path: str | None = Field(None,max_length=1000)
    title: str = Field('Shared item',min_length=1,max_length=200)
    body: str = Field('',max_length=20000)

class Membership(BaseModel):
    usernames: list[str] = Field(max_length=100)

class Reaction(BaseModel):
    emoji: Literal['👍','❤️','😂','🎉','😮','😢','✅','👀']

class Pin(BaseModel):
    pinned: bool

class Task(BaseModel):
    title: str = Field(min_length=1,max_length=300)
    assignee: str = Field(min_length=1,max_length=200)
    due_at: datetime | None = None

class TaskStatus(BaseModel):
    status: Literal['todo','in_progress','done']

class Preferences(BaseModel):
    mode: Literal['all','mentions','muted']

class SaveNote(BaseModel):
    title: str = Field('Saved message',min_length=1,max_length=200)



class QuietSettings(BaseModel):
    quiet_enabled: bool = False
    start: str = Field('22:00',pattern=r'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$')
    end: str = Field('08:00',pattern=r'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$')
    timezone: str = Field('UTC',max_length=100)

    @model_validator(mode='after')
    def valid_zone(self):
        try: ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError,ValueError): raise ValueError('Choose a valid IANA timezone')
        if self.quiet_enabled and self.start==self.end: raise ValueError('Quiet hours need distinct start and end times')
        return self


def notifications_paused(db,username,now=None):
    row=db.execute('SELECT * FROM people_chat.bob_chat_notification_settings WHERE username=%s',(username,)).fetchone()
    if not row or not row['quiet_enabled']: return False
    current=(now or datetime.now(timezone.utc)).astimezone(ZoneInfo(row['timezone'])).strftime('%H:%M')
    return row['start']<=current<row['end'] if row['start']<row['end'] else current>=row['start'] or current<row['end']


def register(router, current_user, same_origin):
    from buddy_people import community as c
    write = [Depends(same_origin)]

    @router.get('/notification-settings')
    def notification_settings(user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            row=db.execute('SELECT quiet_enabled,start,"end",timezone FROM people_chat.bob_chat_notification_settings WHERE username=%s',(user['username'],)).fetchone()
            return row or QuietSettings().model_dump()

    @router.put('/notification-settings',dependencies=write)
    def set_notification_settings(body:QuietSettings,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            db.execute('''INSERT INTO people_chat.bob_chat_notification_settings(username,quiet_enabled,start,"end",timezone)
                VALUES (%s,%s,%s,%s,%s) ON CONFLICT(username) DO UPDATE SET quiet_enabled=excluded.quiet_enabled,
                start=excluded.start,"end"=excluded."end",timezone=excluded.timezone''',(user['username'],body.quiet_enabled,body.start,body.end,body.timezone))
            c.changed(db,0)
        return body.model_dump()

    @router.post('/rooms/{room_id}/share',dependencies=write)
    def share(room_id:int, body:Share,user=Depends(current_user)):
        c.ensure_schema()
        from app import notes
        if body.kind=='note': notes.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            filename = content = copy_of_id = None
            title, text = body.title.strip(),body.body
            if body.kind=='note':
                row=db.execute('SELECT title,body,community_message_id FROM bob_notes WHERE id=%s AND username=%s FOR SHARE',(body.note_id,user['username'])).fetchone()
                if not row: raise HTTPException(404,'Note not found')
                title,text=row['title'],row['body']
                copy_of_id=row['community_message_id']
                if copy_of_id is not None and not db.execute('SELECT id FROM people_chat.bob_chat_messages WHERE id=%s FOR SHARE',(copy_of_id,)).fetchone():
                    raise HTTPException(404,'Original shared message was deleted')
                if len(text)>20000: raise HTTPException(413,'Select a note of 20,000 characters or fewer')
            elif body.kind=='artifact':
                if not body.session_id or not body.path: raise HTTPException(422,'Select an artifact')
                from app import artifacts,postgres_storage
                scope=artifacts.scope_for(user['username'],body.session_id)
                try:
                    postgres_storage.validate_path(body.path)
                    row=postgres_storage.get_file(user['username'],scope,body.path)
                except ValueError as exc: raise HTTPException(422,'Invalid artifact path') from exc
                if not row: raise HTTPException(404,'Artifact not found')
                content=bytes(row['content'])
                if len(content)>c.MAX_FILE: raise HTTPException(413,'Files must be 20 MB or smaller')
                filename=PurePosixPath(body.path).name[:200]
                title=filename
                text=''
            if not title or (body.kind=='text' and not text.strip()): raise HTTPException(422,'Enter a title and content')
            shared={'kind':body.kind,'title':title,'preview':text[:1000],'snapshot':True}
            if body.kind!='artifact': shared['body']=text
            row=db.execute('''INSERT INTO people_chat.bob_chat_messages(room_id,sender,body,filename,content,shared,copy_of_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id''',(room_id,user['username'],text,filename,content,Jsonb(shared),copy_of_id)).fetchone()
            from buddy_people.community_away import enqueue
            enqueue(db,room_id,row['id'],user['username'])
            c.changed(db,room_id)
            return row

    @router.put('/rooms/{room_id}/members',dependencies=write)
    def membership(room_id:int,body:Membership,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            room=db.execute('SELECT * FROM people_chat.bob_chat_rooms WHERE id=%s FOR UPDATE',(room_id,)).fetchone()
            if room['creator']!=user['username'] or room['kind']!='channel': raise HTTPException(403,'Only the channel owner can manage members')
            audience=set(body.usernames)|{room['creator']}
            if room['visibility']=='private' and len(audience)<2: raise HTTPException(422,'Private groups need at least two members')
            registered=db.execute('SELECT username FROM users WHERE username=ANY(%s)',(list(audience),)).fetchall()
            if {r['username'] for r in registered}!=audience: raise HTTPException(422,'Select registered members only')
            db.execute('DELETE FROM people_chat.bob_chat_members WHERE room_id=%s AND NOT(username=ANY(%s))',(room_id,list(audience)))
            db.execute('DELETE FROM people_chat.bob_chat_notification_preferences WHERE room_id=%s AND NOT(username=ANY(%s))',(room_id,list(audience)))
            for who in sorted(audience):
                db.execute('INSERT INTO people_chat.bob_chat_members(room_id,username) VALUES (%s,%s) ON CONFLICT DO NOTHING',(room_id,who))
            c.changed(db,0)
        return {'updated':True}

    @router.post('/rooms/{room_id}/messages/{message_id}/reactions',dependencies=write)
    def react(room_id:int,message_id:int,body:Reaction,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            message_in_room(db,room_id,message_id)
            deleted=db.execute('DELETE FROM people_chat.bob_chat_reactions WHERE message_id=%s AND username=%s AND emoji=%s RETURNING message_id',(message_id,user['username'],body.emoji)).fetchone()
            if not deleted: db.execute('INSERT INTO people_chat.bob_chat_reactions VALUES (%s,%s,%s)',(message_id,user['username'],body.emoji))
            c.changed(db,room_id)
        return {'active':not bool(deleted)}

    @router.post('/rooms/{room_id}/messages/{message_id}/pin',dependencies=write)
    def pin(room_id:int,message_id:int,body:Pin,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            message_in_room(db,room_id,message_id)
            db.execute('UPDATE people_chat.bob_chat_messages SET pinned=%s WHERE room_id=%s AND id=%s',(body.pinned,room_id,message_id))
            c.changed(db,room_id)
        return {'pinned':body.pinned}

    @router.post('/rooms/{room_id}/messages/{message_id}/tasks',dependencies=write)
    def create_task(room_id:int,message_id:int,body:Task,user=Depends(current_user)):
        c.ensure_schema()
        if not body.title.strip(): raise HTTPException(422,'Enter a task title')
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            message_in_room(db,room_id,message_id)
            if not db.execute('SELECT 1 FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s',(room_id,body.assignee)).fetchone(): raise HTTPException(422,'Assign tasks to conversation members')
            row=db.execute('''INSERT INTO people_chat.bob_chat_tasks(room_id,message_id,creator,assignee,title,due_at)
                VALUES (%s,%s,%s,%s,%s,%s) RETURNING *''',(room_id,message_id,user['username'],body.assignee,body.title.strip(),body.due_at)).fetchone()
            c.changed(db,room_id)
            return row

    @router.get('/rooms/{room_id}/tasks')
    def tasks(room_id:int,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'])
            return db.execute('SELECT * FROM people_chat.bob_chat_tasks WHERE room_id=%s ORDER BY id DESC',(room_id,)).fetchall()

    @router.get('/tasks/my')
    def my_tasks(user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            return db.execute('''SELECT t.*,r.name AS room_name FROM people_chat.bob_chat_tasks t JOIN people_chat.bob_chat_rooms r ON r.id=t.room_id
                JOIN people_chat.bob_chat_members m ON m.room_id=t.room_id AND m.username=%s WHERE t.assignee=%s ORDER BY t.id DESC''',(user['username'],user['username'])).fetchall()

    @router.patch('/rooms/{room_id}/tasks/{task_id}',dependencies=write)
    def update_task(room_id:int,task_id:int,body:TaskStatus,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            row=db.execute('''UPDATE people_chat.bob_chat_tasks SET status=%s WHERE room_id=%s AND id=%s
                AND (assignee=%s OR creator=%s) RETURNING *''',(body.status,room_id,task_id,user['username'],user['username'])).fetchone()
            if not row: raise HTTPException(404,'Task not found or not assigned to you')
            c.changed(db,room_id)
            return row

    @router.post('/rooms/{room_id}/messages/{message_id}/save-note',dependencies=write)
    def save_note(room_id:int,message_id:int,body:SaveNote,user=Depends(current_user)):
        c.ensure_schema()
        from app import notes
        notes.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            msg=message_in_room(db,room_id,message_id)
            if not msg['body'].strip(): raise HTTPException(422,'This message has no text to save')
            # Same transaction as access check; attachment grants are not copied.
            row=db.execute('''INSERT INTO bob_notes(username,title,body,color,collection,tags,favorite,sources,community_message_id)
                VALUES (%s,%s,%s,'butter',%s,'[]'::jsonb,false,'[]'::jsonb,%s) RETURNING *''',
                (user['username'],body.title.strip() or 'Saved message',msg['body'],notes.default_collection(),message_id)).fetchone()
            notes.save_version(db,row)
            return notes.serialize(row)

    @router.get('/rooms/{room_id}/files')
    def files(room_id:int,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'])
            return db.execute('''SELECT id,filename,octet_length(content) AS size,shared,created_at
                FROM people_chat.bob_chat_messages WHERE room_id=%s AND filename IS NOT NULL ORDER BY id DESC LIMIT 200''',(room_id,)).fetchall()

    def search_rows(db,username,q,room_id=None):
        return db.execute(f'''SELECT msg.id,msg.room_id,msg.sender,{c.display_name_sql('msg.sender')} AS sender_name,
            msg.body,msg.filename,msg.parent_id,msg.shared,msg.pinned,msg.created_at FROM people_chat.bob_chat_messages msg
            JOIN people_chat.bob_chat_members m ON m.room_id=msg.room_id AND m.username=%s
            LEFT JOIN bob_user_profiles p ON p.username=msg.sender
            WHERE (msg.body ILIKE %s OR msg.filename ILIKE %s) {'AND msg.room_id=%s' if room_id is not None else ''}
            ORDER BY msg.id DESC LIMIT 100''', (username,'%'+q+'%','%'+q+'%')+((room_id,) if room_id is not None else ())).fetchall()

    @router.get('/rooms/{room_id}/search')
    def search_room(room_id:int,q:str=Query(min_length=2,max_length=200),user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'])
            return search_rows(db,user['username'],q,room_id)

    @router.get('/search')
    def search(q:str=Query(min_length=2,max_length=200),user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db: return search_rows(db,user['username'],q)

    @router.get('/rooms/{room_id}/notifications')
    def preferences(room_id:int,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'])
            return db.execute('SELECT mode FROM people_chat.bob_chat_notification_preferences WHERE room_id=%s AND username=%s',(room_id,user['username'])).fetchone() or {'mode':'all'}

    @router.put('/rooms/{room_id}/notifications',dependencies=write)
    def set_preferences(room_id:int,body:Preferences,user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db,room_id,user['username'],True)
            db.execute('''INSERT INTO people_chat.bob_chat_notification_preferences(room_id,username,mode) VALUES (%s,%s,%s)
                ON CONFLICT(room_id,username) DO UPDATE SET mode=excluded.mode''',(room_id,user['username'],body.mode))
            c.changed(db,room_id)
        return {'mode':body.mode}
