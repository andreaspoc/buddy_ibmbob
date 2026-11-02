"""Compact historical names remain scoped to the conversation owner."""
import json
import uuid
from app import job_queue
from app.sessions import list_sessions, touch_session

owner = 'titletest-' + uuid.uuid4().hex[:8]
other = owner + '-other'
session_id = uuid.uuid4().hex
job_queue.ensure_schema()
try:
    with job_queue._connect() as db:
        for username in (owner, other):
            db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb)',
                       (username, session_id, json.dumps({'id':session_id,'title':'New conversation','updated':'2026-10-03'})))
        for username, prompt in ((owner, 'hi how are you?'), (owner, 'check docs and tell me about acme company information'), (other, 'Private competitor report')):
            db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',
                       (username, session_id, json.dumps({'type':'request','prompt':prompt})))
    assert list_sessions(owner)[0]['title'] == 'Acme company information'
    assert list_sessions(other)[0]['title'] == 'Private competitor report'
    touch_session(session_id, owner, 'Can you create a PowerPoint presentation about cloud migration?')
    with job_queue._connect() as db:
        record = db.execute('SELECT record FROM bob_conversations WHERE username=%s AND id=%s', (owner,session_id)).fetchone()['record']
        assert record['title'] == 'Cloud migration presentation', record
    print('Historical topics, owner isolation, and compact stored titles passed')
finally:
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_conversation_history WHERE username IN (%s,%s)', (owner,other))
        db.execute('DELETE FROM bob_conversations WHERE username IN (%s,%s)', (owner,other))
