"""WebSocket push with real PostgreSQL notifications and isolated synthetic data."""
import json
import os
import secrets
import uuid
from unittest.mock import AsyncMock, patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from app.main import app

original = os.environ['DATABASE_URL']
schema = 'artifact_socket_' + secrets.token_hex(6)
job_id = str(uuid.uuid4())
correlation = {'correlation_id': str(uuid.uuid4()), 'user_message_id': str(uuid.uuid4()), 'assistant_message_id': str(uuid.uuid4())}
with psycopg.connect(original, autocommit=True) as db:
    db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
try:
    scoped = make_conninfo(original, options=f'-c search_path={schema}')
    with psycopg.connect(scoped, autocommit=True) as db:
        db.execute('CREATE TABLE bob_jobs (id uuid PRIMARY KEY, status text)')
        db.execute('CREATE TABLE bob_job_events (id bigserial PRIMARY KEY, job_id uuid, event jsonb)')
        db.execute("INSERT INTO bob_jobs VALUES (%s,'running')", (job_id,))
        with patch.dict(os.environ, {'DATABASE_URL': scoped}), patch('app.main.current_user', AsyncMock(return_value={'username': 'synthetic-owner'})), patch('app.main.job_queue.get_job', return_value={'status': 'running', 'workspace_id': 'fixture-chat', 'payload': correlation}), TestClient(app) as client:
            url = f'/jobs/{job_id}/artifacts/ws'
            with client.websocket_connect(url, headers={'origin': 'http://testserver'}) as ws:
                content = '<h1>Synthetic large artifact</h1>' + 'x' * 20000
                event = {'type': 'artifact', 'path': 'fixture.html', 'kind': 'html', 'content': content, 'sha256': 'fixture', 'live': True}
                db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)', (job_id, json.dumps(event)))
                # Delivery must recover even if this commit has no notification.
                received = ws.receive_json()
                assert received['content'] == content
                assert received['event_id'] > 0
                assert received['correlation_id'] == correlation['correlation_id']
                assert received['message_id'] == correlation['assistant_message_id']
                assert received['chat_id'] == 'fixture-chat'
                assert received['job_id'] == job_id
                first_id = received['event_id']
                updated = {**event, 'content': '<h1>Synthetic updated artifact</h1>'}
                db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)', (job_id, json.dumps(updated)))
                db.execute("SELECT pg_notify('bob_job_events',%s)", (job_id,))
                assert ws.receive_json()['content'] == updated['content']
                db.execute("UPDATE bob_jobs SET status='completed' WHERE id=%s", (job_id,))
                db.execute("SELECT pg_notify('bob_job_events',%s)", (job_id,))
                assert ws.receive_json()['type'] == 'complete'
            # Reconnecting replays the full saved snapshot, even after completion.
            with client.websocket_connect(url) as ws:
                assert ws.receive_json()['content'] == content
                assert ws.receive_json()['content'] == updated['content']
                assert ws.receive_json()['type'] == 'complete'
            with client.websocket_connect(url + f'?after_id={first_id}') as ws:
                assert ws.receive_json()['content'] == updated['content']
                assert ws.receive_json()['type'] == 'complete'
            for mocks, headers in [
                (patch('app.main.current_user', AsyncMock(side_effect=HTTPException(401))), {}),
                (patch('app.main.job_queue.get_job', return_value=None), {}),
                (patch('app.main.job_queue.get_job', return_value={'status': 'running'}), {'origin': 'https://untrusted.example'}),
            ]:
                with mocks:
                    try:
                        with client.websocket_connect(url, headers=headers):
                            raise AssertionError('Unauthorized socket accepted')
                    except WebSocketDisconnect as error:
                        assert error.code == 1008
    print('PASS: full large snapshot push, completion, replay, authentication, ownership and origin checks')
finally:
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
