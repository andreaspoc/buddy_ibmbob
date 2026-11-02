"""Fork completed conversation turns without reusing native task state."""
import json
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from app.auth import current_user
from app import sessions, job_queue, postgres_storage as storage

router = APIRouter()

class BranchRequest(BaseModel):
    turn_index: int = Field(ge=0)

def selected_history(history, turn_index):
    starts = [i for i, event in enumerate(history) if event.get('type') == 'request']
    if turn_index >= len(starts):
        raise HTTPException(422, 'Message is not present in saved history')
    end = starts[turn_index + 1] if turn_index + 1 < len(starts) else len(history)
    turn = history[starts[turn_index]:end]
    terminal = next((i for i, event in enumerate(turn) if event.get('type') in {'done', 'error'}), None)
    if terminal is None:
        raise HTTPException(409, 'Wait for this reply to finish before branching')
    # Native session IDs and pending permissions must never be reused by a fork.
    result = []
    for event in history[:starts[turn_index] + terminal + 1]:
        if event.get('type') in {'approval', 'guidance', 'approval_policy', 'start'}:
            continue
        clean = {key: value for key, value in event.items() if key not in {'session_id', 'job_id', 'request_id', 'agent_context_id'}}
        result.append(clean)
    return result

def branch_conversation(username, session_id, turn_index):
    try:
        record = sessions.get_session(session_id, username)
        scope = sessions.storage_scope(session_id, username)
        with storage.mutation(username, scope, session_id, user_lock=True) as db:
            db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'conversation:{username}:{session_id}',))
            history = [row['event'] for row in db.execute('SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s ORDER BY id', (username, session_id)).fetchall()]
            events = selected_history(history, turn_index)
            fork = {'id': uuid.uuid4().hex, 'title': ('Branch: ' + record.get('title', 'Conversation'))[:100],
                    'updated': datetime.now(timezone.utc).isoformat(), 'branched_from': session_id, 'branched_turn': turn_index}
            if record.get('project_id'):
                fork['project_id'] = record['project_id']
            db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb)', (username, fork['id'], json.dumps(fork)))
            for event in events:
                db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)', (username, fork['id'], json.dumps(event)))
            if not record.get('project_id'):
                # Copy the current attachment snapshot, not native session caches.
                rows = db.execute('SELECT path,content,sha256,mode,modified,object_key,object_bucket,size,search_text FROM bob_storage_files WHERE username=%s AND scope=%s', (username, scope)).fetchall()
                for row in rows:
                    if any(part.startswith('.') for part in row['path'].split('/')):
                        continue
                    db.execute('INSERT INTO bob_storage_files(username,scope,path,content,sha256,mode,modified,object_key,object_bucket,size,search_text) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                               (username, 'session:' + fork['id'], row['path'], row['content'], row['sha256'], row['mode'], row['modified'], row['object_key'], row['object_bucket'], row['size'], row['search_text']))
        return fork
    except FileNotFoundError as exc:
        raise HTTPException(404, 'Conversation not found') from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post('/sessions/{session_id}/branch', status_code=201)
def branch(session_id: str, request: BranchRequest, user=Depends(current_user)):
    return branch_conversation(user['username'], session_id, request.turn_index)
