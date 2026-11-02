"""HTTP integration with real temporary SQLite and synthetic engine responses.

No tests connect to Tetragon, providers, real user databases, or external services.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from app.admin_users import administrator
from app.auth import current_user
from buddy_tetragon.engine import EngineError, policy_name
from buddy_tetragon.service import create_app
from buddy_tetragon.store import Store

BODY = {'name': 'Synthetic file denial', 'kind': 'file',
        'paths': ['/synthetic/secret'], 'binaries': ['/synthetic/cat']}


class PluginHTTPTests(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix='buddy-tetragon-http-')
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / 'rules.sqlite')
        self.engine = MagicMock()
        self.engine.status.return_value = {'connected': True, 'message': 'Synthetic engine', 'policies': []}
        self.engine.add.return_value = {'state': 'enabled', 'mode': 'enforce'}
        self.app = create_app(store=self.store, engine=self.engine)
        self.app.dependency_overrides[administrator] = lambda: {'username': 'synthetic-admin', 'is_admin': True}
        self.client = self.enterContext(TestClient(self.app))

    def create(self, body=None):
        response = self.client.post('/api/tetragon/rules', json=body or BODY)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def url(self, rule, action=''):
        return '/api/tetragon/rules/' + rule['id'] + ('/' + action if action else '')

    def test_preview_is_not_saved_and_has_no_engine_effect(self):
        response = self.client.post('/api/tetragon/preview', json=BODY)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('Override', response.json()['yaml'])
        self.assertEqual(response.json()['policy']['spec']['lsmhooks'][0]['hook'], 'file_open')
        self.assertEqual(self.client.get('/api/tetragon/rules').json(), {'rules': [], 'audit': []})
        self.engine.add.assert_not_called()

    def test_create_apply_remove_and_delete_with_real_audit_and_persistence(self):
        rule = self.create()
        self.assertEqual(rule['revision'], 1)
        self.assertFalse(rule['enabled'])
        response = self.client.post(self.url(rule, 'apply'), json={'expected_revision': 1})
        self.assertEqual(response.status_code, 200, response.text)
        applied = response.json()
        self.assertTrue(applied['enabled'])
        self.assertTrue(applied['attempted'])
        self.assertEqual(applied['revision'], 2)
        self.assertEqual(self.engine.add.call_args.args[0]['metadata']['name'], policy_name(rule['id']))
        blocked = self.client.delete(self.url(rule), params={'expected_revision': 2})
        self.assertEqual(blocked.status_code, 409)
        response = self.client.post(self.url(rule, 'remove'), json={'expected_revision': 2})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()['enabled'])
        self.assertEqual(response.json()['revision'], 3)
        self.engine.remove.assert_called_once_with(policy_name(rule['id']))
        response = self.client.delete(self.url(rule), params={'expected_revision': 3})
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Store(self.store.path).snapshot()['rules'])
        audit = self.store.snapshot()['audit']
        self.assertEqual([(item['action'], item['outcome']) for item in reversed(audit)],
                         [('save', 'draft'), ('apply', 'requested'), ('apply', 'confirmed'),
                          ('remove', 'requested'), ('remove', 'confirmed'), ('delete', 'confirmed')])
        self.assertTrue(all(item['actor'] == 'synthetic-admin' for item in audit))

    def test_revision_replay_rejected_before_engine_or_audit(self):
        rule = self.create()
        self.assertEqual(self.client.post(self.url(rule, 'apply'), json={'expected_revision': 1}).status_code, 200)
        calls = self.engine.add.call_count
        audit = self.store.snapshot()['audit']
        for action in ('apply', 'remove'):
            response = self.client.post(self.url(rule, action), json={'expected_revision': 1})
            self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.engine.add.call_count, calls)
        self.engine.remove.assert_not_called()
        self.assertEqual(self.store.snapshot()['audit'], audit)
        self.assertEqual(self.client.delete(self.url(rule), params={'expected_revision': 1}).status_code, 409)

    def test_unknown_or_invalid_rules_and_schema_fail_closed(self):
        for body in (BODY | {'kind': 'network'}, BODY | {'binaries': []}, BODY | {'paths': ['/']},
                     BODY | {'name': '   '}, BODY | {'script': 'arbitrary code'}, BODY | {'paths': ['/x/../etc']}):
            with self.subTest(body=body):
                response = self.client.post('/api/tetragon/rules', json=body)
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.post('/api/tetragon/rules/not-a-uuid/apply', json={'expected_revision': 1}).status_code, 422)
        self.assertEqual(self.client.post('/api/tetragon/rules/22222222-2222-4222-8222-222222222222/apply', json={'expected_revision': 1}).status_code, 404)
        rule = self.create()
        for body in ({}, {'expected_revision': True}, {'expected_revision': 0}, {'expected_revision': 1, 'policy': {}}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post(self.url(rule, 'apply'), json=body).status_code, 422)
        self.engine.add.assert_not_called()

    def test_failed_apply_retains_uncertain_attempt_and_audits_failure(self):
        rule = self.create()
        self.engine.add.side_effect = EngineError('Synthetic readback failure')
        response = self.client.post(self.url(rule, 'apply'), json={'expected_revision': 1})
        self.assertEqual(response.status_code, 503)
        saved = self.store.get(rule['id'])
        self.assertFalse(saved['enabled'])
        self.assertTrue(saved['attempted'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(saved['last_error'], 'Synthetic readback failure')
        audit = self.store.snapshot()['audit']
        self.assertEqual(audit[1]['outcome'], 'requested')
        self.assertEqual(audit[0]['outcome'], 'failed')
        self.engine.status.return_value = {'connected': False, 'message': 'Synthetic offline', 'policies': []}
        response = self.client.delete(self.url(rule), params={'expected_revision': 2})
        self.assertEqual(response.status_code, 503)
        self.assertIsNotNone(self.store.get(rule['id']))
        self.engine.status.return_value = {'connected': True, 'policies': [{'name': policy_name(rule['id']), 'state': 'enabled'}]}
        self.assertEqual(self.client.delete(self.url(rule), params={'expected_revision': 2}).status_code, 409)
        self.engine.status.return_value = {'connected': True, 'policies': []}
        self.assertEqual(self.client.delete(self.url(rule), params={'expected_revision': 2}).status_code, 204)

    def test_failed_remove_retains_enabled_rule_and_prevents_deletion(self):
        rule = self.create()
        self.client.post(self.url(rule, 'apply'), json={'expected_revision': 1})
        self.engine.remove.side_effect = EngineError('Synthetic removal failure')
        response = self.client.post(self.url(rule, 'remove'), json={'expected_revision': 2})
        self.assertEqual(response.status_code, 503)
        self.assertTrue(self.store.get(rule['id'])['enabled'])
        self.assertEqual(self.store.get(rule['id'])['revision'], 3)
        self.assertEqual(self.client.delete(self.url(rule), params={'expected_revision': 3}).status_code, 409)

    def test_intent_is_committed_before_engine_call(self):
        rule = self.create()
        def check_intent(policy):
            separate = Store(self.store.path)
            self.assertTrue(separate.get(rule['id'])['attempted'])
            self.assertEqual(separate.snapshot()['audit'][0]['outcome'], 'requested')
        self.engine.add.side_effect = check_intent
        self.assertEqual(self.client.post(self.url(rule, 'apply'), json={'expected_revision': 1}).status_code, 200)

    def test_status_is_live_and_reads_are_no_store(self):
        response = self.client.get('/api/tetragon/status')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'private, no-store')
        self.engine.status.assert_called_once()
        self.engine.status.return_value = {'connected': False, 'message': 'Synthetic offline', 'policies': []}
        response = self.client.get('/api/tetragon/status')
        self.assertFalse(response.json()['connected'])
        self.assertEqual(self.client.get('/api/tetragon/rules').headers['cache-control'], 'private, no-store')

    def test_assets_are_selected_from_packaged_files_only(self):
        static = Path(__file__).parents[1] / 'buddy_tetragon' / 'static'
        name = next(static.glob('index-*.js')).name
        self.assertEqual(self.client.get('/tetragon/assets/' + name).status_code, 200)
        for path in ('%2e%2e%2fservice.py', '%2fetc%2fpasswd', 'missing.js'):
            with self.subTest(path=path):
                self.assertEqual(self.client.get('/tetragon/assets/' + path).status_code, 404)

    def test_never_applied_draft_can_delete_while_engine_offline(self):
        rule = self.create()
        self.engine.status.side_effect = AssertionError('Draft deletion must not require engine')
        self.assertEqual(self.client.delete(self.url(rule), params={'expected_revision': 1}).status_code, 204)

    def test_nonadmins_cannot_access_screen_assets_or_api(self):
        self.app.dependency_overrides.pop(administrator)
        self.app.dependency_overrides[current_user] = lambda: {'username': 'synthetic-member', 'is_admin': False}
        rule_id = '22222222-2222-4222-8222-222222222222'
        for method, path, kwargs in (
            ('get', '/tetragon/', {}), ('get', '/tetragon/assets/test.js', {}),
            ('get', '/api/tetragon/status', {}), ('get', '/api/tetragon/rules', {}),
            ('post', '/api/tetragon/preview', {'json': BODY}),
            ('post', '/api/tetragon/rules', {'json': BODY}),
            ('post', f'/api/tetragon/rules/{rule_id}/apply', {'json': {'expected_revision': 1}}),
            ('post', f'/api/tetragon/rules/{rule_id}/remove', {'json': {'expected_revision': 1}}),
            ('delete', f'/api/tetragon/rules/{rule_id}', {'params': {'expected_revision': 1}})):
            with self.subTest(path=path, method=method):
                self.assertEqual(getattr(self.client, method)(path, **kwargs).status_code, 403)
        self.engine.add.assert_not_called()
        self.engine.remove.assert_not_called()

    def test_ambient_cookie_writes_need_same_origin_metadata(self):
        self.client.cookies.set('bob_ui_session', 'synthetic-cookie')
        for headers in ({}, {'Origin': 'https://attacker.invalid'}, {'Sec-Fetch-Site': 'cross-site'},
                        {'Origin': 'https://attacker.invalid', 'Authorization': 'Bearer arbitrary'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.post('/api/tetragon/rules', json=BODY, headers=headers).status_code, 403)
        response = self.client.post('/api/tetragon/rules', json=BODY, headers={'Origin': 'http://testserver'})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(len(self.store.snapshot()['rules']), 1)
