"""Owner-scoped guidance for one durable, resumable chat response."""
from __future__ import annotations

from app import job_queue


def supported(payload):
    return not payload.get('agent_name') and all(payload.get(key) is None for key in ('workflow', 'research')) and payload.get('mode') != 'presentation'


def submit(job_id, username, instruction):
    instruction = instruction.strip()
    if not instruction or len(instruction) > 4000:
        raise ValueError('Guidance must contain 1–4000 characters')
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        job = db.execute('SELECT * FROM bob_jobs WHERE id=%s AND username=%s FOR UPDATE', (job_id, username)).fetchone()
        if not job:
            return None
        if not supported(job['payload']):
            raise ValueError('Guidance is available for local chat responses only')
        if job['status'] not in ('queued', 'running') or job['payload'].get('cancel_requested') or job['payload'].get('guidance_closed'):
            raise ValueError('This response is finishing or has stopped. Send your instruction as the next chat message.')
        if db.execute('SELECT count(*) AS count FROM bob_job_guidance WHERE job_id=%s', (job_id,)).fetchone()['count'] >= 20:
            raise ValueError('This response has reached its 20-instruction limit')
        row = db.execute('INSERT INTO bob_job_guidance(job_id,instruction) VALUES(%s,%s) RETURNING id', (job_id, instruction)).fetchone()
        event = {'type': 'guidance', 'id': row['id'], 'text': instruction, 'status': 'queued'}
        encoded = job_queue._dumps_jsonb(event)
        db.execute('INSERT INTO bob_job_events(job_id,event) VALUES(%s,%s::jsonb)', (job_id, encoded))
        db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES(%s,%s,%s::jsonb)', (username, job['workspace_id'], encoded))
        db.execute("SELECT pg_notify('bob_job_events',%s)", (str(job_id),))
        return event


def instructions(job_id, *, pending=False):
    with job_queue._connect() as db:
        return db.execute('SELECT id,instruction,applied FROM bob_job_guidance WHERE job_id=%s' +
                          (' AND NOT applied' if pending else '') + ' ORDER BY id', (job_id,)).fetchall()


def open_intake(job_id, token):
    with job_queue._connect() as db:
        db.execute("UPDATE bob_jobs SET payload=payload - 'guidance_closed' WHERE id=%s AND worker_token=%s AND status='running'", (job_id, token))


def applied(job_id, token, ids):
    with job_queue._connect() as db:
        if not db.execute("SELECT 1 FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE", (job_id, token)).fetchone():
            raise RuntimeError('Worker lost its lease while applying guidance')
        db.execute('UPDATE bob_job_guidance SET applied=true WHERE job_id=%s AND id=ANY(%s)', (job_id, ids))


def close_if_ready(job_id, token):
    """Serialize terminal delivery with new notes; accepted notes cannot be lost."""
    with job_queue._connect() as db:
        if not db.execute("SELECT 1 FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE", (job_id, token)).fetchone():
            raise RuntimeError('Worker lost its lease before completion')
        if db.execute('SELECT 1 FROM bob_job_guidance WHERE job_id=%s AND NOT applied LIMIT 1', (job_id,)).fetchone():
            return False
        db.execute("UPDATE bob_jobs SET payload=payload || '{\"guidance_closed\":true}'::jsonb WHERE id=%s", (job_id,))
        return True
