"""Real PostgreSQL previews and atomic mutation audit; temporary fixtures removed."""
import secrets
import uuid
from tests.group_fixtures import make_group, set_members
from app import auth, rag, job_queue, access_views

username = 'access-test-' + uuid.uuid4().hex[:20]
ids = []
try:
    auth.create_user(username, secrets.token_urlsafe(20), admin=True)
    auth.user_profile(username, True)
    group_a = make_group('audit-alpha')
    group_b = make_group('audit-beta')
    for audience in ('both', group_a, group_b):
        document = rag.add_document(username, 'shared', f'{audience}.txt', (username + audience).encode(), audience=audience, admin=True)
        ids.append(document['id'])
    for memberships in ([], [group_a], [group_b], [group_a, group_b]):
        set_members(group_a, *([username] if group_a in memberships else []))
        set_members(group_b, *([username] if group_b in memberships else []))
        live = {doc['id'] for doc in rag.list_documents(username) if doc['id'] in ids}
        preview = {doc['id'] for doc in rag.preview_documents({'groups': memberships}) if doc['id'] in ids}
        assert live == preview, (memberships, live, preview)
        assert len(live) == 1 + len(memberships)
    document = ids[0]
    rag.update_description(username, 'shared', document, 'Reviewed fixture', admin=True)
    rag.update_classification(username, 'shared', document, 'company', group_a, admin=True)
    rag.replace_document(username, 'shared', document, 'updated.txt', (username + 'updated').encode(), admin=True)
    with job_queue._connect() as db:
        db.execute("UPDATE bob_knowledge_documents SET status='failed' WHERE id=%s", (document,))
    assert rag.retry_document(username, 'shared', document, admin=True)
    assert rag.remove_document(username, 'shared', document, admin=True)
    events = access_views.audit({'username': username, 'is_admin': True}, 100, None, username, None)['events']
    actions = {event['action'] for event in events}
    assert {'upload-document', 'describe-document', 'classify-document', 'replace-document', 'reindex-document', 'remove-document'} <= actions
    classified = next(event for event in events if event['action'] == 'classify-document')
    assert classified['details']['before']['audience'] == 'both'
    assert classified['details']['after']['audience'] == group_a
    page = access_views.audit({'username': username, 'is_admin': True}, 2, None, username, None)
    following = access_views.audit({'username': username, 'is_admin': True}, 2, page['next_before_id'], username, None)
    assert not {event['id'] for event in page['events']} & {event['id'] for event in following['events']}
    print('Access preview matrix and durable document audit integration passed')
finally:
    with job_queue._connect() as db:
        for document_id in ids:
            db.execute('DELETE FROM bob_knowledge_documents WHERE id=%s', (document_id,))
        db.execute('DELETE FROM bob_access_audit WHERE actor=%s', (username,))
        db.execute('DELETE FROM bob_user_profiles WHERE username=%s', (username,))
        db.execute('DELETE FROM users WHERE username=%s', (username,))
