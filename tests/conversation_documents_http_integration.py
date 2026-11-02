"""Real authenticated conversation attachment HTTP checks in a disposable schema."""
import os
import secrets
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import auth
from app.main import app


def main():
    original = os.environ['DATABASE_URL']
    schema = 'attachment_http_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_FILE_STORAGE': 'postgres', 'BOB_UI_SECURE_COOKIE': '0', 'BOB_BLOB_STORAGE': 'postgres'}):
            password = secrets.token_urlsafe(24)
            for name in ('attachmentowner', 'attachmentother'):
                auth.create_user(name, password)
            with TestClient(app) as owner, TestClient(app) as other, TestClient(app) as anonymous:
                for client in (owner, other, anonymous):
                    client.headers['Origin'] = 'http://testserver'
                for client, name in ((owner, 'attachmentowner'), (other, 'attachmentother')):
                    response = client.post('/auth/login', json={'username': name, 'password': password})
                    assert response.status_code == 200, response.text
                sid = owner.post('/sessions').json()['id']
                second = owner.post('/sessions').json()['id']
                prefix = f'/sessions/{sid}'
                filename = 'brief.md'
                content = b'# Synthetic attachment fixture\n\nReview milestone: Thursday.\n'
                response = owner.post(prefix + '/upload', files={'file': (filename, content)})
                assert response.status_code == 201, response.text
                uploaded = response.json()
                assert uploaded['document']['status'] == 'queued', uploaded
                assert uploaded['session_id'] == sid, uploaded
                assert owner.get(prefix + '/file', params={'path': filename}).content == content
                assert owner.get(prefix + '/documents/preview', params={'path': filename}).status_code == 200
                assert anonymous.get(prefix + '/documents/preview', params={'path': filename}).status_code == 401
                assert other.get(prefix + '/documents/preview', params={'path': filename}).status_code == 404
                assert owner.get(f'/sessions/{second}/documents/preview', params={'path': filename}).status_code == 404
                assert other.post(prefix + '/documents/prepare', params={'path': filename}).status_code == 404
                assert owner.get(prefix + '/documents/preview', params={'path': '../brief.md'}).status_code == 400
                assert owner.post(prefix + '/upload', files={'file': ('empty.md', b'')}).status_code == 422
                assert owner.post(prefix + '/upload', files={'file': ('huge.pdf', b'x' * (25 * 1024 * 1024 + 1))}).status_code == 413
                assert owner.get(prefix + '/file', params={'path': 'huge.pdf'}).status_code == 404
                files = owner.get(prefix + '/files').json()
                assert next(item for item in files if item['name'] == filename)['size'] == len(content)
                assert owner.delete(prefix + '/file', params={'path': filename}).status_code == 204
                assert owner.get(prefix + '/documents/preview', params={'path': filename}).status_code == 404
        print('Attachment HTTP integration passed: authenticated upload/download, document metadata, account and conversation isolation, traversal, empty and oversized rejection, deletion.')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
