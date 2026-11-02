import json
import os
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import patch
from app.app_registry import registry, _safe_url


class RegistryContracts(TestCase):
    def test_learning_opens_in_current_window(self):
        with patch.dict(os.environ, {'BUDDY_LEARNING_ENABLED': '1'}):
            app = next(app for app in registry({'username': 'example', 'is_admin': False})['apps'] if app['id'] == 'learning')
        self.assertEqual(app['launch'], {'kind': 'link', 'url': '/learning/', 'target': '_self'})

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        environment = patch.dict(os.environ, {'BUDDY_APP_MANIFEST_DIR': self.folder.name,
            'BUDDY_OFFICE_ENABLED': '0', 'BUDDY_PEOPLE_ENABLED': '0', 'DOCMOST_URL': ''})
        environment.start()
        self.addCleanup(environment.stop)
        self.user = {'username': 'example', 'is_admin': False}

    def write(self, name='example.json', **changes):
        data = {'id': 'example-app', 'name': 'Example', 'description': 'Test fixture',
                'url': 'https://example.com/app', **changes}
        (Path(self.folder.name) / name).write_text(json.dumps(data))

    def ids(self, user=None):
        return {app['id'] for app in registry(user or self.user)['apps']}

    def test_core_only_has_existing_tools_without_addons(self):
        self.assertTrue({'chat', 'notes', 'tasks', 'knowledge', 'research', 'workflows'}.issubset(self.ids()))
        self.assertFalse({'office', 'people', 'docmost'}.intersection(self.ids()))

    def test_presentations_and_productivity_are_core_apps_with_launch_contracts(self):
        apps = {app['id']: app for app in registry(self.user)['apps']}
        for identity in ('presentations', 'productivity'):
            self.assertEqual(apps[identity]['kind'], 'core')
            self.assertEqual(apps[identity]['launch']['kind'], identity)
            self.assertFalse(apps[identity]['desktop_only'])
        self.assertEqual(apps['presentations']['name'], 'Presentations')
        self.assertEqual(apps['productivity']['name'], 'Productivity workspace')
        self.assertIn('connections', apps, 'Retain legacy connections discovery contract')

    def test_deployed_plugins_are_independent_and_keep_launch_contracts(self):
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}):
            apps = {app['id']: app for app in registry(self.user)['apps']}
            self.assertTrue(apps['office']['desktop_only'])
            self.assertEqual(apps['office']['launch']['kind'], 'office')
            self.assertNotIn('people', apps)
        with patch.dict(os.environ, {'BUDDY_PEOPLE_ENABLED': '1'}):
            self.assertIn('people', self.ids())
            self.assertNotIn('office', self.ids())

    def test_docmost_is_not_an_app_even_when_configured(self):
        with patch.dict(os.environ, {'DOCMOST_URL': 'https://docs.example.com',
                                    'DOCMOST_ALLOWED_GROUPS': 'administrators', 'DOCMOST_ALLOWED_USERS': ''}):
            self.assertNotIn('docmost', self.ids())
            self.assertNotIn('docmost', self.ids({**self.user, 'is_admin': True}))

    def test_registration_updates_without_core_code_changes(self):
        with patch('app.auth.user_group_names', return_value=set()):
            self.write()
            self.assertIn('example-app', self.ids())
            self.write(enabled=False)
            self.assertNotIn('example-app', self.ids())
            self.write(users=['someone-else'])
            self.assertNotIn('example-app', self.ids())
        with patch('app.auth.user_group_names', return_value={'engineering'}):
            self.write(groups=['administrators'])
            self.assertIn('example-app', self.ids({**self.user, 'is_admin': True}))
            self.write(groups=['engineering'])
            self.assertIn('example-app', self.ids())
            self.write(groups=['sales'])
            self.assertNotIn('example-app', self.ids())

    def test_invalid_and_duplicate_manifests_cannot_replace_core(self):
        self.write(id='notes', name='Replacement')
        (Path(self.folder.name)/'invalid.json').write_text('{bad')
        self.write('unsafe.json', id='unsafe', url='javascript:alert(1)')
        self.assertEqual(next(app['name'] for app in registry(self.user)['apps'] if app['id']=='notes'), 'Notes')
        self.assertNotIn('unsafe', self.ids())

    def test_urls_reject_active_content_and_ambiguous_origins(self):
        for value in ('javascript:alert(1)', '//evil.example', '/%2fevil', '/\\evil', 'https://u:p@example.com', 'https://[invalid', 'https://example.com:bad', 'http://example.com', '/ok\nBad'):
            self.assertFalse(_safe_url(value), value)
        self.assertTrue(_safe_url('/team-portal/'))
        self.assertTrue(_safe_url('https://example.com/app'))

    def test_api_discovery_requires_login_and_stays_private(self):
        from fastapi import FastAPI, HTTPException
        from fastapi.testclient import TestClient
        from app.app_registry import router
        from app.auth import current_user
        from app.access_boundary import AccessBoundaryMiddleware
        user = self.user
        async def authenticate(request):
            if request.cookies.get('session') != 'fixture':
                raise HTTPException(401)
            return user
        application = FastAPI()
        application.add_middleware(AccessBoundaryMiddleware, authenticate=authenticate)
        application.include_router(router)
        application.dependency_overrides[current_user] = lambda: user
        with TestClient(application) as client:
            self.assertEqual(client.get('/api/apps').status_code, 401)
            client.cookies.set('session', 'fixture')
            response = client.get('/api/apps')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['cache-control'], 'private, no-store')


class TetragonRegistryContracts(TestCase):
    def test_tetragon_is_admin_only_and_launches_plugin(self):
        with patch.dict(os.environ, {'BUDDY_TETRAGON_ENABLED': '1', 'BUDDY_APP_MANIFEST_DIR': '/nonexistent'}):
            normal = registry({'username': 'member', 'is_admin': False})
            self.assertFalse(any(a['id'] == 'tetragon' for a in normal['apps']))
            admin = registry({'username': 'admin', 'is_admin': True})
            app = next(a for a in admin['apps'] if a['id'] == 'tetragon')
            self.assertEqual(app['launch'], {'kind': 'link', 'url': '/tetragon/'})
        with patch.dict(os.environ, {'BUDDY_TETRAGON_ENABLED': '0', 'BUDDY_APP_MANIFEST_DIR': '/nonexistent'}):
            self.assertFalse(any(a['id'] == 'tetragon' for a in registry({'username': 'admin', 'is_admin': True})['apps']))
