"""Remove individual chat prose and invalidate retained model transcripts."""
from __future__ import annotations

from app.branding import brand_text
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from app.auth import current_user
from app import job_queue, postgres_storage as storage, sessions

router = APIRouter()


def message_ids(row):
    event = row['event']
    return (event.get('user_message_id') or event.get('message_id') or f"history-{row['id']}-user",
            event.get('assistant_message_id') or f"history-{row['id']}-assistant")


def plan_deletion(rows, message_id):
    """Keep a content-free boundary so either sibling can survive independently."""
    starts = [index for index, row in enumerate(rows) if row['event'].get('type') == 'request']
    for ordinal, start in enumerate(starts):
        row = rows[start]
        user_id, assistant_id = message_ids(row)
        if message_id not in (user_id, assistant_id):
            continue
        role = 'user' if message_id == user_id else 'assistant'
        end = starts[ordinal + 1] if ordinal + 1 < len(starts) else len(rows)
        event = dict(row['event'], user_message_id=user_id, assistant_message_id=assistant_id)
        removals = []
        replacements = {}
        if role == 'user':
            keep = {'type', 'correlation_id', 'user_message_id', 'assistant_message_id', 'message_id',
                    'workspace_id', 'chat_id', 'job_id', 'assistant_deleted'}
            event = {key: value for key, value in event.items() if key in keep}
            event.update(prompt='', user_deleted=True)
            # Tool/activity traces can copy the question verbatim. Keep only the
            # independently retained answer and its content-free completion.
            for item in rows[start + 1:end]:
                if item['event'].get('type') not in {'delta', 'done'}:
                    removals.append(item['id'])
                elif item['event'].get('type') == 'done':
                    replacements[item['id']] = {'type': 'done'}
        else:
            event['assistant_deleted'] = True
            removals = [item['id'] for item in rows[start + 1:end]]
        replacements[row['id']] = event
        return row['id'], role, replacements, removals
    raise HTTPException(404, 'Message not found')


def _optional_delete(db, table, query, params):
    if db.execute('SELECT to_regclass(%s) AS name', (table,)).fetchone()['name']:
        db.execute(query, params)


def delete_message(username, session_id, message_id):
    try:
        sessions.get_session(session_id, username)
        scope = sessions.storage_scope(session_id, username)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, 'Conversation not found') from exc
    storage.ensure_schema()
    with job_queue._connect() as db:
        # Same order as enqueue, so no old worker can restore a deleted turn.
        storage._lock(db, username, 'user')
        storage._lock(db, username, scope)
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'conversation:{username}:{session_id}',))
        if db.execute('SELECT 1 FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s', (username, session_id)).fetchone():
            raise HTTPException(404, 'Conversation not found')
        if db.execute("SELECT 1 FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running')", (f'{username}:{scope}',)).fetchone():
            raise HTTPException(409, brand_text('Wait for Buddy to finish before deleting a message'))
        rows = db.execute('SELECT id,event FROM bob_conversation_history WHERE username=%s AND session_id=%s ORDER BY id', (username, session_id)).fetchall()
        request_id, role, replacements, removals = plan_deletion(rows, message_id)
        request = next(row['event'] for row in rows if row['id'] == request_id)
        task_ids = {row['event']['session_id'] for row in rows if row['event'].get('session_id') and row['event'].get('type') in {'done', 'error'}}
        # Entire native transcripts contain earlier turns. Rebuild from surviving
        # chat prose rather than attempting to edit opaque model session formats.
        storage.delete_scope(username, 'home:' + session_id, db)
        from app.conversation_delete import _delete_bob_tasks, _delete_bob_shell_logs
        unique_prompts = job_queue.session_unique_bob_prompts(username, session_id)
        with storage.temporary_tree(username, 'user') as root:
            database = root / '.home/.bob/db/bob.db'
            if database.is_file():
                _delete_bob_tasks(database, task_ids, None, unique_prompts)
                storage._upsert(db, username, 'user', '.home/.bob/db/bob.db', database.read_bytes())
            # Historical logs may quote any previous turn in this conversation.
            for path in (root / '.home/.bob/logs').rglob('*'):
                if path.is_file() and ('/sessions/' + session_id).encode() in path.read_bytes():
                    db.execute("DELETE FROM bob_storage_files WHERE username=%s AND scope='user' AND path=%s", (username, path.relative_to(root).as_posix()))
            db.execute("DELETE FROM bob_storage_files WHERE username=%s AND scope='user' AND path IN ('.home/.bob/db/bob.db-wal','.home/.bob/db/bob.db-shm')", (username,))
        for identifier, event in replacements.items():
            db.execute('UPDATE bob_conversation_history SET event=%s::jsonb WHERE username=%s AND session_id=%s AND id=%s', (json.dumps(event), username, session_id, identifier))
        if removals:
            db.execute('DELETE FROM bob_conversation_history WHERE username=%s AND session_id=%s AND id=ANY(%s)', (username, session_id, removals))
        # A retained answer must not refer the next turn to an old native session.
        db.execute("UPDATE bob_conversation_history SET event=event-'session_id'-'agent_context_id' WHERE username=%s AND session_id=%s", (username, session_id))
        job_id = request.get('job_id')
        # Legacy events may lack job IDs; message IDs and correlation IDs still
        # resolve the originating job without touching other conversations.
        db.execute("""DELETE FROM bob_jobs WHERE username=%s AND workspace_id=%s AND
            (id::text=%s OR payload->>'user_message_id'=%s OR payload->>'assistant_message_id'=%s
             OR (%s::text IS NOT NULL AND payload->>'correlation_id'=%s))""",
                   (username, session_id, str(job_id) if job_id else '', *message_ids({'id': request_id, 'event': request}), request.get('correlation_id'), request.get('correlation_id')))
        # Legacy jobs with no routing IDs cannot be reliably attributed. Their
        # opaque traces are disposable; the remaining visible chat is retained.
        db.execute("DELETE FROM bob_jobs WHERE username=%s AND workspace_id=%s AND NOT(payload ? 'user_message_id')", (username, session_id))
        _optional_delete(db, 'bob_answer_feedback', 'DELETE FROM bob_answer_feedback WHERE username=%s AND session_id=%s AND request_history_id=%s', (username, session_id, request_id))
        _optional_delete(db, 'bob_conversation_shares', 'DELETE FROM bob_conversation_shares WHERE username=%s AND session_id=%s', (username, session_id))
        _optional_delete(db, 'bob_interactive_widgets', 'DELETE FROM bob_interactive_widgets WHERE username=%s AND session_id=%s', (username, session_id))
        # Titles can be derived from the deleted question. Reset to surviving
        # user prose so the removed text also disappears from lists and search.
        remaining = [replacements.get(row['id'], row['event']) for row in rows if row['id'] not in removals]
        from app.conversation_titles import conversation_title
        title = next((value for event in remaining if event.get('type') == 'request' and not event.get('user_deleted')
                      and (value := conversation_title(event.get('prompt', '')))), 'New conversation')
        db.execute("""UPDATE bob_conversations SET record=record || jsonb_build_object(
            'title',%s::text,'updated',%s::text,'history_revision',COALESCE((record->>'history_revision')::integer,0)+1)
            WHERE username=%s AND id=%s""", (title, datetime.now(timezone.utc).isoformat(), username, session_id))
    # Migrated installations can retain source journals and task databases on
    # disk. They are not active history, but must not retain the removed prose.
    legacy_root = sessions._root() / 'users' / username
    legacy_chat = legacy_root if session_id == 'legacy' else legacy_root / 'sessions' / session_id
    if (legacy_chat / '.history.jsonl').is_file():
        clean = sessions.read_history(session_id, username)
        (legacy_chat / '.history.jsonl').write_text(''.join(json.dumps(event, ensure_ascii=False) + '\n' for event in clean))
    if (legacy_chat / '.conversation.json').is_file():
        (legacy_chat / '.conversation.json').write_text(json.dumps(sessions.get_session(session_id, username)))
    for directory in (legacy_root / '.home/.bob', legacy_chat / '.home/.bob'):
        _delete_bob_tasks(directory / 'db/bob.db', task_ids, None, unique_prompts)
        _delete_bob_shell_logs(directory / 'logs', legacy_chat)
    from app.blob_storage import purge_message_caches
    pending = purge_message_caches(username, session_id)
    return {'deleted': True, 'message_id': message_id, 'role': role, 'cleanup_pending': pending}


@router.delete('/sessions/{session_id}/messages/{message_id}')
def remove_message(session_id: str, message_id: str, user=Depends(current_user)):
    return delete_message(user['username'], session_id, message_id)
