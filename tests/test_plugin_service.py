"""Service isolation and access-boundary contracts; no live storage required."""
from pathlib import Path
import sys
from unittest import TestCase, main
from unittest.mock import patch

# Ensure all plugin packages are on sys.path
_plugins_dir = Path(__file__).resolve().parent.parent / 'plugins'
for _plugin in _plugins_dir.iterdir():
    if _plugin.is_dir() and str(_plugin) not in sys.path:
        sys.path.insert(0, str(_plugin))

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.plugin_service import create_app


async def authenticated(request):
    if request.cookies.get('bob_ui_session') == 'test-session':
        return {'username': 'tester', 'is_admin': False}
    if request.cookies.get('bob_ui_session') == 'admin-session':
        return {'username': 'admin', 'is_admin': True}
    raise HTTPException(401, 'Sign in required')


class PluginServiceTests(TestCase):
    def setUp(self):
        # Application startup normally initializes feature DDL. Unit tests never
        # touch the deployment database.
        for target in (
            'app.office.ensure_schema',
            'app.community.ensure_schema',
            'buddy_projects.service.ensure_schema',
            'app.decisions_buddy.main.db.init_db',
        ):
            patcher = patch(target)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_invalid_service_fails_closed(self):
        with self.assertRaises(ValueError):
            create_app('unexpected')

    def test_route_inventory_is_separate(self):
        def paths(router):
            result = set()
            for route in router.routes:
                if hasattr(route, 'path'):
                    result.add(route.path)
                elif hasattr(route, 'original_router'):
                    result.update(paths(route.original_router))
            return result

        office = paths(create_app('office'))
        people = paths(create_app('people'))
        projects = paths(create_app('projects'))
        decisions = paths(create_app('decisions'))

        self.assertIn('/api/office/files', office)
        self.assertIn('/api/office/callback', office)
        self.assertIn('/office-editor/{path:path}', office)
        self.assertIn('/static/office-bridge', office)

        self.assertIn('/api/community/ws', people)
        self.assertIn('/api/community/rooms/{room_id}/messages/{message_id}/reactions', people)

        self.assertIn('/api/projects/portfolio', projects)
        self.assertIn('/api/projects/work-items', projects)

        self.assertIn('/models', decisions)
        self.assertIn('/evaluate', decisions)

        self.assertFalse(any(p.startswith('/api/community') for p in office))
        self.assertFalse(any(p.startswith('/api/office') for p in people))
        self.assertFalse(any(p.startswith('/api/projects') for p in office | people))
        self.assertNotIn('/auth/login', office | people | projects | decisions)

    def test_liveness_is_public_and_manifest_requires_shared_session(self):
        with patch('app.auth.current_user', authenticated):
            for service in ('office', 'people'):
                with TestClient(create_app(service)) as client:
                    self.assertEqual(client.get('/health').json(), {'ok': True})
                    self.assertEqual(client.get('/plugins/manifest').status_code, 401)
                    self.assertEqual(client.get('/openapi.json').status_code, 401)
                    client.cookies.set('bob_ui_session', 'test-session')
                    response = client.get('/plugins/manifest')
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()['id'], service)
                    self.assertEqual(response.headers['cache-control'], 'private, no-store')

    def test_projects_and_decisions_health_and_anonymous_protection(self):
        with patch('app.auth.current_user', authenticated):
            for service in ('projects', 'decisions'):
                with TestClient(create_app(service)) as client:
                    self.assertEqual(client.get('/health').json(), {'ok': True})

            with TestClient(create_app('projects')) as client:
                # Anonymous calls to protected project routes must be rejected
                self.assertEqual(client.get('/api/projects/portfolio').status_code, 401)

            with TestClient(create_app('decisions')) as client:
                self.assertEqual(client.get('/models').status_code, 401)

    def test_projects_parameter_validation(self):
        with patch('app.auth.current_user', authenticated):
            with TestClient(create_app('projects')) as client:
                # Non-admin writing to projects returns 403
                client.cookies.set('bob_ui_session', 'test-session')
                res_non_admin = client.post('/api/projects/projects', json={'name': 'Project 1'})
                self.assertEqual(res_non_admin.status_code, 403)

                # Admin user writing invalid parameters
                client.cookies.set('bob_ui_session', 'admin-session')

                # 1. Blank name returns 422
                bad_name = {'name': '   ', 'description': 'desc'}
                res1 = client.post('/api/projects/projects', json=bad_name)
                self.assertEqual(res1.status_code, 422)

                # 2. Start date after due date returns 422
                bad_dates = {
                    'name': 'Sprint 1',
                    'start_date': '2026-12-31',
                    'due_date': '2026-01-01',
                }
                res2 = client.post('/api/projects/projects', json=bad_dates)
                self.assertEqual(res2.status_code, 422)

                # 3. Invalid priority returns 422
                bad_priority = {'name': 'Sprint 1', 'priority': 'extreme'}
                res3 = client.post('/api/projects/projects', json=bad_priority)
                self.assertEqual(res3.status_code, 422)

    def test_office_anonymous_file_and_static_are_protected(self):
        with patch('app.auth.current_user', authenticated):
            with TestClient(create_app('office')) as client:
                for path in ('/api/office/files', '/static/office-bridge/index.html',
                             '/office-editor/web-apps/apps/api/documents/api.js'):
                    self.assertEqual(client.get(path).status_code, 401)

    def test_readiness_masks_database_failure(self):
        with patch('app.job_queue._connect', side_effect=RuntimeError('secret database url')):
            with TestClient(create_app('people')) as client:
                response = client.get('/ready')
                self.assertEqual(response.status_code, 503)
                self.assertNotIn('secret', response.text)

    def test_onlyoffice_capability_endpoints_retain_their_signature_checks(self):
        # The boundary must let these reach the *existing* signed handlers. Invalid
        # input should fail protocol validation, rather than request browser login.
        with patch('app.auth.current_user', authenticated), patch('app.office.secret', return_value='test-only-key'):
            with TestClient(create_app('office')) as client:
                response = client.post('/api/office/callback', json={})
                self.assertEqual(response.status_code, 403)
                response = client.get('/api/office/source/00000000-0000-0000-0000-000000000000?token=invalid')
                self.assertEqual(response.status_code, 403)


if __name__ == '__main__':
    main()
