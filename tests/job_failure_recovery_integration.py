"""Expired agent jobs fail without replay; stale workers cannot publish.

Uses a disposable PostgreSQL schema, never claims live jobs.
"""
import os
import uuid
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from app import job_queue, postgres_storage


def main():
    original = os.environ['DATABASE_URL']
    schema = 'recovery_test_' + uuid.uuid4().hex
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options='-c search_path=' + schema)}):
            postgres_storage.ensure_schema()
            job_queue.ensure_schema()
            assert job_queue.MAX_ATTEMPTS == 1
            job_id, token = str(uuid.uuid4()), str(uuid.uuid4())
            with job_queue._connect() as db:
                db.execute("""INSERT INTO bob_jobs
                    (id,username,workspace_id,workspace_key,payload,status,attempts,max_attempts,worker_token,lease_until)
                    VALUES (%s,'owner','test','owner:test','{}','running',1,%s,%s,now()-interval '1 second')""",
                    (job_id, job_queue.MAX_ATTEMPTS, token))
            job_queue.requeue_expired()
            assert job_queue.get_job(job_id, 'owner')['status'] == 'failed'
            assert job_queue.get_job(job_id, 'other') is None
            assert job_queue.claim(str(uuid.uuid4())) is None
            assert not job_queue.heartbeat(job_id, token)
            assert not job_queue.append_event(job_id, token, {'type': 'delta', 'text': 'late'})
            events, state = job_queue.events_after(job_id, 0)
            assert state == 'failed'
            assert events[-1]['event']['type'] == 'error'
            assert 'Review external actions' in events[-1]['event']['message']
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
    print('Expired job no-replay, account ownership and stale-worker fencing checks passed')


if __name__ == '__main__':
    main()
