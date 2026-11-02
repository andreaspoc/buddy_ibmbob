"""Decision settings are administrator-only; flow authoring needs explicit group access."""
import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import current_user
from app.decisions_buddy import main as decisions, watsonx_inference as watsonx

ADMIN = {'username': 'fixture-admin', 'is_admin': True}
AUTHOR = {'username': 'fixture-author', 'is_admin': False}
VIEWER = {'username': 'fixture-viewer', 'is_admin': False}
GRAPH = {'nodes': [{'id': 'e', 'type': 'expressionNode', 'content': {'expressions': [{'key': 'a', 'value': '1'}]}}], 'edges': []}
MODEL = {'id': 'm1', 'name': 'Model', 'graph': GRAPH, 'expectedVersion': 0}


def group_lookup(row):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = row
    context = MagicMock()
    context.__enter__.return_value = connection
    return patch('app.app_groups._connect', return_value=context), connection


def client_for(user):
    app = FastAPI()
    app.include_router(decisions.router)
    app.dependency_overrides[current_user] = lambda: user
    app.dependency_overrides[decisions.permitted] = lambda: user
    return TestClient(app)


class CanAuthorTests(unittest.TestCase):
    def test_administrator_needs_no_group_lookup(self):
        lookup, connection = group_lookup(None)
        with lookup:
            self.assertTrue(decisions.can_author(ADMIN))
        connection.execute.assert_not_called()

    def test_membership_is_checked_for_the_signed_in_user(self):
        lookup, connection = group_lookup((1,))
        with lookup:
            self.assertTrue(decisions.can_author(AUTHOR))
        self.assertEqual(connection.execute.call_args.args[1], ('fixture-author', 'Decision authors'))

    def test_no_membership_means_no_access(self):
        lookup, _ = group_lookup(None)
        with lookup:
            self.assertFalse(decisions.can_author(VIEWER))


class RouteAccessTests(unittest.TestCase):
    def assert_status(self, user, member, method, path, expected, **kwargs):
        lookup, _ = group_lookup((1,) if member else None)
        with lookup:
            self.assertEqual(getattr(client_for(user), method)(path, **kwargs).status_code, expected, path)

    def test_settings_are_administrator_only(self):
        routes = (('get', '/api/decisions/admin/integrations', {}),
                  ('put', '/api/decisions/admin/integrations/ikc', {'json': {}}),
                  ('post', '/api/decisions/admin/integrations/ikc/test', {}),
                  ('post', '/api/decisions/watsonx/test', {'json': {}}))
        for method, path, kwargs in routes:
            with self.subTest(path=path):
                self.assert_status(AUTHOR, True, method, path, 403, **kwargs)
        with patch.object(decisions, 'get_public_settings', return_value={'providers': {}}):
            self.assert_status(ADMIN, False, 'get', '/api/decisions/admin/integrations', 200)

    def test_viewer_cannot_author_or_run_unsaved_flows(self):
        routes = (('post', '/api/decisions/models', {'json': MODEL}),
                  ('delete', '/api/decisions/models/m1?expectedVersion=1', {}),
                  ('post', '/api/decisions/models/m1/rollback?version=1&expectedVersion=2', {}),
                  ('put', '/api/decisions/models/m1/test-cases', {'json': {'expectedVersion': 1, 'expectedSuiteRevision': 0, 'cases': [{'name': 'a', 'expected': 1}]}}),
                  ('post', '/api/decisions/assistant/generate-flow', {'json': {'prompt': 'x'}}),
                  ('post', '/api/decisions/evaluate', {'json': {'graph': GRAPH}}),
                  ('post', '/api/decisions/evaluate/batch', {'json': {'graph': GRAPH, 'items': [{}]}}),
                  ('post', '/api/decisions/analyze', {'json': {'graph': GRAPH}}),
                  ('post', '/api/decisions/dvs/evaluate', {'json': {'graph': GRAPH}}))
        for method, path, kwargs in routes:
            with self.subTest(path=path):
                self.assert_status(VIEWER, False, method, path, 403, **kwargs)

    def test_group_member_can_create_a_flow(self):
        saved = {'id': 'm1', 'version': 1}
        with patch.object(decisions.db, 'save_decision', return_value=saved):
            self.assert_status(AUTHOR, True, 'post', '/api/decisions/models', 200, json=MODEL)

    def test_viewer_can_still_run_a_saved_decision_they_can_read(self):
        readable = {'id': 'm1', 'version': 1, 'owner': 'someone', 'accessPolicy': 'authenticated', 'graph': GRAPH}
        with patch.object(decisions.db, 'get_decision', return_value=readable), patch.object(decisions.db, 'log_evaluation'):
            self.assert_status(VIEWER, False, 'post', '/api/decisions/evaluate', 200, json={'decisionId': 'm1'})

    def test_profile_reports_authoring_access(self):
        lookup, _ = group_lookup((1,))
        with lookup:
            body = client_for(AUTHOR).get('/api/decisions/me').json()
        self.assertEqual((body['username'], body['isAdmin'], body['canAuthor']), ('fixture-author', False, True))


class SavedKeyTests(unittest.TestCase):
    SETTINGS = {'base_url': 'https://saved.invalid', 'api_key': 'saved-key'}

    def test_saved_key_only_goes_to_the_saved_service(self):
        self.assertEqual(watsonx._saved_key(self.SETTINGS, 'https://saved.invalid'), 'saved-key')
        self.assertEqual(watsonx._saved_key(self.SETTINGS, 'https://saved.invalid/ml/v1/text/generation'), 'saved-key')

    def test_saved_key_is_withheld_from_other_hosts(self):
        for host in ('https://attacker.invalid', 'https://saved.invalid.attacker.invalid'):
            with self.subTest(host=host):
                self.assertEqual(watsonx._saved_key(self.SETTINGS, host), '')

    def test_no_saved_service_means_no_saved_key(self):
        with patch.dict('os.environ', {'WATSONX_URL': '', 'WATSONX_APIKEY': 'env-key'}):
            self.assertEqual(watsonx._saved_key({}, 'https://attacker.invalid'), '')


if __name__ == '__main__':
    unittest.main()
