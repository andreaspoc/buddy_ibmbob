"""Verify database notifications deliver durable events immediately and in order."""
import asyncio
import json
import secrets
import shutil
import time
import uuid

import httpx
from app import job_queue
from app.auth import _connect
from app.main import _stream_job_events
from app.sessions import user_root, workspace_for

async def check(jid, token):
    stream = _stream_job_events(jid)
    first = asyncio.create_task(anext(stream))
    # Ensure LISTEN is registered before committing an event.
    await asyncio.sleep(.1)
    started = time.monotonic()
    assert await asyncio.to_thread(job_queue.append_event, jid, token, {'type':'delta','text':'First chunk'})
    event = json.loads(await asyncio.wait_for(first, 2))
    elapsed = time.monotonic()-started
    assert event['text']=='First chunk'
    assert elapsed < .3, elapsed
    latencies = []
    for i in range(30):
        waiting = asyncio.create_task(anext(stream))
        started = time.monotonic()
        assert await asyncio.to_thread(job_queue.append_event, jid, token, {'type':'delta','text':str(i)})
        result = json.loads(await asyncio.wait_for(waiting, 2))
        assert result == {'type':'delta','text':str(i)}, result
        latencies.append((time.monotonic() - started) * 1000)
    print(f'30 consecutive deliveries: median={sorted(latencies)[15]:.1f} ms, max={max(latencies):.1f} ms')
    assert max(latencies) < 300, latencies
    assert await asyncio.to_thread(job_queue.append_event, jid, token, {'type':'delta','text':'Final chunk'})
    assert await asyncio.to_thread(job_queue.finish, jid, token, {'type':'done'})
    rest=[json.loads(e) async for e in stream]
    assert rest==[{'type':'delta','text':'Final chunk'},{'type':'done'}],rest
    print(f'Notification delivery passed: {elapsed*1000:.1f} ms from commit through event delivery; exact event order and final text preserved')


def main():
    user='streamtest-'+secrets.token_hex(4)
    jid, token = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        with httpx.Client(base_url='http://127.0.0.1:8080') as client:
            r=client.post('/auth/register',json={'username':user,'password':secrets.token_urlsafe(24)})
            assert r.status_code==201,r.text
            sid=client.post('/sessions').json()['id']
        with job_queue._connect() as db:
            db.execute("""INSERT INTO bob_jobs (id,username,workspace_id,workspace_key,payload,status,worker_token,lease_until)
                VALUES (%s,%s,%s,%s,'{}','running',%s,now()+interval '90 seconds')""",
                (jid,user,sid,str(workspace_for(sid,user)),token))
        asyncio.run(check(jid,token))
    finally:
        with job_queue._connect() as db:
            db.execute('DELETE FROM bob_jobs WHERE username=%s',(user,))
        with _connect() as db:
            db.execute('DELETE FROM sessions WHERE username=%s',(user,))
            db.execute('DELETE FROM users WHERE username=%s',(user,))
        shutil.rmtree(user_root(user),ignore_errors=True)

if __name__=='__main__':main()
