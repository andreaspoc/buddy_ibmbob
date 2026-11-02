"""Verify task ownership, terminal states and replacement results against PostgreSQL."""
import json
import uuid
import os
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from app import job_queue, microsoft_auth
from app.auth import current_user
from app.main import app


def main():
    username = 'tasktest-' + uuid.uuid4().hex[:10]
    other = username + '-other'
    own_id, other_id, stopped_id = [str(uuid.uuid4()) for _ in range(3)]
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        for jid, owner, status in [(own_id, username, 'completed'), (other_id, other, 'completed'), (stopped_id, username, 'failed')]:
            db.execute("""INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status)
                VALUES (%s,%s,'test',%s,%s::jsonb,%s)""",
                (jid, owner, jid, json.dumps({'prompt': 'Task title', 'bob_prompt': 'private prompt metadata', 'mode': 'agent'}), status))
        for event in [{'type': 'delta', 'text': 'discarded'}, {'type': 'delta', 'text': 'Replacement', 'replace': True},
                      {'type': 'delta', 'text': ' result'}, {'type': 'done', 'duration_ms': 50}]:
            db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)', (own_id, json.dumps(event)))
        db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)',
                   (stopped_id, json.dumps({'type': 'error', 'message': 'Stopped by you', 'cancelled': True})))
    app.dependency_overrides[current_user] = lambda: {'username': username, 'is_admin': True}
    try:
        with TestClient(app) as client:
            response = client.get('/tasks')
            assert response.status_code == 200, response.text
            assert response.headers['cache-control'] == 'no-store'
            tasks = response.json()
            assert {task['id'] for task in tasks} == {own_id, stopped_id}
            assert 'private prompt metadata' not in response.text
            assert next(task for task in tasks if task['id'] == stopped_id)['status'] == 'stopped'
            assert all(task['terminal_event_id'] for task in tasks)
            assert client.get('/tasks/' + other_id).status_code == 404
            detail = client.get('/tasks/' + own_id)
            assert detail.json()['result'] == 'Replacement result', detail.text
            assert detail.json()['steps'][-1]['message'] == 'Completed'
            assert client.get('/tasks/not-a-uuid').status_code == 422
            with patch.object(microsoft_auth, '_user_token_file', return_value=Path('/tmp/test-ms-token')), \
                 patch.object(microsoft_auth, 'current_user', AsyncMock(return_value={'username': username, 'is_admin': True})), \
                 patch.object(microsoft_auth.storage, 'read_user_file', return_value=json.dumps({'access_token':'never-return', 'scope':'User.Read https://graph.microsoft.com/Sites.Read.All'}).encode()):
                status = client.get('/auth/microsoft/status')
                assert 'never-return' not in status.text
                assert 'Sites.Read.All' in status.json()['scopes']
                assert 'Chat.Read' in status.json()['missing_scopes']
            with patch.object(microsoft_auth, '_get_client_id', return_value='test-client'), \
                 patch.object(microsoft_auth, '_create_state', return_value='test-state'), \
                 patch.object(microsoft_auth, 'current_user', AsyncMock(return_value={'username': username})), \
                 patch.dict(os.environ, {'GRAPH_SCOPES':'User.Read Mail.Read'}):
                response = client.get('/auth/microsoft/login?business=true', follow_redirects=False)
                assert response.status_code == 302
                scopes = parse_qs(urlparse(response.headers['location']).query)['scope'][0].split()
                assert 'Sites.Read.All' in scopes and 'Chat.Read' in scopes and 'Mail.Read' in scopes
        app.dependency_overrides.clear()
        with TestClient(app) as client:
            assert client.get('/tasks').status_code == 401
    finally:
        app.dependency_overrides.clear()
        with job_queue._connect() as db:
            db.execute('DELETE FROM bob_jobs WHERE username IN (%s,%s)', (username, other))
    print('Tasks API ownership, result, notification cursor and Microsoft scope checks passed')

if __name__ == '__main__': main()
