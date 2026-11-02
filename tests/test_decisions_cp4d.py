"""Synthetic CPD HTTP contracts and governance boundaries; no live remote writes."""
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import httpx

from app.decisions_buddy import cp4d_client as client_module, cp4d_governance as governance
from app.decisions_buddy.cp4d_client import CP4DClient, digest
from app.decisions_buddy.cp4d_settings import ConnectorSettings, GovernanceError, encryption, public_settings, validate_origin


CONFIG = {'provider': 'ikc', 'base_url': 'https://cpd.synthetic.invalid:8443', 'version': 'test-version',
          'api_profile': 'cpd_common_core_v2', 'auth_mode': 'bearer', 'bearer': 'synthetic-secret-token',
          'revision': 2, 'asset_type': 'data_asset'}


class CP4DClientTests(unittest.TestCase):
    def client(self, handler, **config):
        return CP4DClient({**CONFIG, **config}, transport=httpx.MockTransport(handler))

    def test_redirects_and_remote_errors_never_disclose_secrets_or_follow_other_origins(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(302, headers={'Location': 'https://other.invalid/leak'},
                                  json={'echo': 'synthetic-secret-token'})
        with self.client(handler) as client, self.assertRaises(GovernanceError) as error:
            client.list_catalogs()
        self.assertEqual(len(requests), 1)
        self.assertNotIn('synthetic-secret-token', str(error.exception))

    def test_api_key_authorization_uses_same_saved_origin_and_known_route(self):
        requests = []
        def handler(request):
            requests.append(request)
            if request.url.path == '/icp4d-api/v1/authorize':
                self.assertEqual(json.loads(request.content), {'username': 'synthetic-account', 'api_key': 'synthetic-api-key'})
                return httpx.Response(200, json={'accessToken': 'synthetic-access-token'})
            self.assertEqual(request.headers['Authorization'], 'Bearer synthetic-access-token')
            return httpx.Response(200, json={'catalogs': []})
        with self.client(handler, bearer='', username='synthetic-account', api_key='synthetic-api-key') as client:
            self.assertEqual(client.list_catalogs(), [])
        self.assertEqual({str(r.url.host) for r in requests}, {'cpd.synthetic.invalid'})

    def test_catalogs_are_remote_records_and_term_search_is_not_active_term_evidence(self):
        def handler(request):
            if request.url.path == '/v2/catalogs':
                return httpx.Response(200, json={'catalogs': [{'metadata': {'guid': 'synthetic-catalog'}, 'entity': {'name': 'Synthetic catalog'}}]})
            if request.url.path == '/v3/search':
                return httpx.Response(200, json={'rows': [{'metadata': {'artifact_id': 'synthetic-term', 'name': 'Synthetic term'}}]})
            self.assertEqual(request.url.params['status'], 'ACTIVE')
            return httpx.Response(200, json={'resources': [{'metadata': {'version_id': 'synthetic-term-v1', 'name': 'Synthetic active term'}}]})
        with self.client(handler) as client:
            self.assertEqual(client.list_catalogs()[0]['catalogId'], 'synthetic-catalog')
            self.assertFalse(client.list_terms()[0]['verifiedActive'])
            self.assertTrue(client.get_term('synthetic-term')['verifiedActive'])

    def test_asset_registration_requires_acknowledged_id_and_readback_digest_marker(self):
        created = {}
        def handler(request):
            self.assertEqual(request.url.params['catalog_id'], 'synthetic-catalog')
            if request.method == 'POST':
                created.update(json.loads(request.content))
                self.assertNotIn('secret_expression', request.content.decode())
                return httpx.Response(201, json={'metadata': {'asset_id': 'synthetic-asset'}})
            return httpx.Response(200, json={'metadata': {**created['metadata'], 'asset_id': 'synthetic-asset'}})
        with self.client(handler) as client:
            proof = client.upsert_decision_asset(catalog_id='synthetic-catalog', asset_id=None,
                decision_id='synthetic-decision', decision_name='Synthetic decision', version=3,
                graph_digest=digest({'expression': 'secret_expression'}), mappings={})
        self.assertEqual(proof['assetId'], 'synthetic-asset')
        self.assertEqual(proof['decisionVersion'], 3)
        self.assertEqual(proof['settingsRevision'], 2)

    def test_missing_asset_id_and_wrong_readback_are_not_success(self):
        for response in ({}, {'metadata': {'asset_id': 'synthetic-asset'}}):
            with self.client(lambda request: httpx.Response(200, json=response)) as client:
                with self.assertRaises(GovernanceError):
                    client.upsert_decision_asset(catalog_id='synthetic', asset_id=None,
                        decision_id='d', decision_name='D', version=1, graph_digest='digest', mappings={})

    def test_response_size_and_destination_validation_fail_closed(self):
        with patch.object(client_module, 'MAX_RESPONSE', 20), self.client(lambda request: httpx.Response(200, json={'catalogs': ['x' * 100]})) as client:
            with self.assertRaises(GovernanceError): client.list_catalogs()
        for value in ('http://cpd.invalid', 'https://user:secret@cpd.invalid', 'https://127.0.0.1',
                      'https://169.254.169.254', 'https://100.100.100.200', 'https://[fd00:ec2::254]', 'https://cpd.invalid/other', 'https://cpd.invalid?token=x'):
            with self.subTest(url=value), self.assertRaises(GovernanceError): validate_origin(value)
        self.assertEqual(validate_origin('https://10.42.0.10:8443'), 'https://10.42.0.10:8443')

    def test_unsupported_profile_and_absolute_request_are_denied(self):
        with self.assertRaises(GovernanceError): self.client(lambda r: httpx.Response(200), api_profile='unknown')
        with self.client(lambda r: httpx.Response(200)) as client:
            with self.assertRaises(GovernanceError): client._request('GET', 'https://other.invalid')


class GovernanceProofTests(unittest.TestCase):
    def setUp(self):
        self.graph = {'nodes': [{'type': 'decisionTableNode', 'content': {'inputs': [{'field': 'amount'}]}}], 'edges': []}
        self.mapping = {'amount': {'termId': 'synthetic-term', 'verification': 'active_remote_term',
                                  'provider': 'ikc', 'source': CONFIG['base_url']}}
        self.settings = {'providers': {p: {'enabled': True, 'revision': 2, 'base_url': CONFIG['base_url']} for p in ('ikc','wxdi')}}
        self.decision = {'version': 3, 'graph': self.graph}
        self.record = {'syncStatus': 'synced', 'syncedVersion': 3, 'graphDigest': digest(self.graph),
                       'termMappings': self.mapping, 'governanceSnapshot': {
                           'checkedAt': datetime.now(timezone.utc).isoformat(), 'sources': {
                               p: {'assetId': 'synthetic-asset-'+p, 'settingsRevision': 2, 'origin': CONFIG['base_url'],
                                   'decisionVersion': 3, 'graphDigest': digest(self.graph), 'mappingDigest': digest(self.mapping)}
                               for p in ('ikc','wxdi')}}}

    def ready(self):
        with patch.object(governance, 'get_public_settings', return_value=self.settings):
            return governance.governance_ready(self.record, self.decision)

    def test_both_enabled_providers_require_current_version_bound_evidence(self):
        self.assertTrue(self.ready())
        self.record['governanceSnapshot']['sources'].pop('wxdi')
        self.assertFalse(self.ready())

    def test_edited_graph_new_settings_unmapped_fields_and_stale_evidence_block_release(self):
        self.decision['version'] = 4
        self.assertFalse(self.ready())
        self.decision['version'] = 3
        self.settings['providers']['ikc']['revision'] = 3
        self.assertFalse(self.ready())
        self.settings['providers']['ikc']['revision'] = 2
        self.mapping['amount']['verification'] = 'unmapped'
        self.assertFalse(self.ready())
        self.mapping['amount']['verification'] = 'active_remote_term'
        self.record['governanceSnapshot']['checkedAt'] = (datetime.now(timezone.utc)-timedelta(days=2)).isoformat()
        self.assertFalse(self.ready())

    def test_local_design_lineage_never_claims_execution_or_certification(self):
        lineage = governance.generate_openlineage_manifest('synthetic','Synthetic',{},self.graph)
        self.assertFalse(lineage['remoteLineagePublished'])
        self.assertNotIn('eventType', lineage)
        self.assertNotIn('Certified', json.dumps(lineage))

    def test_governance_read_does_not_commit_or_release_callers_decision_lock(self):
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = {
            'decision_id': 'synthetic', 'term_mappings': {}, 'lineage_manifest': {},
            'sync_status': 'not_configured', 'classification': 'Not assessed'}
        with patch.object(governance, 'connection_status', return_value={'configured': False}):
            result = governance.get_or_create_cp4d_governance(conn, 'synthetic', 'Synthetic', self.graph, version=3)
        self.assertEqual(result['syncStatus'], 'stale')
        conn.commit.assert_not_called()
        conn.rollback.assert_not_called()
        self.assertIn('amount', result['termMappings'])

    def test_term_mapping_preserves_transaction_and_invalidates_prior_approval(self):
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = {'term_mappings': {'amount': {'field': 'amount', 'type': 'input'}}}
        term = {'id': 'synthetic-term', 'name': 'Synthetic', 'version': 'v1',
                'source': CONFIG['base_url'], 'sourceDigest': 'synthetic-digest'}
        with patch.object(governance, 'load_connection', return_value=CONFIG), patch.object(governance, 'CP4DClient') as client:
            client.return_value.__enter__.return_value.get_term.return_value = term
            result = governance.update_cp4d_term_mapping(conn, 'synthetic', 'amount', 'synthetic-term')
        self.assertEqual(result['amount']['verification'], 'active_remote_term')
        conn.commit.assert_not_called()
        queries = [call.args[0] for call in conn.execute.call_args_list]
        self.assertTrue(any("status='in_review',approver=NULL" in query for query in queries))


class CredentialTests(unittest.TestCase):
    def test_credentials_are_encrypted_and_never_in_public_settings(self):
        with patch.dict(os.environ, {'BUDDY_MEMORY_SIGNING_KEY': 'synthetic-service-only-key-at-least-32-characters'}, clear=True):
            cipher = encryption()
            encrypted = cipher.encrypt(b'synthetic-private-credential').decode()
            self.assertNotIn('synthetic-private-credential', encrypted)
            self.assertEqual(cipher.decrypt(encrypted.encode()), b'synthetic-private-credential')
            public = public_settings('ikc', {'config': {'enabled': True}, 'credentials': encrypted})
            self.assertTrue(public['credential_configured'])
            self.assertNotIn(encrypted, json.dumps(public))
        with patch.dict(os.environ, {'BOB_API_KEY': 'synthetic-provider-key-at-least-32-characters'}, clear=True):
            with self.assertRaises(GovernanceError): encryption()

    def test_model_rejects_unknown_fields_and_enable_requires_version_and_origin(self):
        for values in ({'enabled': True}, {'enabled': True, 'base_url': 'https://synthetic.invalid'}, {'api_url_override': 'x'}):
            with self.assertRaises(ValueError): ConnectorSettings.model_validate(values)


if __name__ == '__main__': unittest.main()
