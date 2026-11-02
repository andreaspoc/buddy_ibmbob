"""Durable approval owner checks, replay, cancellation and decision immutability."""
import json
import uuid
from fastapi.testclient import TestClient
from app import job_queue
from app.auth import current_user
from app.main import app

username = 'approval-test-' + uuid.uuid4().hex
job_id, token, approval_id = [str(uuid.uuid4()) for _ in range(3)]
job_queue.ensure_schema()
with job_queue._connect() as db:
    db.execute("INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status,worker_token) VALUES(%s,%s,'test',%s,'{}','running',%s)", (job_id,username,job_id,token))
event = {'type':'approval','job_id':job_id,'approval_id':approval_id,'title':'Write file','detail':{'kind':'edit'},'status':'pending'}
job_queue.create_approval(job_id, token, event)
job_queue.append_event(job_id,token,event)
app.dependency_overrides[current_user] = lambda: {'username':username,'is_admin':True}
try:
    with TestClient(app) as client:
        url=f'/jobs/{job_id}/approvals/{approval_id}'
        app.dependency_overrides[current_user] = lambda: {'username':username+'other','is_admin':True}
        assert client.post(url,json={'decision':'approve'}).status_code == 404
        app.dependency_overrides[current_user] = lambda: {'username':username,'is_admin':True}
        assert client.post(url,json={'decision':'approve'}).json()['status']=='approved'
        assert client.post(url,json={'decision':'approve'}).status_code==200
        assert client.post(url,json={'decision':'reject'}).status_code==409
        assert client.post(url,json={'decision':'always'}).status_code==422
        assert job_queue.approval_decision(job_id,token,approval_id)=='approve'
        assert job_queue.events_after(job_id,0)[0][0]['event']==event
        job_queue.request_cancel(job_id,username)
        assert client.post(url,json={'decision':'approve'}).status_code==404
        try:
            job_queue.approval_decision(job_id,token,approval_id)
        except RuntimeError:
            pass
        else:
            raise AssertionError('Cancelled job must not execute approved action')
finally:
    app.dependency_overrides.clear()
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_jobs WHERE username=%s',(username,))
        db.execute('DELETE FROM bob_conversation_history WHERE username=%s',(username,))
print('Approval ownership, durable replay, immutable decision and cancellation passed')
