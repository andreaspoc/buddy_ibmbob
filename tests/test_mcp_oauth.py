"""OAuth network/metadata/PKCE boundaries without contacting external providers."""
import unittest
import base64
import json
import re
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from app import mcp_oauth as oauth

class OAuthTests(unittest.TestCase):
    def test_dynamic_registration_preferred_over_unreachable_metadata(self):
        provider = {'client_metadata_supported': True, 'registration_endpoint': 'https://auth.example/register', 'scope': ''}
        with patch.object(oauth, 'http_request', return_value=(201, {}, {'client_id': 'registered-fixture', 'token_endpoint_auth_method': 'none'})) as request:
            registered = oauth.registration(provider, {}, 'https://192.0.2.10')
        self.assertEqual(registered['client_id'], 'registered-fixture')
        self.assertEqual(request.call_args.kwargs['body']['redirect_uris'], ['https://192.0.2.10/mcp-oauth/callback'])

    def test_metadata_only_provider_requires_public_client_url(self):
        provider = {'client_metadata_supported': True, 'registration_endpoint': None, 'scope': ''}
        for base in ('https://192.0.2.10', 'https://127.0.0.1', 'https://localhost', 'https://[::1]'):
            with self.subTest(base=base), self.assertRaisesRegex(oauth.OAuthError, 'publicly reachable'):
                oauth.registration(provider, {}, base)
        result = oauth.registration(provider, {}, 'https://buddy.example')
        self.assertEqual(result['client_id'], 'https://buddy.example/mcp-oauth/client-metadata.json')

    def test_public_https_endpoints_only(self):
        for url in ('http://example.com/token', 'https://127.0.0.1/token', 'https://169.254.169.254/',
                    'https://[::1]/', 'https://user:secret@example.com/', 'https://example.com:8443/', 'https://example.com/#fragment'):
            with self.subTest(url=url), self.assertRaises(oauth.OAuthError):
                oauth.public_url(url)
        self.assertEqual(oauth.public_url('https://provider.example/token'), 'https://provider.example/token')

    @patch('app.mcp_oauth.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.2', 443))])
    def test_dns_private_addresses_are_rejected(self, resolver):
        with self.assertRaises(oauth.OAuthError):
            oauth.PublicNetworkBackend().connect_tcp('provider.example', 443)

    @patch('app.mcp_oauth.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
    @patch('httpcore.SyncBackend.connect_tcp', return_value='network stream')
    def test_connection_uses_checked_ip_instead_of_resolving_again(self, connect, resolver):
        self.assertEqual(oauth.PublicNetworkBackend().connect_tcp('provider.example', 443), 'network stream')
        connect.assert_called_once_with('93.184.216.34', 443, None, None, None)

    def test_resource_binding_allows_parent_not_unrelated_origin_or_path(self):
        self.assertTrue(oauth.resource_matches('https://mcp.example/v2/mcp?login', 'https://mcp.example/v2'))
        self.assertFalse(oauth.resource_matches('https://mcp.example/v2/mcp', 'https://other.example/v2'))
        self.assertFalse(oauth.resource_matches('https://mcp.example/v2/mcp', 'https://mcp.example/v20'))

    def test_popup_escapes_errors_has_strict_csp_and_posts_only_status(self):
        response = oauth.popup_response('https://buddy.example', 'fixture', False, '<script>token-secret</script>')
        body = response.body.decode()
        self.assertIn('&lt;script&gt;', body)
        self.assertNotIn('<script>token-secret', body)
        encoded = re.search(r'JSON.parse\(atob\("([A-Za-z0-9+/=]+)"\)\)', body).group(1)
        self.assertEqual(json.loads(base64.b64decode(encoded))['payload']['status'], 'error')
        self.assertIn('frame-ancestors \'none\'', response.headers['content-security-policy'])
        self.assertEqual(response.headers['cache-control'], 'no-store')

    def test_popup_keeps_template_id_inside_script_data(self):
        template_id = 'Δ</script><script>alert(1)</script>'
        body = oauth.popup_response('https://buddy.example', template_id).body.decode()
        self.assertNotIn(template_id, body)
        encoded = re.search(r'JSON.parse\(atob\("([A-Za-z0-9+/=]+)"\)\)', body).group(1)
        self.assertEqual(json.loads(base64.b64decode(encoded))['payload']['template_id'], template_id)
        self.assertEqual(body.count('<script'), 1)

    @patch('app.mcp_oauth.http_request')
    def test_discovery_checks_declared_issuer_and_s256(self, request):
        def response(method, url, **kwargs):
            if url == 'https://mcp.example/mcp':
                return 401, {'www-authenticate': 'Bearer resource_metadata="https://mcp.example/prm"'}, None
            if url == 'https://mcp.example/prm':
                return 200, {}, {'resource': 'https://mcp.example/mcp', 'authorization_servers': ['https://auth.example']}
            return 200, {}, {'issuer': 'https://wrong.example', 'authorization_endpoint': 'https://auth.example/authorize',
                             'token_endpoint': 'https://auth.example/token', 'code_challenge_methods_supported': ['S256']}
        request.side_effect = response
        with self.assertRaisesRegex(oauth.OAuthError, 'issuer'):
            oauth.discover({'url': 'https://mcp.example/mcp'})

    @patch('app.mcp_oauth.http_request', return_value=(200, {}, {'access_token': 'synthetic-secret', 'token_type': 'Bearer', 'expires_in': 300, 'refresh_token': 'rotated-refresh'}))
    def test_refresh_rotation_and_token_lifetime_are_recorded_privately(self, request):
        record = {'client_id': 'fixture', 'client_secret': '', 'auth_method': 'none', 'token_endpoint': 'https://auth.example/token',
                  'resource': 'https://mcp.example', 'refresh_token': 'old-refresh'}
        updated = oauth.token_exchange(record, {'grant_type': 'refresh_token', 'refresh_token': 'old-refresh'})
        self.assertEqual(updated['refresh_token'], 'rotated-refresh')
        self.assertEqual(updated['access_token'], 'synthetic-secret')
        self.assertGreater(updated['expires_at'], 0)
        self.assertEqual(request.call_args.kwargs['data']['resource'], 'https://mcp.example')

    @patch('app.mcp_oauth.http_request', return_value=(400, {}, {'error_description': 'sensitive-provider-error-token'}))
    def test_provider_error_body_never_enters_user_error(self, request):
        with self.assertRaises(oauth.OAuthError) as error:
            oauth.token_exchange({'client_id': 'id', 'resource': 'https://mcp.example', 'auth_method': 'none', 'token_endpoint': 'https://auth.example/token'}, {})
        self.assertNotIn('sensitive-provider-error-token', str(error.exception))

    def test_confidential_client_cannot_read_unrelated_service_secrets(self):
        provider = {'auth_methods': ['client_secret_post']}
        for variable in ('DATABASE_URL', 'AZURE_CLIENT_SECRET', 'BOB_S3_SECRET_ACCESS_KEY'):
            with self.subTest(variable=variable), self.assertRaisesRegex(oauth.OAuthError, 'dedicated'):
                oauth.registration(provider, {'oauth_client_id': 'fixture', 'oauth_client_secret_env': variable, 'oauth_token_auth_method': 'client_secret_post'}, 'https://buddy.example')

    @patch('app.mcp_oauth.json_metadata')
    def test_keycloak_discovery_binds_realm_and_requests_only_openid(self, metadata):
        issuer = 'https://keycloak.example/realms/work'
        metadata.return_value = {'issuer': issuer, 'authorization_endpoint': issuer + '/protocol/openid-connect/auth',
                                 'token_endpoint': issuer + '/protocol/openid-connect/token',
                                 'code_challenge_methods_supported': ['S256'], 'token_endpoint_auth_methods_supported': ['none']}
        provider = oauth.discover({'auth_mode': 'keycloak', 'url': issuer, 'oauth_client_id': 'buddy-readonly'})
        metadata.assert_called_once_with(issuer + '/.well-known/openid-configuration')
        self.assertEqual(provider['resource'], '')
        self.assertEqual(provider['scope'], 'openid')
        self.assertIsNone(provider['registration_endpoint'])
        metadata.return_value['token_endpoint_auth_methods_supported'] = ['client_secret_basic']
        public_provider = oauth.discover({'auth_mode': 'keycloak', 'url': issuer, 'oauth_client_id': 'buddy-readonly'})
        self.assertEqual(oauth.registration(public_provider, {'oauth_client_id': 'buddy-readonly'}, 'https://buddy.example')['auth_method'], 'none')
        metadata.return_value['issuer'] = 'https://keycloak.example/realms/other'
        with self.assertRaisesRegex(oauth.OAuthError, 'issuer'):
            oauth.discover({'auth_mode': 'keycloak', 'url': issuer, 'oauth_client_id': 'buddy-readonly'})

    def test_keycloak_requires_pre_registered_client(self):
        with self.assertRaisesRegex(oauth.OAuthError, 'register'):
            oauth.discover({'auth_mode': 'keycloak', 'url': 'https://keycloak.example/realms/work'})

    @patch('app.mcp_oauth.http_request', return_value=(200, {}, {'access_token': 'synthetic-keycloak-token', 'token_type': 'Bearer', 'expires_in': 300}))
    def test_native_keycloak_token_exchange_omits_mcp_resource(self, request):
        oauth.token_exchange({'client_id': 'buddy-readonly', 'resource': '', 'auth_method': 'none',
                              'token_endpoint': 'https://keycloak.example/realms/work/protocol/openid-connect/token'}, {'grant_type': 'authorization_code'})
        self.assertNotIn('resource', request.call_args.kwargs['data'])

    @patch('app.mcp_oauth.ensure_schema')
    @patch('app.mcp_oauth._connect')
    @patch('app.mcp_oauth.allowed_definition', return_value={'auth_mode': 'keycloak', 'url': 'https://keycloak.example/realms/work', 'oauth_client_id': 'buddy-readonly'})
    @patch('app.mcp_oauth.discover', return_value={'issuer': 'https://keycloak.example/realms/work', 'resource': '', 'authorization_endpoint': 'https://keycloak.example/realms/work/protocol/openid-connect/auth', 'token_endpoint': 'https://keycloak.example/realms/work/protocol/openid-connect/token', 'auth_methods': ['none'], 'scope': 'openid'})
    def test_native_keycloak_authorize_has_pkce_without_mcp_resource(self, discovery, allowed, connect, schema):
        query = parse_qs(urlsplit(oauth.create_start('alice', 'session', 'keycloak', 'https://buddy.example')).query)
        self.assertNotIn('resource', query)
        self.assertEqual(query['scope'], ['openid'])
        self.assertEqual(query['code_challenge_method'], ['S256'])

    @patch('app.mcp_oauth.json_metadata')
    def test_keycloak_rejects_cross_realm_endpoints_and_personal_scopes(self, metadata):
        issuer = 'https://keycloak.example/realms/work'
        definition = {'auth_mode': 'keycloak', 'url': issuer, 'oauth_client_id': 'buddy-readonly'}
        metadata.return_value = {'issuer': issuer, 'authorization_endpoint': issuer + '/protocol/openid-connect/auth',
                                 'token_endpoint': 'https://keycloak.example/realms/other/protocol/openid-connect/token',
                                 'code_challenge_methods_supported': ['S256']}
        with self.assertRaisesRegex(oauth.OAuthError, 'configured realm'):
            oauth.discover(definition)
        metadata.return_value['token_endpoint'] = issuer + '/protocol/openid-connect/token'
        with self.assertRaisesRegex(oauth.OAuthError, 'profile or email'):
            oauth.discover({**definition, 'oauth_scopes': 'openid email'})

if __name__ == '__main__':
    unittest.main()
