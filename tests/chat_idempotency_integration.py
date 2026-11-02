"""Atomic retry protection against isolated PostgreSQL tables."""
import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from app import job_queue
from app.chat_correlation import request_ids
from app.chat_submission import fingerprint

original = os.environ['DATABASE_URL']
schema = 'chat_idempotency_' + secrets.token_hex(6)
with psycopg.connect(original, autocommit=True) as db:
    db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
try:
    scoped = make_conninfo(original, options=f'-c search_path={schema}')
    with patch.dict(os.environ, {'DATABASE_URL': scoped}):
        job_queue.ensure_schema()
        with job_queue._connect() as db:
            db.execute('CREATE TABLE bob_conversation_history(id bigserial PRIMARY KEY,username text,session_id text,event jsonb)')
            db.execute('CREATE TABLE bob_conversations(username text NOT NULL,id text NOT NULL,record jsonb NOT NULL,PRIMARY KEY(username,id))')
        request_hash = fingerprint({'prompt': 'fixture request'})
        def submit(index):
            payload = {**request_ids({}), 'prompt': 'fixture request'}
            return job_queue.enqueue('fixture-owner', 'chat', 'fixture-owner:chat', payload,
                                     idempotency_key='same-key', request_hash=request_hash,
                                     request_event={'type': 'request', 'prompt': payload['prompt']})
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(8)))
        assert len(set(results)) == 1
        assert sum(not result.reused for result in results) == 1
        assert len({result.payload['assistant_message_id'] for result in results}) == 1
        job_id = str(results[0])
        with job_queue._connect() as db:
            assert db.execute('SELECT count(*) AS n FROM bob_jobs').fetchone()['n'] == 1
            history = db.execute('SELECT event FROM bob_conversation_history ORDER BY id').fetchall()
            assert [row['event']['type'] for row in history] == ['request', 'delivery_state', 'delivery_state']
            assert [row['event'].get('state') for row in history[1:]] == ['accepted', 'queued']
            for row in history[1:]:
                assert datetime.fromisoformat(row['event']['timestamp']).utcoffset().total_seconds() == 0
            db.execute("UPDATE bob_jobs SET status='completed' WHERE id=%s", (job_id,))
        replay = submit(99)
        assert str(replay) == job_id and replay.reused
        try:
            job_queue.enqueue('fixture-owner', 'chat', 'fixture-owner:chat', {'prompt': 'changed'},
                              idempotency_key='same-key', request_hash=fingerprint({'prompt': 'changed'}))
            raise AssertionError('Conflicting retry accepted')
        except ValueError:
            pass
        assert job_queue.find_submission('other-owner', 'chat', 'same-key', request_hash) is None
        assert job_queue.find_submission('fixture-owner', 'other-chat', 'same-key', request_hash) is None
    print('PASS: eight concurrent retries create one job/history, canonical IDs, completed replay, conflict rejection, scoped keys, UTC lifecycle')
finally:
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
