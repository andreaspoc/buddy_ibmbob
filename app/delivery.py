"""Server-observed delivery milestones, stored in the same job transaction."""
from datetime import datetime, timezone
import json

STATES = {'accepted', 'queued', 'running', 'streaming', 'saving', 'completed', 'failed', 'cancelled'}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def delivery_event(state, metadata, at=None):
    if state not in STATES:
        raise ValueError('Unknown delivery state')
    from app.chat_correlation import turn_metadata
    return {**turn_metadata(metadata, metadata.get('workspace_id'), metadata.get('job_id')),
            'type': 'delivery_state', 'state': state, 'timestamp': at or timestamp()}


def terminal_state(event):
    return 'cancelled' if event.get('cancelled') else 'completed' if event.get('type') == 'done' else 'failed'


def persist_delivery(db, job_id, username, workspace_id, event):
    encoded = json.dumps(event, ensure_ascii=False)
    db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)', (str(job_id), encoded))
    db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',
               (username, workspace_id, encoded))
    db.execute('SELECT pg_notify(%s,%s)', ('bob_job_' + str(job_id).replace('-', ''), encoded))
    db.execute("SELECT pg_notify('bob_job_events',%s)", (str(job_id),))
