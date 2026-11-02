"""Permanent file deletion also removes embedded preview sources and task results."""
import json
import uuid
from app import job_queue, postgres_storage as storage
from app.presentation_delete import delete_presentation

owner='deckdelete-'+uuid.uuid4().hex[:8]
other=owner+'-other'
session=uuid.uuid4().hex
scope='session:'+session
job=str(uuid.uuid4())
deck={'title':'Deleted deck','slides':[{'elements':[]}]}
body='Overview.\n```bobdeck\n'+json.dumps(deck)+'\n```\npresentation.bobdeck'
html='HTML overview.\n```html\n<html><body>Deleted HTML</body></html>\n```\npresentation.html'
storage.ensure_schema()
try:
    with job_queue._connect() as db:
        for username in (owner,other):
            db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb)', (username,session,json.dumps({'id':session,'title':'Test'})))
            for event in ({'type':'request','mode':'presentation','presentation_format':'pptx','prompt':'Create deck'}, {'type':'delta','text':body[:30]}, {'type':'delta','text':body[30:]}, {'type':'done'}, {'type':'request','mode':'presentation','presentation_format':'html','prompt':'Create HTML'}, {'type':'delta','text':html}):
                db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)', (username,session,json.dumps(event)))
        db.execute("INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status) VALUES (%s,%s,%s,%s,%s::jsonb,'completed')", (job,owner,session,owner+':'+scope,json.dumps({'mode':'presentation'})))
        db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)',(job,json.dumps({'type':'delta','text':body})))
    for name, content in [('presentation.bobdeck',json.dumps(deck).encode()),('presentation.pptx',b'pptx'),('presentation.html',b'<html>deck</html>'),('older.bobdeck',b'{"slides":[]}')]:
        storage.put_file(owner,scope,name,content,session_id=session)
    storage.put_file(other,scope,'presentation.bobdeck',json.dumps(deck).encode(),session_id=session)
    assert delete_presentation(owner,scope,'presentation.pptx',session)
    assert storage.get_file(owner,scope,'presentation.pptx') is None
    assert storage.get_file(owner,scope,'presentation.bobdeck') is None
    assert storage.get_file(owner,scope,'presentation.html') is not None
    assert storage.get_file(owner,scope,'older.bobdeck') is not None
    assert storage.get_file(other,scope,'presentation.bobdeck') is not None
    with job_queue._connect() as db:
        events=[row['event'] for row in db.execute('SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s ORDER BY id',(owner,session))]
        assert {'presentation.bobdeck', 'presentation.pptx'}.issubset(set(events[0]['deleted_presentations']))
        assert events[1]['text'].startswith('Overview.') and '"slides"' not in events[1]['text']
        assert events[2]['text']==''
        assert 'deleted_presentations' not in events[4]
        result=db.execute('SELECT event FROM bob_job_events WHERE job_id=%s',(job,)).fetchone()['event']['text']
        assert '"slides"' not in result
        untouched=db.execute('SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s ORDER BY id',(other,session)).fetchall()
        assert 'deleted_presentations' not in untouched[0]['event']
    assert delete_presentation(owner,scope,'presentation.html',session)
    assert storage.get_file(owner,scope,'presentation.html') is None
    with job_queue._connect() as db:
        result=db.execute("SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s AND event->>'type'='delta' ORDER BY id DESC LIMIT 1",(owner,session)).fetchone()['event']
        assert '<html>' not in result['text'] and result['presentation_deleted']
    print('Files, related PPTX/BobDeck, inline sources, task results, owner isolation, and unrelated decks verified')
finally:
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_job_events WHERE job_id=%s',(job,))
        db.execute('DELETE FROM bob_jobs WHERE id=%s',(job,))
        db.execute('DELETE FROM bob_conversation_history WHERE username IN (%s,%s)',(owner,other))
        db.execute('DELETE FROM bob_conversations WHERE username IN (%s,%s)',(owner,other))
        db.execute('DELETE FROM bob_storage_files WHERE username IN (%s,%s)',(owner,other))
