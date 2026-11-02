"""High-density deep unit tests targeting uncovered lines across core backend modules.

Covers:
- decisions_buddy/cp4d_settings.py
- keycloak_auth.py
- agent_catalog.py
- research_sources.py
- decisions_buddy/main.py
- plugins/learning/buddy_learning/course_completion.py
- plugins/learning/buddy_learning/classrooms.py
- plugins/learning/buddy_learning/service.py
- main.py

100% hermetic in-memory execution with zero live external network or database calls.
Zero fake operational data.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from uuid import UUID, uuid4
import zipfile

from fastapi import HTTPException, Response, UploadFile
from fastapi.testclient import TestClient
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / 'plugins'

for p in (
    str(ROOT),
    str(PLUGINS / 'learning'),
    str(PLUGINS / 'office'),
    str(PLUGINS / 'projects'),
    str(PLUGINS / 'people'),
    str(PLUGINS / 'decisions'),
    str(PLUGINS / 'tetragon'),
):
    if p not in sys.path:
        sys.path.insert(0, p)

import httpx
from app import agent_catalog, keycloak_auth, main, research_sources
from app.decisions_buddy import cp4d_settings, main as decisions_main
from buddy_learning import classrooms, course_completion, service as learning_service


# ---------------------------------------------------------------------------
# Test Doubles
# ---------------------------------------------------------------------------

class DoubleCursor:
    def __init__(self, db, rowcount=1):
        self._db = db
        self.rowcount = rowcount

    def fetchone(self):
        if isinstance(self._db._fetchone_val, list):
            return self._db._fetchone_val.pop(0) if self._db._fetchone_val else None
        elif callable(self._db._fetchone_val):
            return self._db._fetchone_val()
        return self._db._fetchone_val

    def fetchall(self):
        if isinstance(self._db._fetchall_val, list) and self._db._fetchall_val and isinstance(self._db._fetchall_val[0], list):
            return self._db._fetchall_val.pop(0)
        elif callable(self._db._fetchall_val):
            return self._db._fetchall_val()
        return self._db._fetchall_val if self._db._fetchall_val is not None else []


class DoubleDB:
    """Hermetic in-memory database double.

    Uses a non-Mock SimpleNamespace for info so that both _is_real_db(db) returns True
    and _is_mock_db(db) returns False when deep branches need to be exercised.
    """
    def __init__(self, fetchone_val=None, fetchall_val=None, rowcount=1, real=True):
        self._fetchone_val = fetchone_val
        self._fetchall_val = fetchall_val
        self.rowcount = rowcount
        self.executed: list[tuple[str, any]] = []
        self.info = SimpleNamespace(backend_pid=1001) if real else Mock()

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return DoubleCursor(self, rowcount=self.rowcount)

    def transaction(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False


# ===========================================================================
# 1. Decisions CP4D Settings Deep Coverage
# ===========================================================================

class DecisionsCp4dSettingsDeepCoverageTests(unittest.TestCase):
    def test_connector_settings_newlines_validation(self):
        with self.assertRaises(ValidationError):
            cp4d_settings.ConnectorSettings(
                base_url='https://cp4d.example.com',
                version='4.8.0',
                username='admin\nuser'
            )
        with self.assertRaises(ValidationError):
            cp4d_settings.ConnectorSettings(
                base_url='https://cp4d.example.com',
                version='4.8.0',
                api_key='secret\rkey'
            )

    def test_encryption_governance_error_and_success(self):
        with patch.dict(os.environ, {'BUDDY_CP4D_ENCRYPTION_KEY': 'short', 'BUDDY_MEMORY_SIGNING_KEY': ''}):
            with self.assertRaises(cp4d_settings.GovernanceError):
                cp4d_settings.encryption()

        with patch.dict(os.environ, {'BUDDY_CP4D_ENCRYPTION_KEY': 'a' * 32}):
            fernet = cp4d_settings.encryption()
            token = fernet.encrypt(b'payload')
            self.assertEqual(fernet.decrypt(token), b'payload')

    def test_ensure_settings_schema(self):
        conn = MagicMock()
        cp4d_settings.ensure_settings_schema(conn)
        self.assertGreaterEqual(conn.execute.call_count, 2)

    def test_get_public_settings_available_and_unavailable(self):
        row_ikc = {
            'provider': 'ikc',
            'config': {'base_url': 'https://ikc.example.com', 'auth_mode': 'api_key', 'username': 'admin', 'version': '4.8.0', 'enabled': True},
            'credentials': 'token',
            'revision': 1,
            'updated_by': 'admin',
            'updated_at': '2026-10-30T10:00:00Z',
            'last_test': {}
        }
        db = DoubleDB(fetchall_val=[row_ikc])
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db):
            with patch('app.decisions_buddy.cp4d_settings.encryption', side_effect=cp4d_settings.GovernanceError('No key')):
                res_unavail = cp4d_settings.get_public_settings()
                self.assertFalse(res_unavail['encryption_available'])

            with patch('app.decisions_buddy.cp4d_settings.encryption', return_value=MagicMock()):
                res_avail = cp4d_settings.get_public_settings()
                self.assertTrue(res_avail['encryption_available'])
                self.assertIn('ikc', res_avail['providers'])

    def test_load_connection_disabled_and_decryption_error(self):
        db_disabled = DoubleDB(fetchone_val={'config': {'enabled': False}, 'credentials': 'enc', 'revision': 1})
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db_disabled):
            with self.assertRaises(cp4d_settings.GovernanceError) as ctx:
                cp4d_settings.load_connection('ikc')
            self.assertIn('disabled', str(ctx.exception))

        fernet_mock = MagicMock()
        fernet_mock.decrypt.side_effect = cp4d_settings.InvalidToken
        db_bad_token = DoubleDB(fetchone_val={'config': {'enabled': True}, 'credentials': 'enc', 'revision': 1})
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db_bad_token), \
             patch('app.decisions_buddy.cp4d_settings.encryption', return_value=fernet_mock):
            with self.assertRaises(cp4d_settings.GovernanceError) as ctx:
                cp4d_settings.load_connection('ikc')
            self.assertIn('could not be decrypted', str(ctx.exception))

    def test_load_connection_success(self):
        fernet_mock = MagicMock()
        fernet_mock.decrypt.return_value = json.dumps({'api_key': 'unencrypted_key'}).encode()
        db = DoubleDB(fetchone_val={'config': {'enabled': True, 'base_url': 'https://ikc.local'}, 'credentials': 'enc', 'revision': 2})
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db), \
             patch('app.decisions_buddy.cp4d_settings.encryption', return_value=fernet_mock):
            res = cp4d_settings.load_connection('ikc')
            self.assertEqual(res['api_key'], 'unencrypted_key')
            self.assertEqual(res['revision'], 2)

    def test_update_admin_settings_revision_mismatch_and_no_credentials_error(self):
        db = DoubleDB(fetchone_val={'revision': 2, 'config': {}, 'credentials': ''})
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db):
            body = {'expected_revision': 1, 'base_url': 'https://ikc.local', 'version': '4.8.0', 'auth_mode': 'api_key'}
            with self.assertRaises(cp4d_settings.GovernanceError) as ctx:
                cp4d_settings.update_admin_settings('ikc', body, 'admin')
            self.assertIn('Reload before saving', str(ctx.exception))

        db_rev1 = DoubleDB(fetchone_val={'revision': 1, 'config': {}, 'credentials': ''})
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db_rev1):
            body_enabled = {'expected_revision': 1, 'base_url': 'https://ikc.local', 'version': '4.8.0', 'auth_mode': 'api_key', 'enabled': True}
            with self.assertRaises(cp4d_settings.GovernanceError) as ctx:
                cp4d_settings.update_admin_settings('ikc', body_enabled, 'admin')
            self.assertIn('Supply credentials', str(ctx.exception))

    def test_update_admin_settings_success(self):
        fernet_mock = MagicMock()
        fernet_mock.encrypt.return_value = b'encrypted_secret'
        saved_row = {
            'provider': 'ikc',
            'config': {'base_url': 'https://ikc.local', 'version': '4.8.0', 'auth_mode': 'api_key', 'username': 'admin_u', 'enabled': True},
            'credentials': 'encrypted_secret',
            'revision': 2,
            'updated_by': 'admin',
            'updated_at': '2026-10-30T10:00:00Z',
            'last_test': {}
        }
        db = DoubleDB(fetchone_val=saved_row, fetchall_val=[])
        body = {
            'expected_revision': 2,
            'base_url': 'https://ikc.local',
            'version': '4.8.0',
            'auth_mode': 'api_key',
            'username': 'admin_u',
            'api_key': 'my_api_key',
            'enabled': True
        }
        with patch('app.decisions_buddy.cp4d_settings._connection', return_value=db), \
             patch('app.decisions_buddy.cp4d_settings.encryption', return_value=fernet_mock):
            res = cp4d_settings.update_admin_settings('ikc', body, 'admin')
            self.assertEqual(res['provider'], 'ikc')
            self.assertTrue(res['credential_configured'])

    def test_test_admin_connection_success(self):
        client_mock = MagicMock()
        client_mock.__enter__.return_value = client_mock
        client_mock.list_catalogs.return_value = [{'id': 'cat1', 'name': 'Catalog 1'}]

        db = DoubleDB()
        with patch('app.decisions_buddy.cp4d_settings.load_connection', return_value={'catalog_id': 'cat1', 'revision': 1}), \
             patch('app.decisions_buddy.cp4d_client.CP4DClient', return_value=client_mock), \
             patch('app.decisions_buddy.cp4d_settings._connection', return_value=db):
            res = cp4d_settings.test_admin_connection('ikc', 'admin_actor')
            self.assertEqual(res['status'], 'connected')
            self.assertEqual(res['catalog_count'], 1)


# ===========================================================================
# 2. Keycloak Auth Deep Coverage
# ===========================================================================

class KeycloakAuthDeepCoverageTests(unittest.IsolatedAsyncioTestCase):
    def test_keycloak_getaddrinfo_resolution(self):
        with patch.dict(os.environ, {'KEYCLOAK_HOST_IP': '10.0.0.5', 'KEYCLOAK_ISSUER': 'https://auth.company.com/realms/bob'}):
            with patch('app.keycloak_auth._orig_getaddrinfo') as orig_mock:
                orig_mock.side_effect = [socket.gaierror, [('res',)]]
                res = keycloak_auth._keycloak_getaddrinfo('auth.company.com', 443)
                self.assertEqual(res, [('res',)])
                orig_mock.assert_called_with('10.0.0.5', 443, 0, 0, 0, 0)

            with patch('app.keycloak_auth._orig_getaddrinfo', side_effect=socket.gaierror):
                with self.assertRaises(socket.gaierror):
                    keycloak_auth._keycloak_getaddrinfo('other.company.com', 443)

    def test_issuer_validation_errors(self):
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': 'http://insecure.auth/realms/bob'}):
            with self.assertRaises(HTTPException) as ctx:
                keycloak_auth.issuer()
            self.assertEqual(ctx.exception.status_code, 503)

        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': ''}):
            with self.assertRaises(HTTPException) as ctx:
                keycloak_auth.issuer()
            self.assertEqual(ctx.exception.status_code, 503)

    def test_redirect_uri_variations(self):
        req = MagicMock()
        req.headers = {'x-forwarded-proto': 'https', 'x-forwarded-host': 'proxy.bob.com'}
        with patch.dict(os.environ, {'KEYCLOAK_REDIRECT_URI': '', 'PUBLIC_BASE_URL': ''}):
            uri = keycloak_auth.redirect_uri(req)
            self.assertEqual(uri, 'https://proxy.bob.com/auth/keycloak/callback')

        with patch.dict(os.environ, {'KEYCLOAK_REDIRECT_URI': 'https://explicit.bob.com/callback'}):
            uri_exp = keycloak_auth.redirect_uri(req)
            self.assertEqual(uri_exp, 'https://explicit.bob.com/callback')

        with patch.dict(os.environ, {'KEYCLOAK_REDIRECT_URI': '', 'PUBLIC_BASE_URL': 'https://public.bob.com'}):
            uri_pub = keycloak_auth.redirect_uri(None)
            self.assertEqual(uri_pub, 'https://public.bob.com/auth/keycloak/callback')

    async def test_discovery_mismatch_and_invalid_endpoints(self):
        client = AsyncMock()
        resp_mismatch = MagicMock()
        resp_mismatch.json.return_value = {'issuer': 'https://different.auth'}
        client.get.return_value = resp_mismatch

        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': 'https://auth.bob.com/realm'}):
            with self.assertRaises(ValueError) as ctx:
                await keycloak_auth.discovery(client)
            self.assertIn('Issuer mismatch', str(ctx.exception))

            resp_bad_endpoint = MagicMock()
            resp_bad_endpoint.json.return_value = {
                'issuer': 'https://auth.bob.com/realm',
                'authorization_endpoint': 'https://malicious.endpoint/auth',
                'token_endpoint': 'https://auth.bob.com/realm/token',
                'jwks_uri': 'https://auth.bob.com/realm/jwks'
            }
            client.get.return_value = resp_bad_endpoint
            with self.assertRaises(ValueError) as ctx:
                await keycloak_auth.discovery(client)
            self.assertIn('Unexpected endpoint', str(ctx.exception))

    def test_validate_token_missing_azp(self):
        with patch.dict(os.environ, {'KEYCLOAK_CLIENT_ID': 'client1', 'KEYCLOAK_ISSUER': 'https://auth.local'}), \
             patch('jwt.get_unverified_header', return_value={'alg': 'RS256', 'kid': 'k1'}), \
             patch('jwt.PyJWK.from_dict') as jwk_mock, \
             patch('jwt.decode', return_value={'sub': 's1', 'nonce': 'nonce1', 'aud': ['client1', 'client2']}):
            jwk_mock.return_value.key = 'pubkey'
            with self.assertRaises(ValueError) as ctx:
                keycloak_auth.validate_token('fake_tok', {'keys': [{'kid': 'k1', 'kty': 'RSA', 'use': 'sig', 'alg': 'RS256'}]}, 'nonce1')
            self.assertIn('Authorized party missing', str(ctx.exception))

    def test_resolve_identity_new_user_conflict_and_admin(self):
        claims = {'iss': 'https://auth.bob.com/realm', 'sub': 'sub123'}
        db_conflict = DoubleDB(fetchone_val=[None, None, {'username': 'existing'}])
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': 'https://auth.bob.com/realm'}):
            with patch('app.keycloak_auth._connect', return_value=db_conflict), \
                 patch('app.keycloak_auth.user_profile', side_effect=lambda u, a: {'username': u, 'is_admin': a}):
                with self.assertRaises(ValueError) as ctx:
                    keycloak_auth.resolve_identity(claims)
                self.assertIn('Identity allocation conflict', str(ctx.exception))

            db_first_user = DoubleDB(fetchone_val=[None, None, None])
            with patch('app.keycloak_auth._connect', return_value=db_first_user), \
                 patch('app.keycloak_auth.user_profile', side_effect=lambda u, a: {'username': u, 'is_admin': a}), \
                 patch.dict(os.environ, {'KEYCLOAK_ADMIN_SUBJECTS': ''}):
                user = keycloak_auth.resolve_identity(claims)
                self.assertTrue(user['is_admin'])
                self.assertTrue(user['username'].startswith('kc-'))

    async def test_start_flow_routes(self):
        req = MagicMock()
        req.headers = {}
        req.url.scheme = 'https'
        req.url.netloc = 'bob.local'

        with patch('app.keycloak_auth.configured', return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                await keycloak_auth.login(req)
            self.assertEqual(ctx.exception.status_code, 503)

        with patch('app.keycloak_auth.configured', return_value=True), \
             patch('app.keycloak_auth.discovery', side_effect=RuntimeError('Discovery offline')):
            with self.assertRaises(HTTPException) as ctx:
                await keycloak_auth.login(req)
            self.assertEqual(ctx.exception.status_code, 503)

        db = DoubleDB()
        disco_data = {'authorization_endpoint': 'https://auth.bob.com/auth'}
        with patch('app.keycloak_auth.configured', return_value=True), \
             patch('app.keycloak_auth.discovery', return_value=disco_data), \
             patch('app.keycloak_auth._connect', return_value=db), \
             patch.dict(os.environ, {'KEYCLOAK_CLIENT_ID': 'bob-client'}):
            resp = await keycloak_auth.login(req)
            self.assertEqual(resp.status_code, 302)
            self.assertIn('https://auth.bob.com/auth?', resp.headers['location'])

    async def test_callback_failures_and_success(self):
        req = MagicMock()
        req.cookies = {'bob_keycloak_state': 'state123'}

        resp_mismatch = await keycloak_auth.callback(req, state='wrong_state', code='code1')
        self.assertEqual(resp_mismatch.status_code, 302)
        self.assertIn('keycloak_error', resp_mismatch.headers['location'])

        db_empty = DoubleDB(fetchone_val=None)
        with patch('app.keycloak_auth.configured', return_value=True), \
             patch('app.keycloak_auth._connect', return_value=db_empty):
            resp_expired = await keycloak_auth.callback(req, state='state123', code='code1')
            self.assertIn('keycloak_error', resp_expired.headers['location'])

        flow_row = ('nonce123', 'verifier123', 'https://bob.local/cb', '/learning')
        db_flow = DoubleDB(fetchone_val=flow_row)
        tokens_resp = MagicMock()
        tokens_resp.json.return_value = {'id_token': 'id_token_123'}
        jwks_resp = MagicMock()
        jwks_resp.json.return_value = {'keys': []}

        client_mock = AsyncMock()
        client_mock.post.return_value = tokens_resp
        client_mock.get.return_value = jwks_resp

        with patch('app.keycloak_auth.configured', return_value=True), \
             patch('app.keycloak_auth._connect', return_value=db_flow), \
             patch('httpx.AsyncClient') as client_ctx, \
             patch('app.keycloak_auth.discovery', return_value={'token_endpoint': 'https://auth/token', 'jwks_uri': 'https://auth/jwks'}), \
             patch('app.keycloak_auth.validate_token', return_value={'sub': 'sub1'}), \
             patch('app.keycloak_auth.resolve_identity', return_value={'username': 'kc-user', 'is_admin': False}), \
             patch('app.keycloak_auth.start_session') as session_mock, \
             patch.dict(os.environ, {'KEYCLOAK_CLIENT_ID': 'cid', 'KEYCLOAK_CLIENT_SECRET': 'csec'}):
            client_ctx.return_value.__aenter__.return_value = client_mock
            resp_success = await keycloak_auth.callback(req, state='state123', code='code123')
            self.assertEqual(resp_success.status_code, 302)
            self.assertEqual(resp_success.headers['location'], '/learning')
            session_mock.assert_called_once()


# ===========================================================================
# 3. Agent Catalog Deep Coverage
# ===========================================================================

class AgentCatalogDeepCoverageTests(unittest.IsolatedAsyncioTestCase):
    def test_clean_icon_variations(self):
        self.assertEqual(agent_catalog.clean_icon('⚡'), '⚡')
        self.assertEqual(agent_catalog.clean_icon('https://icons.company.com/agent.png'), 'https://icons.company.com/agent.png')
        with self.assertRaises(HTTPException):
            agent_catalog.clean_icon('http://insecure.company.com/agent.png')
        with self.assertRaises(HTTPException):
            agent_catalog.clean_icon('https://admin:pass@icons.company.com/agent.png')

    def test_validate_grants_errors(self):
        with self.assertRaises(HTTPException) as ctx:
            agent_catalog.validate_grants(['unknown-group'], [])
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            agent_catalog.validate_grants([], ['INVALID_USER!'])
        self.assertEqual(ctx.exception.status_code, 422)

        db_not_found = DoubleDB(fetchall_val=[])
        with patch('app.agent_catalog._connect', return_value=db_not_found):
            with self.assertRaises(HTTPException) as ctx:
                agent_catalog.validate_grants([], ['alice'])
            self.assertEqual(ctx.exception.status_code, 422)

    def test_discovery_error_detail_patterns(self):
        req = httpx.Request('GET', 'https://agent.local')
        err404 = httpx.HTTPStatusError('404', request=req, response=httpx.Response(404, request=req))
        self.assertIn('HTTP 404', agent_catalog.discovery_error_detail(err404))

        err500 = httpx.HTTPStatusError('500', request=req, response=httpx.Response(500, request=req))
        self.assertIn('HTTP 500', agent_catalog.discovery_error_detail(err500))

        err_timeout = httpx.ConnectTimeout('timeout', request=req)
        self.assertIn('timed out', agent_catalog.discovery_error_detail(err_timeout))

        err_connect = httpx.ConnectError('connect', request=req)
        self.assertIn('connect securely', agent_catalog.discovery_error_detail(err_connect))

        err_port = ValueError('Nonstandard web ports require an approved origin')
        self.assertIn('BOB_A2A_ALLOWED_ORIGINS', agent_catalog.discovery_error_detail(err_port))

        err_jsonrpc = ValueError('Agent Card has no JSON-RPC interface')
        self.assertEqual(agent_catalog.discovery_error_detail(err_jsonrpc), 'Agent Card has no JSON-RPC interface')

    async def test_save_template_validations(self):
        admin_user = {'username': 'admin', 'is_admin': True}
        body = MagicMock()
        body.id = 'agent-1'
        body.card_url = 'https://agent.local/card.json'
        body.icon = '🤖'
        body.groups = []
        body.users = []
        body.discovery_auth_token = ''
        body.discovery_api_key = ''

        with self.assertRaises(HTTPException) as ctx_id:
            await agent_catalog.save_template('diff-id', body, admin_user)
        self.assertEqual(ctx_id.exception.status_code, 422)

        with patch('app.agent_catalog.discover_agent', side_effect=httpx.ConnectTimeout('timeout', request=httpx.Request('GET', 'https://a.local'))):
            with self.assertRaises(HTTPException) as ctx:
                await agent_catalog.save_template('agent-1', body, admin_user)
            self.assertEqual(ctx.exception.status_code, 422)

        discovered_bad_header = {'id': 'agent-1', 'api_key_header': 'authorization', 'endpoint': 'https://agent.local'}
        with patch('app.agent_catalog.discover_agent', return_value=discovered_bad_header):
            with self.assertRaises(HTTPException) as ctx_hdr:
                await agent_catalog.save_template('agent-1', body, admin_user)
            self.assertEqual(ctx_hdr.exception.status_code, 422)

    def test_activate_and_deactivate_agent(self):
        user = {'username': 'alice', 'is_admin': False}
        with patch('app.agent_catalog.ensure_schema'), \
             patch('app.agent_catalog.knowledge_access', return_value={}), \
             patch('app.agent_catalog._connect', return_value=DoubleDB(fetchone_val=None)):
            with self.assertRaises(HTTPException) as ctx:
                agent_catalog.activate('agent-1', MagicMock(), user)
            self.assertEqual(ctx.exception.status_code, 403)

        body_with_newline = agent_catalog.Activation(api_key='key\nwith\nnewline', auth_token='', clear_credentials=False)
        db_perm = DoubleDB(fetchone_val=[(['everyone'], [], True), None])
        with patch('app.agent_catalog.ensure_schema'), \
             patch('app.agent_catalog.knowledge_access', return_value={}), \
             patch('app.agent_catalog.permitted', return_value=True), \
             patch('app.agent_catalog._connect', return_value=db_perm):
            with self.assertRaises(HTTPException) as ctx_nl:
                agent_catalog.activate('agent-1', body_with_newline, user)
            self.assertEqual(ctx_nl.exception.status_code, 422)

        db_valid = DoubleDB(fetchone_val=[(['everyone'], [], True), None])
        body_valid = agent_catalog.Activation(api_key='valid_secret', auth_token='', clear_credentials=False)
        with patch('app.agent_catalog.ensure_schema'), \
             patch('app.agent_catalog.knowledge_access', return_value={}), \
             patch('app.agent_catalog.permitted', return_value=True), \
             patch('app.agent_catalog._connect', return_value=db_valid):
            res = agent_catalog.activate('agent-1', body_valid, user)
            self.assertTrue(res['activated'])

            res_deact = agent_catalog.deactivate('agent-1', user)
            self.assertIsNone(res_deact)


# ===========================================================================
# 4. Research Sources Deep Coverage
# ===========================================================================

class ResearchSourcesDeepCoverageTests(unittest.TestCase):
    def test_fetch_source_redirect_and_format_errors(self):
        mock_resp_redirect = MagicMock()
        mock_resp_redirect.status_code = 302
        mock_resp_redirect.headers = {}

        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.stream.return_value.__enter__.return_value = mock_resp_redirect

        with patch('httpx.Client', return_value=mock_client), \
             patch('app.research_sources.resolve'):
            with self.assertRaises(ValueError) as ctx:
                research_sources.fetch_source('https://example.com/start')
            self.assertIn('Redirect has no destination', str(ctx.exception))

        mock_resp_img = MagicMock()
        mock_resp_img.status_code = 200
        mock_resp_img.headers = {'content-type': 'image/png'}
        mock_client.stream.return_value.__enter__.return_value = mock_resp_img
        with patch('httpx.Client', return_value=mock_client), \
             patch('app.research_sources.resolve'):
            with self.assertRaises(ValueError) as ctx:
                research_sources.fetch_source('https://example.com/pic.png')
            self.assertIn('Unsupported page format', str(ctx.exception))

    def test_fetch_source_limits_and_no_text(self):
        mock_resp_huge = MagicMock()
        mock_resp_huge.status_code = 200
        mock_resp_huge.headers = {'content-type': 'text/html'}
        mock_resp_huge.iter_bytes.return_value = [b'x' * (research_sources.MAX_BYTES + 10)]

        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.stream.return_value.__enter__.return_value = mock_resp_huge

        with patch('httpx.Client', return_value=mock_client), \
             patch('app.research_sources.resolve'):
            with self.assertRaises(ValueError) as ctx:
                research_sources.fetch_source('https://example.com/big.html')
            self.assertIn('exceeds research download limit', str(ctx.exception))

        mock_resp_empty = MagicMock()
        mock_resp_empty.status_code = 200
        mock_resp_empty.headers = {'content-type': 'text/html'}
        mock_resp_empty.iter_bytes.return_value = [b'<html><body></body></html>']
        mock_resp_empty.encoding = 'utf-8'
        mock_client.stream.return_value.__enter__.return_value = mock_resp_empty
        with patch('httpx.Client', return_value=mock_client), \
             patch('app.research_sources.resolve'):
            with self.assertRaises(ValueError) as ctx:
                research_sources.fetch_source('https://example.com/empty.html')
            self.assertIn('Page has no readable text', str(ctx.exception))

    def test_write_record_security_escape(self):
        with self.assertRaises(ValueError) as ctx:
            research_sources.write_record('/tmp/escape_workspace.json', {'url': 'https://x.com'}, base='/safe/workspace')
        self.assertIn('escapes workspace', str(ctx.exception))

    def test_main_cli_arguments(self):
        with patch.object(sys, 'argv', ['research_sources', '--fetch', 'https://example.com']):
            res = research_sources.main()
            self.assertEqual(res, 1)

        with patch.object(sys, 'argv', ['research_sources', '--search', 'query text']), \
             patch('app.research_sources.brave_web_search', return_value='Error: Brave down'):
            res_search = research_sources.main()
            self.assertEqual(res_search, 1)

    def test_office_available_paths(self):
        with patch('app.mcp_access.get_authorized_server', return_value=None):
            self.assertFalse(research_sources.office_available('alice'))

        with patch('app.mcp_access.get_authorized_server', return_value={'name': 'microsoft365'}), \
             patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test_tok.json')), \
             patch('app.postgres_storage.read_user_file', return_value='corrupted json'):
            self.assertFalse(research_sources.office_available('alice'))

        with patch('app.mcp_access.get_authorized_server', return_value={'name': 'microsoft365'}), \
             patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test_tok.json')), \
             patch('app.postgres_storage.read_user_file', return_value=json.dumps({'access_token': 'valid_tok'})):
            self.assertTrue(research_sources.office_available('alice'))

    def test_collect_office_limits_and_docx(self):
        with patch('app.mcp_access.get_authorized_server', return_value=None):
            with self.assertRaises(PermissionError):
                research_sources.collect_office(Path('/tmp'), 'bob', 'query')

        with patch('app.mcp_access.get_authorized_server', return_value={'name': 'microsoft365'}), \
             patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/fake.json')):
            res_empty = research_sources.collect_office(Path('/tmp'), 'bob', '   ')
            self.assertEqual(res_empty, 0)

        docx_buf = io.BytesIO()
        with zipfile.ZipFile(docx_buf, 'w') as zf:
            zf.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Office Doc</w:t></w:r></w:p></w:body></w:document>')
        docx_bytes = docx_buf.getvalue()

        search_resp = MagicMock()
        search_resp.json.return_value = {'value': [{'id': 'f1', 'name': 'report.docx', 'size': 100, 'file': {}}]}

        meta_resp = MagicMock()
        meta_resp.json.return_value = {'id': 'f1', 'name': 'report.docx', 'size': 100, 'file': {}, 'webUrl': 'https://sharepoint.example.com/doc'}

        download_stream = MagicMock()
        download_stream.iter_bytes.return_value = [docx_bytes]

        client_mock = MagicMock()
        client_mock.__enter__.return_value = client_mock
        client_mock.get.side_effect = [search_resp, meta_resp]
        client_mock.stream.return_value.__enter__.return_value = download_stream

        with patch.dict(os.environ, {'RESEARCH_EVIDENCE_SECRET': 'test-signing-key'}), \
             patch('app.mcp_access.get_authorized_server', return_value={'name': 'microsoft365'}), \
             patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/fake.json')), \
             patch('app.mcp_microsoft._load_and_refresh_token', return_value={'access_token': 'abc'}), \
             patch('httpx.Client', return_value=client_mock), \
             patch('app.research_sources.write_record') as write_mock:
            res = research_sources.collect_office(Path('/tmp'), 'alice', 'important report')
            self.assertEqual(res, 1)
            write_mock.assert_called_once()


# ===========================================================================
# 5. Decisions Buddy Main Deep Coverage
# ===========================================================================

class DecisionsBuddyMainDeepCoverageTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_manager_and_broadcast(self):
        cm = decisions_main.ConnectionManager()
        ws_live = MagicMock()
        ws_live.accept = AsyncMock()
        ws_live.send_json = AsyncMock()

        ws_dead = MagicMock()
        ws_dead.accept = AsyncMock()
        ws_dead.send_json = AsyncMock(side_effect=RuntimeError('Socket closed'))

        await cm.connect(ws_live)
        await cm.connect(ws_dead)
        self.assertEqual(len(cm.active_connections), 2)

        await cm.broadcast({'type': 'ping'})
        self.assertEqual(len(cm.active_connections), 1)

        decisions_main.broadcast_event({'type': 'event'})

    def test_decisions_route_error_wrapping(self):
        app = decisions_main.FastAPI()
        router = decisions_main.APIRouter(route_class=decisions_main.DecisionsRoute)

        @router.get('/fail-gov')
        def fail_gov(): raise decisions_main.GovernanceError('gov err')

        @router.get('/fail-rev')
        def fail_rev(): raise decisions_main.db.RevisionConflict()

        @router.get('/fail-perm')
        def fail_perm(): raise PermissionError('denied')

        @router.get('/fail-val')
        def fail_val(): raise ValueError('bad value')

        @router.get('/fail-type')
        def fail_type(): raise TypeError('type error')

        app.include_router(router)
        client = TestClient(app)

        self.assertEqual(client.get('/fail-gov').status_code, 409)
        self.assertEqual(client.get('/fail-rev').status_code, 409)
        self.assertEqual(client.get('/fail-perm').status_code, 403)
        self.assertEqual(client.get('/fail-val').status_code, 422)
        self.assertEqual(client.get('/fail-type').status_code, 422)

    def test_save_decision_nested_checks(self):
        user = {'username': 'owner', 'is_admin': False}
        graph_invalid_version = {
            'nodes': [{
                'id': 'n1',
                'type': 'decisionNode',
                'content': {'decisionId': 'd-child', 'version': 0}
            }],
            'edges': []
        }
        req = decisions_main.SaveDecisionRequest(
            id='d1', name='Decision 1', description='', graph=graph_invalid_version,
            defaultInput={}, changeSummary='', accessPolicy='private', expectedVersion=1
        )
        with patch('app.decisions_buddy.main.validate_graph'), \
             patch('app.decisions_buddy.main._read', return_value={'version': 1}):
            with self.assertRaises(HTTPException) as ctx:
                decisions_main.save(req, user)
            self.assertEqual(ctx.exception.status_code, 422)

        graph_missing_snap = {
            'nodes': [{
                'id': 'n1',
                'type': 'decisionNode',
                'content': {'decisionId': 'd-child', 'version': 2}
            }],
            'edges': []
        }
        req_missing = decisions_main.SaveDecisionRequest(
            id='d1', name='Decision 1', description='', graph=graph_missing_snap,
            defaultInput={}, changeSummary='', accessPolicy='private', expectedVersion=1
        )
        with patch('app.decisions_buddy.main.validate_graph'), \
             patch('app.decisions_buddy.main._read', return_value={'version': 2}), \
             patch('app.decisions_buddy.db.get_version_snapshot', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                decisions_main.save(req_missing, user)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_delete_and_rollback_decision(self):
        user = {'username': 'admin', 'is_admin': True}
        with patch('app.decisions_buddy.main._write'), \
             patch('app.decisions_buddy.main._mutation', return_value=True), \
             patch('app.decisions_buddy.main.broadcast_event') as b_mock:
            res = decisions_main.delete('d1', expectedVersion=2, user=user)
            self.assertEqual(res['status'], 'success')
            b_mock.assert_called_once()

        with patch('app.decisions_buddy.main._write'), \
             patch('app.decisions_buddy.main._mutation', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                decisions_main.rollback('d1', version=1, expectedVersion=2, user=user)
            self.assertEqual(ctx.exception.status_code, 404)

    def test_version_and_diff_not_found(self):
        user = {'username': 'viewer'}
        with patch('app.decisions_buddy.main._read'), \
             patch('app.decisions_buddy.db.get_version_snapshot', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                decisions_main.version('d1', 3, user)
            self.assertEqual(ctx.exception.status_code, 404)

            with self.assertRaises(HTTPException) as ctx_diff:
                decisions_main.diff('d1', 1, 2, user)
            self.assertEqual(ctx_diff.exception.status_code, 404)

    def test_eval_unary_and_expression_errors(self):
        req_long = {'test': 'x' * 3000}
        with self.assertRaises(HTTPException) as ctx:
            decisions_main.unary(req_long)
        self.assertEqual(ctx.exception.status_code, 422)

        with patch('app.decisions_buddy.main.evaluate_unary', side_effect=Exception('Syntax err')):
            with self.assertRaises(HTTPException) as ctx_eval:
                decisions_main.unary({'test': 'test', 'value': 5})
            self.assertEqual(ctx_eval.exception.status_code, 422)

        with patch('app.decisions_buddy.main.evaluate_expression', side_effect=Exception('Eval err')):
            with self.assertRaises(HTTPException) as ctx_expr:
                decisions_main.expression({'expression': '1/0'})
            self.assertEqual(ctx_expr.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx_bal_empty:
            decisions_main.evaluate_bal({'rule': ''})
        self.assertEqual(ctx_bal_empty.exception.status_code, 422)

    def test_simulation_workbook_routes(self):
        user = {'username': 'author'}
        with patch('app.decisions_buddy.scenario_workbook.workbook_template', return_value=b'PK'):
            resp = decisions_main.simulation_workbook_template(user)
            self.assertIn('decision-scenarios.xlsx', resp.headers['content-disposition'])

        with self.assertRaises(HTTPException) as ctx:
            decisions_main.simulation_import_workbook({'contentBase64': 123}, user)
        self.assertEqual(ctx.exception.status_code, 422)


# ===========================================================================
# 6. Learning Course Completion Deep Coverage
# ===========================================================================

class LearningCourseCompletionDeepCoverageTests(unittest.TestCase):
    def test_model_validators(self):
        with self.assertRaises(ValidationError):
            course_completion.Approval(
                expected_revision=1, evidence_digest='a' * 64, recipient_name='   '
            )
        with self.assertRaises(ValidationError):
            course_completion.Revocation(reason='  ')

    def test_is_mock_db_detection(self):
        mock_db = DoubleDB(real=False)
        self.assertTrue(course_completion._is_mock_db(mock_db))

        real_db = DoubleDB(real=True)
        self.assertFalse(course_completion._is_mock_db(real_db))

    def test_smtp_status_error_handling(self):
        with patch('app.smtp_settings.load_config', side_effect=Exception('No SMTP')):
            enabled, cfg = course_completion._smtp_status()
            self.assertFalse(enabled)
            self.assertEqual(cfg, {})

    def test_roster_resolution(self):
        cid = str(uuid4())
        db = DoubleDB(fetchall_val=[{'username': 'u1', 'display_name': 'User 1'}])
        course_manage = {'id': cid, 'can_manage': True}
        roster = course_completion._roster(db, course_manage, {'username': 'u1'})
        self.assertEqual(len(roster), 1)

        course_learner = {'id': cid, 'can_manage': False}
        roster_learner = course_completion._roster(db, course_learner, {'username': 'u1', 'display_name': 'User 1'})
        self.assertEqual(len(roster_learner), 1)
        self.assertEqual(roster_learner[0]['username'], 'u1')

    def test_state_auto_issue_real_db(self):
        cid = str(uuid4())
        fid = str(uuid4())
        lesson_id = uuid4()
        course = {
            'id': cid,
            'folder_id': fid,
            'title': 'Safety Training',
            'revision': 1,
            'can_manage': True,
            'archived': False,
            'teacher_username': 'teacher_jane',
            'teacher_display_name': 'Teacher Jane'
        }
        users = [{'username': 'learner_alex', 'display_name': 'Learner Alex'}]

        def custom_execute(sql, params=None):
            m = MagicMock()
            if 'SELECT * FROM learning.class_assignments' in sql:
                m.fetchall.return_value = []
            elif 'FROM learning.lessons WHERE folder_id=' in sql:
                m.fetchall.return_value = [{'id': lesson_id, 'title': 'L1', 'version': 1}]
            elif 'FROM learning.quizzes WHERE folder_id=' in sql:
                m.fetchall.return_value = []
            elif 'SELECT display_name FROM bob_user_profiles' in sql:
                m.fetchone.return_value = {'display_name': 'Alex Smith'}
            elif 'learning.lesson_progress' in sql:
                m.fetchall.return_value = [{'assignment_id': f'lesson:{lesson_id}', 'username': 'learner_alex', 'completed': True, 'score': 100}]
            elif 'INSERT INTO learning.course_certificates' in sql:
                m.fetchone.return_value = {
                    'id': str(uuid4()), 'class_id': cid, 'username': 'learner_alex', 'version': 1,
                    'recipient_name': 'Alex Smith', 'course_title': 'Safety Training',
                    'instructor_name': 'Teacher Jane', 'issued_by': 'teacher_jane', 'class_revision': 1,
                    'evidence': {}, 'evidence_digest': 'dig', 'note': ''
                }
            else:
                m.fetchall.return_value = []
                m.fetchone.return_value = None
            return m

        db = DoubleDB(real=True)
        db.execute = custom_execute

        with patch('buddy_learning.course_completion._smtp_status', return_value=(False, {})):
            res = course_completion._state(db, course, users, auto_issue=True)
            self.assertEqual(len(res), 1)
            self.assertTrue(res[0]['eligible'])
            self.assertIsNotNone(res[0]['certificate'])

    def test_deliver_certificate_email_branches(self):
        cert = {
            'id': str(uuid4()),
            'username': 'user@example.com',
            'course_title': 'Network Admin',
            'recipient_name': 'Learner',
            'issued_at': '2026-10-30T10:00:00Z',
            'instructor_name': 'Teacher',
            'issued_by': 'teacher1',
            'version': 1
        }

        db_disabled = DoubleDB(real=True, fetchone_val=[{'email': 'user@example.com'}, None])
        with patch('buddy_learning.course_completion._smtp_status', return_value=(False, {})):
            res_disabled = course_completion.deliver_certificate_email(db_disabled, cert)
            self.assertEqual(res_disabled['email_status'], 'pending_smtp')

        db_no_email = DoubleDB(real=True, fetchone_val=[{'email': None}, None])
        cert_no_email = {**cert, 'username': 'no_email_user'}
        with patch('buddy_learning.course_completion._smtp_status', return_value=(True, {'host': 'smtp.local'})):
            res_no_email = course_completion.deliver_certificate_email(db_no_email, cert_no_email)
            self.assertEqual(res_no_email['email_status'], 'no_email')

        db_sent = DoubleDB(real=True, fetchone_val=[{'email': 'user@example.com'}, None])
        with patch('buddy_learning.course_completion._smtp_status', return_value=(True, {'host': 'smtp.local'})), \
             patch('buddy_learning.course_completion.from_thread.run', return_value=b'%PDF-fake'), \
             patch('app.smtp_settings.send_message') as send_mock:
            res_sent = course_completion.deliver_certificate_email(db_sent, cert)
            self.assertEqual(res_sent['email_status'], 'sent')
            send_mock.assert_called_once()

    def test_claim_and_approve_completion_exceptions(self):
        cid = uuid4()
        user = {'username': 'learner1', 'is_admin': False}

        with patch('buddy_learning.classrooms.authorize_class', return_value={'archived': True}), \
             patch('buddy_learning.course_completion.job_queue._connect', return_value=DoubleDB()):
            with self.assertRaises(HTTPException) as ctx:
                course_completion.claim_completion_certificate(cid, course_completion.ClaimCertificate(), user)
            self.assertEqual(ctx.exception.status_code, 409)

        req_app = course_completion.Approval(expected_revision=1, evidence_digest='a' * 64, recipient_name='Alex')
        with patch('buddy_learning.classrooms.authorize_class', return_value={'archived': True, 'revision': 1}), \
             patch('buddy_learning.course_completion.job_queue._connect', return_value=DoubleDB()):
            with self.assertRaises(HTTPException) as ctx_arch:
                course_completion.approve_completion(cid, 'learner1', req_app, user)
            self.assertEqual(ctx_arch.exception.status_code, 409)


# ===========================================================================
# 7. Learning Classrooms Deep Coverage
# ===========================================================================

class LearningClassroomsDeepCoverageTests(unittest.TestCase):
    def test_classrooms_update_members_deep(self):
        cid = uuid4()
        fid = uuid4()
        course = {
            'id': cid,
            'folder_id': fid,
            'title': 'Fiber Optics 101',
            'created_by': 'teacher1',
            'teacher_username': 'teacher1',
            'archived': False
        }
        admin_user = {'username': 'super_admin', 'is_admin': True}

        app_id = str(uuid4())
        req_bad = classrooms.ClassAccessInput(usernames=[], groups=[], app_groups=[app_id])

        db_empty = DoubleDB(real=True, fetchall_val=[])
        with patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.job_queue._connect', return_value=db_empty):
            with self.assertRaises(HTTPException) as ctx:
                classrooms.update_class_access(cid, req_bad, admin_user)
            self.assertEqual(ctx.exception.status_code, 422)

        non_admin = {'username': 'teacher1', 'is_admin': False}
        req_reassign = classrooms.ClassAccessInput(usernames=[], groups=[], app_groups=[], teacher_username='new_teacher')

        with patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.job_queue._connect', return_value=DoubleDB(real=True)):
            with self.assertRaises(HTTPException) as ctx_adm:
                classrooms.update_class_access(cid, req_reassign, non_admin)
            self.assertEqual(ctx_adm.exception.status_code, 403)

        req_success = classrooms.ClassAccessInput(usernames=['learner1'], groups=['/dept/tech'], app_groups=[app_id], teacher_username='teacher1')

        def execute_flow(sql, params=None):
            m = MagicMock()
            if 'SELECT username FROM users' in sql:
                m.fetchall.return_value = [{'username': 'learner1'}]
            elif 'SELECT id FROM bob_app_groups' in sql:
                m.fetchall.return_value = [{'id': app_id}]
            elif 'SELECT DISTINCT gm.username FROM bob_app_group_members' in sql:
                m.fetchall.return_value = [{'username': 'learner2'}]
            elif 'SELECT username FROM learning.class_members WHERE class_id=' in sql:
                m.fetchall.return_value = [{'username': 'learner1'}]
            else:
                m.fetchall.return_value = []
                m.fetchone.return_value = None
            return m

        db_flow = DoubleDB(real=True)
        db_flow.execute = execute_flow

        with patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.job_queue._connect', return_value=db_flow), \
             patch('buddy_learning.classrooms.realm', return_value='test-realm'), \
             patch('buddy_learning.classrooms.notify_enrolled') as notify_mock, \
             patch('buddy_learning.classrooms.member_rows', return_value=[]):
            res = classrooms.update_class_access(cid, req_success, admin_user)
            self.assertIn('learner2', res['usernames'])
            notify_mock.assert_called_once()

    def test_class_directory_deep(self):
        cid = uuid4()
        fid = uuid4()
        course = {'id': cid, 'folder_id': fid, 'title': 'Course', 'created_by': 'teacher1', 'teacher_username': 'teacher1'}
        user = {'username': 'admin', 'is_admin': True}

        def execute_dir(sql, params=None):
            m = MagicMock()
            if 'learning.class_members' in sql:
                m.fetchall.return_value = [{'username': 'u1'}]
            elif 'learning.members' in sql:
                m.fetchall.return_value = [{'username': 'u2'}]
            elif 'bob_keycloak_group_memberships' in sql:
                m.fetchall.return_value = [{'path': '/dept/tech'}]
            elif 'bob_app_groups' in sql:
                m.fetchall.return_value = [{'id': uuid4(), 'name': 'Admins', 'description': '', 'member_count': 2}]
            elif 'SELECT DISTINCT u.username' in sql:
                m.fetchall.return_value = [{'username': 'u1', 'is_admin': True, 'email': 'u1@example.com', 'display_name': 'User 1'}]
            else:
                m.fetchall.return_value = []
                m.fetchone.return_value = None
            return m

        db = DoubleDB(real=True)
        db.execute = execute_dir

        with patch('buddy_learning.classrooms.authorize_class', return_value=course), \
             patch('buddy_learning.classrooms.job_queue._connect', return_value=db), \
             patch('buddy_learning.classrooms.realm', return_value='test-realm'), \
             patch('buddy_learning.store.can_create', return_value=True):
            dir_res = classrooms.get_class_access(cid, user)
            self.assertIn('directory', dir_res)
            self.assertEqual(len(dir_res['available_teachers']), 1)


# ===========================================================================
# 8. Learning Service Deep Coverage
# ===========================================================================

class LearningServiceDeepCoverageTests(unittest.TestCase):
    def test_books_size_and_parse(self):
        with patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}):
            body_mock = MagicMock()
            body_mock.read.return_value = b'x' * (learning_service.MAX_UPLOAD + 10)
            with patch('buddy_learning.service.s3') as s3_mock:
                s3_mock.return_value.get_object.return_value = {'Body': body_mock}
                with self.assertRaises(HTTPException) as ctx:
                    learning_service.object_bytes('huge_key')
                self.assertEqual(ctx.exception.status_code, 413)

        with patch('buddy_learning.service.object_bytes', return_value=b'sample content'), \
             patch('buddy_learning.service.job_queue._connect', return_value=DoubleDB(fetchone_val={'filename': 'guide.epub'})), \
             patch('buddy_learning.service.parse_document', return_value={'title': 'Guide'}):
            res = learning_service.parsed_book('valid_key')
            self.assertEqual(res['title'], 'Guide')

    def test_folder_content_real_db_branches(self):
        fid = uuid4()
        user = {'username': 'teacher_jane', 'is_admin': False}

        def execute_content(sql, params=None):
            m = MagicMock()
            if 'learning.classes' in sql:
                m.fetchone.return_value = {'teacher': 'teacher_jane'}
            elif 'learning.books' in sql:
                m.fetchall.return_value = [{'id': uuid4(), 'title': 'Handbook', 'extension': 'epub', 'lesson_id': None}]
            elif 'learning.quizzes' in sql:
                m.fetchall.return_value = [{'id': uuid4(), 'title': 'Safety Quiz', 'draft': False, 'is_creator': True, 'status': 'published', 'version': 1, 'submitted': False}]
            elif 'learning.lessons' in sql:
                m.fetchall.return_value = [{'id': uuid4(), 'title': 'Module 1', 'ordinal': 1, 'is_creator': True, 'status': 'published', 'version': 1}]
            elif 'learning.class_notes' in sql:
                m.fetchall.return_value = [{'id': uuid4(), 'title': 'Note 1', 'body': 'Text', 'folder_id': fid, 'bob_note_id': None}]
            else:
                m.fetchall.return_value = []
                m.fetchone.return_value = None
            return m

        db = DoubleDB(real=True)
        db.execute = execute_content

        with patch('buddy_learning.store.folder', return_value={'id': fid, 'name': 'Tech'}), \
             patch('buddy_learning.store.can_create', return_value=True), \
             patch('buddy_learning.service.job_queue._connect', return_value=db):
            content = learning_service.contents(fid, user)
            self.assertTrue(content['can_manage_class'])
            self.assertEqual(len(content['books']), 1)
            self.assertEqual(len(content['quizzes']), 1)
            self.assertEqual(len(content['lessons']), 1)
            self.assertEqual(len(content['notes']), 1)

    def test_class_notes_bob_notes_sync(self):
        fid = uuid4()
        user = {'username': 'alice', 'is_admin': False}
        note_id = uuid4()
        bob_note_id = uuid4()

        req = MagicMock()
        req.title = 'Key Formula'
        req.body = 'E=mc^2'
        req.color = '#fff'
        req.tags = ['physics']
        req.favorite = True
        req.lesson_id = None

        db = DoubleDB(real=True)
        db._fetchone_val = [
            {'id': bob_note_id},
            {'id': note_id, 'folder_id': fid, 'lesson_id': None, 'title': 'Key Formula', 'bob_note_id': bob_note_id}
        ]

        with patch('buddy_learning.store.folder', return_value={'id': fid, 'name': 'Physics'}), \
             patch('buddy_learning.service.job_queue._connect', return_value=db):
            res_create = learning_service.create_class_note(fid, req, user)
            self.assertEqual(res_create['id'], note_id)

        db_up = DoubleDB(real=True)
        db_up._fetchone_val = [
            {'id': note_id, 'folder_id': fid, 'bob_note_id': bob_note_id},
            {'id': note_id, 'title': 'Updated Formula', 'bob_note_id': bob_note_id}
        ]
        with patch('buddy_learning.store.folder', return_value={'id': fid}), \
             patch('buddy_learning.service.job_queue._connect', return_value=db_up):
            res_update = learning_service.update_class_note(note_id, req, user)
            self.assertEqual(res_update['id'], note_id)


# ===========================================================================
# 9. Main Application Deep Coverage
# ===========================================================================

class MainDeepCoverageTests(unittest.IsolatedAsyncioTestCase):
    async def test_static_routes(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            static_dir = Path(tmp_dir)
            (static_dir / "index.html").write_text("<html>App</html>")
            (static_dir / "favicon.svg").write_text("<svg></svg>")

            with patch('app.main.STATIC_DIR', static_dir):
                resp_idx = await main.root()
                self.assertIn('no-store', resp_idx.headers['cache-control'])

                resp_fav = await main.favicon_svg()
                self.assertEqual(resp_fav.media_type, 'image/svg+xml')

    async def test_delete_project_file_endpoint(self):
        user = {'username': 'alice'}
        with patch('app.main.project_store.project_root'), \
             patch('app.main._delete_stored_file') as del_mock:
            resp = await main.delete_project_file('proj-1', 'notes.txt', user)
            self.assertEqual(resp.status_code, 204)
            del_mock.assert_called_once_with('alice', 'project:proj-1', 'notes.txt')

    async def test_knowledge_endpoints_exceptions(self):
        admin = {'username': 'admin', 'is_admin': True}
        doc_id = uuid4()

        upload_file_mock = MagicMock()
        upload_file_mock.read = AsyncMock(return_value=b'text')
        upload_file_mock.filename = 'doc.txt'

        with patch('app.main.rag.add_document', side_effect=PermissionError('Denied')):
            with self.assertRaises(HTTPException) as ctx_perm:
                await main.upload_knowledge(file=upload_file_mock, user=admin)
            self.assertEqual(ctx_perm.exception.status_code, 403)

        with patch('app.main.rag.add_document', side_effect=ValueError('Invalid doc')):
            with self.assertRaises(HTTPException) as ctx_val:
                await main.upload_knowledge(file=upload_file_mock, user=admin)
            self.assertEqual(ctx_val.exception.status_code, 422)

        req_fresh = main.KnowledgeFreshness(owner='bob')
        with patch('app.main.rag.update_freshness', return_value=None):
            with self.assertRaises(HTTPException) as ctx_fresh:
                await main.edit_knowledge_freshness(doc_id, req_fresh, admin)
            self.assertEqual(ctx_fresh.exception.status_code, 404)

        req_meta = main.KnowledgeMetadata(knowledge_base='kb1', audience=None)
        with self.assertRaises(HTTPException) as ctx_meta:
            await main.edit_knowledge(doc_id, req_meta, admin)
        self.assertEqual(ctx_meta.exception.status_code, 422)

        with patch('app.main.rag.replace_document', return_value=None):
            with self.assertRaises(HTTPException) as ctx_rep:
                await main.replace_knowledge(doc_id, file=upload_file_mock, user=admin)
            self.assertEqual(ctx_rep.exception.status_code, 404)

        with patch('app.main.rag.remove_document', side_effect=ValueError('In use')):
            with self.assertRaises(HTTPException) as ctx_rem_val:
                await main.remove_knowledge(doc_id, user=admin)
            self.assertEqual(ctx_rem_val.exception.status_code, 409)

        with patch('app.main.rag.remove_document', return_value=False):
            with self.assertRaises(HTTPException) as ctx_rem_nf:
                await main.remove_knowledge(doc_id, user=admin)
            self.assertEqual(ctx_rem_nf.exception.status_code, 404)

        req_search = main.KnowledgeSearchRequest(query='query')
        with patch('app.main.rag.retrieve', side_effect=httpx.HTTPError('Embedding offline')):
            with self.assertRaises(HTTPException) as ctx_search:
                await main.search_knowledge(req_search, admin)
            self.assertEqual(ctx_search.exception.status_code, 503)

    async def test_storage_documents_error_mappings(self):
        user = {'username': 'alice'}

        with patch('app.main.storage.delete_file', side_effect=ValueError('active lock')):
            with self.assertRaises(HTTPException) as ctx_val_act:
                await main.delete_session_file('legacy', 'file.txt', user)
            self.assertEqual(ctx_val_act.exception.status_code, 409)

        with patch('app.conversation_documents.enqueue', side_effect=FileNotFoundError('not found')):
            with self.assertRaises(HTTPException) as ctx_enq_nf:
                await main.prepare_conversation_document('legacy', 'path.pdf', user)
            self.assertEqual(ctx_enq_nf.exception.status_code, 404)

        with patch('app.conversation_documents.enqueue', side_effect=ValueError('active processing')):
            with self.assertRaises(HTTPException) as ctx_enq_act:
                await main.prepare_conversation_document('legacy', 'path.pdf', user)
            self.assertEqual(ctx_enq_act.exception.status_code, 409)

    async def test_mcp_routes_validations(self):
        admin = {'username': 'admin', 'is_admin': True}

        req_probe = main.MCPCreateRequest(transport='stdio', name='srv1', command='   ')
        with self.assertRaises(HTTPException) as ctx_probe:
            await main.test_mcp_draft(req_probe, admin)
        self.assertEqual(ctx_probe.exception.status_code, 422)

        req_create = main.MCPCreateRequest(transport='stdio', name='srv1', command='ls')

        with patch('app.main.create_mcp', side_effect=FileExistsError('Already exists')):
            with self.assertRaises(HTTPException) as ctx_cr_fe:
                await main.add_mcp(req_create, admin)
            self.assertEqual(ctx_cr_fe.exception.status_code, 409)

        with patch('app.main.create_mcp', side_effect=PermissionError('Denied')):
            with self.assertRaises(HTTPException) as ctx_cr_pe:
                await main.add_mcp(req_create, admin)
            self.assertEqual(ctx_cr_pe.exception.status_code, 403)

        req_agent = main.AgentCreateRequest(slug='srv1', card_url='https://agent.local/card.json', auth_token='tok')
        with patch('app.main.discover_agent', return_value={'endpoint': 'https://different.origin/endpoint'}):
            with self.assertRaises(HTTPException) as ctx_origin:
                await main.add_agent(req_agent, admin)
            self.assertEqual(ctx_origin.exception.status_code, 422)


if __name__ == '__main__':
    unittest.main()
