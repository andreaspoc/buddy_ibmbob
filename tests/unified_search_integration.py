"""Real PostgreSQL ownership, replacement, document and current-ACL search checks."""
import secrets
import uuid
from tests.group_fixtures import make_group, set_members
from app import auth, sessions, job_queue, rag, postgres_storage as storage, unified_search, conversation_documents

token = 'searchfixture' + uuid.uuid4().hex
owner = 'search-test-' + uuid.uuid4().hex[:16]
other = 'search-test-' + uuid.uuid4().hex[:16]
document_ids = []
try:
    auth.create_user(owner, secrets.token_urlsafe(20), admin=True)
    auth.create_user(other, secrets.token_urlsafe(20))
    session = sessions.create_session(owner)['id']
    scope = sessions.storage_scope(session, owner)
    for event in [dict(type='request',prompt='Question'), dict(type='delta',text='discarded'+token),
                  dict(type='delta',text=token[:15],replace=True),dict(type='delta',text=token[15:]),dict(type='done')]:
        sessions.append_history(session, owner, event)
    storage.put_file(owner, scope, 'executive-report.md', ('Saved report '+token).encode(), session_id=session)
    storage.put_file(owner, scope, '.hidden.md', token.encode(), internal=True)
    storage.put_file(owner, scope, 'prepared-source.pdf', b'fixture', session_id=session)
    storage.put_file(owner, scope, 'document-text/prepared.md', token.encode(), session_id=session)
    conversation_documents.ensure_schema()
    source = storage.get_file(owner, scope, 'prepared-source.pdf')
    with job_queue._connect() as db:
        db.execute("INSERT INTO bob_conversation_documents(username,scope,path,session_id,sha256,status,prepared_path) VALUES (%s,%s,%s,%s,%s,'ready',%s)",
                   (owner,scope,'prepared-source.pdf',session,source['sha256'],'document-text/prepared.md'))
    group = make_group('search')
    for audience in ('both',group):
        doc = rag.add_document(owner, 'shared', f'{token}-{audience}.txt', (token+audience).encode(), audience=audience, admin=True)
        document_ids.append(doc['id'])
    own = unified_search.search_saved(owner, token)['results']
    assert {r['kind'] for r in own} == {'conversations','files','knowledge'}, own
    assert any(r.get('path') == 'executive-report.md' for r in own)
    assert any(r.get('path') == 'prepared-source.pdf' for r in own)
    assert not any(r.get('path','').startswith(('.','document-text/')) for r in own)
    assert not unified_search.search_saved(owner, 'discarded'+token, 'conversations')['results']
    foreign = unified_search.search_saved(other, token)['results']
    assert all(r['kind'] == 'knowledge' for r in foreign), foreign
    assert {r['id'] for r in foreign} == {document_ids[0]}, foreign
    set_members(group, other)
    assert len(unified_search.search_saved(other, token, 'knowledge')['results']) == 2
    assert unified_search.search_saved(owner, '%', 'files')['results'] == []
    print('Unified search real PostgreSQL checks passed: split answers, replacement, file text, prepared PDFs, ownership, current knowledge ACL and literal wildcard.')
finally:
    with job_queue._connect() as db:
        for username in (owner, other):
            for table in ('bob_conversation_documents','bob_conversation_history','bob_conversations','bob_storage_files','bob_storage_users'):
                db.execute(f'DELETE FROM {table} WHERE username=%s', (username,))
        for identifier in document_ids:
            db.execute('DELETE FROM bob_knowledge_documents WHERE id=%s', (identifier,))
        db.execute('DELETE FROM bob_access_audit WHERE actor=%s', (owner,))
    with auth._connect() as db:
        for username in (owner,other):
            db.execute('DELETE FROM bob_user_profiles WHERE username=%s', (username,))
            db.execute('DELETE FROM users WHERE username=%s', (username,))
