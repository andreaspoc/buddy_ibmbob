"""Deterministic SSRF checks; never make external or internal requests."""
import unittest
from unittest.mock import patch, AsyncMock

import httpcore
import httpx
from app import safe_http
from app import a2a_client


def answer(ip):
    return [(2, 1, 6, '', (ip, 443))]


class PinnedTransportTests(unittest.TestCase):
    def test_public_port_opt_in_is_a2a_only_and_blocks_private_literals(self):
        with patch.dict('os.environ', {'BOB_A2A_ALLOW_PUBLIC_PORTS': '1'}, clear=True):
            self.assertEqual(a2a_client.validate_url('https://public.example:9010/card'),
                             'https://public.example:9010/card')
            with self.assertRaises(ValueError):
                safe_http.validate_url('https://public.example:9010/card')
            with self.assertRaises(ValueError):
                a2a_client.validate_mcp_url('https://public.example:9010/card')
            for url in ('http://127.0.0.1:9010', 'http://169.254.169.254:9010',
                        'http://10.0.0.1:9010', 'https://u:p@public.example:9010',
                        'https://*.example:9010'):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    a2a_client.validate_url(url)

    def test_relaxed_trust_uses_only_explicit_a2a_hosts(self):
        with patch.dict('os.environ', {'BOB_A2A_RELAXED_ORIGINS': '1',
                'BOB_A2A_ALLOWED_ORIGINS': 'https://trusted.example:8443',
                'BOB_MCP_ALLOWED_ORIGINS': 'https://mcp.example:8443'}, clear=True):
            self.assertEqual(a2a_client.validate_url('http://trusted.example:9999/a2a'),
                             'http://trusted.example:9999/a2a')
            with self.assertRaises(ValueError):
                a2a_client.validate_mcp_url('http://trusted.example:9999/a2a')
            for url in ('http://other.example:9999', 'http://mcp.example:9999',
                        'http://10.0.0.9:9999'):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    a2a_client.validate_url(url)
        with patch.dict('os.environ', {'BOB_A2A_RELAXED_ORIGINS': '1',
                'BOB_A2A_ALLOWED_ORIGINS': 'https://169.254.169.254:8443'}, clear=True):
            with self.assertRaises(ValueError):
                a2a_client.validate_url('http://169.254.169.254:9999')

    def test_nonstandard_error_identifies_exact_origin_without_path_or_query(self):
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaises(ValueError) as raised:
                a2a_client.validate_url('https://agent.example:8443/card?token=secret')
        self.assertIn('https://agent.example:8443', str(raised.exception))
        self.assertIn('BOB_A2A_ALLOWED_ORIGINS', str(raised.exception))
        self.assertNotIn('secret', str(raised.exception))

    def test_https_proxy_card_normalizes_same_origin_before_validation(self):
        with patch.dict('os.environ', {'BOB_A2A_ALLOWED_ORIGINS': 'https://agent.example:8443'}, clear=True):
            self.assertEqual(a2a_client._discovered_endpoint(
                'http://agent.example:8443/a2a', 'https://agent.example:8443/card'),
                'https://agent.example:8443/a2a')
            for endpoint in ('http://other.example:8443/a2a',
                             'http://agent.example:8444/a2a', 'http://127.0.0.1:8443/a2a'):
                with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                    a2a_client._discovered_endpoint(endpoint, 'https://agent.example:8443/card')

    def test_private_ipv4_ipv6_and_credentials_are_blocked(self):
        for url in ('http://127.0.0.1', 'http://169.254.169.254', 'http://10.0.0.1',
                    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'https://u:p@example.com',
                    'https://example.com:8443', 'https://example.com/#fragment'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                safe_http.validate_url(url)

    def test_public_dns_rebinding_never_reaches_second_resolution(self):
        with patch('app.safe_http.socket.getaddrinfo', side_effect=[answer('93.184.216.34'), answer('127.0.0.1')]) as dns, \
                patch.object(httpcore.SyncBackend, 'connect_tcp', return_value='stream') as connect:
            self.assertEqual(safe_http.PublicNetworkBackend().connect_tcp('example.com', 443), 'stream')
            self.assertEqual(dns.call_count, 1)
            self.assertEqual(connect.call_args.args[:2], ('93.184.216.34', 443))

    def test_mixed_dns_and_ipv6_private_answers_are_blocked(self):
        for answers in (answer('93.184.216.34') + answer('10.0.0.1'), answer('::1')):
            with patch('app.safe_http.socket.getaddrinfo', return_value=answers), \
                    patch.object(httpcore.SyncBackend, 'connect_tcp') as connect:
                with self.assertRaises(ValueError):
                    safe_http.PublicNetworkBackend().connect_tcp('example.com', 443)
                connect.assert_not_called()

    def test_tls_keeps_original_origin(self):
        names = []
        class Stream:
            def start_tls(self, ssl_context, server_hostname=None, timeout=None):
                names.append(server_hostname)
                return self
            def write(self, data, timeout=None): pass
            def read(self, max_bytes, timeout=None):
                return b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'
            def close(self): pass
            def get_extra_info(self, info): return None
        transport = safe_http.sync_transport()
        with patch('app.safe_http.socket.getaddrinfo', return_value=answer('93.184.216.34')), \
                patch.object(httpcore.SyncBackend, 'connect_tcp', return_value=Stream()) as connect:
            response = transport.handle_request(httpx.Request('GET', 'https://example.com/card'))
            response.read()
            response.close()
            self.assertEqual(connect.call_args.args[:2], ('93.184.216.34', 443))
            self.assertEqual(names, ['example.com'])
        transport.close()


class AsyncPinnedTests(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_rejects_api_key_header_injection_before_request(self):
        for header in ('Host', 'Authorization', 'Cookie', 'x-api-key\r\nInjected'):
            with self.subTest(header=header), patch('app.a2a_client.httpx.AsyncClient') as client:
                with self.assertRaises(ValueError):
                    await a2a_client.discover_agent('https://agent.example/card', api_key='private', api_key_header=header)
                client.assert_not_called()

    async def test_discovery_bearer_only_follows_same_origin_redirects(self):
        for destination in ('https://agent.example:8443/next', 'https://other.example:8443/next',
                            'http://agent.example:8443/next', 'https://agent.example:9443/next'):
            requests = []
            def handler(request):
                requests.append(request)
                if len(requests) == 1:
                    return httpx.Response(302, headers={'location': destination})
                return httpx.Response(200, json={'url': destination, 'protocolVersion': '0.3'})
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with patch.dict('os.environ', {'BOB_A2A_ALLOW_PUBLIC_PORTS': '1'}, clear=True), \
                    patch('app.a2a_client.httpx.AsyncClient', return_value=client):
                result = await a2a_client.discover_agent('https://agent.example:8443/card', bearer_token='secret', api_key='private-key')
            self.assertEqual(requests[0].headers['authorization'], 'Bearer secret')
            self.assertEqual(requests[1].headers.get('authorization'),
                             'Bearer secret' if destination == 'https://agent.example:8443/next' else None)
            self.assertEqual(requests[0].headers['x-api-key'], 'private-key')
            self.assertEqual(requests[1].headers.get('x-api-key'),
                             'private-key' if destination == 'https://agent.example:8443/next' else None)
            self.assertNotIn('secret', str(result))
            self.assertNotIn('private-key', str(result))

    async def test_public_port_connection_checks_dns_and_pins_public_ip(self):
        transport = safe_http.async_transport(allow_public_ports=True)
        backend = transport._pool._network_backend
        with patch('app.safe_http.socket.getaddrinfo', return_value=answer('93.184.216.34')), \
                patch.object(safe_http.AnyIOBackend, 'connect_tcp', new_callable=AsyncMock, return_value='stream') as connect:
            self.assertEqual(await backend.connect_tcp('public.example', 9010), 'stream')
            self.assertEqual(connect.call_args.args[:2], ('93.184.216.34', 9010))
        for ip in ('10.0.0.1', '127.0.0.1', '169.254.169.254'):
            with patch('app.safe_http.socket.getaddrinfo', return_value=answer(ip)), \
                    patch.object(safe_http.AnyIOBackend, 'connect_tcp', new_callable=AsyncMock) as connect:
                with self.assertRaises(ValueError):
                    await backend.connect_tcp('public.example', 9010)
                connect.assert_not_called()
        await transport.aclose()

    async def test_relaxed_host_can_resolve_private_but_not_metadata_or_loopback(self):
        transport = safe_http.async_transport(trusted_hosts={'trusted.example'})
        backend = transport._pool._network_backend
        with patch('app.safe_http.socket.getaddrinfo', return_value=answer('10.0.0.5')), \
                patch.object(safe_http.AnyIOBackend, 'connect_tcp', new_callable=AsyncMock, return_value='stream') as connect:
            self.assertEqual(await backend.connect_tcp('trusted.example', 9999), 'stream')
            self.assertEqual(connect.call_args.args[:2], ('10.0.0.5', 9999))
            with self.assertRaises(ValueError):
                await backend.connect_tcp('unrelated.example', 9999)
        for ip in ('127.0.0.1', '169.254.169.254', '::1', 'fd00:ec2::254', '100.100.100.200'):
            with patch('app.safe_http.socket.getaddrinfo', return_value=answer(ip)), \
                    patch.object(safe_http.AnyIOBackend, 'connect_tcp', new_callable=AsyncMock) as connect:
                with self.assertRaises(ValueError):
                    await backend.connect_tcp('trusted.example', 9999)
                connect.assert_not_called()
        await transport.aclose()

    async def test_discovery_uses_normalized_https_endpoint_and_no_credentials(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'name': 'Proxy agent', 'protocolVersion': '0.3',
                'url': 'http://agent.example:8443/a2a'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.dict('os.environ', {'BOB_A2A_ALLOWED_ORIGINS': 'https://agent.example:8443'}, clear=True), \
                patch('app.a2a_client.httpx.AsyncClient', return_value=client):
            card = await a2a_client.discover_agent('https://agent.example:8443/card')
        self.assertEqual(card['endpoint'], 'https://agent.example:8443/a2a')
        self.assertEqual(len(requests), 1)
        self.assertNotIn('authorization', requests[0].headers)
        self.assertNotIn('cookie', requests[0].headers)

    async def test_unapproved_explicit_http_override_is_not_normalized(self):
        with patch.dict('os.environ', {'BOB_A2A_ALLOWED_ORIGINS': 'https://agent.example:8443'}, clear=True), \
                patch('app.a2a_client.httpx.AsyncClient') as client:
            with self.assertRaises(ValueError):
                await a2a_client.discover_agent('https://agent.example:8443/card',
                                                'http://agent.example:8443/a2a')
            client.assert_not_called()

    async def test_internal_grant_is_exact_origin(self):
        approved = safe_http.allowed_origins('https://internal.example:8443')
        transport = safe_http.async_transport(approved)
        for url in ('http://internal.example:8443/card', 'https://other.example:8443/card'):
            with self.assertRaises(ValueError):
                await transport.handle_async_request(httpx.Request('GET', url))
        with patch('app.safe_http.anyio.to_thread.run_sync', new_callable=AsyncMock, return_value='10.0.0.5'), \
                patch.object(safe_http.AnyIOBackend, 'connect_tcp', new_callable=AsyncMock, return_value='stream') as connect:
            self.assertEqual(await transport._pool._network_backend.connect_tcp('internal.example', 8443), 'stream')
            self.assertEqual(connect.call_args.args[:2], ('10.0.0.5', 8443))
        await transport.aclose()

    async def test_discovery_redirect_to_metadata_is_rejected(self):
        requests = []
        def handler(request):
            requests.append(str(request.url))
            return httpx.Response(302, headers={'location': 'http://169.254.169.254/latest/meta-data'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.dict('os.environ', {'BOB_A2A_ALLOW_PUBLIC_PORTS': '1',
                'BOB_A2A_RELAXED_ORIGINS': '1'}, clear=True), \
                patch('app.a2a_client.httpx.AsyncClient', return_value=client):
            with self.assertRaises(ValueError):
                await a2a_client.discover_agent('https://example.com:9443/card')
        self.assertEqual(requests, ['https://example.com:9443/card'])

    async def test_decoded_response_size_is_bounded(self):
        response = httpx.Response(200, content=b'x' * 11)
        with patch.object(a2a_client, 'MAX_RESPONSE_BYTES', 10), self.assertRaises(ValueError):
            await a2a_client._bound_response(response)

    async def test_stream_size_is_bounded(self):
        response = httpx.Response(200, content=b'data: {"large":"xxxxxxxxxxxxxxxxxx"}\n\n')
        with patch.object(a2a_client, 'MAX_RESPONSE_BYTES', 10), self.assertRaises(ValueError):
            async for _ in a2a_client.sse_messages(response):
                pass
