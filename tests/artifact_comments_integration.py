"""Real PostgreSQL lifecycle smoke test using isolated temporary conversations."""
from uuid import uuid4
from fastapi import HTTPException, FastAPI
from fastapi.testclient import TestClient
from app.auth import current_user
from app import artifact_comments as review, sessions, postgres_storage as storage, job_queue

username = 'review-test-' + uuid4().hex[:12]
session = sessions.create_session(username)['id']
user = {'username': username}
path = 'review.md'
try:
    storage.put_file(username, 'session:' + session, path, b'First revision', session_id=session)
    app = FastAPI(); app.include_router(review.router)
    app.dependency_overrides[current_user] = lambda: user
    client = TestClient(app)
    response = client.post('/artifact-comments', json={'session_id': session, 'path': path, 'anchor': 'Paragraph 1', 'comment': 'Clarify the claim'})
    assert response.status_code == 201, response.text
    row = response.json()
    assert client.get('/artifact-comments', params={'session_id': session, 'path': path}).status_code == 200
    app.dependency_overrides[current_user] = lambda: {'username': 'review-other'}
    assert client.get('/artifact-comments', params={'session_id': session, 'path': path}).status_code == 404
    assert client.patch('/artifact-comments/' + str(row['id']), json={'status': 'resolved'}).status_code == 404
    app.dependency_overrides[current_user] = lambda: user
    assert client.patch('/artifact-comments/' + str(row['id']), json={'status': 'resolved'}).json()['status'] == 'resolved'
    assert client.patch('/artifact-comments/' + str(row['id']), json={'status': 'open'}).json()['status'] == 'open'
    assert client.post('/artifact-comments/revision-request', json={'session_id': session, 'path': path, 'ids': [row['id']]}).status_code == 200
    assert row['status'] == 'open' and not row['outdated']
    assert review.list_comments(session, path, 200, user)['items'][0]['id'] == row['id']
    try:
        review.list_comments(session, path, 200, {'username':'review-other'})
        raise AssertionError('cross-user review was permitted')
    except HTTPException as error:
        assert error.status_code == 404
    storage.put_file(username, 'session:' + session, path, b'Second revision', session_id=session)
    assert review.list_comments(session, path, 200, user)['items'][0]['outdated']
    assert 'Clarify the claim' in review.revision_request(review.Selection(session_id=session, path=path, ids=[row['id']]), user)['prompt']
    assert review.update_comment(row['id'], review.Status(status='resolved'), user)['status'] == 'resolved'
    review.update_comment(row['id'], review.Status(status='open'), user)
    storage.delete_file(username, 'session:' + session, path, session_id=session)
    with job_queue._connect() as db:
        assert not db.execute('SELECT 1 FROM bob_artifact_comments WHERE username=%s', (username,)).fetchone()
    storage.put_file(username, 'session:' + session, path, b'Third revision', session_id=session)
    review.add_comment(review.Comment(session_id=session, path=path, anchor='Paragraph 1', comment='Another note'), user)
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_conversations WHERE username=%s AND id=%s', (username,session))
        assert not db.execute('SELECT 1 FROM bob_artifact_comments WHERE username=%s', (username,)).fetchone()
    print('Artifact comments persistence, access, revision, resolution, and cleanup verified.')
finally:
    with job_queue._connect() as db:
        db.execute('DELETE FROM bob_storage_files WHERE username=%s', (username,))
        db.execute('DELETE FROM bob_conversations WHERE username=%s', (username,))
