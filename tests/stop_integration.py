"""Verify authenticated cancellation, worker cleanup and subprocess termination."""
import asyncio
import json
import os
import secrets
import shutil
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
from app import job_queue, worker
from app.auth import _connect
from app.sessions import user_root, workspace_for


def insert_running(username, sid):
    token, jid = str(uuid.uuid4()), str(uuid.uuid4())
    payload = {"prompt": "Temporary cancellation check", "bob_prompt": "Temporary cancellation check", "mode": "ask"}
    with job_queue._connect() as db:
        db.execute("""INSERT INTO bob_jobs (id,username,workspace_id,workspace_key,payload,status,worker_token,lease_until)
            VALUES (%s,%s,%s,%s,%s::jsonb,'running',%s,now()+interval '90 seconds')""",
            (jid, username, sid, str(workspace_for(sid, username)), json.dumps(payload), token))
    return job_queue.get_job(jid, username), token


def alive(pid):
    path = Path(f'/proc/{pid}/stat')
    return path.exists() and path.read_text().split(')')[1].strip().split()[0] != 'Z'


async def check(client, stranger, username, sid, queued_sid):
    job, token = insert_running(username, sid)
    jid = str(job['id'])
    assert (await asyncio.to_thread(stranger.post, f'/jobs/{jid}/cancel')).status_code == 404
    with httpx.Client(base_url='http://127.0.0.1:8080') as anonymous:
        assert (await asyncio.to_thread(anonymous.post, f'/jobs/{jid}/cancel')).status_code == 401
    # Another queued job for this user cannot be claimed while the first runs.
    queued = job_queue.enqueue(username, queued_sid, str(workspace_for(queued_sid, username)), job['payload'])
    response = await asyncio.to_thread(client.post, f'/jobs/{queued}/cancel')
    assert response.status_code == 200 and response.json()['status'] == 'stopped'
    assert job_queue.get_job(queued)['status'] == 'failed'

    pid_file = workspace_for(sid, username) / '.stop-test-pids'
    child = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(120)"
    script = f"import os,signal,subprocess,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); c=subprocess.Popen([{sys.executable!r},'-c',{child!r}],stdout=subprocess.PIPE); c.stdout.readline(); open({str(pid_file)!r},'w').write(str(os.getpid())+' '+str(c.pid)); time.sleep(120)"
    real_spawn = asyncio.create_subprocess_exec
    async def spawn(*args, **kwargs):
        return await real_spawn(sys.executable, '-c', script, **kwargs)
    with patch.object(worker.object_storage, 'enabled', return_value=False), patch('app.acp_bridge.asyncio.create_subprocess_exec', spawn), patch('app.acp_bridge.sandbox_command', side_effect=lambda command, **kwargs: command):
        task = asyncio.create_task(worker.execute_job(job, token))
        try:
            async with asyncio.timeout(10):
                while not pid_file.exists(): await asyncio.sleep(.05)
            pids = [int(p) for p in pid_file.read_text().split()]
            assert all(alive(p) for p in pids)
            response = await asyncio.to_thread(client.post, f'/jobs/{jid}/cancel')
            assert response.status_code == 200 and response.json()['status'] == 'stopped', response.text
            await asyncio.wait_for(task, 5)
            assert not any(alive(p) for p in pids), pids
            assert job_queue.get_job(jid)['status'] == 'failed'
            events, _ = job_queue.events_after(jid, 0)
            assert events[-1]['event']['cancelled']
            assert (await asyncio.to_thread(client.post, f'/jobs/{jid}/cancel')).json()['status'] == 'stopped'
        finally:
            if not task.done():
                task.cancel()
                try: await task
                except asyncio.CancelledError: pass
    # A lost worker must never retry a job that the user already stopped.
    expired, _ = insert_running(username, sid)
    expired_id = str(expired['id'])
    job_queue.request_cancel(expired_id, username)
    with job_queue._connect() as db:
        db.execute("UPDATE bob_jobs SET lease_until=now()-interval '1 second' WHERE id=%s", (expired_id,))
    job_queue.requeue_expired()
    assert job_queue.get_job(expired_id)['status'] == 'failed'
    # Cancellation must not exit the worker's per-job runner.
    next_job, next_token = insert_running(username, sid)
    class CompletedBridge:
        async def stream(self, *args, **kwargs):
            yield {'type': 'done'}
    with patch.object(worker, 'bridge', CompletedBridge()), patch.object(worker.object_storage, 'enabled', return_value=False):
        await worker.execute_job(next_job, next_token)
    assert job_queue.get_job(str(next_job['id']))['status'] == 'completed'


def main():
    users = ['stoptest-'+secrets.token_hex(4), 'stopother-'+secrets.token_hex(4)]
    sessions = []
    job_queue.ensure_schema()
    try:
        with httpx.Client(base_url='http://127.0.0.1:8080', timeout=20) as client, httpx.Client(base_url='http://127.0.0.1:8080') as stranger:
            for c, user in zip((client, stranger), users):
                r=c.post('/auth/register',json={'username':user,'password':secrets.token_urlsafe(24)})
                assert r.status_code == 201, r.text
            sessions=[client.post('/sessions').json()['id'] for _ in range(2)]
            asyncio.run(check(client,stranger,users[0],*sessions))
        print('Stop integration passed: ownership, queued cancellation, running cancellation, parent and child termination, repeat stop, worker reuse')
    finally:
        with job_queue._connect() as db:
            db.execute('DELETE FROM bob_jobs WHERE username=ANY(%s)',(users,))
            db.execute('DELETE FROM bob_deleted_conversations WHERE username=ANY(%s)',(users,))
        with _connect() as db:
            db.execute('DELETE FROM sessions WHERE username=ANY(%s)',(users,))
            db.execute('DELETE FROM users WHERE username=ANY(%s)',(users,))
        for user in users:
            shutil.rmtree(user_root(user),ignore_errors=True)

if __name__=='__main__': main()
