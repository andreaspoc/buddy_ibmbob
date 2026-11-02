"""Unit tests covering app/mcp_oauth.py."""
import asyncio
from contextlib import contextmanager
import hashlib
import json
import os
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from starlette.datastructures import Headers

from app import mcp_oauth as oauth


class MCPOAuthCoverageTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'alice', 'is_admin': True}

    def test_digest_and_fingerprint(self):
        d = oauth.digest('hello')
        self.assertEqual(d, hashlib.sha256(b'hello').hexdigest())

        defn1 = {'transport': 'http', 'url': 'https://example.com'}
        defn2 = {'url': 'https://example.com', 'transport': 'http'}
        self.assertEqual(oauth.fingerprint(defn1), oauth.fingerprint(defn2))

    def test_origin(self):
        self.assertEqual(oauth.origin('https://example.com:8443/path?query#hash'), 'https://example.com:8443')

    def test_app_base(self):
        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'https://buddy.example.com'}):
            self.assertEqual(oauth.app_base(), 'https://buddy.example.com')

        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'http://localhost:8000'}):
            self.assertEqual(oauth.app_base(), 'http://localhost:8000')

        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'http://insecure.example.com'}):
            with self.assertRaises(oauth.OAuthError):
                oauth.app_base()

        with patch.dict(os.environ, {'PUBLIC_BASE_URL': ''}):
            req = MagicMock()
            req.base_url = 'https://req.example.com/'
            self.assertEqual(oauth.app_base(req), 'https://req.example.com')

    def test_discover_keycloak(self):
        # Invalid issuer (has query or not realms)
        with self.assertRaises(oauth.OAuthError):
            oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth?realm=master', 'oauth_client_id': 'id'})
        with self.assertRaises(oauth.OAuthError):
            oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth/realms/..', 'oauth_client_id': 'id'})

        # Missing client ID
        with self.assertRaises(oauth.OAuthError):
            oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth/realms/master', 'oauth_client_id': ''})

        # Missing openid configuration
        with patch.object(oauth, 'json_metadata', return_value=None):
            with self.assertRaises(oauth.OAuthError):
                oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth/realms/master', 'oauth_client_id': 'id'})

        # Code challenge does not have S256
        with patch.object(oauth, 'json_metadata', return_value={'issuer': 'https://keycloak.example.com/auth/realms/master', 'code_challenge_methods_supported': ['plain']}):
            with self.assertRaises(oauth.OAuthError):
                oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth/realms/master', 'oauth_client_id': 'id'})

        # Disallowed scopes profile / email
        valid_meta = {
            'issuer': 'https://keycloak.example.com/auth/realms/master',
            'code_challenge_methods_supported': ['S256'],
            'authorization_endpoint': 'https://keycloak.example.com/auth/realms/master/protocol/openid-connect/auth',
            'token_endpoint': 'https://keycloak.example.com/auth/realms/master/protocol/openid-connect/token',
            'token_endpoint_auth_methods_supported': ['client_secret_basic', 'none'],
        }
        with patch.object(oauth, 'json_metadata', return_value=valid_meta):
            with self.assertRaises(oauth.OAuthError):
                oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth/realms/master', 'oauth_client_id': 'id', 'oauth_scopes': 'openid profile'})

        # Success
        with patch.object(oauth, 'json_metadata', return_value=valid_meta):
            res = oauth.discover_keycloak({'url': 'https://keycloak.example.com/auth/realms/master', 'oauth_client_id': 'id', 'oauth_scopes': 'openid'})
            self.assertEqual(res['issuer'], 'https://keycloak.example.com/auth/realms/master')
            self.assertIn('none', res['auth_methods'])

    def test_allowed_definition(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # Not found
        with patch.object(oauth, '_connect', mock_conn), patch('app.mcp_oauth.knowledge_access', return_value=self.user):
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(oauth.OAuthError):
                oauth.allowed_definition('alice', 'unknown')

        # Invalid auth mode
        with patch.object(oauth, '_connect', mock_conn), patch('app.mcp_oauth.knowledge_access', return_value=self.user):
            db.execute.return_value.fetchone.return_value = [{'auth_mode': 'credentials', 'enabled': True}]
            with self.assertRaises(oauth.OAuthError):
                oauth.allowed_definition('alice', 'cred_server')

        # Success
        with patch.object(oauth, '_connect', mock_conn), \
             patch('app.mcp_oauth.knowledge_access', return_value=self.user), \
             patch('app.mcp_catalog.permitted', return_value=True):
            defn = {'id': 's1', 'auth_mode': 'oauth', 'enabled': True}
            db.execute.return_value.fetchone.return_value = [defn]
            res = oauth.allowed_definition('alice', 's1')
            self.assertEqual(res['id'], 's1')

            # Fingerprint mismatch
            with self.assertRaises(oauth.OAuthError):
                oauth.allowed_definition('alice', 's1', expected={'transport': 'stdio'})

    def test_consume_state(self):
        with self.assertRaises(oauth.OAuthError):
            oauth.consume_state('', 'alice', 'session1')
        with self.assertRaises(oauth.OAuthError):
            oauth.consume_state('state', 'alice', '')

        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(oauth, '_connect', mock_conn), patch.object(oauth, 'ensure_schema'):
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(oauth.OAuthError):
                oauth.consume_state('valid_state', 'alice', 'sess')

            db.execute.return_value.fetchone.return_value = ('tmpl', 'fp', {'origin': 'https://buddy.example'})
            res = oauth.consume_state('valid_state', 'alice', 'sess')
            self.assertEqual(res[0], 'tmpl')

    def test_complete_and_complete_consumed(self):
        record = {
            'origin': 'https://buddy.example',
            'issuer': 'https://auth.example',
            'redirect_uri': 'https://buddy.example/mcp-oauth/callback',
            'verifier': 'verifier123',
            'response_issuer_required': True,
        }
        defn = {'id': 'tmpl', 'auth_mode': 'oauth', 'enabled': True}
        fp = oauth.fingerprint(defn)

        # Provider error param
        with self.assertRaises(oauth.OAuthError):
            oauth.complete_consumed('alice', 'tmpl', fp, record, 'code123', error='access_denied', response_issuer='https://auth.example')

        # Missing code
        with self.assertRaises(oauth.OAuthError):
            oauth.complete_consumed('alice', 'tmpl', fp, record, '', error='', response_issuer='https://auth.example')

        # Missing issuer
        with self.assertRaises(oauth.OAuthError):
            oauth.complete_consumed('alice', 'tmpl', fp, record, 'code123', error='', response_issuer='')

        # Wrong issuer
        with self.assertRaises(oauth.OAuthError):
            oauth.complete_consumed('alice', 'tmpl', fp, record, 'code123', error='', response_issuer='https://wrong.example')

        # Success complete_consumed
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(oauth, 'allowed_definition', return_value=defn), \
             patch.object(oauth, 'token_exchange', return_value={'access_token': 'tok', 'expires_at': int(time.time()) + 3600}), \
             patch.object(oauth, '_connect', mock_conn):
            tmpl_id, origin = oauth.complete_consumed('alice', 'tmpl', fp, record, 'code123', error='', response_issuer='https://auth.example')
            self.assertEqual(tmpl_id, 'tmpl')
            self.assertEqual(origin, 'https://buddy.example')

    def test_access_token_and_status(self):
        defn = {'id': 'tmpl', 'auth_mode': 'oauth', 'enabled': True}
        fp = oauth.fingerprint(defn)

        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # access_token valid unexpired
        with patch.object(oauth, 'ensure_schema'), \
             patch.object(oauth, 'allowed_definition', return_value=defn), \
             patch.object(oauth, '_connect', mock_conn):
            db.execute.return_value.fetchone.return_value = (fp, {'access_token': 'active_tok', 'expires_at': int(time.time()) + 1000})
            tok = oauth.access_token('alice', 'tmpl', defn)
            self.assertEqual(tok, 'active_tok')

        # access_token expired but refreshed
        with patch.object(oauth, 'ensure_schema'), \
             patch.object(oauth, 'allowed_definition', return_value=defn), \
             patch.object(oauth, 'token_exchange', return_value={'access_token': 'new_tok', 'expires_at': int(time.time()) + 1000}), \
             patch.object(oauth, '_connect', mock_conn):
            db.execute.return_value.fetchone.return_value = (fp, {'access_token': 'old_tok', 'refresh_token': 'ref', 'expires_at': int(time.time()) - 10})
            tok2 = oauth.access_token('alice', 'tmpl', defn)
            self.assertEqual(tok2, 'new_tok')

        # status check
        with patch.object(oauth, 'ensure_schema'), patch.object(oauth, '_connect', mock_conn):
            db.execute.return_value.fetchone.return_value = (fp, {'access_token': 'tok', 'expires_at': int(time.time()) + 500})
            st = oauth.status('alice', 'tmpl', defn)
            self.assertTrue(st['connected'])
            self.assertFalse(st['needs_reconnect'])

    def test_disconnect_and_invalidate_template(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(oauth, 'ensure_schema'), patch.object(oauth, '_connect', mock_conn):
            oauth.disconnect('alice', 'tmpl')
            self.assertEqual(db.execute.call_count, 2)

        with patch.object(oauth, 'ensure_schema'), patch.object(oauth, '_connect', mock_conn):
            oauth.invalidate_template('tmpl')
            self.assertEqual(db.execute.call_count, 4)

    def test_client_metadata_route(self):
        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'http://localhost:8000'}):
            with self.assertRaises(HTTPException) as exc:
                oauth.client_metadata()
            self.assertEqual(exc.exception.status_code, 503)

        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'https://buddy.example'}):
            resp = oauth.client_metadata()
            self.assertEqual(resp.status_code, 200)
            data = json.loads(resp.body.decode())
            self.assertEqual(data['client_id'], 'https://buddy.example/mcp-oauth/client-metadata.json')


if __name__ == '__main__':
    unittest.main()
