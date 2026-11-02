"""Governance evidence rules with synthetic settings, a fake connection and a fake CPD client."""
from datetime import datetime, timedelta, timezone
import json
from unittest import TestCase
from unittest.mock import MagicMock, patch

from app.decisions_buddy import cp4d_governance as governance
from app.decisions_buddy.cp4d_client import digest
from app.decisions_buddy.cp4d_settings import GovernanceError

ORIGIN = 'https://cpd.synthetic.invalid'


def graph(*fields):
    return {'nodes': [{'id': 'i', 'type': 'inputNode'}, {'id': 'd', 'type': 'decisionTableNode', 'content': {
        'inputs': [{'field': field} for field in fields], 'outputs': [{'field': 'result', 'label': 'Result'}]}}],
        'edges': []}


def settings(**providers):
    base = {'enabled': False, 'base_url': ORIGIN, 'credential_configured': True, 'version': '5', 'revision': 1,
            'catalog_id': 'cat', 'last_test': None}
    return {'providers': {name: {**base, **providers.get(name, {})} for name in ('ikc', 'wxdi')}}


class Connection:
    """Answers SELECTs from canned rows and records every statement."""

    def __init__(self, **rows):
        self.rows, self.statements, self.commits, self.rollbacks = rows, [], 0, 0

    def execute(self, statement, parameters=None):
        self.statements.append((statement, parameters))
        result = MagicMock()
        if 'cp4d_governance' in statement and statement.lstrip().startswith('SELECT'):
            result.fetchone.return_value = self.rows.get('governance')
        elif 'decisions.decisions' in statement and statement.lstrip().startswith('SELECT'):
            rows = self.rows.get('decisions')
            result.fetchone.return_value = rows.pop(0) if isinstance(rows, list) and len(rows) > 1 else (rows[0] if isinstance(rows, list) else rows)
        return result

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def updates(self, fragment):
        return [item for item in self.statements if fragment in item[0] and 'UPDATE' in item[0]]


class Case(TestCase):
    def provider_settings(self, **providers):
        patcher = patch.object(governance, 'get_public_settings', return_value=settings(**providers))
        return self.enterContext(patcher)

    def client(self):
        client = MagicMock()
        context = self.enterContext(patch.object(governance, 'CP4DClient'))
        context.return_value.__enter__.return_value = client
        return client


class StatusTests(Case):
    def test_connection_status_requires_enabled_url_and_credential(self):
        for provider, expected in (({'enabled': True}, True), ({'enabled': False}, False),
                                   ({'enabled': True, 'credential_configured': False}, False),
                                   ({'enabled': True, 'base_url': ''}, False)):
            with self.subTest(provider=provider), patch.object(governance, 'get_public_settings',
                                                               return_value=settings(ikc=provider)):
                status = governance.connection_status()
                self.assertIs(status['configured'], expected)
                self.assertEqual(status['status'], 'configured' if expected else 'not_configured')
                self.assertEqual(status['providers']['ikc']['catalogId'], 'cat')

    def test_catalog_and_term_listing_is_empty_when_disabled(self):
        self.provider_settings()
        self.assertEqual(governance.list_catalogs(), [])
        self.assertEqual(governance.list_terms('wxdi'), [])

    def test_catalog_and_term_listing_uses_saved_connection(self):
        self.provider_settings(ikc={'enabled': True})
        client = self.client()
        client.list_catalogs.return_value = [{'catalogId': 'c'}]
        client.list_terms.return_value = [{'id': 't'}]
        with patch.object(governance, 'load_connection', return_value={'provider': 'ikc'}) as load:
            self.assertEqual(governance.list_catalogs('ikc'), [{'catalogId': 'c'}])
            self.assertEqual(governance.list_terms('ikc'), [{'id': 't'}])
        self.assertEqual(load.call_count, 2)

    def test_table_initialiser_delegates_to_schema_owner(self):
        with patch('app.decisions_buddy.db.init_db') as init:
            governance.init_cp4d_tables(None)
        init.assert_called_once_with()


class MappingTests(TestCase):
    def test_only_decision_tables_contribute_valid_fields(self):
        source = graph('age', '', 7)
        mappings = governance.get_default_term_mappings('d', source)
        self.assertEqual(set(mappings), {'age', 'result'})
        self.assertEqual(mappings['result']['label'], 'Result')
        self.assertEqual(mappings['age']['verification'], 'unmapped')

    def test_output_with_input_name_gets_a_prefixed_key(self):
        source = {'nodes': [{'type': 'decisionTableNode', 'content': {'schema': {
            'inputs': [{'field': 'x'}], 'outputs': [{'field': 'x'}]}}}]}
        self.assertEqual(set(governance.get_default_term_mappings('d', source)), {'x', 'output:x'})

    def test_field_limit_is_enforced(self):
        source = graph(*[f'f{index}' for index in range(201)])
        with self.assertRaisesRegex(GovernanceError, 'at most 200'):
            governance.get_default_term_mappings('d', source)

    def test_lineage_never_claims_remote_publication(self):
        manifest = governance.generate_openlineage_manifest('d', 'D', {'a': {'type': 'input'}, 'b': {'type': 'output'}}, graph())
        self.assertIs(manifest['remoteLineagePublished'], False)
        self.assertEqual((manifest['inputs'], manifest['outputs']), ([{'type': 'input'}], [{'type': 'output'}]))

    def test_json_helper(self):
        self.assertEqual(governance._json(None, {'d': 1}), {'d': 1})
        self.assertEqual(governance._json('{"a": 1}', {}), {'a': 1})
        self.assertEqual(governance._json({'b': 2}, {}), {'b': 2})


class SnapshotTests(Case):
    def row(self, source, **changes):
        mappings = governance.get_default_term_mappings('d', source)
        return {'decision_id': 'd', 'term_mappings': json.dumps(mappings), 'lineage_manifest': '{}',
                'sync_status': 'not_synced', **changes}

    def test_version_is_looked_up_when_omitted(self):
        self.provider_settings()
        source = graph('a')
        conn = Connection(decisions={'version': 4}, governance=self.row(source, sync_status='synced', synced_version=4,
                                                                         synced_digest=digest(source)))
        # Matching the looked-up version is what keeps the record synced.
        self.assertEqual(governance.get_or_create_cp4d_governance(conn, 'd', 'D', source)['syncStatus'], 'synced')

    def test_synced_record_without_remote_evidence_is_reported_stale(self):
        self.provider_settings(ikc={'enabled': True})
        source = graph('a')
        conn = Connection(governance=self.row(source, sync_status='synced', synced_version=4, synced_digest=digest(source)))
        self.assertEqual(governance.get_or_create_cp4d_governance(conn, 'd', 'D', source, version=4)['syncStatus'], 'stale')

    def test_missing_decision_is_refused(self):
        with self.assertRaisesRegex(GovernanceError, 'does not exist'):
            governance.get_or_create_cp4d_governance(Connection(decisions=None), 'd', 'D', graph())

    def test_changed_fields_mark_record_stale_and_keep_matching_mapping(self):
        self.provider_settings()
        stored = governance.get_default_term_mappings('d', graph('a'))
        stored['a'].update(termId='t1', verification='active_remote_term')
        stored['gone'] = {'field': 'gone', 'type': 'input'}
        conn = Connection(governance={'decision_id': 'd', 'term_mappings': stored, 'lineage_manifest': {}, 'sync_status': 'synced'})
        result = governance.get_or_create_cp4d_governance(conn, 'd', 'D', graph('a'), version=1)
        self.assertEqual(result['syncStatus'], 'stale')
        self.assertEqual(result['termMappings']['a']['termId'], 't1')
        self.assertNotIn('gone', result['termMappings'])
        self.assertIn('review mappings', result['lastError'])
        self.assertTrue(conn.updates("sync_status='stale'"))

    def test_view_marks_stale_synced_record_from_other_version(self):
        source = graph('a')
        view = governance._view(self.row(source, sync_status='synced', synced_version=1, synced_digest=digest(source)), source, 2)
        self.assertEqual(view['syncStatus'], 'stale')
        self.assertEqual(view['classification'], 'Not assessed')


class TermMappingTests(Case):
    TERM = {'id': 't', 'name': 'Term', 'source': ORIGIN, 'version': 'v1', 'sourceDigest': 'x'}

    def setUp(self):
        self.client().get_term.return_value = self.TERM
        self.enterContext(patch.object(governance, 'load_connection', return_value={'provider': 'ikc'}))

    def test_requires_loaded_record(self):
        with self.assertRaisesRegex(GovernanceError, 'Load governance metadata'):
            governance.update_cp4d_term_mapping(Connection(), 'd', 'a', 't')

    def test_requires_known_field(self):
        conn = Connection(governance={'term_mappings': {}})
        with self.assertRaisesRegex(GovernanceError, 'does not exist'):
            governance.update_cp4d_term_mapping(conn, 'd', 'a', 't')

    def test_saves_verified_term_and_invalidates_release(self):
        conn = Connection(governance={'term_mappings': json.dumps({'a': {'field': 'a'}})})
        result = governance.update_cp4d_term_mapping(conn, 'd', 'a', 't', provider='wxdi')
        self.assertEqual(result['a']['verification'], 'active_remote_term')
        self.assertEqual(result['a']['provider'], 'wxdi')
        self.assertTrue(conn.updates("status='in_review'"))


class ReadinessTests(Case):
    def setUp(self):
        self.source = graph('a')
        self.decision = {'id': 'd', 'version': 2, 'graph': self.source}
        mappings = governance.get_default_term_mappings('d', self.source)
        for item in mappings.values():
            item.update(termId='t', verification='active_remote_term', provider='ikc', source=ORIGIN)
        self.mappings = mappings
        self.provider_settings(ikc={'enabled': True})

    def record(self, **source):
        proof = {'settingsRevision': 1, 'origin': ORIGIN, 'decisionVersion': 2, 'graphDigest': digest(self.source),
                 'mappingDigest': digest(self.mappings), 'assetId': 'asset', **source}
        return {'syncStatus': 'synced', 'syncedVersion': 2, 'graphDigest': digest(self.source), 'termMappings': self.mappings,
                'governanceSnapshot': {'checkedAt': datetime.now(timezone.utc).isoformat(), 'sources': {'ikc': proof}}}

    def test_complete_fresh_evidence_is_ready(self):
        self.assertTrue(governance.governance_ready(self.record(), self.decision))

    def test_each_mismatched_proof_field_blocks(self):
        for field, value in (('settingsRevision', 9), ('origin', 'https://other.invalid'), ('decisionVersion', 1),
                             ('graphDigest', 'x'), ('mappingDigest', 'x'), ('assetId', '')):
            with self.subTest(field=field):
                self.assertFalse(governance.governance_ready(self.record(**{field: value}), self.decision))

    def test_unsynced_or_changed_fields_block(self):
        unsynced = {**self.record(), 'syncStatus': 'stale'}
        self.assertFalse(governance.governance_ready(unsynced, self.decision))
        self.assertFalse(governance.governance_ready({**self.record(), 'termMappings': {}}, self.decision))

    def test_unverified_mapping_blocks(self):
        for changes in ({'termId': None}, {'verification': 'unmapped'}, {'provider': 'wxdi'}, {'source': 'https://x.invalid'}):
            with self.subTest(changes=changes):
                changed = {key: {**value, **changes} for key, value in self.mappings.items()}
                self.assertFalse(governance.governance_ready({**self.record(), 'termMappings': changed}, self.decision))

    def test_missing_malformed_expired_or_future_timestamp_blocks(self):
        now = datetime.now(timezone.utc)
        for value in (None, 'not-a-date', (now - timedelta(days=3)).isoformat(), (now + timedelta(days=3)).isoformat()):
            with self.subTest(value=value):
                record = self.record()
                record['governanceSnapshot']['checkedAt'] = value
                self.assertFalse(governance.governance_ready(record, self.decision))
        record = self.record()
        del record['governanceSnapshot']['checkedAt']
        self.assertFalse(governance.governance_ready(record, self.decision))

    def test_invalid_ttl_setting_blocks(self):
        with patch.dict('os.environ', {'BUDDY_DECISIONS_GOVERNANCE_TTL_SECONDS': 'soon'}):
            self.assertFalse(governance.governance_ready(self.record(), self.decision))

    def test_no_enabled_provider_is_ready_when_record_matches(self):
        self.provider_settings()
        self.assertTrue(governance.governance_ready(self.record(), self.decision))


class SyncTests(Case):
    def setUp(self):
        self.source = graph('a')
        self.config = {'provider': 'ikc', 'base_url': ORIGIN, 'catalog_id': 'cat', 'revision': 1}
        self.provider_settings(ikc={'enabled': True})
        self.remote = self.client()
        self.remote.get_catalog.return_value = {'entity': {'name': 'Catalog'}}
        self.remote.upsert_decision_asset.return_value = {'assetId': 'asset', 'catalogId': 'cat', 'origin': ORIGIN}
        self.load = self.enterContext(patch.object(governance, 'load_connection', return_value=self.config))
        self.conn = Connection(decisions={'version': 2, 'graph': self.source}, governance={
            'decision_id': 'd', 'sync_status': 'not_synced', 'lineage_manifest': {},
            'term_mappings': governance.get_default_term_mappings('d', self.source)})

    def sync(self, **kwargs):
        return governance.sync_decision_to_cp4d(self.conn, 'd', 'D', self.source, version=2, **kwargs)

    def assertFailure(self, fragment, **kwargs):
        with self.assertRaisesRegex(GovernanceError, fragment):
            self.sync(**kwargs)

    def test_success_persists_primary_asset(self):
        result = self.sync()
        self.assertEqual((result['syncStatus'], result['ikcAssetId'], result['catalogName']), ('synced', 'asset', 'Catalog'))
        self.assertTrue(self.conn.updates("sync_status='synced'"))
        self.assertGreaterEqual(self.conn.commits, 3)

    def test_changed_decision_is_refused_before_remote_calls(self):
        self.conn.rows['decisions'] = {'version': 2, 'graph': graph('other')}
        self.assertFailure('Reload before synchronizing')
        self.remote.upsert_decision_asset.assert_not_called()

    def test_disabled_providers_are_refused(self):
        self.provider_settings()
        self.assertFailure('Configure and test')

    def test_unresolved_previous_sync_is_refused(self):
        self.conn.rows['governance'] = {**self.conn.rows['governance'], 'sync_status': 'pending'}
        self.assertFailure('unresolved')

    def assertRecordedState(self, state):
        recorded = [params for statement, params in self.conn.statements if 'SET sync_status=%s' in statement]
        self.assertEqual(recorded[-1][0], state)
        self.assertGreaterEqual(self.conn.rollbacks, 1)

    def test_catalog_scope_mismatch_records_failure(self):
        self.assertFailure('administrator-saved', catalog_id='other')
        self.assertRecordedState('failed')

    def test_missing_catalog_records_failure(self):
        self.load.return_value = {**self.config, 'catalog_id': ''}
        self.assertFailure('Choose and save a catalog')
        self.assertRecordedState('failed')

    def test_expired_deadline_stops_term_resolution(self):
        self.conn.rows['governance']['term_mappings']['a'].update(provider='ikc', termId='t')
        with patch.object(governance.time, 'monotonic', side_effect=[0, 1000]):
            self.assertFailure('time limit')

    def test_expired_deadline_stops_publication(self):
        self.conn.rows['governance']['term_mappings'] = {}
        self.conn.rows['governance']['lineage_manifest'] = {}
        with patch.object(governance.time, 'monotonic', side_effect=[0, 1000]):
            with self.assertRaisesRegex(GovernanceError, 'time limit|stale|Decision fields'):
                self.sync()

    def test_uncertain_create_requires_reconciliation_without_leaking_error(self):
        self.remote.upsert_decision_asset.side_effect = RuntimeError('synthetic-secret')
        with self.assertRaises(GovernanceError) as failure:
            self.sync()
        self.assertNotIn('synthetic-secret', str(failure.exception))
        self.assertRecordedState('reconciliation_required')

    def test_decision_change_during_sync_is_detected(self):
        self.conn.rows['decisions'] = [{'version': 2, 'graph': self.source}, {'version': 3, 'graph': self.source}]
        self.assertFailure('during synchronization')
        self.assertRecordedState('failed')

    def test_settings_change_during_sync_is_detected(self):
        self.load.return_value = {**self.config, 'revision': 8}
        self.assertFailure('settings changed')

    def test_mapped_terms_are_refreshed_before_publication(self):
        self.conn.rows['governance']['term_mappings']['a'].update(provider='ikc', termId='t')
        self.remote.get_term.return_value = {'name': 'Fresh', 'version': 'v2', 'sourceDigest': 'd', 'source': ORIGIN}
        self.sync()
        mappings = self.remote.upsert_decision_asset.call_args.kwargs['mappings']
        self.assertEqual(mappings['a']['termName'], 'Fresh')

    def test_retry_reuses_acknowledged_asset(self):
        sources = {'ikc': {'origin': ORIGIN, 'catalogId': 'cat', 'assetId': 'known'}}
        self.conn.rows['governance']['lineage_manifest'] = {'governanceSnapshot': {'sources': sources}}
        self.sync()
        self.assertEqual(self.remote.upsert_decision_asset.call_args.kwargs['asset_id'], 'known')


class AdoptionTests(Case):
    def setUp(self):
        self.remote = self.client()
        self.config = {'base_url': ORIGIN, 'catalog_id': 'cat'}
        self.load = self.enterContext(patch.object(governance, 'load_connection', return_value=self.config))

    def describe(self, description):
        self.remote._request.return_value = {'metadata': {'description': description}}

    MATCHING = 'Buddy decision governance metadata\n' + json.dumps({'decision_id': 'd'})

    def test_invalid_scope_or_asset_is_refused(self):
        for config, asset in (({**self.config, 'catalog_id': ''}, 'a'), (self.config, ''), (self.config, 7), (self.config, 'x' * 201)):
            with self.subTest(asset=asset):
                self.load.return_value = config
                with self.assertRaisesRegex(GovernanceError, 'valid remote asset'):
                    governance.adopt_remote_asset(Connection(), 'd', 'ikc', asset)

    def test_foreign_or_unreadable_remote_record_is_refused(self):
        foreign = 'Buddy decision governance metadata\n' + json.dumps({'decision_id': 'other'})
        for description in ('no marker', 'wrong marker\n{"decision_id": "d"}', foreign, 'Buddy decision governance metadata\nnot-json', None):
            with self.subTest(description=description):
                self.describe(description)
                with self.assertRaisesRegex(GovernanceError, 'not a matching'):
                    governance.adopt_remote_asset(Connection(), 'd', 'ikc', 'asset')

    def test_missing_local_record_is_refused(self):
        self.describe(self.MATCHING)
        with self.assertRaisesRegex(GovernanceError, 'record does not exist'):
            governance.adopt_remote_asset(Connection(), 'd', 'ikc', 'asset')

    def test_adoption_records_identity_but_leaves_evidence_stale(self):
        self.describe(self.MATCHING)
        conn = Connection(governance={'lineage_manifest': '{}'})
        self.assertEqual(governance.adopt_remote_asset(conn, 'd', 'ikc', 'as/set')['status'], 'reconciled')
        self.assertEqual(self.remote._request.call_args.args[1], '/v2/assets/as%2Fset')
        stored = json.loads(conn.updates("sync_status='stale'")[0][1][0])
        self.assertEqual(stored['governanceSnapshot']['sources']['ikc']['assetId'], 'as/set')
