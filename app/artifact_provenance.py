"""Attribute exact artifact bytes using owned, durable events; never infer tool authorship."""
from app import job_queue

FIELDS = ('correlation_id', 'user_message_id', 'assistant_message_id', 'tool_call_id')


def generated_provenance(username, workspace_id, path, sha256, db=None):
    def lookup(connection):
        row = connection.execute("""SELECT e.event,e.created_at,e.id,j.id AS job_id FROM bob_job_events e
            JOIN bob_jobs j ON j.id=e.job_id
            WHERE j.username=%s AND j.workspace_id=%s AND e.event->>'type'='artifact'
            AND e.event->>'path'=%s AND e.event->>'sha256'=%s
            ORDER BY e.id DESC LIMIT 1""", (username, workspace_id, path, sha256)).fetchone()
        if not row:
            return None
        event = row['event']
        return {'origin': 'generated', 'workspace_id': workspace_id, 'chat_id': workspace_id,
                'path': path, 'sha256': sha256, 'job_id': str(row['job_id']),
                'event_id': row['id'], 'created_at': row['created_at'].isoformat(),
                **{key: event[key] for key in FIELDS if event.get(key)}}
    if db is not None:
        return lookup(db)
    with job_queue._connect() as connection:
        return lookup(connection)
