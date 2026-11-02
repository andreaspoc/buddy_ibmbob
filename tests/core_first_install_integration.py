"""Core-first installation smoke test inside a disposable schema of the SAME DB.

Run using the core image with DATABASE_URL. Creates no database, user accounts in
public, external AI jobs or S3 objects. Its test schema is removed in finally.
"""
import importlib.util
import os
from pathlib import Path
import secrets
import tempfile

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo


def main():
    original = os.environ['DATABASE_URL']
    schema = 'buddy_install_verify_' + secrets.token_hex(8)
    with psycopg.connect(original, autocommit=True) as db:
        databases_before = db.execute('SELECT count(*) FROM pg_database').fetchone()[0]
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with tempfile.TemporaryDirectory(prefix='buddy-core-install-') as workspace:
            os.environ.update(DATABASE_URL=make_conninfo(original, options='-c search_path=' + schema),
                              BUDDY_OFFICE_ENABLED='0', BUDDY_PEOPLE_ENABLED='0',
                              BUDDY_OFFICE_PLUGIN_URL='', BUDDY_PEOPLE_PLUGIN_URL='',
                              BOB_LOCAL_LOGIN_ENABLED='1', KEYCLOAK_ISSUER='',
                              BOB_FILE_STORAGE='postgres', BOB_WORKSPACE=workspace)
            from fastapi.testclient import TestClient
            from app.main import app
            assert importlib.util.find_spec('buddy_office') is None
            assert importlib.util.find_spec('buddy_people') is None
            with TestClient(app, base_url='https://testserver') as client:
                assert client.get('/auth/status').json()['setup_required'] is True
                response = client.post('/auth/setup', json={'username': 'install-test',
                                                           'password': secrets.token_urlsafe(24)})
                assert response.status_code == 200, response.status_code
                assert client.get('/auth/status').json()['user']['username'] == 'install-test'
                apps = client.get('/api/apps').json()['apps']
                assert any(app['id'] == 'notes' for app in apps)
                assert not any(app['id'] in ('office', 'people') for app in apps)
                capabilities = client.get('/api/plugins').json()['plugins']
                assert all(plugin['enabled'] is False for plugin in capabilities)
                response = client.post('/sessions')
                assert response.status_code == 201, response.status_code
                conversation = response.json()['id']
                records = client.get('/sessions').json()
                assert any(item['id'] == conversation for item in records)
                assert client.get('/api/office/files').status_code == 503
                assert client.get('/api/community/rooms').status_code == 503
                assert client.get('/notifications').status_code == 200
            with psycopg.connect(os.environ['DATABASE_URL']) as db:
                names = [row[0] for row in db.execute('SELECT tablename FROM pg_tables WHERE schemaname=%s', (schema,))]
                assert 'bob_conversations' in names
                assert 'bob_chat_submissions' in names
                assert not any(name.startswith('bob_office_') or name == 'bob_chat_rooms' for name in names)
            print('Core-first setup, login, conversation creation, notifications and disabled plugins passed')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
            assert db.execute('SELECT count(*) FROM pg_database').fetchone()[0] == databases_before
        print('Disposable test schema removed; database count unchanged')


if __name__ == '__main__':
    main()
