"""Guidance ownership, persistence and terminal acceptance race against PostgreSQL."""
import json
import uuid
from fastapi.testclient import TestClient
from app import job_queue, chat_guidance
from app.auth import current_user
from app.main import app

username = 'guidance-test-' + uuid.uuid4().hex
job_id, token = str(uuid.uuid4()), str(uuid.uuid4())
job_queue.ensure_schema()
with job_queue._connect() as db:
    db.execute("""INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status,worker_token)
    VALUES(%s,%s,'test',%s,%s::jsonb,'running',%s)""", (job_id,username,job_id,json.dumps({'prompt':'Original','mode':'agent'}),token))
app.dependency_overrides[current_user] = lambda: {'username':username,'is_admin':True}
try:
    with TestClient(app) as client:
        url = f'/jobs/{job_id}/guidance'
        assert client.post(url,json={'instruction':'Keep it concise'}).status_code == 202
        assert client.post(url,json={'instruction':'Use a list'}).status_code == 202
        notes = chat_guidance.instructions(job_id)
        assert [n['instruction'] for n in notes] == ['Keep it concise','Use a list']
        assert not chat_guidance.close_if_ready(job_id,token)
        app.dependency_overrides[current_user] = lambda: {'username':username+'other','is_admin':True}
        assert client.post(url,json={'instruction':'Wrong owner'}).status_code == 404
        app.dependency_overrides[current_user] = lambda: {'username':username,'is_admin':True}
        assert client.post(url,json={'instruction':''}).status_code == 422
        chat_guidance.applied(job_id,token,[n['id'] for n in notes])
        assert chat_guidance.close_if_ready(job_id,token)
        assert client.post(url,json={'instruction':'Too late'}).status_code == 409
        with job_queue._connect() as db:
            assert db.execute('SELECT count(*) AS n FROM bob_jobs WHERE username=%s',(username,)).fetchone()['n'] == 1
            assert db.execute('SELECT count(*) AS n FROM bob_conversation_history WHERE username=%s',(username,)).fetchone()['n'] == 2
    assert not chat_guidance.supported({'workflow':{}})
    assert not chat_guidance.supported({'research':{}})
    assert not chat_guidance.supported({'mode':'presentation'})
finally:
    app.dependency_overrides.clear()
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_jobs WHERE username=%s',(username,))
        db.execute('DELETE FROM bob_conversation_history WHERE username=%s',(username,))
print('Guidance persistence, ownership and completion race passed')
