"""Projects discovery, transport and shared-login contracts without live data."""
import json
import os
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.app_registry import registry
from app.plugin_gateway import PluginGatewayMiddleware
from app.plugin_host import application


class ProjectsRegistryContracts(unittest.TestCase):
    def test_optional_launcher_and_reserved_identity(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            'BUDDY_APP_MANIFEST_DIR': folder, 'BUDDY_PROJECTS_ENABLED': '0',
            'BUDDY_OFFICE_ENABLED': '0', 'BUDDY_PEOPLE_ENABLED': '0', 'DOCMOST_URL': '',
        }):
            # An administrator manifest must not impersonate the bundled feature.
            Path(folder, 'impersonator.json').write_text(json.dumps({
                'id': 'projects', 'name': 'Replacement', 'url': 'https://example.com',
            }))
            user = {'username': 'fixture', 'is_admin': False}
            self.assertNotIn('projects', {item['id'] for item in registry(user)['apps']})
            with patch.dict(os.environ, {'BUDDY_PROJECTS_ENABLED': '1'}):
                apps = [item for item in registry(user)['apps'] if item['id'] == 'projects']
                self.assertEqual(len(apps), 1)
                self.assertEqual(apps[0]['launch']['kind'], 'projects')
                self.assertFalse(apps[0]['desktop_only'])
                self.assertNotEqual(apps[0]['name'], 'Replacement')


class ProjectsGatewayContracts(unittest.IsolatedAsyncioTestCase):
    async def request(self, app, path='/api/projects/projects'):
        messages = []
        async def receive():
            return {'type': 'http.request', 'body': b'{"name":"fixture"}'}
        async def send(message):
            messages.append(message)
        await app({'type': 'http', 'method': 'POST', 'path': path,
                   'raw_path': path.encode(), 'query_string': b'', 'headers': [
                       (b'host', b'buddy.example'), (b'origin', b'https://buddy.example'),
                       (b'cookie', b'bob_ui_session=fixture-session'),
                       (b'x-user-id', b'forged-admin'), (b'x-buddy-user', b'forged-admin'),
                   ]}, receive, send)
        return messages

    async def test_service_preserves_shared_session_and_strips_identity_spoofing(self):
        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"ok":true}'
        async def upstream(request):
            self.assertEqual(str(request.url), 'http://projects:8080/api/projects/projects')
            self.assertEqual(request.headers['cookie'], 'bob_ui_session=fixture-session')
            self.assertEqual(request.headers['origin'], 'https://buddy.example')
            self.assertEqual(request.headers['host'], 'buddy.example')
            self.assertNotIn('x-user-id', request.headers)
            self.assertNotIn('x-buddy-user', request.headers)
            self.assertEqual(await request.aread(), b'{"name":"fixture"}')
            return httpx.Response(200, stream=Body())
        app = PluginGatewayMiddleware(None, environ={
            'BUDDY_PROJECTS_ENABLED': '1', 'BUDDY_PROJECTS_PLUGIN_URL': 'http://projects:8080',
        }, transport=httpx.MockTransport(upstream))
        result = await self.request(app)
        self.assertEqual(result[0]['status'], 200)
        self.assertEqual(b''.join(item.get('body', b'') for item in result), b'{"ok":true}')

    async def test_disabled_and_prefix_boundaries(self):
        calls = []
        async def fallback(scope, receive, send):
            calls.append(scope['path'])
        app = PluginGatewayMiddleware(fallback, environ={'BUDDY_PROJECTS_ENABLED': '0'})
        self.assertEqual((await self.request(app))[0]['status'], 503)
        await self.request(app, '/api/projectsmanship')
        await self.request(app, '/projects')  # Existing code-workspace API is distinct.
        self.assertEqual(calls, ['/api/projectsmanship', '/projects'])


class ProjectsHostContracts(unittest.TestCase):
    def test_factory_loads_projects_package_without_other_plugin_routes(self):
        from app.plugin_service import create_app
        source = str(Path(__file__).resolve().parents[1] / 'plugins' / 'projects')
        with patch.object(sys, 'path', [source, *sys.path]):
            with patch('buddy_projects.service.ensure_schema'):
                app = create_app('projects')
        def paths(router):
            result = set()
            for route in router.routes:
                if hasattr(route, 'path'):
                    result.add(route.path)
                elif hasattr(route, 'original_router'):
                    result.update(paths(route.original_router))
            return result
        inventory = paths(app)
        self.assertIn('/api/projects/portfolio', inventory)
        self.assertIn('/api/projects/impact/preview', inventory)
        self.assertIn('/api/projects/impact/apply', inventory)
        self.assertIn('/api/projects/work-items', inventory)
        self.assertIn('/api/projects/work-items/{item_id}', inventory)
        self.assertFalse(any(path.startswith(('/api/community', '/api/office', '/auth/')) for path in inventory))

    def test_manifest_private_and_exact_schema_contract(self):
        @asynccontextmanager
        async def lifespan(app):
            yield
        async def authenticate(request):
            if request.cookies.get('bob_ui_session') != 'fixture-session':
                raise HTTPException(401, 'Sign in required')
            return {'username': 'fixture', 'is_admin': False}
        with patch('app.auth.current_user', authenticate):
            with TestClient(application('projects', '1.0.0', lifespan)) as client:
                self.assertEqual(client.get('/health').json(), {'ok': True})
                self.assertEqual(client.get('/plugins/manifest').status_code, 401)
                self.assertEqual(client.get('/api/projects/people').status_code, 401)
                client.cookies.set('bob_ui_session', 'fixture-session')
                response = client.get('/plugins/manifest')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {
                    'id': 'projects', 'version': '1.0.0', 'runtime_api': 1,
                    'schema': 'projects', 'api_prefix': '/api/projects',
                })
                self.assertEqual(response.headers['cache-control'], 'private, no-store')


if __name__ == '__main__':
    unittest.main()
