"""Actual cookies, administrator permissions and document ACLs in a disposable schema."""
import os
import secrets
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from tests.group_fixtures import make_group, set_members
from app import auth, rag
from app.main import app


def main():
    original = os.environ['DATABASE_URL']
    schema = 'buddy_admin_http_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_FILE_STORAGE': 'postgres', 'BOB_UI_SECURE_COOKIE': '0'}):
            rag._schema_ready = False
            password = secrets.token_urlsafe(24)
            auth.create_user('fixtureadmin', password, admin=True)
            auth.create_user('fixtureemployee', password)
            with TestClient(app) as admin, TestClient(app) as employee, TestClient(app) as anonymous:
                for client, name in ((admin, 'fixtureadmin'), (employee, 'fixtureemployee')):
                    response = client.post('/auth/login', json={'username': name, 'password': password})
                    assert response.status_code == 200, response.text
                assert anonymous.get('/admin/users').status_code == 401
                assert employee.get('/admin/users').status_code == 403
                assignments = {'is_admin': False}
                group_a = make_group('alpha', 'fixtureemployee')
                group_b = make_group('beta')
                assert employee.put('/admin/users/fixtureemployee', json={**assignments, 'is_admin': True}).status_code == 403
                assert employee.post('/admin/administrators', json={'email': 'fixture@example.invalid'}).status_code == 403
                assert admin.put('/admin/users/fixtureemployee', json=assignments).status_code == 200
                assert admin.put('/admin/users/fixtureadmin', json={**assignments, 'is_admin': False}).status_code == 409
                response = admin.post('/knowledge', files={'file': ('policy.txt', b'Explicit synthetic policy fixture.')}, data={'knowledge_base': 'company', 'audience': group_a})
                assert response.status_code == 201, response.text
                document = response.json()
                path = '/knowledge/' + document['id']
                assert employee.get(path + '/file').status_code == 200
                assert employee.post('/knowledge', files={'file': ('forbidden.txt', b'fixture')}).status_code == 403
                assert employee.patch(path, json={'knowledge_base': 'company', 'audience': 'both'}).status_code == 403
                edited = admin.patch(path, json={'knowledge_base': 'company', 'audience': group_b, 'description': 'Reclassified fixture'})
                assert edited.status_code == 200, edited.text
                assert edited.json()['description'] == 'Reclassified fixture'
                assert employee.get('/knowledge').json() == []
                assert employee.get(path + '/file').status_code == 404
                assert employee.get(path + '/preview').status_code == 404
                assert employee.get(path + '/prepared').status_code == 404
                assert admin.get(path + '/file').status_code == 200
                set_members(group_b, 'fixtureemployee')
                assert employee.get(path + '/file').status_code == 200
                set_members(group_b)
                assert employee.get(path + '/file').status_code == 404
                invalid = admin.patch(path, json={'knowledge_base': 'invalid', 'audience': 'both', 'description': 'must not apply'})
                assert invalid.status_code == 422
                assert admin.get('/knowledge').json()[0]['description'] == 'Reclassified fixture'
                assert admin.post('/admin/administrators', json={'email': 'future@example.invalid'}).status_code == 200
                assert 'future@example.invalid' in admin.get('/admin/users').json()['pending_admins']
                assert admin.delete('/admin/administrators/future@example.invalid').status_code == 200
                assert 'future@example.invalid' not in admin.get('/admin/users').json()['pending_admins']
                assignments['is_admin'] = True
                assert admin.put('/admin/users/fixtureemployee', json=assignments).status_code == 200
                assert employee.get('/admin/users').status_code == 200
                assignments['is_admin'] = False
                assert admin.put('/admin/users/fixtureemployee', json=assignments).status_code == 200
                assert employee.get('/admin/users').status_code == 403
        print('Administrator/knowledge HTTP integration passed: real sessions, role changes, last-admin guard, classification, downloads and citation ACLs.')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
