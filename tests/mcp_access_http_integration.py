"""Real HTTP sessions and MCP management ACLs in a disposable database schema."""
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
    schema = 'buddy_mcp_http_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_FILE_STORAGE': 'postgres', 'BOB_UI_SECURE_COOKIE': '0'}):
            rag._schema_ready = False
            password = secrets.token_urlsafe(24)
            auth.create_user('fixtureadmin', password, admin=True)
            auth.create_user('fixturebuddy', password)
            auth.create_user('fixturemeridien', password)
            with TestClient(app) as admin, TestClient(app) as buddy, TestClient(app) as meridien, TestClient(app) as anonymous:
                for client in (admin, buddy, meridien, anonymous):
                    client.headers['Origin'] = 'http://testserver'
                for client, name in ((admin, 'fixtureadmin'), (buddy, 'fixturebuddy'), (meridien, 'fixturemeridien')):
                    response = client.post('/auth/login', json={'username': name, 'password': password})
                    assert response.status_code == 200, response.text
                assert anonymous.get('/mcps').status_code == 401
                group_a = make_group('alpha', 'fixturebuddy')
                group_b = make_group('beta', 'fixturemeridien')
                group_restricted = make_group('restricted', 'fixturemeridien')
                definitions = [
                    ('fixture-common', 'company', 'both'),
                    ('fixture-buddy', 'company', group_a),
                    ('fixture-meridien', 'company', group_b),
                    ('fixture-restricted', 'company', group_restricted),
                    ('fixture-restricted-meridien', 'company', group_b),
                ]
                for name, base, audience in definitions:
                    body = {'name': name, 'transport': 'http', 'url': 'https://example.com/mcp?key=secret-query', 'headers': {'Authorization': 'secret-header'}, 'knowledge_base': base, 'audience': audience}
                    response = admin.post('/mcps', json=body)
                    assert response.status_code == 201, response.text
                    assert 'secret-' not in response.text, response.text
                    for endpoint in ['/mcps', '/mcps/check']:
                        assert buddy.post(endpoint, json=body).status_code == 403
                    path = '/mcps/' + name
                    assert buddy.get(path + '/config').status_code == 403
                    assert buddy.put(path, json=body).status_code == 403
                    assert buddy.delete(path).status_code == 403
                    assert buddy.patch(path + '/access', json={'knowledge_base': 'company', 'audience': 'both'}).status_code == 403
                    managed = admin.get(path + '/config')
                    assert managed.status_code == 200, managed.text
                    assert managed.json()['knowledge_base'] == base
                def fixtures(payload):
                    return {item['name'] for item in payload if item['name'].startswith('fixture-')}
                expected_buddy = {'fixture-common', 'fixture-buddy'}
                expected_meridien = {'fixture-common', 'fixture-meridien', 'fixture-restricted', 'fixture-restricted-meridien'}
                for client, expected in [(buddy, expected_buddy), (meridien, expected_meridien)]:
                    result = client.get('/mcps')
                    assert result.status_code == 200, result.text
                    assert fixtures(result.json()) == expected
                    assert 'secret-' not in result.text
                    access = client.get('/access/me')
                    assert access.status_code == 200, access.text
                    assert fixtures(access.json()['mcps']) == expected
                managed_catalog = admin.get('/mcps').json()
                assert fixtures(managed_catalog) == {name for name, _, _ in definitions}
                assert not next(row for row in managed_catalog if row['name'] == 'fixture-restricted')['allowed']
                preview = admin.post('/admin/access-preview', json={'groups': [group_b, group_restricted]})
                assert preview.status_code == 200, preview.text
                assert fixtures(preview.json()['mcps']) == expected_meridien
                assert buddy.post('/admin/access-preview', json={'groups': [group_b, group_restricted]}).status_code == 403
                assert buddy.post('/mcps/fixture-restricted/check').status_code == 404
                path = '/mcps/fixture-restricted-meridien'
                changed = admin.patch(path + '/access', json={'knowledge_base': 'company', 'audience': 'both'})
                assert changed.status_code == 200, changed.text
                assert 'fixture-restricted-meridien' in fixtures(buddy.get('/mcps').json())
                changed = admin.patch(path + '/access', json={'knowledge_base': 'company', 'audience': group_restricted})
                assert changed.status_code == 200, changed.text
                assert 'fixture-restricted-meridien' not in fixtures(buddy.get('/mcps').json())
                set_members(group_restricted)
                assert 'fixture-restricted-meridien' not in fixtures(meridien.get('/mcps').json())
                assert meridien.post(path + '/check').status_code == 404
                body = {'name': 'fixture-common', 'transport': 'stdio', 'command': 'python3', 'args': ['-m', 'fixture'], 'knowledge_base': 'company', 'audience': group_a}
                changed = admin.put('/mcps/fixture-common', json=body)
                assert changed.status_code == 200, changed.text
                assert 'fixture-common' not in fixtures(buddy.get('/mcps').json())
                assert admin.delete('/mcps/fixture-common').status_code == 204
                assert admin.get('/mcps/fixture-common/config').status_code == 404
                audit = admin.get('/admin/audit', params={'limit': 100})
                assert audit.status_code == 200, audit.text
                assert 'secret-query' not in audit.text and 'secret-header' not in audit.text
                actions = {item['action'] for item in audit.json()['events']}
                assert {'create-mcp', 'update-mcp', 'classify-mcp', 'delete-mcp'} <= actions
                assert buddy.get('/admin/audit').status_code == 403
        print('MCP HTTP integration passed: real sessions, scope matrix, admin-only management, secret redaction, previews and revocation.')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
