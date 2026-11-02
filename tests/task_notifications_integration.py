"""Verify owner-scoped notification kinds against disposable PostgreSQL records."""
import json
import uuid
from fastapi.testclient import TestClient
from app import job_queue
from app.auth import current_user
from app.main import app


def main():
    username = 'notice-test-' + uuid.uuid4().hex[:10]
    ids = {kind: str(uuid.uuid4()) for kind in ('chat', 'research', 'workflow')}
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        for kind, job_id in ids.items():
            payload = {'prompt': 'Notification classification', 'mode': 'agent'}
            if kind != 'chat':
                payload[kind] = {}
            db.execute('''INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status)
                VALUES(%s,%s,'test',%s,%s::jsonb,'completed')''',
                (job_id, username, job_id, json.dumps(payload)))
            db.execute('INSERT INTO bob_job_events(job_id,event) VALUES(%s,%s::jsonb)',
                (job_id, json.dumps({'type': 'done'})))
    app.dependency_overrides[current_user] = lambda: {'username': username, 'is_admin': True}
    try:
        with TestClient(app) as client:
            response = client.get('/tasks')
            assert response.status_code == 200
            tasks = {task['id']: task for task in response.json()}
            assert set(tasks) == set(ids.values())
            for kind, job_id in ids.items():
                assert tasks[job_id]['kind'] == kind
                assert tasks[job_id]['terminal_event_id']
            app.dependency_overrides[current_user] = lambda: {'username': username + '-other', 'is_admin': True}
            assert client.get('/tasks').json() == []
    finally:
        app.dependency_overrides.clear()
        with job_queue._connect() as db:
            db.execute('DELETE FROM bob_jobs WHERE username=%s', (username,))
    print('Task notification kinds and owner isolation passed')


if __name__ == '__main__':
    main()
