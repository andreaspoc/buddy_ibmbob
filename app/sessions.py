"""Conversation metadata and history in PostgreSQL; tool workspaces are temporary."""
from __future__ import annotations
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from app.conversation_titles import conversation_title
from app import job_queue, postgres_storage as storage

_VALID_ID = re.compile(r'^(legacy|[a-f0-9]{32})$')
_VALID_USER = re.compile(r'^[a-z][a-z0-9-]{0,63}$')


def _root():
    return Path(os.getenv('BOB_WORKSPACE','/workspace')).resolve()


def user_root(user_id: str, create: bool=False):
    if not _VALID_USER.fullmatch(user_id): raise ValueError('Invalid user ID')
    if create: storage.seed_user(user_id)
    # A path descriptor does not create a persistent cache.
    return storage.runtime_root()/'users'/user_id


def get_session(session_id,user_id):
    if not _VALID_ID.fullmatch(session_id): raise ValueError('Invalid conversation ID')
    user_root(user_id)
    if session_id == 'legacy': return {'id':'legacy','title':'Legacy workspace','updated':''}
    storage.ensure_schema()
    with job_queue._connect() as db:
        row=db.execute('SELECT record FROM bob_conversations WHERE username=%s AND id=%s',(user_id,session_id)).fetchone()
        deleted=db.execute('SELECT 1 FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s',(user_id,session_id)).fetchone()
    if not row or deleted: raise FileNotFoundError('Conversation not found')
    return row['record']


def session_storage(session_id,user_id,create=False):
    get_session(session_id,user_id)
    root=user_root(user_id)
    return root/'legacy' if session_id=='legacy' else root/'sessions'/session_id


def storage_scope(session_id,user_id):
    record=get_session(session_id,user_id)
    if record.get('project_id'):
        from app.projects import project_root
        project_root(user_id,record['project_id'])
        return 'project:'+record['project_id']
    return 'session:'+session_id


def workspace_key(session_id,user_id):
    return f'{user_id}:{storage_scope(session_id,user_id)}'


def workspace_for(session_id,user_id,create=False):
    record=get_session(session_id,user_id)
    if record.get('project_id'):
        from app.projects import project_root
        return project_root(user_id,record['project_id'])
    return session_storage(session_id,user_id)


def create_session(user_id,project_id=None, *, purpose='conversation'):
    if purpose not in ('conversation', 'note_enrichment'):
        raise ValueError('Invalid workspace purpose')
    user_root(user_id)
    if project_id:
        from app.projects import project_root
        project_root(user_id,project_id)
    record={'id':uuid.uuid4().hex,'title':'New conversation','updated':datetime.now(timezone.utc).isoformat()}
    if project_id: record['project_id']=project_id
    if purpose == 'note_enrichment': record['purpose']=purpose
    storage.ensure_schema()
    with job_queue._connect() as db:
        db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb)',(user_id,record['id'],json.dumps(record)))
    return record


def touch_session(session_id,user_id,title=None):
    if session_id=='legacy': return
    get_session(session_id,user_id)
    title = conversation_title(title) if title else None
    with job_queue._connect() as db:
        db.execute('''UPDATE bob_conversations SET record=record || jsonb_build_object('updated',%s::text)
            || CASE WHEN (record->>'title'='New conversation' OR record->>'title'='Greetings') AND %s::text IS NOT NULL
            THEN jsonb_build_object('title',%s::text) ELSE '{}'::jsonb END WHERE username=%s AND id=%s''',
            (datetime.now(timezone.utc).isoformat(),title,title[:60] if title else None,user_id,session_id))


_ALL_PROJECTS = object()


def mark_note_enrichment_sessions(user_id):
    """Mark older editor revisions, preserving every conversation and history row.

    Only the first request's exact editor prefix plus its JSON marker qualifies.
    The owner predicate and null-purpose guard keep the operation narrowly scoped
    and idempotent; regular chats quoting these instructions later are unaffected.
    """
    storage.ensure_schema()
    prefix = "Revise this sticky note according to the user's instruction."
    with job_queue._connect() as db:
        db.execute('''UPDATE bob_conversations c
            SET record=record || '{"purpose":"note_enrichment"}'::jsonb
            WHERE c.username=%s AND c.record->>'purpose' IS NULL
            AND EXISTS (
                SELECT 1 FROM (
                    SELECT h.event->>'prompt' AS prompt FROM bob_conversation_history h
                    WHERE h.username=c.username AND h.session_id=c.id AND h.event->>'type'='request'
                    ORDER BY h.id LIMIT 1
                ) first_request
                WHERE left(first_request.prompt,length(%s))=%s
                AND strpos(first_request.prompt,'SOURCE NOTE (JSON):')>0
            )''', (user_id, prefix, prefix))


def list_sessions(user_id, project_id=_ALL_PROJECTS):
    user_root(user_id)
    storage.ensure_schema()
    mark_note_enrichment_sessions(user_id)
    query = """SELECT c.record,
        CASE WHEN c.record->>'title' IS NULL OR c.record->>'title' IN ('New conversation', 'Greetings')
             THEN requests.prompts ELSE NULL END AS prompts
        FROM bob_conversations c
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(event->>'prompt' ORDER BY id) AS prompts FROM (
                SELECT id,event FROM bob_conversation_history
                WHERE username=c.username AND session_id=c.id AND (event->>'type')='request'
                ORDER BY id LIMIT 20
            ) first_requests
        ) requests ON (c.record->>'title' IS NULL OR c.record->>'title' IN ('New conversation', 'Greetings'))
        WHERE c.username=%s AND COALESCE(c.record->>'purpose','conversation') <> 'note_enrichment' """
    params: list[Any] = [user_id]
    if project_id is not _ALL_PROJECTS:
        if project_id is None:
            query += "AND (c.record->>'project_id' IS NULL) "
        else:
            query += "AND (c.record->>'project_id' = %s) "
            params.append(project_id)
    query += "ORDER BY c.record->>'updated' DESC"

    with job_queue._connect() as db:
        rows=db.execute(query, tuple(params)).fetchall()
        legacy = False
        if project_id is _ALL_PROJECTS or project_id is None:
            legacy=db.execute("SELECT 1 FROM bob_storage_files WHERE username=%s AND scope='session:legacy' LIMIT 1",(user_id,)).fetchone()
    found=[]
    for row in rows:
        record = dict(row['record'])
        if record.get('title') in (None, 'New conversation', 'Greetings'):
            # Existing chats receive the same compact names without rewriting history.
            title = next((title for prompt in (row['prompts'] or []) if (title := conversation_title(prompt))), None)
            record['title'] = title or ('Greetings' if row['prompts'] else record.get('title', 'New conversation'))
        found.append(record)
    if legacy: found.append(get_session('legacy',user_id))
    return found


def append_history(session_id,user_id,event: dict[str,Any]):
    get_session(session_id,user_id)
    with job_queue.session_guard(user_id,session_id), job_queue._connect() as db:
        db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',(user_id,session_id,json.dumps(event,ensure_ascii=False)))


def read_history(session_id,user_id):
    get_session(session_id,user_id)
    with job_queue._connect() as db:
        rows = db.execute('SELECT id,event FROM bob_conversation_history WHERE username=%s AND session_id=%s ORDER BY id',(user_id,session_id)).fetchall()
    from app.message_deletion import message_ids
    events = []
    for row in rows:
        event = dict(row['event'])
        if event.get('type') == 'request':
            event['user_message_id'], event['assistant_message_id'] = message_ids(row)
        events.append(event)
    from app.task_usage import recover_usage
    terminal = [event for event in events if event.get('type') in {'done', 'error'}]
    recovered = iter(recover_usage(user_id, session_id, terminal))
    return [next(recovered) if event.get('type') in {'done', 'error'} else event for event in events]
