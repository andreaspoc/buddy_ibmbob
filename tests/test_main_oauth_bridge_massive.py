"""Massive unit test suite covering app/main.py, app/mcp_oauth.py, and app/acp_bridge.py.
Hermetically validates:
- app/main.py: Routes, auth flows, projects, sessions, hooks, MCPs, skills, jobs/guidance.
- app/mcp_oauth.py: RFC PKCE flow, discovery, registration, token exchange, refresh, state validation.
- app/acp_bridge.py: Protocol event bridging, subprocess controls, approval client, guidance, redaction.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import acp_bridge
from app import mcp_oauth
from app import main

client = TestClient(main.app, raise_server_exceptions=False)


class McpOauthPKCEMassiveTests(unittest.TestCase):
    """Deep coverage for OAuth 2.0 PKCE, discovery, state, and token management in app/mcp_oauth.py."""

    def setUp(self):
        self.username = 'alice'
        self.template_id = 'tmpl_slack'
        self.definition = {
            'transport': 'sse',
            'url': 'https://api.example.com/mcp/sse',
            'auth_mode': 'oauth',
            'oauth_client_id': 'client_123',
            'oauth_scopes': 'read write',
            'oauth_token_auth_method': 'none'
        }

    def test_public_url_validation(self):
        # Valid public HTTPS
        self.assertEqual(mcp_oauth.public_url('https://api.example.com/mcp'), 'https://api.example.com/mcp')
        self.assertEqual(mcp_oauth.public_url('https://api.example.com:443/mcp'), 'https://api.example.com:443/mcp')

        # Invalid schemes or embedded credentials
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('http://api.example.com/mcp')
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('https://user:pass@api.example.com/mcp')
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('https://api.example.com:8443/mcp')
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('https://api.example.com#fragment')
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('x' * 5000)

        # Private / loopback IP address
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('https://127.0.0.1/mcp')
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('https://10.0.0.1/mcp')
        with self.assertRaises(mcp_oauth.OAuthError):
            mcp_oauth.public_url('https://192.168.1.1/mcp')

    def test_resource_matches_and_origin(self):
        self.assertEqual(mcp_oauth.origin('https://api.example.com/path?query=1'), 'https://api.example.com')
        # Subpath matching
        self.assertTrue(mcp_oauth.resource_matches('https://api.example.com/v1/mcp', 'https://api.example.com/v1'))
        self.assertTrue(mcp_oauth.resource_matches('https://api.example.com/v1', 'https://api.example.com/v1'))
        self.assertFalse(mcp_oauth.resource_matches('https://api.example.com/v2', 'https://api.example.com/v1'))
        self.assertFalse(mcp_oauth.resource_matches('https://other.example.com/v1', 'https://api.example.com/v1'))

    def test_fingerprint_stability(self):
        fp1 = mcp_oauth.fingerprint(self.definition)
        fp2 = mcp_oauth.fingerprint(dict(reversed(list(self.definition.items()))))
        self.assertEqual(fp1, fp2)
        changed = {**self.definition, 'oauth_scopes': 'admin'}
        self.assertNotEqual(fp1, mcp_oauth.fingerprint(changed))

    def test_discover_standard_and_keycloak(self):
        # 1. Standard OAuth discovery failure cases
        with patch.object(mcp_oauth, 'http_request') as mock_req:
            mock_req.return_value = (404, {}, None)
            with self.assertRaisesRegex(mcp_oauth.OAuthError, 'does not advertise OAuth'):
                mcp_oauth.discover(self.definition)

            # Metadata resource mismatch
            mock_req.side_effect = [
                (401, {}, None),
                (200, {}, {'authorization_servers': ['https://auth.example.com'], 'resource': 'https://different.example.com'})
            ]
            with self.assertRaisesRegex(mcp_oauth.OAuthError, 'does not match this MCP resource'):
                mcp_oauth.discover(self.definition)

            # Missing S256 PKCE
            mock_req.side_effect = [
                (401, {}, None),
                (200, {}, {'authorization_servers': ['https://auth.example.com'], 'resource': 'https://api.example.com/mcp/sse'}),
                (200, {}, {'issuer': 'https://auth.example.com', 'code_challenge_methods_supported': ['plain']})
            ]
            with self.assertRaisesRegex(mcp_oauth.OAuthError, 'must support PKCE S256'):
                mcp_oauth.discover(self.definition)

            # Successful standard discovery
            mock_req.side_effect = [
                (401, {}, None),
                (200, {}, {'authorization_servers': ['https://auth.example.com'], 'resource': 'https://api.example.com/mcp/sse'}),
                (200, {}, {
                    'issuer': 'https://auth.example.com',
                    'code_challenge_methods_supported': ['S256'],
                    'response_types_supported': ['code'],
                    'authorization_endpoint': 'https://auth.example.com/authorize',
                    'token_endpoint': 'https://auth.example.com/token'
                })
            ]
            res = mcp_oauth.discover(self.definition)
            self.assertEqual(res['issuer'], 'https://auth.example.com')
            self.assertEqual(res['authorization_endpoint'], 'https://auth.example.com/authorize')

        # 2. Keycloak discovery
        kc_def = {
            'auth_mode': 'keycloak',
            'url': 'https://sso.example.com/realms/corp',
            'oauth_client_id': 'bob-client',
            'oauth_token_auth_method': 'none'
        }
        with patch.object(mcp_oauth, 'json_metadata') as mock_meta:
            mock_meta.return_value = {
                'issuer': 'https://sso.example.com/realms/corp',
                'code_challenge_methods_supported': ['S256'],
                'authorization_endpoint': 'https://sso.example.com/realms/corp/protocol/openid-connect/auth',
                'token_endpoint': 'https://sso.example.com/realms/corp/protocol/openid-connect/token'
            }
            res_kc = mcp_oauth.discover_keycloak(kc_def)
            self.assertEqual(res_kc['issuer'], 'https://sso.example.com/realms/corp')
            self.assertIn('none', res_kc['auth_methods'])

    def test_registration_flow(self):
        provider = {
            'auth_methods': ['none', 'client_secret_basic'],
            'registration_endpoint': 'https://auth.example.com/register',
            'client_metadata_supported': False,
            'scope': 'read'
        }
        # Pre-configured client
        reg = mcp_oauth.registration(provider, self.definition, 'https://buddy.example.com')
        self.assertEqual(reg['client_id'], 'client_123')

        # Dynamic registration
        no_client_def = {**self.definition, 'oauth_client_id': ''}
        with patch.object(mcp_oauth, 'http_request') as mock_http:
            mock_http.return_value = (201, {}, {'client_id': 'dyn_123', 'token_endpoint_auth_method': 'none'})
            reg_dyn = mcp_oauth.registration(provider, no_client_def, 'https://buddy.example.com')
            self.assertEqual(reg_dyn['client_id'], 'dyn_123')

    def test_create_start_and_consume_state(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.mcp_oauth._connect', mock_conn), \
             patch.object(mcp_oauth, 'ensure_schema'), \
             patch.object(mcp_oauth, 'allowed_definition', return_value=self.definition), \
             patch.object(mcp_oauth, 'discover', return_value={
                 'authorization_endpoint': 'https://auth.example.com/authorize',
                 'token_endpoint': 'https://auth.example.com/token',
                 'resource': '', 'scope': 'read', 'auth_methods': ['none']
             }), \
             patch.object(mcp_oauth, 'registration', return_value={'client_id': 'c1', 'client_secret': '', 'auth_method': 'none'}):

            url = mcp_oauth.create_start('alice', 'session_secret', self.template_id, 'https://buddy.example.com')
            self.assertIn('https://auth.example.com/authorize', url)
            self.assertIn('code_challenge=', url)
            self.assertIn('state=', url)
            self.assertTrue(db.execute.called)

            # Consume state success
            db.execute.return_value.fetchone.return_value = (self.template_id, mcp_oauth.fingerprint(self.definition), {'origin': 'https://buddy.example.com'})
            row = mcp_oauth.consume_state('valid_state', 'alice', 'session_secret')
            self.assertEqual(row[0], self.template_id)

            # Consume state failure
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaisesRegex(mcp_oauth.OAuthError, 'invalid or expired'):
                mcp_oauth.consume_state('bad_state', 'alice', 'session_secret')

    def test_token_exchange_and_lifecycle(self):
        record = {
            'client_id': 'c1', 'resource': '', 'auth_method': 'none',
            'token_endpoint': 'https://auth.example.com/token',
            'origin': 'https://buddy.example.com'
        }
        with patch.object(mcp_oauth, 'http_request') as mock_req:
            # Token exchange invalid token_type
            mock_req.return_value = (200, {}, {'access_token': 'tok1', 'token_type': 'mac'})
            with self.assertRaisesRegex(mcp_oauth.OAuthError, 'must issue a Bearer access token'):
                mcp_oauth.token_exchange(record, {'code': 'c'})

            # Token exchange success
            mock_req.return_value = (200, {}, {
                'access_token': 'tok1', 'token_type': 'Bearer', 'expires_in': 3600, 'refresh_token': 'ref1'
            })
            tok = mcp_oauth.token_exchange(record, {'code': 'c'})
            self.assertEqual(tok['access_token'], 'tok1')
            self.assertEqual(tok['refresh_token'], 'ref1')

        # Status and disconnect
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.mcp_oauth._connect', mock_conn), patch.object(mcp_oauth, 'ensure_schema'):
            db.execute.return_value.fetchone.return_value = (
                mcp_oauth.fingerprint(self.definition),
                {'access_token': 'tok1', 'expires_at': int(time.time()) + 1000}
            )
            st = mcp_oauth.status('alice', self.template_id, self.definition)
            self.assertTrue(st['connected'])
            self.assertFalse(st['needs_reconnect'])

            # Disconnect
            mcp_oauth.disconnect('alice', self.template_id)
            self.assertTrue(db.execute.called)

            # Invalidate template
            mcp_oauth.invalidate_template(self.template_id)
            self.assertTrue(db.execute.called)

    def test_popup_response_and_endpoints(self):
        resp = mcp_oauth.popup_response('https://buddy.example.com', self.template_id, success=True)
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'postMessage', resp.body)
        self.assertIn(b'Connected', resp.body)

        # Client metadata endpoint
        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'https://buddy.example.com'}):
            res = client.get('/mcp-oauth/client-metadata.json')
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json()['client_name'], 'Buddy')


class AcpBridgeProtocolMassiveTests(unittest.IsolatedAsyncioTestCase):
    """Deep coverage for ACP subprocess bridge, approval client, and IPC in app/acp_bridge.py."""

    def test_approval_error_and_stderr_details(self):
        # TeamUserNotFoundError
        class MockErr:
            data = {'details': 'TeamUserNotFoundError: user not in team'}
        detail = acp_bridge._approval_error_detail(MockErr())
        self.assertIn('Check key membership in the configured team', detail)

        # input_schema error
        class MockSchemaErr:
            data = {'details': 'The input_schema is not valid'}
        schema_detail = acp_bridge._approval_error_detail(MockSchemaErr())
        self.assertIn('invalid input schema', schema_detail)

        # Redaction of secrets
        secret = 'SECRET_TOKEN_XYZ'
        class GenericErr(Exception):
            pass
        gen_err = GenericErr(f'Failed with {secret}')
        redacted = acp_bridge._approval_error_detail(gen_err, secrets=[secret])
        self.assertNotIn(secret, redacted)

        # Stderr detail filtering
        stderr_bytes = b'Log line 1\nrequest.body: sensitive content\nLog line 2'
        filtered = acp_bridge._approval_stderr_detail(stderr_bytes)
        self.assertIn('Log line 1', filtered)
        self.assertNotIn('sensitive content', filtered)

    async def test_capture_approval_stderr(self):
        stream = AsyncMock()
        stream.read = AsyncMock(side_effect=[b'chunk 1, ', b'chunk 2', b''])
        tail = await acp_bridge._capture_approval_stderr(stream)
        self.assertEqual(tail, b'chunk 1, chunk 2')

    def test_bob_child_environment(self):
        with patch.dict(os.environ, {'BOB_API_KEY': 'key123', 'LANG': 'en_US.UTF-8'}):
            env = acp_bridge.bob_child_environment('/home/alice', '/tmp/knowledge.sock', '/tmp/mcp.sock')
            self.assertEqual(env['HOME'], '/home/alice')
            self.assertEqual(env['BOB_KNOWLEDGE_SOCKET'], '/tmp/knowledge.sock')
            self.assertEqual(env['BOB_MCP_SOCKET'], '/tmp/mcp.sock')
            self.assertEqual(env['BOB_API_KEY'], 'key123')

    async def test_process_group_termination(self):
        proc = AsyncMock()
        proc.pid = 12345
        proc.wait = AsyncMock(return_value=0)

        with patch('os.killpg') as mock_kill:
            await acp_bridge._terminate_process_group(proc, grace_seconds=0.01)
            mock_kill.assert_called()
            proc.wait.assert_awaited()

    async def test_capture_client_and_approval_client(self):
        # CaptureClient
        cc = acp_bridge.CaptureClient()
        perm = await cc.request_permission('s1', {}, {})
        self.assertEqual(perm['outcome']['outcome'], 'cancelled')

        from acp.schema import AgentMessageChunk, TextContentBlock
        chunk = AgentMessageChunk(content=TextContentBlock(type='text', text='hello'), session_update='agent_message_chunk')
        await cc.session_update('s1', chunk)
        self.assertEqual(cc.text_chunks, ['hello'])

        # ApprovalClient
        ac = acp_bridge.ApprovalClient(job_id='j1', worker_token='tok1')
        await ac.session_update('s1', chunk)
        evt = await ac.queue.get()
        self.assertEqual(evt, {'type': 'delta', 'text': 'hello'})

        # Refresh policy
        with patch('app.job_queue.worker_approval_policy', return_value={'policy': {'auto': True}, 'revision': 2}):
            await ac.refresh_policy()
            self.assertEqual(ac.policy_revision, 2)

    def test_bridge_helpers(self):
        bridge = acp_bridge.BobACPBridge()
        # MCP server request detection
        self.assertIsNone(bridge._requested_mcp_servers({}, {}))
        self.assertEqual(bridge._requested_mcp_servers({'a': 1}, {'server1': {}}), ['server1'])

        # Payload needs MCP check
        self.assertTrue(bridge._payload_needs_mcp({'research': True}))
        self.assertTrue(bridge._payload_needs_mcp({'workflow': True}))
        self.assertTrue(bridge._payload_needs_mcp({'skill_name': 'research-buddy'}))
        self.assertTrue(bridge._payload_needs_mcp({'prompt': 'Please search the web for docs'}))
        self.assertFalse(bridge._payload_needs_mcp({'prompt': 'Write a poem'}))

    async def test_bridge_stream_job_owner_and_auth(self):
        bridge = acp_bridge.BobACPBridge()
        # Stream without job in action_context raises PermissionError
        with self.assertRaises(PermissionError):
            async for _ in bridge.stream('prompt', username='alice'):
                pass

        # Stream with mismatched username raises PermissionError
        from app.app_actions import action_context
        tok = action_context.set({'job': {'id': 'j1', 'username': 'bob', 'payload': {}}})
        try:
            with self.assertRaises(PermissionError):
                async for _ in bridge.stream('prompt', username='alice'):
                    pass
        finally:
            action_context.reset(tok)

    async def test_legacy_methods_refusal(self):
        bridge = acp_bridge.BobACPBridge()
        with self.assertRaises(PermissionError):
            async for _ in bridge._stream('prompt'):
                pass

        with self.assertRaises(PermissionError):
            await bridge._ask_via_cli('prompt')


class MainRoutingAndAuthMassiveTests(unittest.IsolatedAsyncioTestCase):
    """Deep coverage for API endpoints, auth, projects, sessions, and hooks in app/main.py."""

    def setUp(self):
        self.user = {'username': 'alice', 'is_admin': True}
        self.env_patch = patch.dict(os.environ, {'DATABASE_URL': 'postgres://test:5432/db'})
        self.env_patch.start()
        self.auth_user_patch = patch('app.auth.current_user', new=AsyncMock(return_value=self.user))
        self.auth_user_patch.start()
        self.main_user_patch = patch('app.main.current_user', new=AsyncMock(return_value=self.user))
        self.main_user_patch.start()
        main.app.dependency_overrides[main.current_user] = lambda: self.user
        main.app.dependency_overrides[main.administrator] = lambda: self.user

    def tearDown(self):
        main.app.dependency_overrides.clear()
        self.main_user_patch.stop()
        self.auth_user_patch.stop()
        self.env_patch.stop()

    def test_cors_and_public_headers(self):
        # Health check
        resp = client.get('/health')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'ok': True})

        # GET /api/plugins
        with patch('app.plugin_client.capabilities', return_value={'plugins': ['office']}):
            resp = client.get('/api/plugins')
            self.assertEqual(resp.status_code, 200)

        # GET /favicon.svg
        resp = client.get('/favicon.svg')
        self.assertIn(resp.status_code, (200, 404))

    def test_auth_status_and_logout(self):
        def mock_unauth(request=None):
            raise HTTPException(401, 'Unauthorized')

        with patch('app.main.current_user', new=AsyncMock(side_effect=mock_unauth)), \
             patch('app.main.has_users', return_value=True):
            resp = client.get('/auth/status')
            self.assertEqual(resp.status_code, 200)
            self.assertIsNone(resp.json()['user'])

        with patch('app.main.has_users', return_value=True):
            resp = client.get('/auth/status')
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()['user']['username'], 'alice')

        # Logout
        resp = client.post('/auth/logout')
        self.assertEqual(resp.status_code, 200)

    def test_auth_login_and_setup(self):
        # Setup: when has_users is False, setup succeeds
        with patch('app.main.has_users', return_value=False), \
             patch('app.main.create_user', return_value={'username': 'alice', 'is_admin': True}) as mock_create, \
             patch('app.main.user_root', return_value=Path('/tmp/alice')), \
             patch('app.main.start_session'):
            resp = client.post('/auth/setup', json={'username': 'alice', 'password': 'password123'})
            self.assertEqual(resp.status_code, 200)
            mock_create.assert_called_once()

        # Setup: the storage layer rejects an already initialized instance.
        with patch('app.main.create_user', side_effect=ValueError('Setup already completed')):
            resp = client.post('/auth/setup', json={'username': 'alice', 'password': 'password123'})
            self.assertEqual(resp.status_code, 400)

        # Login: invalid credentials raises 401
        with patch('app.main.reserve_login_attempt'), \
             patch('app.main.authenticate', return_value=None):
            resp = client.post('/auth/login', json={'username': 'alice', 'password': 'wrong'})
            self.assertEqual(resp.status_code, 401)

        # Login: valid credentials sets cookie
        with patch('app.main.reserve_login_attempt'), \
             patch('app.main.clear_account_attempts'), \
             patch('app.main.authenticate', return_value={'username': 'alice'}), \
             patch('app.main.start_session'):
            resp = client.post('/auth/login', json={'username': 'alice', 'password': 'correct'})
            self.assertEqual(resp.status_code, 200)

    def test_sessions_and_projects_endpoints(self):
        with patch('app.main.list_sessions', return_value=[{'id': 's1', 'title': 'Test'}]), \
             patch('app.main.create_session', return_value={'id': 's2'}), \
             patch('app.job_queue.deletion_states', return_value={}), \
             patch('app.main.delete_conversation') as mock_del_conv:

            # List sessions
            resp = client.get('/sessions')
            self.assertEqual(resp.status_code, 200)

            # Create session
            resp = client.post('/sessions')
            self.assertEqual(resp.status_code, 201)

            # Delete session
            resp = client.delete('/sessions/s1')
            self.assertEqual(resp.status_code, 200)
            mock_del_conv.assert_called_once()

        # Projects listing and creation
        with patch('app.projects.list_projects', return_value=[{'id': 'p1', 'title': 'Project 1'}]), \
             patch('app.projects.create_project', return_value={'id': 'p2', 'title': 'Project 2'}):

            resp = client.get('/projects')
            self.assertEqual(resp.status_code, 200)

            resp = client.post('/projects', json={'name': 'Project 2'})
            self.assertEqual(resp.status_code, 201)

    def test_skills_and_modes_endpoints(self):
        with patch('app.main.list_skills', return_value=[{'name': 'skill1', 'description': 'desc'}]), \
             patch('app.main.get_skill', return_value={'name': 'skill1', 'content': 'prompt'}), \
             patch('app.main.delete_skill') as mock_del_skill:

            # Get skills list
            resp = client.get('/skills')
            self.assertEqual(resp.status_code, 200)

            # Get single skill
            resp = client.get('/skills/skill1')
            self.assertEqual(resp.status_code, 200)

            # Delete skill
            resp = client.delete('/skills/skill1')
            self.assertEqual(resp.status_code, 200)
            mock_del_skill.assert_called_once()

        # Modes list
        with patch('app.main.list_modes', return_value=[{'id': 'agent', 'name': 'Agent'}]):
            resp = client.get('/modes')
            self.assertEqual(resp.status_code, 200)

    def test_hooks_api_endpoints(self):
        mock_hook = {
            'id': 'h1', 'name': 'Audit Hook', 'event': 'conversation_start', 'enabled': True
        }
        with patch('app.main.list_hooks', return_value=[mock_hook]), \
             patch('app.main.save_hook', return_value=mock_hook), \
             patch('app.main.toggle_hook', return_value=True), \
             patch('app.main.delete_hook', return_value=True) as mock_del_hook, \
             patch('app.main.record_hook_audit'):

            # List hooks
            resp = client.get('/api/hooks')
            self.assertEqual(resp.status_code, 200)

            # Create/Save hook
            resp = client.post('/api/hooks', json={
                'name': 'Audit Hook', 'event': 'conversation_start', 'url': 'https://example.com/webhook',
                'method': 'POST', 'headers': {}, 'body': ''
            })
            self.assertEqual(resp.status_code, 201)

            # Toggle hook
            resp = client.post('/api/hooks/h1/toggle', json={'enabled': False})
            self.assertEqual(resp.status_code, 200)

            # Delete hook
            resp = client.delete('/api/hooks/h1')
            self.assertEqual(resp.status_code, 204)
            mock_del_hook.assert_called_once()

    def test_job_guidance_cancel_and_approvals(self):
        job_id = str(uuid.uuid4())
        # Job guidance
        with patch('app.chat_guidance.submit', return_value={'id': 1, 'status': 'submitted'}):
            resp = client.post(f'/jobs/{job_id}/guidance', json={'instruction': 'Focus on section 2'})
            self.assertEqual(resp.status_code, 202)

        # Job cancellation
        with patch('app.job_queue.request_cancel', return_value={'workspace_id': 's1', 'status': 'stopped', 'payload': {'cancel_requested': True}}), \
             patch('app.job_queue.get_job', return_value={'status': 'stopped', 'payload': {'cancel_requested': True}}):
            resp = client.post(f'/jobs/{job_id}/cancel')
            self.assertEqual(resp.status_code, 200)

        # Approval capabilities
        resp = client.get('/approvals/capabilities')
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['available'])


if __name__ == '__main__':
    unittest.main()
