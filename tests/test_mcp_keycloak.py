"""Native Keycloak MCP boundaries against explicitly synthetic HTTP fixtures."""
import asyncio
import io
import json
import os
import threading
import sys
import logging
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx
from mcp.server.fastmcp.exceptions import ToolError
from app import mcp_keycloak as kc

logging.getLogger('httpx').setLevel(logging.WARNING)
ENV = {'BOB_KEYCLOAK_MCP_ISSUER': 'https://keycloak.example/auth/realms/test-realm', 'BOB_KEYCLOAK_MCP_CLIENT_ID': 'synthetic-client', 'BOB_KEYCLOAK_MCP_TOKEN': 'synthetic-secret-token'}

class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.server.requests.append({'method': self.command, 'path': self.path, 'authorization': self.headers.get('Authorization')})
        status, headers, content = self.server.response
        self.send_response(status)
        for key, value in headers.items(): self.send_header(key, value)
        self.end_headers(); self.wfile.write(content)

class KeycloakTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        cls.server.requests = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def setUp(self):
        self.server.requests.clear()
        self.server.response = (200, {'Content-Type': 'application/json'}, b'{}')
        self.environment = patch.dict(os.environ, ENV); self.environment.start()
        # Test-only HTTPS-to-loopback transport; production remains verified HTTPS.
        def forward(request):
            target = 'http://127.0.0.1:' + str(self.server.server_port) + request.url.raw_path.decode()
            with httpx.Client(timeout=3, trust_env=False, follow_redirects=False) as client:
                response = client.request(request.method, target, headers=request.headers)
                return httpx.Response(response.status_code, headers=response.headers, content=response.content)
        self.client_patch = patch.object(kc, '_http_client', lambda: httpx.Client(transport=httpx.MockTransport(forward), timeout=3, trust_env=False, follow_redirects=False)); self.client_patch.start()
    def tearDown(self): self.client_patch.stop(); self.environment.stop()
    def respond(self, value, status=200, headers=None):
        self.server.response = (status, headers or {'Content-Type': 'application/json'}, json.dumps(value).encode())

    def test_realm_whitelist_excludes_users_secrets_nested_and_wrong_types(self):
        self.respond({'realm': 'test-realm', 'enabled': True, 'sslRequired': 'external', 'accessTokenLifespan': 300, 'ssoSessionIdleTimeout': True,
                      'browserFlow': 'browser', 'users': [{'email': 'private@example.invalid'}], 'smtpServer': {'password': 'synthetic-smtp-secret'},
                      'privateKey': 'synthetic-private-key', 'attributes': {'token': 'synthetic-secret-token'}, 'rememberMe': {'secret': 'hidden'}})
        result = kc.keycloak_realm_configuration()
        self.assertEqual(result['configuration'], {'realm': 'test-realm', 'enabled': True, 'sslRequired': 'external', 'accessTokenLifespan': 300, 'browserFlow': 'browser'})
        self.assertEqual(self.server.requests, [{'method': 'GET', 'path': '/auth/admin/realms/test-realm', 'authorization': 'Bearer synthetic-secret-token'}])
        self.assertNotIn('secret', json.dumps(result))

    def test_clients_have_only_explicit_fields_and_pagination(self):
        self.respond([{'id': 'internal-id', 'clientId': 'public-name', 'name': 'Synthetic client', 'enabled': True, 'protocol': 'openid-connect', 'publicClient': False,
                       'secret': 'do-not-return', 'serviceAccountsEnabled': True, 'serviceAccountUser': {'username': 'hidden'}, 'attributes': {'secret': 'hidden'}, 'redirectUris': ['https://example.invalid']}])
        result = kc.keycloak_list_clients(first=4, max_results=1)
        self.assertEqual(set(result['items'][0]), set(kc.CLIENT_FIELDS))
        self.assertTrue(result['may_have_more']); self.assertTrue(result['bounded_page'])
        self.assertEqual(self.server.requests[0]['path'], '/auth/admin/realms/test-realm/clients?first=4&max=1')
        self.assertNotIn('do-not-return', json.dumps(result))

    def test_realm_and_client_roles_do_not_return_assignments(self):
        self.respond([{'id': 'role-id', 'name': 'view-config', 'description': 'Synthetic role', 'composite': False, 'clientRole': False, 'attributes': {'email': 'hidden'}, 'users': ['hidden'], 'groups': ['hidden']}])
        result = kc.keycloak_list_realm_roles(max_results=2)
        self.assertEqual(set(result['items'][0]), set(kc.ROLE_FIELDS))
        self.assertEqual(self.server.requests[-1]['path'], '/auth/admin/realms/test-realm/roles?first=0&max=2&briefRepresentation=true')
        result = kc.keycloak_list_client_roles('internal-client-id', first=1, max_results=2)
        self.assertEqual(self.server.requests[-1]['path'], '/auth/admin/realms/test-realm/clients/internal-client-id/roles?first=1&max=2&briefRepresentation=true')
        self.assertNotIn('hidden', json.dumps(result))

    def test_authentication_flows_are_capped_without_configuration_secrets(self):
        self.respond([{'id': str(index), 'alias': 'browser', 'providerId': 'basic-flow', 'topLevel': True, 'builtIn': True,
                       'authenticationExecutions': [{'authenticatorConfig': 'secret'}], 'config': {'token': 'hidden'}} for index in range(3)])
        result = kc.keycloak_list_authentication_flows(max_results=2)
        self.assertEqual(len(result['items']), 2); self.assertTrue(result['truncated'])
        self.assertEqual(self.server.requests[-1]['path'], '/auth/admin/realms/test-realm/authentication/flows')
        self.assertNotIn('secret', json.dumps(result)); self.assertNotIn('config', json.dumps(result))

    def test_path_traversal_forbidden_endpoints_and_invalid_pages_never_send(self):
        for suffix in ['/users', '/events', '/sessions', '/clients/id/client-secret', '/clients/id/service-account-user', '/../other', '/roles/role/users', 'https://evil.invalid', '/clients/id/roles?users=true']:
            with self.assertRaises(ToolError): kc._read(suffix)
        for value in ['../users', 'id/roles', 'id?search=users', 'https://evil.invalid', '%2e%2e', '']:
            with self.assertRaises(ToolError): kc.keycloak_list_client_roles(value)
        for first, maximum in [(-1, 1), (100001, 1), (0, 0), (0, 101), (True, 1), (0, 1.5)]:
            with self.assertRaises(ToolError): kc.keycloak_list_clients(first, maximum)
        self.assertEqual(self.server.requests, [])

    def test_invalid_issuer_and_missing_credentials_never_send(self):
        issuers = ['http://keycloak.example/realms/test', 'https://user:pass@keycloak.example/realms/test', 'https://keycloak.example/realms/test?token=secret',
                   'https://keycloak.example/realms/test#fragment', 'https://keycloak.example/realms', 'https://keycloak.example/realms/..',
                   'https://keycloak.example/auth/../realms/test', 'https://keycloak.example/realms/%2fusers', 'https://keycloak.example:bad/realms/test']
        for issuer in issuers:
            with patch.dict(os.environ, {'BOB_KEYCLOAK_MCP_ISSUER': issuer}):
                with self.assertRaises(ToolError): kc.keycloak_list_clients()
        for token in ['', 'secret\nInjected: header', ' secret ', '☃']:
            with patch.dict(os.environ, {'BOB_KEYCLOAK_MCP_TOKEN': token}):
                with self.assertRaises(ToolError): kc.keycloak_list_clients()
        self.assertEqual(self.server.requests, [])

    def test_upstream_errors_and_redirects_never_leak_body_or_forward_token(self):
        output = io.StringIO()
        for status in [401, 403, 404, 302, 500]:
            self.respond({'error': 'synthetic-secret-token private@example.invalid'}, status=status, headers={'Content-Type': 'application/json', 'Location': 'https://evil.invalid/users'})
            with redirect_stdout(output), redirect_stderr(output), self.assertRaises(ToolError) as caught:
                kc.keycloak_realm_configuration()
            self.assertNotIn('synthetic-secret-token', str(caught.exception)); self.assertNotIn('private@example.invalid', str(caught.exception)); self.assertNotIn('evil.invalid', str(caught.exception))
        self.assertEqual(len(self.server.requests), 5)
        self.assertEqual(output.getvalue(), '')

    def test_oversized_and_invalid_json_responses_are_redacted(self):
        for content, headers in [(b'x' * (kc.MAX_RESPONSE_BYTES + 1), {'Content-Type': 'application/json'}),
                                 (b'synthetic-secret-token', {'Content-Type': 'application/json'}),
                                 (b'{"secret":"synthetic-secret-token"}', {'Content-Type': 'text/html'})]:
            self.server.response = (200, headers, content)
            with self.assertRaises(ToolError) as caught: kc.keycloak_realm_configuration()
            self.assertNotIn('synthetic-secret-token', str(caught.exception))

    def test_invalid_list_shapes_never_return_unfiltered_objects(self):
        for value in [{'users': ['hidden']}, [42], [['private-user']]]:
            self.respond(value)
            with self.assertRaises(ToolError): kc.keycloak_list_clients()

    def test_token_is_read_per_call_and_not_in_configuration_repr(self):
        self.respond([]); kc.keycloak_list_clients()
        with patch.dict(os.environ, {'BOB_KEYCLOAK_MCP_TOKEN': 'second-user-token'}):
            self.assertNotIn('second-user-token', repr(kc.configuration()))
            kc.keycloak_list_clients()
        self.assertEqual([request['authorization'] for request in self.server.requests], ['Bearer synthetic-secret-token', 'Bearer second-user-token'])

    def test_sdk_exposes_only_five_read_only_tools(self):
        tools = asyncio.run(kc.mcp.list_tools())
        self.assertEqual({tool.name for tool in tools}, {'keycloak_realm_configuration', 'keycloak_list_clients', 'keycloak_list_realm_roles', 'keycloak_list_client_roles', 'keycloak_list_authentication_flows'})
        for tool in tools:
            self.assertTrue(tool.annotations.readOnlyHint); self.assertFalse(tool.annotations.destructiveHint)
            self.assertNotIn('token', tool.inputSchema.get('properties', {})); self.assertNotIn('issuer', tool.inputSchema.get('properties', {}))

    def test_production_client_keeps_tls_redirect_proxy_and_timeout_guards(self):
        self.client_patch.stop()
        with patch.object(kc.httpx, 'Client') as constructor:
            kc._http_client()
            options = constructor.call_args.kwargs
            self.assertTrue(options['verify']); self.assertFalse(options['follow_redirects']); self.assertFalse(options['trust_env'])
            self.assertEqual(options['timeout'].connect, 5); self.assertEqual(options['timeout'].read, 15)
        self.client_patch.start()

class StdioTests(unittest.TestCase):
    def test_native_module_starts_and_rejects_unavailable_tools_and_paths(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        async def verify():
            params = StdioServerParameters(command=sys.executable, args=['-m', 'app.mcp_keycloak'], env={**os.environ, **ENV})
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    self.assertEqual(len(tools.tools), 5)
                    result = await session.call_tool('keycloak_list_client_roles', {'client_uuid': '../users'})
                    self.assertTrue(result.isError)
                    self.assertNotIn('synthetic-secret-token', str(result))
                    result = await session.call_tool('keycloak_list_users', {})
                    self.assertTrue(result.isError)
        asyncio.run(asyncio.wait_for(verify(), timeout=15))

if __name__ == '__main__': unittest.main()
