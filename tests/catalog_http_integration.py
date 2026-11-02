"""Real authenticated HTTP catalogs and productivity routes in a disposable schema."""
import os
import secrets
from unittest.mock import AsyncMock, patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import auth, rag
from app.main import app


def main():
    original = os.environ['DATABASE_URL']
    schema = 'buddy_catalog_http_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_FILE_STORAGE': 'postgres', 'BOB_UI_SECURE_COOKIE': '0'}):
            rag._schema_ready = False
            password = secrets.token_urlsafe(24)
            for name in ('fixtureadmin', 'fixturealice', 'fixturebob'):
                auth.create_user(name, password, admin=name == 'fixtureadmin')
            with TestClient(app) as admin, TestClient(app) as alice, TestClient(app) as bob, TestClient(app) as anonymous:
                for client in (admin, alice, bob, anonymous):
                    client.headers['Origin'] = 'http://testserver'
                for client, name in ((admin, 'fixtureadmin'), (alice, 'fixturealice'), (bob, 'fixturebob')):
                    assert client.post('/auth/login', json={'username': name, 'password': password}).status_code == 200
                for endpoint in ('/mcp-catalog', '/agent-catalog', '/notifications', '/productivity/recipes'):
                    assert anonymous.get(endpoint).status_code == 401, endpoint
                template = {'id': 'http-fixture', 'name': 'Synthetic MCP', 'description': 'Synthetic fixture', 'url': 'https://example.invalid/mcp', 'fields': [{'key': 'token', 'label': 'Token', 'target': 'Authorization', 'prefix': 'Bearer '}], 'access_mode': 'users', 'users': ['fixturealice']}
                assert alice.put('/mcp-catalog/http-fixture', json=template).status_code == 403
                assert admin.put('/mcp-catalog/http-fixture', json=template).status_code == 200
                assert not any(item['id'] == 'http-fixture' for item in bob.get('/mcp-catalog').json())
                result = alice.post('/mcp-catalog/http-fixture/connect', json={'credentials': {'token': 'synthetic-private-token'}})
                assert result.status_code == 200, result.text
                assert 'synthetic-private-token' not in alice.get('/mcp-catalog').text
                assert bob.post('/mcp-catalog/http-fixture/connect', json={'credentials': {'token': 'no'}}).status_code == 404
                with patch('app.mcp_health.probe_mcp', new_callable=AsyncMock, return_value={'status': 'working', 'message': 'Synthetic handshake fixture'}) as probe:
                    assert alice.post('/mcp-catalog/http-fixture/check').json()['status'] == 'working'
                    assert probe.call_args.kwargs['cwd']
                assert alice.put('/mcp-catalog/http-fixture/access', json={'users': ['fixturealice']}).status_code == 403
                assert admin.put('/mcp-catalog/http-fixture/access', json={'groups': ['company'], 'users': ['fixturebob']}).status_code == 200
                with patch('app.mcp_health.probe_mcp', new_callable=AsyncMock, return_value={'status': 'working'}) as probe:
                    assert alice.post('/mcp-catalog/http-fixture/check').status_code == 200
                    assert probe.call_args.args[0]['headers']['Authorization'] == 'Bearer synthetic-private-token'
                assert admin.put('/mcp-catalog/http-fixture/access', json={'groups': [], 'users': ['fixturebob']}).status_code == 200
                assert alice.post('/mcp-catalog/http-fixture/check').status_code == 404
                assert admin.put('/mcp-catalog/http-fixture/access', json={'groups': ['unknown']}).status_code == 422
                assert admin.put('/mcp-catalog/missing/access', json={'users': []}).status_code == 404
                assert admin.put('/mcp-catalog/http-fixture', json={**template, 'users': ['fixturebob']}).status_code == 200
                assert alice.post('/mcp-catalog/http-fixture/check').status_code == 404

                discovered = {'name': 'Synthetic agent', 'description': 'Synthetic capability fixture', 'endpoint': 'https://example.invalid/a2a', 'card_url': 'https://example.invalid/card', 'protocol_version': '0.3', 'api_key_header': 'x-api-key', 'capabilities': {'streaming': True}, 'skills': [{'id': 'fixture', 'name': 'Synthetic skill', 'description': 'Fixture only'}]}
                agent = {'id': 'http-fixture', 'card_url': discovered['card_url'], 'description': 'Reviewed fixture description', 'users': ['fixturealice']}
                assert alice.put('/admin/agent-catalog/http-fixture', json=agent).status_code == 403
                with patch('app.agent_catalog.discover_agent', new_callable=AsyncMock, return_value=discovered):
                    result = admin.put('/admin/agent-catalog/http-fixture', json=agent)
                    assert result.status_code == 200, result.text
                assert bob.get('/agent-catalog').json() == []
                assert alice.put('/agent-catalog/http-fixture/activation', json={'api_key': 'synthetic-agent-secret'}).status_code == 200
                registered = alice.get('/agents')
                assert registered.status_code == 200, registered.text
                entry = next(item for item in registered.json() if item['slug'] == 'catalog-http-fixture')
                assert entry['skills'][0]['id'] == 'fixture'
                assert 'synthetic-agent-secret' not in registered.text
                assert admin.put('/admin/agent-catalog/http-fixture/access', json={'users': ['fixturebob']}).status_code == 200
                assert not any(item['slug'] == 'catalog-http-fixture' for item in alice.get('/agents').json())

                project = alice.post('/projects', json={'name': 'Synthetic project'}).json()
                memory_url = '/projects/' + project['id'] + '/memory'
                response = alice.put(memory_url, json={'brief': 'Synthetic project brief', 'revision': 0})
                assert response.status_code == 200, response.text
                assert alice.put(memory_url, json={'brief': 'stale', 'revision': 0}).status_code == 409
                assert bob.get(memory_url).status_code == 404
                recipe = alice.post('/productivity/recipes', json={'name': 'Synthetic recipe', 'instructions': 'Use actual sources'}).json()
                assert bob.delete('/productivity/recipes/' + recipe['id']).status_code == 404
                assert len(alice.get('/productivity/recipes').json()) == 1
                result = alice.post('/productivity/csv/explore', json={'content': 'name,value\na,2\nb,3\n', 'column': 1}).json()
                assert result['stats']['sum'] == 5
                assert alice.get('/notifications').status_code == 200
                assert bob.post('/notifications/read', json={'id': 'task:not-owned'}).status_code == 404
                print('PASS real HTTP authentication, independent catalog grants, private credentials, runtime revocation, nested agent responses, memory revisions, recipes and data exploration')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
