"""Workflow ownership, atomic dispatch, scheduler races and worker results in an isolated schema."""
import asyncio
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch, AsyncMock
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import workflows, job_queue, worker, postgres_storage as storage
from app.auth import current_user, create_user
from app.main import app
from app.projects import database
from app.workspace_config import select_root
from app.sessions import user_root, read_history


async def fake_stream(*args, **kwargs):
    yield {'type': 'start'}
    yield {'type': 'status', 'message': 'Live coordinator activity'}
    yield {'type': 'delta', 'text': 'Verified workflow result'}
    from app.tasks import task_detail
    with job_queue._connect() as db:
        row = db.execute("SELECT id FROM bob_jobs WHERE username='workflow-owner' AND status='running'").fetchone()
    detail = task_detail('workflow-owner', row['id'])
    assert detail['result'] == 'Verified workflow result', detail
    assert any(step['message'] == 'Live coordinator activity' for step in detail['steps']), detail
    yield {'type': 'done', 'session_id': 'test-workflow'}


def main():
    original = os.environ['DATABASE_URL']
    schema = 'workflowtest_' + uuid.uuid4().hex[:12]
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    actor = {'username': 'workflow-owner', 'is_admin': False}
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options='-c search_path=' + schema)}):
            create_user(actor['username'], 'test-password-long-enough', False)
            create_user('workflow-other', 'test-password-long-enough', False)
            select_root(user_root(actor['username'], create=True))
            app.dependency_overrides[current_user] = lambda: actor
            with TestClient(app) as client:
                spec = {'name': 'Weekly report', 'prompt': 'Prepare report', 'frequency': 'weekly', 'timezone': 'Europe/Athens', 'time': '09:00'}
                response = client.post('/workflows', json=spec)
                assert response.status_code == 201, response.text
                saved = response.json(); wid = saved['id']
                assert saved['next_run']
                actor['username'] = 'workflow-other'
                assert client.get('/workflows').json() == []
                assert client.post(f'/workflows/{wid}/run').status_code == 404
                assert client.patch(f'/workflows/{wid}', json={'enabled': False}).status_code == 404
                assert client.delete(f'/workflows/{wid}').status_code == 404
                actor['username'] = 'workflow-owner'
                assert client.post('/workflows/run', json={**spec, 'max_iterations': 2}).status_code == 422
                with job_queue._connect() as db:
                    db.execute("UPDATE bob_workflows SET next_run=now()-interval '1 minute' WHERE id=%s", (wid,))
                with ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(lambda _: workflows.dispatch_due(), range(2)))
                with job_queue._connect() as db:
                    rows = db.execute('SELECT * FROM bob_jobs').fetchall()
                    assert len(rows) == 1
                    assert db.execute('SELECT count(*) AS n FROM bob_conversations').fetchone()['n'] == 1
                assert client.post(f'/workflows/{wid}/run').status_code == 409
                token = str(uuid.uuid4()); job = job_queue.claim(token)
                with patch.object(worker.bridge, 'stream', fake_stream), patch('app.hooks.execute_event_hooks', AsyncMock(return_value=(True, '', ''))):
                    asyncio.run(worker.execute_job(job, token))
                detail = client.get('/tasks/' + str(job['id'])).json()
                assert detail['status'] == 'completed', detail
                assert detail['result'] == 'Verified workflow result', detail
                assert read_history(job['workspace_id'], actor['username'])[-1]['type'] == 'done'
                paused = client.patch(f'/workflows/{wid}', json={'enabled': False}).json()
                assert paused['next_run'] is None and not paused['enabled']
                assert client.patch(f'/workflows/{wid}', json={'enabled': True}).json()['next_run']
                project = uuid.uuid4().hex
                with database() as db:
                    db.execute("INSERT INTO projects(id,username,name,source) VALUES (%s,%s,'Test','empty')", (project, actor['username']))
                started = client.post('/workflows/run', json={**spec, 'project_id': project})
                assert started.status_code == 202, started.text
                assert client.post('/workflows/run', json={**spec, 'project_id': project}).status_code == 409
                with job_queue._connect() as db:
                    assert db.execute('SELECT count(*) AS n FROM bob_conversations').fetchone()['n'] == 2
                # A scheduled workflow targeting a deleted project pauses visibly.
                saved_project = client.post('/workflows', json={**spec, 'project_id': project}).json()
                with job_queue._connect() as db:
                    db.execute('DELETE FROM projects WHERE id=%s', (project,))
                    db.execute("UPDATE bob_workflows SET next_run=now()-interval '1 minute' WHERE id=%s", (saved_project['id'],))
                workflows.dispatch_due()
                row = next(r for r in client.get('/workflows').json() if r['id'] == saved_project['id'])
                assert not row['enabled'] and 'no longer exists' in row['last_error']
                assert client.delete(f'/workflows/{wid}').status_code == 200
                assert client.post(f'/workflows/{wid}/run').status_code == 404
        print('Workflow integration passed: ownership, atomic enqueue, scheduler race, worker result, pause/resume, project locking and deletion')
    finally:
        app.dependency_overrides.pop(current_user, None)
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
