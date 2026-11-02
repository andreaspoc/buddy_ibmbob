"""Real PostgreSQL/storage deletion checks using only a disposable synthetic chat."""
import json
import sqlite3
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import sessions, job_queue, postgres_storage as storage, blob_storage
from app.auth import current_user
from app.message_deletion import router, delete_message
from app.answer_feedback import ensure_schema as feedback_schema
from app.conversation_sharing import _schema as share_schema
from app.interactive_widgets import ensure_schema as widget_schema
from app.conversation_context import add_conversation_context

username = 'message-delete-check-' + uuid4().hex[:10]
session = sessions.create_session(username)
sid = session['id']
workspace_key = f'{username}:session:{sid}'
api = FastAPI(); api.include_router(router)
api.dependency_overrides[current_user] = lambda: {'username': username}


def native_database():
    with sqlite3.connect(':memory:') as db:
        db.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,first_message TEXT)')
        db.execute('CREATE TABLE messages(task_id TEXT,content TEXT)')
        for index in range(3):
            db.execute('INSERT INTO tasks VALUES (?,?,?,?)', (f'task-{index}', f'task-{index-1}' if index else None, '/synthetic', f'Question secret {index}'))
            db.execute('INSERT INTO messages VALUES (?,?)', (f'task-{index}', f'Answer secret {index}'))
        return db.serialize()


try:
    jobs = []
    for index in range(3):
        payload = {'prompt': f'Question secret {index}', 'bob_prompt': f'Question secret {index}',
                   'correlation_id': f'correlation-{index}', 'user_message_id': f'user-{index}', 'assistant_message_id': f'assistant-{index}'}
        identifier = job_queue.enqueue(username, sid, workspace_key, payload,
            request_event={'type': 'request', 'prompt': payload['prompt'], 'display_prompt': payload['prompt']})
        jobs.append(str(identifier))
        with job_queue._connect() as db:
            db.execute("UPDATE bob_jobs SET status='completed' WHERE id=%s", (identifier,))
            db.execute('INSERT INTO bob_job_events(job_id,event) VALUES(%s,%s::jsonb)', (identifier, json.dumps({'type': 'delta', 'text': f'Answer secret {index}'})))
        sessions.append_history(sid, username, {'type': 'delta', 'text': f'Answer secret {index}', 'assistant_message_id': f'assistant-{index}'})
        sessions.append_history(sid, username, {'type': 'done', 'session_id': f'task-{index}', 'agent_context_id': f'remote-{index}'})
    raw = native_database()
    storage.put_file(username, 'home:' + sid, '.bob/db/bob.db', raw, internal=True)
    storage.put_file(username, 'user', '.home/.bob/db/bob.db', raw, internal=True)
    blob_storage.read(storage.get_file(username, 'home:' + sid, '.bob/db/bob.db', internal=True))
    feedback_schema()
    with job_queue._connect() as db:
        request_id = db.execute("SELECT id FROM bob_conversation_history WHERE username=%s AND session_id=%s AND event->>'user_message_id'='user-1' AND event->>'type'='request'", (username, sid)).fetchone()['id']
        db.execute("INSERT INTO bob_answer_feedback(username,session_id,request_history_id,answer_index,answer_text,category) VALUES(%s,%s,%s,1,'Answer secret 1','other')", (username, sid, request_id))
        share_schema(db)
        db.execute('INSERT INTO bob_conversation_shares(token_hash,username,session_id,snapshot) VALUES(%s,%s,%s,%s::jsonb)', (uuid4().hex, username, sid, json.dumps({'messages': ['Question secret 1']})))
        widget_schema(db)
        db.execute("INSERT INTO bob_interactive_widgets(username,session_id,widget_key,source_hash,state) VALUES(%s,%s,'fixture','fixture','{}'::jsonb)", (username, sid))
    with TestClient(api) as client:
        api.dependency_overrides[current_user] = lambda: {'username': 'another-fixture'}
        assert client.delete(f'/sessions/{sid}/messages/user-1').status_code == 404
        api.dependency_overrides[current_user] = lambda: {'username': username}
        result = client.delete(f'/sessions/{sid}/messages/user-1')
        assert result.status_code == 200, result.text
        assert not result.json()['cleanup_pending'], result.text
        history = sessions.read_history(sid, username)
        assert 'Question secret 1' not in json.dumps(history)
        assert 'Answer secret 1' in json.dumps(history)
        assert not any(event.get('session_id') or event.get('agent_context_id') for event in history)
        assert not storage.list_files(username, 'home:' + sid, internal=True)
        stored = storage.get_file(username, 'user', '.home/.bob/db/bob.db', internal=True)
        with sqlite3.connect(':memory:') as db:
            db.deserialize(bytes(stored['content']))
            assert db.execute('SELECT count(*) FROM tasks').fetchone()[0] == 0
        with job_queue._connect() as db:
            assert not db.execute('SELECT 1 FROM bob_jobs WHERE id=%s', (jobs[1],)).fetchone()
            for table in ('bob_answer_feedback', 'bob_conversation_shares', 'bob_interactive_widgets'):
                assert not db.execute(f'SELECT 1 FROM {table} WHERE username=%s AND session_id=%s', (username, sid)).fetchone()
        assert client.delete(f'/sessions/{sid}/messages/assistant-2').status_code == 200
        history = sessions.read_history(sid, username)
        assert 'Answer secret 2' not in json.dumps(history)
        assert 'Question secret 2' in json.dumps(history)
        context = add_conversation_context('Explain the previous remaining answer', history + [{'type': 'request', 'prompt': 'Explain the previous remaining answer'}], [], workspace='/synthetic', include_history=True)
        assert 'Answer secret 1' in context and 'Answer secret 2' not in context and 'Question secret 1' not in context
        followup = job_queue.enqueue(username, sid, workspace_key,
            {'prompt': 'Continue', 'bob_prompt': 'Continue', 'user_message_id': 'next-user', 'assistant_message_id': 'next-assistant', 'session_id': 'stale-task', 'agent_context_id': 'stale-remote'})
        with job_queue._connect() as db:
            payload = db.execute('SELECT payload FROM bob_jobs WHERE id=%s', (followup,)).fetchone()['payload']
            assert payload['session_id'] is None and payload['agent_context_id'] is None and payload['context_rebuilt']
        assert client.delete(f'/sessions/{sid}/messages/user-0').status_code == 409
        with job_queue._connect() as db:
            db.execute("UPDATE bob_jobs SET status='completed' WHERE id=%s", (followup,))
        assert client.delete(f'/sessions/{sid}/messages/assistant-2').status_code == 200
        try:
            job_queue.enqueue(username, sid, workspace_key, {'user_message_id': 'user-1', 'assistant_message_id': 'assistant-1', 'prompt': 'Question secret 1'})
            raise AssertionError('Deleted message retry accepted')
        except ValueError:
            pass
    sessions.append_history('legacy', username, {'type': 'request', 'prompt': 'Synthetic legacy question', 'user_message_id': 'legacy-user', 'assistant_message_id': 'legacy-assistant'})
    sessions.append_history('legacy', username, {'type': 'delta', 'text': 'Synthetic legacy answer'})
    sessions.append_history('legacy', username, {'type': 'done'})
    delete_message(username, 'legacy', 'legacy-assistant')
    legacy_job = job_queue.enqueue(username, 'legacy', f'{username}:session:legacy', {'prompt': 'Continue legacy', 'session_id': 'stale', 'agent_context_id': 'stale'})
    with job_queue._connect() as db:
        legacy_payload = db.execute('SELECT payload FROM bob_jobs WHERE id=%s', (legacy_job,)).fetchone()['payload']
        assert legacy_payload['context_rebuilt'] and legacy_payload['session_id'] is None and legacy_payload['agent_context_id'] is None
        db.execute("UPDATE bob_jobs SET status='completed' WHERE id=%s", (legacy_job,))
    print('PASS: legacy workspace stale-context reset', flush=True)
    print('PASS: owner isolation, independent role deletion, native/job/feedback/share/widget/cache cleanup, retained followup context, stale-context rejection and active-job guard', flush=True)
finally:
    with job_queue._connect() as db:
        for table in ('bob_answer_feedback', 'bob_conversation_shares', 'bob_interactive_widgets', 'bob_conversation_history', 'bob_jobs', 'bob_conversations', 'bob_storage_files', 'bob_storage_users'):
            db.execute(f'DELETE FROM {table} WHERE username=%s', (username,))
    blob_storage.purge_message_caches(username, sid)
    print('Disposable message deletion fixtures cleaned', flush=True)
