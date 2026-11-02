"""Synthetic knowledge fixtures validate real SQL against current retrieval policy."""
import uuid
from unittest.mock import patch
from app import job_queue, rag, notification_inbox
username='synthetic-knowledge-notification-'+uuid.uuid4().hex
visible,denied=str(uuid.uuid4()),str(uuid.uuid4())
ALLOWED,RESTRICTED=str(uuid.uuid4()),str(uuid.uuid4())
notification_inbox.ensure_schema()
try:
    with job_queue._connect() as db:
        for document_id,audience in [(visible,ALLOWED),(denied,RESTRICTED)]:
            db.execute("INSERT INTO bob_knowledge_documents(id,username,workspace_id,filename,content,sha256,status,owner,review_due,size,knowledge_base,audience) VALUES (%s,%s,'shared','Synthetic notification policy.txt','synthetic fixture',%s,'ready','Synthetic policy owner',CURRENT_DATE-1,17,'company',%s)",(document_id,username,uuid.uuid4().hex,audience))
            db.execute("INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,'replace-document',%s,'{}')",(username,document_id))
    with patch('app.auth.knowledge_access',return_value={'groups':[ALLOWED]}):
        notices=notification_inbox.list_notifications(username)
        related=[item for item in notices if item.get('document_id') in {visible,denied}]
        assert len(related)==2, related
        assert all(item['document_id']==visible for item in related), related
        assert {item['status'] for item in related}=={'replace-document','review_overdue'}
        assert notification_inbox.mark_read(username,related[0]['id'])
    with patch('app.auth.knowledge_access',return_value={'groups':['unrelated']}):
        revoked=notification_inbox.list_notifications(username)
        assert not any(item.get('document_id') in {visible,denied} for item in revoked)
        assert not notification_inbox.mark_read(username,related[0]['id'])
    print('PASS: source changes, overdue owner alerts, group isolation, access revocation, durable reads')
finally:
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_notification_reads WHERE username=%s',(username,))
        db.execute('DELETE FROM bob_access_audit WHERE actor=%s',(username,))
        db.execute('DELETE FROM bob_knowledge_documents WHERE username=%s',(username,))
