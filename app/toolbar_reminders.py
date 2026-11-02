"""Private, persistent visual reminders created by authenticated chat tools."""
from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Literal
from threading import Lock
from app import job_queue

_schema_lock = Lock()
_schema_ready = False

class CreateReminder(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=160)
    color: Literal['butter', 'rose', 'mint', 'sky', 'lavender'] = 'butter'
    reminder_index: int = Field(default=0, ge=0, le=11)

    @field_validator('title')
    @classmethod
    def clean_title(cls, value):
        if not value.strip(): raise ValueError('Enter a reminder title')
        return value.strip()

def ensure_schema():
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        with job_queue._connect() as db:
            db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_toolbar_reminders_schema'))")
            db.execute('''CREATE TABLE IF NOT EXISTS bob_toolbar_reminders (
                id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL,
                color TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
                reminder_index INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(username,session_id,message_id,reminder_index))''')
        _schema_ready = True

def create(username, args, context):
    if context.get('username') != username or not context.get('workspace_id') or not context.get('assistant_message_id'):
        raise PermissionError('Saving requires an active authenticated chat turn')
    from app import sessions
    sessions.get_session(context['workspace_id'], username)
    ensure_schema()
    with job_queue._connect() as db:
        row = db.execute('''INSERT INTO bob_toolbar_reminders(username,title,color,session_id,message_id,reminder_index)
            VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT (username,session_id,message_id,reminder_index)
            DO UPDATE SET title=bob_toolbar_reminders.title RETURNING *''',
            (username,args.title,args.color,context['workspace_id'],context['assistant_message_id'],args.reminder_index)).fetchone()
    if row['title'] != args.title or row['color'] != args.color:
        raise ValueError('This reminder index already contains a different reminder. Use another index for a new reminder.')
    return {'id':row['id'],'title':row['title'],'color':row['color'],'saved':True,'pinned':True}

def notifications(db, username):
    return db.execute('''SELECT 'reminder:' || n.id::text AS id,'reminder' AS kind,'pinned' AS status,
        n.title,n.color,n.created_at AS occurred_at,NULL::text AS job_id,
        n.session_id,NULL::bigint AS room_id,r.read_at
        FROM bob_toolbar_reminders n LEFT JOIN bob_notification_reads r
        ON r.username=%s AND r.notification_id='reminder:' || n.id::text
        WHERE n.username=%s ORDER BY n.created_at DESC''',(username,username)).fetchall()


def explicit_reminder_title(payload):
    """Handle a standalone reminder command without relying on model tool choice.

    Requests needing context, research, or another deliverable stay with the agent.
    Only the user's own top-level prompt is considered, never retrieved content.
    """
    import re
    if any(payload.get(key) for key in ('research','workflow','agent_name','edit_artifact_path','template_studio','html_artifact_output_path')) or payload.get('mode') == 'presentation':
        return None
    prompt = payload.get('prompt', '').strip()
    match = re.match(r"(?:hey\s+)?(?:(?:bob|buddy)[,!:]?\s+)?(?:please\s+)?(?:remind\s+me\s+(?:to|about|of)|(?:make|create|add|pin|set)\s+(?:me\s+)?(?:a\s+)?reminder)", prompt, re.IGNORECASE)
    if not match:
        return None
    remainder = prompt[match.end():]
    reminder = match[0].lower().endswith('reminder')
    candidates = [remainder]
    if reminder:
        preposition = re.match(r'\s+(?:to|about|for)', remainder, re.I)
        if preposition:
            candidates.insert(0, remainder[preposition.end():])
    title = None
    for candidate in candidates:
        start = 0
        while start < len(candidate) and (candidate[start].isspace() if reminder else candidate[start] in ' \t'):
            start += 1
        if reminder and start < len(candidate) and candidate[start] == ':':
            after_colon = start + 1
            while after_colon < len(candidate) and candidate[after_colon] in ' \t':
                after_colon += 1
            if after_colon > start + 1 and after_colon < len(candidate) and '\n' not in candidate[after_colon:]:
                title = candidate[after_colon:]
                break
        if start > 0 and candidate[start - 1] in ' \t' and start < len(candidate) and '\n' not in candidate[start:]:
            title = candidate[start:]
            break
    if title is None:
        return None
    title = title.strip().rstrip('.').strip()
    if not title or len(title) > 160 or re.fullmatch(r'(?:this|that|it|the above|what we discussed)', title, re.IGNORECASE):
        return None
    if re.search(r'\b(?:and also|then (?:search|research|create)|also (?:search|research|create))\b', title, re.IGNORECASE):
        return None
    return title[0].upper() + title[1:]


async def handle_direct_request(job, recorder, context):
    title = explicit_reminder_title(job['payload'])
    if not title:
        return False
    if not await recorder.record_event({'type':'start'}):
        return True
    import asyncio
    saved = await asyncio.to_thread(create, job['username'], CreateReminder(title=title), context)
    await recorder.record_event({'type':'app_action','action':'reminders_changed','reminder_id':saved['id']})
    await recorder.record_event({'type':'delta','text':f'Pinned your reminder beside Notifications: **{saved["title"]}**. It stays there until you remove it.'})
    await recorder.finish({'type':'done'})
    return True
