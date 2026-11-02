"""Real login cookies and PostgreSQL ownership checks in a disposable schema."""
import json
import os
import secrets
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import postgres_storage as storage, job_queue
from app.auth import create_user
from app.main import app
from app.microsoft_auth import _user_token_file
from app.sessions import workspace_key


def main():
    original = os.environ['DATABASE_URL']
    schema = 'bob_auth_test_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_S3_BUCKET': '', 'BOB_FILE_STORAGE': 'postgres', 'BOB_UI_SECURE_COOKIE': '0'}):
            storage.ensure_schema()
            password = secrets.token_urlsafe(24)
            create_user('authowner', password)
            create_user('authother', password)
            assert not app.dependency_overrides, 'Test requires actual authentication'
            with TestClient(app) as owner, TestClient(app) as other:
                for client in (owner, other):
                    client.headers['Origin'] = 'http://testserver'
                for client, username in ((owner, 'authowner'), (other, 'authother')):
                    response = client.post('/auth/login', json={'username': username, 'password': password})
                    assert response.status_code == 200, response.text
                own = owner.post('/sessions').json()['id']
                foreign = other.post('/sessions').json()['id']
                assert owner.put(f'/sessions/{own}/file', json={'path': 'private.txt', 'content': 'owner private fixture'}).status_code == 200
                assert owner.get(f'/sessions/{own}/file', params={'path': 'private.txt'}).content == b'owner private fixture'
                for client, session in ((other, own), (owner, foreign)):
                    for method, suffix, kwargs in (('get', '/history', {}), ('get', '/file', {'params': {'path': 'private.txt'}}), ('put', '/file', {'json': {'path': 'private.txt', 'content': 'unauthorized'}}), ('delete', '', {})):
                        response = getattr(client, method)(f'/sessions/{session}{suffix}', **kwargs)
                        assert response.status_code == 404, (method, suffix, response.status_code)
                job = job_queue.enqueue('authowner', own, workspace_key(own, 'authowner'), {'prompt': 'ownership fixture'})
                for path, kwargs in ((f'/jobs/{job}/cancel', {}), (f'/jobs/{job}/guidance', {'json': {'instruction': 'unauthorized'}})):
                    assert other.post(path, **kwargs).status_code == 404
                assert other.get(f'/jobs/{job}/events').status_code == 404
                assert job_queue.get_job(job, 'authowner')['status'] == 'queued'
                token_file = _user_token_file('authowner')
                storage.write_user_file(token_file, json.dumps({'access_token': 'fixture-only-secret'}).encode())
                assert storage.read_user_file(token_file) is not None
                assert other.post('/auth/microsoft/disconnect').status_code == 200
                assert storage.read_user_file(token_file) is not None, 'Other account disconnected owner token'
                denied = other.get(f'/sessions/{own}/file', params={'path': '../../.home/.bob/tokens/microsoft.json'})
                assert denied.status_code in {400, 404}
                assert 'fixture-only-secret' not in denied.text
                assert owner.post('/auth/microsoft/disconnect').status_code == 200
                assert storage.read_user_file(token_file) is None
                assert owner.get(f'/sessions/{own}/file', params={'path': 'private.txt'}).content == b'owner private fixture'
        print('Real-session account isolation passed: conversations, files, jobs, integration token disconnect')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
