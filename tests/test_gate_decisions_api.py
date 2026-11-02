"""DecisionsBuddy HTTP contract with synthetic records and a mocked persistence layer."""
import asyncio
import base64
from copy import deepcopy
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI, HTTPException, WebSocketDisconnect
from fastapi.testclient import TestClient

from app.admin_users import administrator
from app.auth import current_user
from app.decisions_buddy import main as api
from app.decisions_buddy.cp4d_settings import GovernanceError
from buddy_decisions.service import create_app as plugin_create_app


_author_access = patch('app.decisions_buddy.main.can_author', return_value=True)


def setUpModule():
    # These suites exercise ownership rules; test_decisions_access covers who may author.
    _author_access.start()


def tearDownModule():
    _author_access.stop()

OWNER = {'username': 'owner', 'is_admin': False}
ADMIN = {'username': 'root', 'display_name': 'Root', 'is_admin': True}
BASE = '/api/decisions'


def table_graph(score=5):
    return {'nodes': [
        {'id': 'in', 'name': 'In', 'type': 'inputNode', 'position': {'x': 0, 'y': 0}, 'content': {}},
        {'id': 'dt', 'name': 'Table', 'type': 'decisionTableNode', 'position': {'x': 1, 'y': 0}, 'content': {
            'hitPolicy': 'first',
            'inputs': [{'id': 'c', 'field': 'age', 'name': 'Age'}, {'id': 'd', 'field': 'tier'}],
            'outputs': [{'id': 'out_1', 'field': 'score', 'name': 'Score'}, {'id': 'out_2', 'field': 'band'}],
            'rules': [{'_id': 'r1', '_description': 'Any', 'c': '-', 'd': '-', 'out_1': str(score), 'out_2': '"A"'}]}},
        {'id': 'out', 'name': 'Out', 'type': 'outputNode', 'position': {'x': 2, 'y': 0}, 'content': {}},
    ], 'edges': [{'id': 'e1', 'sourceId': 'in', 'targetId': 'dt'}, {'id': 'e2', 'sourceId': 'dt', 'targetId': 'out'}]}


def nested_graph(key='child', **content):
    return {'nodes': [
        {'id': 'in', 'name': 'In', 'type': 'inputNode', 'content': {}},
        {'id': 'sub', 'name': 'Sub', 'type': 'decisionNode', 'content': {'key': key, **content}},
        {'id': 'out', 'name': 'Out', 'type': 'outputNode', 'content': {}},
    ], 'edges': [{'id': 'e1', 'sourceId': 'in', 'targetId': 'sub'}, {'id': 'e2', 'sourceId': 'sub', 'targetId': 'out'}]}


def record(identity='d1', graph=None, **changes):
    return {'id': identity, 'name': f'Decision {identity}', 'version': 3, 'owner': 'owner', 'updatedBy': 'owner',
            'accessPolicy': 'private', 'status': 'draft', 'environment': 'development',
            'graph': graph or table_graph(), **changes}


class ApiCase(TestCase):
    def setUp(self):
        self.user = OWNER
        self.records = {'d1': record()}
        self.get_decision = self.db('get_decision', side_effect=lambda key: deepcopy(self.records.get(key)))
        self.log = self.db('log_evaluation')
        self.conn = MagicMock()
        connection = self.db('connection')
        connection.return_value.__enter__.return_value = self.conn
        self.event = self.db('_event')
        self.broadcast = self.enterContext(patch.object(api, 'broadcast_event'))
        app = FastAPI()
        app.include_router(api.router)
        app.dependency_overrides[current_user] = lambda: self.user
        app.dependency_overrides[administrator] = lambda: self.user
        self.client = self.enterContext(TestClient(app))

    def db(self, name, **kwargs):
        return self.enterContext(patch.object(api.db, name, **kwargs))

    def get(self, path, **kwargs):
        return self.client.get(BASE + path, **kwargs)

    def post(self, path, payload=None, **kwargs):
        return self.client.post(BASE + path, json=payload if payload is not None else {}, **kwargs)

    def assertStatus(self, response, status, fragment=None):
        self.assertEqual(response.status_code, status, response.text)
        if fragment:
            self.assertIn(fragment, response.json()['detail'])
        return response.json() if response.content else None


class ReadRouteTests(ApiCase):
    def test_list_and_read_are_scoped_to_the_caller(self):
        listing = self.db('get_all_decisions', return_value=[{'id': 'd1'}])
        self.assertEqual(self.assertStatus(self.get('/models'), 200), [{'id': 'd1'}])
        listing.assert_called_once_with(user=OWNER)
        self.assertEqual(self.assertStatus(self.get('/models/d1'), 200)['version'], 3)
        self.assertStatus(self.get('/models/none'), 404, 'not found')

    def test_private_decision_is_hidden_from_other_users(self):
        self.user = {'username': 'mallory', 'is_admin': False}
        self.assertStatus(self.get('/models/d1'), 404)

    def test_profile_uses_display_name_and_rejects_blank_identity(self):
        self.user = ADMIN
        self.assertEqual(self.assertStatus(self.get('/me'), 200),
                         {'username': 'root', 'displayName': 'Root', 'isAdmin': True, 'canAuthor': True})
        self.user = {'username': ''}
        self.assertStatus(self.get('/me'), 401)

    def test_version_routes(self):
        self.db('get_decision_versions', return_value=[{'version': 3}])
        self.db('get_version_snapshot', side_effect=lambda key, v: table_graph() if v == 1 else None)
        self.assertEqual(self.assertStatus(self.get('/models/d1/versions'), 200), [{'version': 3}])
        self.assertEqual(self.assertStatus(self.get('/models/d1/versions/1'), 200)['version'], 1)
        self.assertStatus(self.get('/models/d1/versions/9'), 404, 'version not found')

    def test_diff_counts_rules_and_reports_missing_version(self):
        self.db('get_version_snapshot', side_effect=lambda key, v: {1: table_graph(), 2: {'nodes': []}}.get(v))
        body = self.assertStatus(self.get('/models/d1/diff', params={'v1': 1, 'v2': 2}), 200)
        self.assertEqual((body['ruleCountV1'], body['ruleCountV2']), (1, 0))
        self.assertStatus(self.get('/models/d1/diff', params={'v1': 1, 'v2': 7}), 404)

    def test_analytics_scope_depends_on_administrator(self):
        heatmap = self.db('compute_rule_heatmap', return_value={'rules': {}})
        self.assertStatus(self.get('/models/d1/analytics'), 200)
        heatmap.assert_called_with('d1', user_id='owner')
        self.user = ADMIN
        self.assertStatus(self.get('/models/d1/analytics'), 200)
        heatmap.assert_called_with('d1', user_id=None)

    def test_audit_logs_scope_depends_on_administrator(self):
        logs = self.db('get_recent_logs', return_value=[])
        self.assertEqual(self.assertStatus(self.get('/audit-logs', params={'limit': 5}), 200), [])
        logs.assert_called_with(5, user_id='owner')
        self.user = ADMIN
        self.assertStatus(self.get('/audit-logs'), 200)
        logs.assert_called_with(50, user_id=None)
        self.assertEqual(self.get('/audit-logs', params={'limit': 500}).status_code, 422)

    def test_metadata_describes_inputs_outputs_rules_and_watsonx_dependencies(self):
        graph = table_graph()
        graph['nodes'].extend([
            {'id': 'ai', 'type': 'watsonxAiNode', 'content': {'endpoint': 'https://synthetic.invalid', 'modelId': 'm', 'outputField': 'x'}},
            {'id': 'ml', 'name': 'ML', 'type': 'watsonxMlNode', 'content': {'deploymentId': 'dep'}},
            {'id': 'other', 'type': 'expressionNode'},
        ])
        self.records['d1'] = record(graph=graph)
        body = self.assertStatus(self.get('/models/d1/metadata'), 200)
        self.assertEqual(body['rulesCount'], 1)
        self.assertEqual([i['name'] for i in body['inputs']], ['Age', 'tier'])
        self.assertEqual(body['rules'][0]['actions'], {'out_1': '5', 'out_2': '"A"'})
        self.assertEqual(body['rules'][0]['conditions'], {'c': '-', 'd': '-'})
        self.assertEqual([(w['id'], w['name'], w['modelOrDeployment']) for w in body['watsonxDependencies']],
                         [('ai', 'ai', 'm'), ('ml', 'ML', 'dep')])
        spec = self.assertStatus(self.get('/models/d1/openapi.json'), 200)
        self.assertEqual(spec['info']['version'], '3')
        self.assertIn('age', spec['paths']['/evaluate']['post']['requestBody']['content']['application/json']['schema']['properties'])

    def test_health_runs_a_query(self):
        self.assertEqual(self.assertStatus(self.get('/health'), 200)['status'], 'ok')
        self.conn.execute.assert_called_once_with('SELECT 1')

    def test_no_store_header_is_set_on_reads(self):
        self.assertEqual(self.get('/models/d1').headers['cache-control'], 'no-store')

    def test_cross_origin_write_is_refused(self):
        response = self.client.post(BASE + '/analyze', json={'graph': table_graph()},
                                    headers={'origin': 'https://evil.invalid'})
        self.assertStatus(response, 403, 'Cross-origin')


class MutationTests(ApiCase):
    def payload(self, **changes):
        return {'id': 'd1', 'name': 'Decision', 'graph': table_graph(), 'expectedVersion': 3, **changes}

    def test_save_broadcasts_and_returns_author(self):
        save = self.db('save_decision', return_value={'id': 'd1', 'version': 4})
        body = self.assertStatus(self.post('/models', self.payload()), 200)
        self.assertEqual(body['author'], 'owner')
        self.assertEqual(save.call_args.kwargs['expected_version'], 3)
        self.broadcast.assert_called_once()

    def test_save_maps_persistence_errors(self):
        for error, status in ((api.db.RevisionConflict('stale'), 409), (PermissionError('no'), 403),
                              (ValueError('bad decision'), 422)):
            with self.subTest(error=type(error).__name__):
                self.db('save_decision', side_effect=error)
                self.assertStatus(self.post('/models', self.payload()), status)

    def test_save_pins_nested_decision_version_and_digest(self):
        child = table_graph(9)
        self.records['child'] = record('child', child, version=2)
        self.db('get_version_snapshot', return_value=child)
        save = self.db('save_decision', return_value={'id': 'd1'})
        self.assertStatus(self.post('/models', self.payload(graph=nested_graph())), 200)
        stored = next(n for n in save.call_args.args[3]['nodes'] if n['type'] == 'decisionNode')
        self.assertEqual(stored['content']['version'], 2)
        self.assertEqual(stored['content']['graphDigest'], api._digest(child))

    def test_save_rejects_invalid_nested_versions(self):
        self.records['child'] = record('child', version=2)
        self.db('get_version_snapshot', return_value=None)
        self.assertStatus(self.post('/models', self.payload(graph=nested_graph(version=0))), 422)
        self.assertStatus(self.post('/models', self.payload(graph=nested_graph(version=2))), 422, 'not found')

    def test_delete_requires_ownership(self):
        remove = self.db('delete_decision')
        self.assertEqual(self.client.delete(BASE + '/models/d1', params={'expectedVersion': 3}).json(), {'status': 'success'})
        remove.assert_called_once()
        self.records['d1']['accessPolicy'] = 'authenticated'
        self.user = {'username': 'reader', 'is_admin': False}
        self.assertStatus(self.client.delete(BASE + '/models/d1', params={'expectedVersion': 3}), 403, 'owner')

    def test_rollback_returns_saved_or_not_found(self):
        rollback = self.db('rollback_decision', return_value={'id': 'd1', 'version': 5})
        params = {'version': 1, 'expectedVersion': 3}
        self.assertEqual(self.assertStatus(self.client.post(BASE + '/models/d1/rollback', params=params), 200)['rolledBackBy'], 'owner')
        self.broadcast.assert_called_once()
        rollback.return_value = None
        self.assertStatus(self.client.post(BASE + '/models/d1/rollback', params=params), 404)

    def transition(self, target, locked=None, user=None):
        self.user = user or self.user
        def update(identity, status, environment, **kwargs):
            kwargs['validate'](self.conn, locked or self.records['d1'])
            return {**self.records['d1'], 'status': status, 'approver': kwargs['approver']}
        self.db('update_governance_status', side_effect=update)
        return self.post('/models/d1/governance', {'status': target, 'environment': 'production', 'expectedVersion': 3})

    def test_submission_is_restricted_to_owner_or_admin(self):
        self.assertEqual(self.assertStatus(self.transition('in_review'), 200)['decision']['status'], 'in_review')
        self.records['d1']['accessPolicy'] = 'authenticated'
        reader = {'username': 'reader', 'is_admin': False, 'roles': ['decision-approver']}
        self.assertStatus(self.transition('in_review', user=reader), 403, 'owner')

    def test_stale_revision_is_refused_before_transition(self):
        response = self.post('/models/d1/governance', {'status': 'in_review', 'expectedVersion': 1})
        self.assertStatus(response, 409, 'Decision changed')

    def test_invalid_transition_and_self_approval_are_refused(self):
        self.assertStatus(self.transition('published'), 409, 'in order')
        self.records['d1']['status'] = 'in_review'
        self.assertStatus(self.transition('approved'), 403, 'independent')

    def test_approval_requires_governance_evidence(self):
        self.records['d1'].update(status='in_review', accessPolicy='authenticated')
        approver = {'username': 'carol', 'roles': ['approver']}
        with patch.object(api, '_gov_snapshot', return_value={}), \
                patch.object(api.governance, 'governance_ready', return_value=False):
            self.assertStatus(self.transition('approved', user=approver), 409, 'governance evidence')
        with patch.object(api, '_gov_snapshot', return_value={}), \
                patch.object(api.governance, 'governance_ready', return_value=True):
            self.assertEqual(self.assertStatus(self.transition('approved', user=approver), 200)['approver'], 'carol')

    def test_publish_records_tested_release(self):
        self.records['d1']['status'] = 'approved'
        tests = self.db('require_passing_tests')
        release = self.db('record_release')
        with patch.object(api, '_gov_snapshot', return_value={}), \
                patch.object(api.governance, 'governance_ready', return_value=True):
            self.assertStatus(self.transition('published', user=ADMIN), 200)
        tests.assert_called_once()
        self.assertEqual(release.call_args.args[3], 'root')


class GovernanceRouteTests(ApiCase):
    def test_settings_routes_delegate(self):
        self.user = ADMIN
        with patch.object(api, 'get_public_settings', return_value={'providers': {}}), \
                patch.object(api, 'update_admin_settings', return_value={'saved': True}) as update, \
                patch.object(api, 'test_admin_connection', return_value={'status': 'connected'}) as probe:
            self.assertEqual(self.assertStatus(self.get('/admin/integrations'), 200), {'providers': {}})
            saved = self.client.put(BASE + '/admin/integrations/ikc', json={'enabled': False})
            self.assertEqual(self.assertStatus(saved, 200), {'saved': True})
            self.assertEqual(update.call_args.args[2], 'root')
            self.assertEqual(self.assertStatus(self.post('/admin/integrations/ikc/test'), 200)['status'], 'connected')
            probe.assert_called_once_with('ikc', 'root')

    def test_catalog_routes_pass_provider_and_reject_unknown(self):
        with patch.object(api.governance, 'connection_status', return_value={'configured': False}), \
                patch.object(api.governance, 'list_catalogs', return_value=[{'catalogId': 'c'}]) as catalogs, \
                patch.object(api.governance, 'list_terms', return_value=[{'id': 't'}]) as terms:
            self.assertEqual(self.assertStatus(self.get('/cp4d/status'), 200), {'configured': False})
            self.assertEqual(self.assertStatus(self.get('/cp4d/catalogs', params={'provider': 'wxdi'}), 200), [{'catalogId': 'c'}])
            catalogs.assert_called_once_with('wxdi')
            self.assertEqual(self.assertStatus(self.get('/cp4d/terms'), 200), [{'id': 't'}])
            terms.assert_called_once_with('ikc')
            self.assertEqual(self.get('/cp4d/terms', params={'provider': 'bad'}).status_code, 422)

    def test_snapshot_and_lineage(self):
        with patch.object(api.governance, 'get_or_create_cp4d_governance',
                          return_value={'syncStatus': 'synced', 'lineageManifest': {'kind': 'k'}}) as snapshot:
            self.assertEqual(self.assertStatus(self.get('/cp4d/governance/d1'), 200)['syncStatus'], 'synced')
            self.assertEqual(self.assertStatus(self.get('/cp4d/lineage/d1'), 200), {'kind': 'k'})
        self.assertEqual(snapshot.call_args.kwargs['version'], 3)

    def lock(self, row):
        self.conn.execute.return_value.fetchone.return_value = row

    def test_map_term_lock_guards(self):
        body = {'field': 'age', 'termId': 't', 'expectedVersion': 3}
        self.lock({'owner': 'owner', 'version': 2})
        self.assertStatus(self.post('/cp4d/governance/d1/map-term', body), 409, 'Refresh')
        self.lock(None)
        self.assertStatus(self.post('/cp4d/governance/d1/map-term', body), 403, 'owner')

    def test_map_term_success_records_event(self):
        self.lock({'owner': 'owner', 'version': 3})
        with patch.object(api, '_gov_snapshot'), \
                patch.object(api.governance, 'update_cp4d_term_mapping', return_value={'age': {}}) as mapped:
            body = {'field': 'age', 'termId': 't', 'provider': 'wxdi', 'expectedVersion': 3}
            self.assertEqual(self.assertStatus(self.post('/cp4d/governance/d1/map-term', body), 200)['termMappings'], {'age': {}})
        self.assertEqual(mapped.call_args.kwargs['provider'], 'wxdi')
        self.assertEqual(self.event.call_args.args[3], 'governance.term_mapped')

    def test_sync_and_reconcile(self):
        self.lock({'owner': 'owner', 'version': 3})
        with patch.object(api.governance, 'sync_decision_to_cp4d', return_value={'status': 'success'}), \
                patch.object(api.governance, 'adopt_remote_asset', return_value={'status': 'reconciled'}):
            self.assertEqual(self.post('/cp4d/sync/d1', {'expectedVersion': 3}).json(), {'status': 'success'})
            self.assertStatus(self.post('/cp4d/sync/d1', {'expectedVersion': 2}), 409)
            body = {'provider': 'ikc', 'assetId': 'a', 'expectedVersion': 3}
            self.assertEqual(self.post('/cp4d/governance/d1/reconcile', body).json()['status'], 'reconciled')
        self.assertEqual(self.event.call_args.args[3], 'governance.asset_reconciled')

    def test_governance_error_maps_to_conflict(self):
        with patch.object(api.governance, 'list_terms', side_effect=GovernanceError('remote refused')):
            self.assertStatus(self.get('/cp4d/terms'), 409, 'remote refused')

    def test_route_wrapper_maps_domain_exceptions(self):
        cases = ((api.db.RevisionConflict('x'), 409), (PermissionError('x'), 403), (ValueError('bad value'), 422),
                 (TypeError('x'), 422), (RecursionError(), 422), (HTTPException(418, 'tea'), 418))
        for error, status in cases:
            with self.subTest(error=type(error).__name__), patch.object(api.governance, 'list_terms', side_effect=error):
                self.assertEqual(self.get('/cp4d/terms').status_code, status)

    def test_require_governance_outcomes(self):
        decision = record()
        with patch.object(api.governance, 'connection_status', return_value={'configured': False}):
            self.assertIsNone(api._require_governance(decision))
        with patch.object(api.governance, 'connection_status', return_value={'configured': True}), \
                patch.object(api, '_gov_snapshot', return_value={'syncStatus': 'synced'}), \
                patch.object(api.governance, 'governance_ready', return_value=True):
            self.assertEqual(api._require_governance(decision), {'syncStatus': 'synced'})
        with patch.object(api.governance, 'connection_status', return_value={'configured': True}), \
                patch.object(api, '_gov_snapshot', return_value={}), \
                patch.object(api.governance, 'governance_ready', return_value=False), \
                self.assertRaises(HTTPException) as failure:
            api._require_governance(decision)
        self.assertEqual(failure.exception.status_code, 409)


class EvaluationTests(ApiCase):
    def test_draft_evaluation_logs_unsaved_draft(self):
        body = self.assertStatus(self.post('/evaluate', {'graph': table_graph(), 'input': {'age': 1, 'tier': 'x'}}), 200)
        self.assertEqual(body['result']['score'], 5)
        self.assertIsNone(body['decisionVersion'])
        self.assertEqual(self.log.call_args.args[0], 'unsaved-draft')

    def test_request_model_requires_one_source(self):
        self.assertEqual(self.post('/evaluate', {'input': {}}).status_code, 422)
        self.assertEqual(self.post('/evaluate', {'decisionId': 'd1', 'mode': 'production'}).status_code, 422)

    def test_production_requires_published_release(self):
        request = {'decisionId': 'd1', 'mode': 'production', 'expectedVersion': 3, 'input': {'age': 1, 'tier': 'x'}}
        self.assertStatus(self.post('/evaluate', request), 409, 'published production')
        self.records['d1'].update(status='published', environment='production')
        with patch.object(api, '_require_governance', return_value=None):
            self.db('get_release', return_value=None)
            self.assertStatus(self.post('/evaluate', request), 409, 'immutable')

    def test_batch_sums_durations_per_item(self):
        items = [{'age': 1, 'tier': 'a'}, {'age': 2, 'tier': 'b'}]
        body = self.assertStatus(self.post('/evaluate/batch', {'decisionId': 'd1', 'items': items}), 200)
        self.assertEqual(body['totalItems'], 2)
        self.assertEqual([r['index'] for r in body['results']], [0, 1])
        self.assertAlmostEqual(body['avgItemMicros'], body['totalDurationMicros'] / 2)
        self.assertEqual(self.log.call_count, 2)

    def test_analyze_requires_one_source_and_reports_severity(self):
        self.assertStatus(self.post('/analyze', {}), 422, 'either')
        self.assertStatus(self.post('/analyze', {'graph': table_graph(), 'decisionId': 'd1'}), 422)
        diagnostics = [{'severity': 'warning'}, {'severity': 'info'}]
        with patch.object(api, 'analyze_graph', return_value=diagnostics):
            body = self.assertStatus(self.post('/analyze', {'decisionId': 'd1'}), 200)
        self.assertEqual((body['issueCount'], body['hasErrors'], body['hasWarnings']), (2, False, True))

    def test_unary_and_expression_map_failures(self):
        self.assertTrue(self.assertStatus(self.post('/evaluate/unary', {'test': '> 1', 'value': 2}), 200)['passed'])
        self.assertStatus(self.post('/evaluate/unary', {'test': 'x' * 3000}), 422, 'too long')
        with patch.object(api, 'evaluate_unary', side_effect=RuntimeError('boom')):
            self.assertStatus(self.post('/evaluate/unary', {'test': '1'}), 422, 'Unary evaluation failed')
        self.assertEqual(self.post('/evaluate/expression', {'expression': '1 + 2'}).json()['result'], 3)
        self.assertStatus(self.post('/evaluate/expression', {'expression': 'unknownword + 1'}), 422, 'Expression evaluation failed')

    def test_oversized_payload_is_refused(self):
        self.assertStatus(self.post('/evaluate/expression', {'expression': 'x' * 70000}), 422, 'allowed size')

    def test_bal_rule_outcomes(self):
        self.assertStatus(self.post('/evaluate/bal', {'rule': '  '}), 422, 'cannot be empty')
        with patch('app.decisions_buddy.bal_engine.evaluate_bal_rule', return_value=[{'fired': True}]):
            body = self.assertStatus(self.post('/evaluate/bal', {'rule': 'if x', 'context': {'x': 1}}), 200)
        self.assertEqual(body['trace'], [{'fired': True}])
        self.assertEqual(body['result'], {'x': 1})
        with patch('app.decisions_buddy.bal_engine.evaluate_bal_rule', side_effect=RuntimeError('bad')):
            self.assertStatus(self.post('/evaluate/bal', {'rule': 'if x'}), 422, 'BAL rule evaluation failed')

    def test_dvs_route_validates_sources_and_scenarios(self):
        self.assertStatus(self.post('/dvs/evaluate', {}), 422, 'either')
        self.assertStatus(self.post('/dvs/evaluate', {'decisionId': 'd1', 'scenarios': 'nope'}), 422, 'up to 500')
        scenario = {'id': 's1', 'input': {'age': 1, 'tier': 'x'}, 'expected': {'score': 5}}
        body = self.assertStatus(self.post('/dvs/evaluate', {'decisionId': 'd1', 'scenarios': [scenario]}), 200)
        self.assertEqual(body['status'], 'success')
        self.assertEqual(body['summary']['passedScenarios'], 1)

    def test_generate_flow_route(self):
        self.assertStatus(self.post('/assistant/generate-flow', {'prompt': ' '}), 422, 'prompt')
        body = self.assertStatus(self.post('/assistant/generate-flow', {'prompt': 'if age < 18 then approve'}), 200)
        self.assertEqual(body['status'], 'success')
        self.assertTrue(body['graph']['nodes'])
        self.broadcast.assert_called_once()

    def test_watsonx_route_dispatches_by_kind(self):
        with patch('app.decisions_buddy.watsonx_inference.execute_watsonx_ml', return_value={'kind': 'ml'}), \
                patch('app.decisions_buddy.watsonx_inference.execute_watsonx_ai', return_value={'kind': 'ai'}):
            self.assertEqual(self.post('/watsonx/test', {'kind': 'watsonx_ml'}).json(), {'kind': 'ml'})
            self.assertEqual(self.post('/watsonx/test', {}).json(), {'kind': 'ai'})


class TestSuiteRouteTests(ApiCase):
    def suite(self, cases, version=3):
        self.db('test_suite', return_value={'cases': cases, 'decisionVersion': version, 'suiteRevision': 7})

    def test_read_suite(self):
        self.suite([])
        self.assertEqual(self.assertStatus(self.get('/models/d1/test-cases'), 200)['suiteRevision'], 7)

    def test_save_suite_rejects_duplicate_or_blank_names(self):
        body = {'expectedVersion': 3, 'expectedSuiteRevision': 0, 'cases': [{'name': 'a', 'expected': 1}, {'name': ' a', 'expected': 1}]}
        self.assertStatus(self.client.put(BASE + '/models/d1/test-cases', json=body), 422, 'unique')
        body['cases'] = [{'name': '  ', 'expected': 1}]
        self.assertStatus(self.client.put(BASE + '/models/d1/test-cases', json=body), 422, 'unique')

    def test_save_suite_passes_revision(self):
        save = self.db('save_test_suite', return_value={'suiteRevision': 1})
        body = {'expectedVersion': 3, 'expectedSuiteRevision': 0, 'cases': [{'name': 'a', 'expected': 1}]}
        self.assertEqual(self.assertStatus(self.client.put(BASE + '/models/d1/test-cases', json=body), 200), {'suiteRevision': 1})
        self.assertEqual(save.call_args.kwargs['actor'], 'owner')

    def test_run_requires_cases_for_current_version(self):
        self.suite([])
        self.assertStatus(self.post('/models/d1/run-tests', {'expectedVersion': 3}), 409, 'Save test cases')

    def test_run_reports_pass_fail_and_evaluation_errors(self):
        graph = table_graph()
        graph['nodes'][1]['content']['rules'][0]['c'] = '< 18'
        self.records['d1'] = record(graph=graph)
        good = {'name': 'good', 'input': {'age': 1, 'tier': 'x'}, 'expected': {'age': 1, 'tier': 'x', 'score': 5, 'band': 'A'}}
        wrong = {**good, 'name': 'wrong', 'expected': {'score': 6}}
        missing = {'name': 'missing', 'input': {}, 'expected': {}}
        self.suite([good, wrong, missing])
        record_run = self.db('record_test_run')
        body = self.assertStatus(self.post('/models/d1/run-tests', {'expectedVersion': 3}), 200)
        self.assertEqual({r['name']: r['passed'] for r in body['results']}, {'good': True, 'wrong': False, 'missing': False})
        self.assertFalse(body['passed'])
        self.assertIn('Evaluation failed', body['results'][2]['error'])
        self.assertIsNone(body['results'][2]['actual'])
        self.assertIs(record_run.call_args.args[5], False)


class SimulationRouteTests(ApiCase):
    def request(self, **changes):
        cases = [{'name': 'a', 'input': {'age': 1, 'tier': 'x'}}]
        return {'decisionId': 'd1', 'cases': cases, 'report': {'outputs': []}, **changes}

    def test_rejects_ambiguous_sources_and_bad_identifiers(self):
        self.assertStatus(self.post('/simulation/kpis', {'graph': {}, 'decisionId': 'd'}), 422, 'either')
        self.assertStatus(self.post('/simulation/kpis', self.request(extra=1)), 422, 'either')
        self.assertStatus(self.post('/simulation/kpis', self.request(decisionId='x' * 201)), 422, 'nonempty')
        self.assertStatus(self.post('/simulation/kpis', self.request(baselineExpectedVersion=0)), 422, 'positive')

    def test_report_carries_baseline_comparison(self):
        self.records['base'] = record('base', table_graph(1), version=1)
        with patch('app.decisions_buddy.simulation_kpis.validate_simulation'), \
                patch('app.decisions_buddy.simulation_kpis.simulate', side_effect=lambda *a: {'n': 1}), \
                patch('app.decisions_buddy.simulation_kpis.compare_reports', return_value={'delta': 0}) as compare:
            body = self.assertStatus(self.post('/simulation/kpis', self.request(
                expectedVersion=3, baselineDecisionId='base', baselineExpectedVersion=1)), 200)
        self.assertEqual(body['decisionVersion'], 3)
        self.assertEqual(body['baseline']['decisionVersion'], 1)
        self.assertEqual(body['comparison'], {'delta': 0})
        compare.assert_called_once()

    def test_stale_baseline_is_refused(self):
        self.records['base'] = record('base', version=1)
        with patch('app.decisions_buddy.simulation_kpis.validate_simulation'), \
                patch('app.decisions_buddy.simulation_kpis.simulate', return_value={}):
            response = self.post('/simulation/kpis', self.request(baselineDecisionId='base', baselineExpectedVersion=4))
        self.assertStatus(response, 409, 'Decision changed')

    def test_workbook_import_routes(self):
        self.assertStatus(self.post('/simulation/import-workbook', {}), 422, 'contentBase64')
        self.assertEqual(self.post('/simulation/import-workbook', {'contentBase64': '!!'}).status_code, 422)
        encoded = base64.b64encode(b'synthetic').decode()
        with patch('app.decisions_buddy.scenario_workbook.import_workbook', return_value=[{'name': 'a'}]) as load:
            self.assertEqual(self.post('/simulation/import-workbook', {'contentBase64': encoded}).json(), {'cases': [{'name': 'a'}]})
        load.assert_called_once_with(b'synthetic')

    def test_workbook_template_is_an_attachment(self):
        with patch('app.decisions_buddy.scenario_workbook.workbook_template', return_value=b'xlsx'):
            response = self.get('/simulation/workbook-template')
        self.assertEqual(response.content, b'xlsx')
        self.assertIn('decision-scenarios.xlsx', response.headers['content-disposition'])


class EngineForTests(TestCase):
    def setUp(self):
        self.records = {}
        self.enterContext(patch.object(api.db, 'get_decision', side_effect=lambda k: deepcopy(self.records.get(k))))
        self.snapshot = self.enterContext(patch.object(api.db, 'get_version_snapshot', return_value=None))
        self.release = self.enterContext(patch.object(api.db, 'get_release', return_value=None))

    def assertRefused(self, status, graph, fragment, **kwargs):
        with self.assertRaises(HTTPException) as failure:
            api._engine_for(graph, ADMIN, **kwargs)
        self.assertEqual(failure.exception.status_code, status)
        self.assertIn(fragment, failure.exception.detail)

    def test_recursion_and_missing_key_are_refused(self):
        self.assertRefused(422, nested_graph(key=''), 'recursive')
        self.records['loop'] = record('loop', nested_graph('loop'), version=1)
        self.assertRefused(422, nested_graph('loop'), 'recursive')

    def test_production_requires_pinned_version(self):
        self.records['child'] = record('child', version=2)
        self.assertRefused(409, nested_graph(), 'Resave', production=True)

    def test_invalid_or_unavailable_pins_are_refused(self):
        self.records['child'] = record('child', version=2)
        self.assertRefused(422, nested_graph(version=True), 'Invalid nested')
        self.assertRefused(409, nested_graph(version=1), 'unavailable')

    def test_integrity_and_release_checks(self):
        graph = table_graph()
        self.records['child'] = record('child', graph, version=2)
        self.snapshot.return_value = graph
        self.assertRefused(409, nested_graph(version=2, graphDigest='0' * 64), 'integrity')
        self.assertRefused(409, nested_graph(version=2), 'immutable published', production=True)
        self.release.return_value = {'graph_digest': api._digest(graph), 'dependency_manifest': {}}
        engine = api._engine_for(nested_graph(version=2), ADMIN, production=True)
        self.assertEqual(engine.dependency_manifest['child']['version'], 2)

    def test_conflicting_pins_for_one_child_are_refused(self):
        graph = nested_graph(version=1)
        second = {'id': 'sub2', 'name': 'S2', 'type': 'decisionNode', 'content': {'key': 'child', 'version': 2}}
        graph['nodes'].insert(2, second)
        graph['edges'] = [{'id': 'a', 'sourceId': 'in', 'targetId': 'sub'}, {'id': 'b', 'sourceId': 'sub', 'targetId': 'sub2'},
                          {'id': 'c', 'sourceId': 'sub2', 'targetId': 'out'}]
        self.records['child'] = record('child', version=2)
        self.snapshot.side_effect = lambda key, version: table_graph(version)
        self.assertRefused(422, graph, 'conflicting')

    def test_more_than_sixteen_children_are_refused(self):
        nodes = [{'id': 'in', 'name': 'In', 'type': 'inputNode', 'content': {}}]
        edges, previous = [], 'in'
        for index in range(17):
            key = f'k{index}'
            self.records[key] = record(key, version=1)
            nodes.append({'id': key, 'name': key, 'type': 'decisionNode', 'content': {'key': key}})
            edges.append({'id': f'e{index}', 'sourceId': previous, 'targetId': key})
            previous = key
        self.assertRefused(422, {'nodes': nodes, 'edges': edges}, 'limit exceeded')


class ConnectionManagerTests(TestCase):
    def test_broadcast_sends_invalidation_only_and_drops_dead_sockets(self):
        manager, alive, dead = api.ConnectionManager(), AsyncMock(), AsyncMock()
        dead.send_json.side_effect = RuntimeError('gone')
        manager.active_connections = [alive, dead]
        asyncio.run(manager.broadcast({'type': 'model_saved', 'decision': {'secret': 'x'}}))
        alive.send_json.assert_awaited_once_with({'type': 'models_changed'})
        self.assertEqual(manager.active_connections, [alive])

    def test_connect_records_running_loop_and_disconnect_is_idempotent(self):
        manager, socket = api.ConnectionManager(), AsyncMock()
        asyncio.run(manager.connect(socket))
        socket.accept.assert_awaited_once()
        self.assertIsNotNone(manager.loop)
        manager.disconnect(socket)
        manager.disconnect(socket)
        self.assertEqual(manager.active_connections, [])

    def test_broadcast_event_uses_current_loop_without_saved_loop(self):
        socket = AsyncMock()
        async def scenario():
            with patch.object(api, 'manager', api.ConnectionManager()) as manager:
                manager.active_connections = [socket]
                api.broadcast_event({'type': 'x'})
                await asyncio.sleep(0)
                await asyncio.sleep(0)
        asyncio.run(scenario())
        socket.send_json.assert_awaited_once_with({'type': 'models_changed'})

    def test_broadcast_event_uses_saved_running_loop(self):
        socket = AsyncMock()
        async def scenario():
            with patch.object(api, 'manager', api.ConnectionManager()) as manager:
                manager.active_connections = [socket]
                manager.loop = asyncio.get_running_loop()
                api.broadcast_event({'type': 'x'})
                for _ in range(3):
                    await asyncio.sleep(0)
        asyncio.run(scenario())
        socket.send_json.assert_awaited_once_with({'type': 'models_changed'})

    def test_broadcast_event_is_silent_without_listeners_or_event_loop(self):
        with patch.object(api, 'manager', api.ConnectionManager()) as manager, \
                patch.object(manager, 'broadcast', new=MagicMock()) as broadcast:
            self.assertIsNone(api.broadcast_event({'type': 'x'}))
            manager.active_connections = [object()]
            self.assertIsNone(api.broadcast_event({'type': 'x'}))
            broadcast.assert_not_called()


class WebsocketTests(TestCase):
    def socket(self, headers=None, frames=()):
        socket = AsyncMock()
        socket.headers = headers or {}
        socket.receive_text.side_effect = [*frames, WebSocketDisconnect()]
        return socket

    def test_foreign_origin_is_closed_without_authentication(self):
        socket = self.socket({'origin': 'https://evil.invalid', 'host': 'buddy.invalid'})
        with patch.object(api, 'current_user', AsyncMock()) as auth:
            asyncio.run(api.decisions_websocket(socket))
        socket.close.assert_awaited_once_with(code=1008)
        auth.assert_not_called()

    def test_failed_authentication_closes(self):
        socket = self.socket()
        with patch.object(api, 'current_user', AsyncMock(side_effect=HTTPException(401))):
            asyncio.run(api.decisions_websocket(socket))
        socket.close.assert_awaited_once_with(code=1008)

    def test_ping_is_answered_and_other_frames_ignored_until_disconnect(self):
        socket = self.socket(frames=('hello', 'ping'))
        with patch.object(api, 'current_user', AsyncMock(return_value=OWNER)), \
                patch.object(api, 'manager', api.ConnectionManager()) as manager:
            asyncio.run(api.decisions_websocket(socket))
            self.assertEqual(manager.active_connections, [])
        socket.send_json.assert_awaited_once_with({'type': 'connected', 'user': 'owner'})
        socket.send_text.assert_awaited_once_with('pong')


class PluginAppTests(TestCase):
    def setUp(self):
        self.app = plugin_create_app()
        # No context manager here: entering it would run the schema-initialising lifespan.
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def test_plugin_entrypoint_is_the_shared_factory(self):
        self.assertIs(plugin_create_app, api.create_app)

    def test_ready_reports_database_state(self):
        with patch.object(api.db, 'connection', side_effect=RuntimeError('down')):
            self.assertEqual(self.client.get('/ready').status_code, 503)
        with patch.object(api.db, 'connection') as connection:
            self.assertEqual(self.client.get('/ready').json(), {'ok': True})
        connection.return_value.__enter__.return_value.execute.assert_called_once()

    def test_liveness_answers_at_the_boundary_and_manifest_requires_login(self):
        self.assertEqual(self.client.get('/health').json(), {'ok': True})
        with patch('app.auth.current_user', AsyncMock(side_effect=HTTPException(401))):
            self.app.middleware_stack = None
            self.assertEqual(self.client.get('/plugins/manifest').status_code, 401)

    def test_manifest_and_app_level_error_handlers(self):
        with patch('app.auth.current_user', AsyncMock(return_value=OWNER)):
            self.app.middleware_stack = None
            def governance_failure():
                raise GovernanceError('remote refused')
            def value_failure():
                raise ValueError('bad value')
            self.app.add_api_route('/x/governance', governance_failure)
            self.app.add_api_route('/x/value', value_failure)
            self.assertEqual(self.client.get('/plugins/manifest').json()['schema'], 'decisions')
            response = self.client.get('/x/governance')
            self.assertEqual((response.status_code, response.json()['detail']), (409, 'remote refused'))
            response = self.client.get('/x/value')
            self.assertEqual((response.status_code, response.json()['detail']), (422, 'bad value'))

    def test_lifespan_initialises_schema_and_records_loop(self):
        with patch.object(api.db, 'init_db') as init, patch.object(api, 'manager', api.ConnectionManager()) as manager:
            with TestClient(plugin_create_app(), raise_server_exceptions=False):
                init.assert_called_once()
            self.assertIsNotNone(manager.loop)
