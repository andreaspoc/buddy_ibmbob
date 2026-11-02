"""Synthetic release, dependency, and privacy regressions through actual routes.

DB adapters are mocked. No real models, sockets, IBM services or production state
are accessed; graph compilation and evaluation use the real engine.
"""
import asyncio
from copy import deepcopy
import json
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import current_user
from app.decisions_buddy import main as api
from app.decisions_buddy import db


_author_access = patch('app.decisions_buddy.main.can_author', return_value=True)


def setUpModule():
    # These suites exercise ownership rules; test_decisions_access covers who may author.
    _author_access.start()


def tearDownModule():
    _author_access.stop()


def leaf(value):
    return {'nodes': [{'id': 'e', 'type': 'expressionNode', 'content': {
        'expressions': [{'key': 'score', 'value': str(value)}]}},
        {'id': 'o', 'type': 'outputNode', 'content': {}}],
        'edges': [{'id': 'eo', 'sourceId': 'e', 'targetId': 'o'}]}


def nested(key, version=1, digest=None):
    content = {'key': key}
    if version is not None: content['version'] = version
    if digest is not None: content['graphDigest'] = digest
    return {'nodes': [{'id': 'sub', 'type': 'decisionNode', 'content': content}], 'edges': []}


def record(identity, graph, version=1, **changes):
    return {'id': identity, 'name': 'Synthetic ' + identity, 'graph': graph,
            'version': version, 'owner': 'owner', 'updatedBy': 'owner',
            'accessPolicy': 'private', 'status': 'draft', 'environment': 'development', **changes}


class ReleaseHTTPTests(TestCase):
    def setUp(self):
        self.user = {'username': 'owner', 'is_admin': False}
        self.old_child = leaf(7)
        self.new_child = leaf(99)
        self.root_graph = nested('child', digest=api._digest(self.old_child))
        self.records = {'root': record('root', self.root_graph),
                        'child': record('child', self.new_child, version=2)}
        self.snapshots = {('child', 1): self.old_child, ('child', 2): self.new_child}
        self.releases = {}
        self.get_decision = self.enterContext(patch.object(api.db, 'get_decision',
            side_effect=lambda key: deepcopy(self.records.get(key))))
        self.snapshot = self.enterContext(patch.object(api.db, 'get_version_snapshot',
            side_effect=lambda key, version: deepcopy(self.snapshots.get((key, version)))))
        self.release = self.enterContext(patch.object(api.db, 'get_release',
            side_effect=lambda key, version: deepcopy(self.releases.get((key, version)))))
        self.audit = self.enterContext(patch.object(api.db, 'log_evaluation'))
        self.enterContext(patch.object(api, '_require_governance', return_value=None))
        self.enterContext(patch.object(api, 'broadcast_event'))
        app = FastAPI()
        app.include_router(api.router)
        app.dependency_overrides[current_user] = lambda: self.user
        self.client = self.enterContext(TestClient(app))

    def evaluate(self, **changes):
        return self.client.post('/api/decisions/evaluate', json={'decisionId': 'root', 'input': {}, **changes})

    def published(self):
        self.records['root'].update(status='published', environment='production')
        binding = {'version': 1, 'graphDigest': api._digest(self.old_child)}
        self.releases[('child', 1)] = {'graph_digest': binding['graphDigest'], 'dependency_manifest': {}}
        self.releases[('root', 1)] = {'graph_digest': api._digest(self.root_graph),
                                    'dependency_manifest': {'child': binding}}
        return binding

    def test_pinned_child_uses_historical_snapshot_when_current_child_changes(self):
        response = self.evaluate()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['result']['score'], 7)
        self.records['child']['graph'] = leaf(123)
        self.records['child']['version'] = 3
        again = self.evaluate()
        self.assertEqual(again.json()['result']['score'], 7)
        manifest = {'child': {'version': 1, 'graphDigest': api._digest(self.old_child)}}
        self.assertEqual(again.json()['dependencyManifest'], manifest)
        self.assertEqual(self.audit.call_args.kwargs['governance_snapshot']['dependencies'], manifest)
        self.assertEqual(self.audit.call_args.kwargs['graph_digest'], api._digest(self.root_graph))

    def test_production_checks_root_and_nested_release_manifest(self):
        binding = self.published()
        response = self.evaluate(mode='production', expectedVersion=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['result']['score'], 7)
        self.assertEqual(response.json()['dependencyManifest'], {'child': binding})
        self.assertEqual(response.json()['decisionVersion'], 1)

    def test_current_child_permission_is_required_for_historical_snapshot(self):
        self.records['child']['owner'] = 'another-owner'
        response = self.evaluate()
        self.assertEqual(response.status_code, 404, response.text)
        self.audit.assert_not_called()
        self.snapshot.assert_not_called()

    def test_missing_historical_snapshot_is_not_replaced_by_current_graph(self):
        self.snapshots.pop(('child', 1))
        response = self.evaluate()
        self.assertEqual(response.status_code, 409)
        self.audit.assert_not_called()

    def test_mismatched_pinned_digest_is_denied(self):
        self.records['root']['graph']['nodes'][0]['content']['graphDigest'] = '0' * 64
        response = self.evaluate()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn('integrity', response.json()['detail'])
        self.audit.assert_not_called()

    def test_missing_or_tampered_root_release_is_denied(self):
        for kind in ('absent', 'digest', 'manifest'):
            with self.subTest(kind=kind):
                self.published()
                if kind == 'absent': self.releases.pop(('root', 1))
                elif kind == 'digest': self.releases[('root', 1)]['graph_digest'] = '0' * 64
                else: self.releases[('root', 1)]['dependency_manifest'] = {}
                response = self.evaluate(mode='production', expectedVersion=1)
                self.assertEqual(response.status_code, 409, response.text)
        self.audit.assert_not_called()

    def test_missing_or_tampered_child_release_is_denied(self):
        for kind in ('absent', 'digest', 'manifest'):
            with self.subTest(kind=kind):
                self.published()
                if kind == 'absent': self.releases.pop(('child', 1))
                elif kind == 'digest': self.releases[('child', 1)]['graph_digest'] = '0' * 64
                else: self.releases[('child', 1)]['dependency_manifest'] = {'unexpected': {}}
                response = self.evaluate(mode='production', expectedVersion=1)
                self.assertEqual(response.status_code, 409, response.text)
        self.audit.assert_not_called()

    def test_unpinned_child_cannot_be_used_for_production(self):
        self.published()
        self.records['root']['graph']['nodes'][0]['content'].pop('version')
        self.assertEqual(self.evaluate(mode='production', expectedVersion=1).status_code, 409)
        self.audit.assert_not_called()

    def test_recursive_dependencies_rejected_even_when_individual_graphs_are_dags(self):
        self.records['root']['graph'] = nested('child', version=1)
        self.snapshots[('child', 1)] = nested('child', version=1)
        self.assertEqual(self.evaluate().status_code, 422)
        self.audit.assert_not_called()

    def test_dependency_depth_limit_is_enforced(self):
        self.records['root']['graph'] = nested('child0')
        for index in range(9):
            graph = nested(f'child{index + 1}') if index < 8 else leaf(1)
            self.records[f'child{index}'] = record(f'child{index}', graph)
            self.snapshots[(f'child{index}', 1)] = graph
        self.assertEqual(self.evaluate().status_code, 422)
        self.audit.assert_not_called()

    def test_conflicting_versions_of_same_child_are_rejected(self):
        self.records['root']['graph'] = {'nodes': [
            {'id': 'one', 'type': 'decisionNode', 'content': {'key': 'child', 'version': 1}},
            {'id': 'two', 'type': 'decisionNode', 'content': {'key': 'child', 'version': 2}}], 'edges': []}
        response = self.evaluate()
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn('conflicting', response.json()['detail'])
        self.audit.assert_not_called()

    def test_save_pins_the_version_and_digest_of_direct_child(self):
        def save(identity, name, description, graph, default_input, **kwargs):
            return record(identity, graph)
        with patch.object(api.db, 'save_decision', side_effect=save) as saver:
            response = self.client.post('/api/decisions/models', json={
                'id': 'parent', 'name': 'Synthetic parent', 'graph': nested('child', version=None),
                'expectedVersion': 0})
        self.assertEqual(response.status_code, 200, response.text)
        pinned = saver.call_args.args[3]['nodes'][0]['content']
        self.assertEqual(pinned['version'], 2)
        self.assertEqual(pinned['graphDigest'], api._digest(self.new_child))

    def test_publish_cannot_bypass_saved_suite_gate(self):
        self.user = {'username': 'reviewer', 'is_admin': True}
        self.records['root']['status'] = 'approved'
        self.published()
        self.records['root']['status'] = 'approved'
        def update(identity, status, environment, **kwargs):
            kwargs['validate'](MagicMock(), deepcopy(self.records[identity]))
            return self.records[identity] | {'status': status, 'environment': environment}
        with patch.object(api.db, 'update_governance_status', side_effect=update), \
             patch.object(api, '_gov_snapshot', return_value={}), \
             patch.object(api.governance, 'governance_ready', return_value=True), \
             patch.object(api.db, 'require_passing_tests', side_effect=ValueError('Synthetic suite has not passed')) as gate, \
             patch.object(api.db, 'record_release') as release:
            response = self.client.post('/api/decisions/models/root/governance', json={
                'status': 'published', 'environment': 'production', 'expectedVersion': 1})
        self.assertEqual(response.status_code, 422, response.text)
        gate.assert_called_once()
        release.assert_not_called()


class ReleaseDatabaseGateTests(TestCase):
    def test_empty_stale_and_failed_suites_are_rejected(self):
        decision = record('root', leaf(1), version=2)
        for suite, run in (({'cases': [], 'decisionVersion': 2, 'suiteRevision': 1}, None),
                           ({'cases': [{'name': 'synthetic'}], 'decisionVersion': 1, 'suiteRevision': 1}, None),
                           ({'cases': [{'name': 'synthetic'}], 'decisionVersion': 2, 'suiteRevision': 1}, None),
                           ({'cases': [{'name': 'synthetic'}], 'decisionVersion': 2, 'suiteRevision': 1}, {'passed': False})):
            conn = MagicMock()
            conn.execute.return_value.fetchone.return_value = run
            with self.subTest(suite=suite, run=run), patch.object(db, 'test_suite', return_value=suite), self.assertRaises(ValueError):
                db.require_passing_tests(conn, decision, {})

    def test_passing_gate_binds_version_suite_digest_and_dependency_manifest(self):
        decision = record('root', leaf(1), version=2)
        manifest = {'child': {'version': 4, 'graphDigest': 'a' * 64}}
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = {'passed': True}
        with patch.object(db, 'test_suite', return_value={'cases': [{'name': 'synthetic'}],
                                                        'decisionVersion': 2, 'suiteRevision': 3}):
            db.require_passing_tests(conn, decision, manifest)
        query, params = conn.execute.call_args.args
        self.assertIn('ORDER BY id DESC', query)
        self.assertEqual(params[:4], ('root', 2, 3, api._digest(decision['graph'])))
        self.assertEqual(json.loads(params[4]), manifest)


class WebsocketPrivacyTests(TestCase):
    def test_two_sockets_only_receive_content_free_invalidation(self):
        async def scenario():
            manager = api.ConnectionManager()
            owner, other = MagicMock(), MagicMock()
            owner.accept = AsyncMock(); other.accept = AsyncMock()
            owner.send_json = AsyncMock(); other.send_json = AsyncMock()
            await manager.connect(owner)
            await manager.connect(other)
            await manager.broadcast({'type': 'model_saved', 'decision': {
                'id': 'private-secret-id', 'name': 'private title', 'graph': leaf(1),
                'defaultInput': {'sensitive': 'synthetic secret'}}, 'author': 'private-owner'})
            for socket in (owner, other):
                socket.send_json.assert_awaited_once_with({'type': 'models_changed'})
            # Permission revocation cannot expose a formerly visible model: even
            # still-open connections receive only the generic invalidation.
            await manager.broadcast({'type': 'model_deleted', 'decisionId': 'private-secret-id'})
            for socket in (owner, other):
                self.assertEqual(socket.send_json.await_args.args, ({'type': 'models_changed'},))
        asyncio.run(scenario())
