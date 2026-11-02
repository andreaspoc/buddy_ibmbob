"""Exercise actual job lifecycle transactions in an isolated PostgreSQL schema."""
import asyncio
import os
import secrets
import uuid
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from app import job_queue
from app.chat_correlation import request_ids

original = os.environ['DATABASE_URL']
schema = 'delivery_' + secrets.token_hex(6)
with psycopg.connect(original, autocommit=True) as db:
    db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
try:
    scoped = make_conninfo(original, options=f'-c search_path={schema}')
    with patch.dict(os.environ, {'DATABASE_URL': scoped}), patch('app.postgres_storage.ensure_schema'):
        job_queue.ensure_schema()
        with job_queue._connect() as db:
            db.execute('CREATE TABLE bob_conversation_history(id bigserial PRIMARY KEY,username text,session_id text,event jsonb)')
        def submit():
            payload = {**request_ids({}), 'prompt': 'Synthetic lifecycle fixture'}
            return job_queue.enqueue('fixture-owner', 'chat', 'fixture-owner:chat', payload,
                                     request_event={'type': 'request', 'prompt': payload['prompt']})
        job_id = submit()
        token = str(uuid.uuid4())
        claimed = job_queue.claim(token)
        assert str(claimed['id']) == str(job_id)
        async def complete():
            async with job_queue.JobStreamRecorder(job_id, token, 'fixture-owner', 'chat', durable=True, correlation=claimed['payload']) as recorder:
                await recorder.record_event({'type': 'delta', 'text': 'first'})
                await recorder.record_event({'type': 'delta', 'text': ' second'})
                await recorder.finish({'type': 'done'})
        asyncio.run(complete())
        with job_queue._connect() as db:
            events = [row['event'] for row in db.execute('SELECT event FROM bob_job_events WHERE job_id=%s ORDER BY id', (job_id,)).fetchall()]
            states = [event['state'] for event in events if event['type'] == 'delivery_state']
            assert states == ['accepted','queued','running','streaming','completed'], states
            assert events[-1]['type'] == 'done'
            saved = [row['event']['state'] for row in db.execute("SELECT event FROM bob_conversation_history WHERE event->>'job_id'=%s AND event->>'type'='delivery_state' ORDER BY id", (job_id,)).fetchall()]
            assert saved == states
        cancelled = submit()
        job_queue.request_cancel(cancelled, 'fixture-owner')
        failed = submit()
        job_queue.claim(token)
        assert job_queue.finish(failed, token, {'type': 'error', 'message': 'Synthetic failure'})
        with job_queue._connect() as db:
            for job, expected in ((cancelled,'cancelled'),(failed,'failed')):
                row = db.execute("SELECT event FROM bob_job_events WHERE job_id=%s AND event->>'type'='delivery_state' ORDER BY id DESC LIMIT 1", (job,)).fetchone()
                assert row['event']['state'] == expected
    print('PASS: actual accepted/queued/running/first-stream/completed milestones, saved history, queued cancellation and worker failure')
finally:
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
