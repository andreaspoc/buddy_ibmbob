"""Exercise durable feature storage against the configured PostgreSQL."""
import uuid
from fastapi import HTTPException, Request
from app.conversation_sharing import router as sharing_router
from app import job_queue, postgres_storage as storage
from app.sessions import create_session, append_history
from app.personalization import save, records, get_preset, memory_context, ensure_schema
from app.artifacts import ArtifactSave, save as artifact_save, history
from app.conversation_sharing import share_conversation, shared_snapshot, revoke_shares, export_conversation

username = 'feature-test-' + uuid.uuid4().hex[:12]
other = 'feature-test-' + uuid.uuid4().hex[:12]
try:
    storage.ensure_schema()
    ensure_schema()
    session = create_session(username)['id']
    memory = save(username, 'memories', uuid.uuid4().hex, {'content':'Use British English', 'enabled':True}, create=True)
    assert 'British English' in memory_context(username)
    assert records(other, 'memories') == []
    save(username, 'memories', memory['id'], {'content':memory['content'], 'enabled':False})
    assert memory_context(username) == ''
    preset = save(username, 'presets', uuid.uuid4().hex, {'name':'Analyst', 'instructions':'Explain assumptions', 'mode':'ask', 'skill_name':None, 'web_search':False}, create=True)
    assert get_preset(username, preset['id'])['mode'] == 'ask'
    assert get_preset(other, preset['id']) is None
    a = artifact_save(username, session, ArtifactSave(path='note.md', content='# First'))
    b = artifact_save(username, session, ArtifactSave(path='note.md', content='# Second', expected_sha256=a['sha256']))
    assert len(history(username, session, 'note.md')) == 2
    try: artifact_save(username, session, ArtifactSave(path='note.md', content='stale', expected_sha256=a['sha256']))
    except HTTPException as e: assert e.status_code == 409
    else: raise AssertionError('Stale save was accepted')
    append_history(session, username, {'type':'request', 'prompt':'Hello'})
    append_history(session, username, {'type':'delta', 'text':'Hi <script>alert(1)</script>'})
    user = {'username': username}
    assert b'Hello' in export_conversation(session, 'markdown', user).body
    request = Request({'type':'http','scheme':'http','server':('testserver',80),'headers':[], 'root_path':'','path':'/', 'router':sharing_router})
    token = share_conversation(session, request, user)['url'].split('/')[-1]
    assert b'Hi <script>' in shared_snapshot(token, user).body
    revoke_shares(session, user)
    try: shared_snapshot(token, user)
    except HTTPException as e: assert e.status_code == 404
    else: raise AssertionError('Revoked share was readable')
    print('Personal memory, presets, artifact persistence/conflicts, export and share revocation passed')
finally:
    with job_queue._connect() as db:
        for table in ('bob_personalization','bob_conversation_shares','bob_storage_files','bob_conversation_history','bob_conversations','bob_storage_users'):
            db.execute('DELETE FROM ' + table + ' WHERE username IN (%s,%s)', (username, other))
