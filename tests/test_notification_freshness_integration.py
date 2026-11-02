"""Isolated synthetic database fixtures, always removed in finally."""
from datetime import datetime, timedelta, timezone
import uuid
from unittest.mock import patch
from app import job_queue, rag, notification_inbox

user='synthetic-productivity-test-'+uuid.uuid4().hex
other=user+'-other'
ids=[str(uuid.uuid4()) for _ in range(4)]
document_id=str(uuid.uuid4())
worker=str(uuid.uuid4())
notification_inbox.ensure_schema();rag.ensure_schema()
try:
    with job_queue._connect() as db:
        for job_id,owner,status in [(ids[0],user,'completed'),(ids[1],user,'failed'),(ids[2],user,'running'),(ids[3],other,'completed')]:
            db.execute("INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status,worker_token,lease_until) VALUES (%s,%s,%s,%s,'{\"prompt\":\"Synthetic integration fixture\"}'::jsonb,%s,%s,now()+interval '1 hour')",(job_id,owner,'fixture-session',owner+job_id,status,worker if status=='running' else None))
        db.execute("INSERT INTO bob_job_approvals(id,job_id,worker_token,event) VALUES (%s,%s,%s,'{}')",(str(uuid.uuid4()),ids[2],worker))
        db.execute("INSERT INTO bob_knowledge_documents(id,username,workspace_id,filename,content,sha256,status,owner,review_due,size) VALUES (%s,%s,'shared','synthetic-freshness.txt','synthetic fixture',%s,'ready','Synthetic policy owner',CURRENT_DATE-1,17)",(document_id,user,uuid.uuid4().hex))
    notices=notification_inbox.list_notifications(user)
    assert {item['status'] for item in notices}=={'completed','failed','pending'}, notices
    assert all(item['job_id']!=ids[3] for item in notices)
    assert notification_inbox.mark_read(user,notices[0]['id'])
    assert notification_inbox.list_notifications(user)[0]['read_at'] is not None
    assert not notification_inbox.mark_read(other,notices[0]['id'])
    with patch.object(rag,'require_admin'),patch.object(rag,'audit_document'):
        result=rag.update_freshness(user,'shared',document_id,'Synthetic reviewed owner',(datetime.now(timezone.utc).date()+timedelta(days=30)).isoformat(),reviewed=True,admin=True)
    assert result['owner']=='Synthetic reviewed owner'
    assert not result['review_overdue'] and result['reviewed_at']
    print('PASS: live notification SQL, owner isolation, durable reads, and knowledge freshness update')
finally:
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_notification_reads WHERE username=ANY(%s)',([user,other],))
        db.execute('DELETE FROM bob_jobs WHERE username=ANY(%s)',([user,other],))
        db.execute('DELETE FROM bob_knowledge_documents WHERE id=%s',(document_id,))
