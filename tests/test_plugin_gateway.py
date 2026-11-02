import asyncio
import unittest

import httpx
from app.plugin_gateway import PluginGatewayMiddleware


class Body(httpx.AsyncByteStream):
    def __init__(self, data=b''):
        self.data = data
    async def __aiter__(self):
        yield self.data


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, app, path='/api/office/files', query=b'', headers=None):
        messages = []
        async def receive():
            return {'type': 'http.request', 'body': b'payload'}
        async def send(message):
            messages.append(message)
        await app({'type': 'http', 'method': 'POST', 'path': path, 'raw_path': path.encode(), 'query_string': query, 'headers': headers or [(b'host', b'buddy.example')]}, receive, send)
        return messages

    async def test_proxy_retains_auth_and_raw_uri_and_duplicate_cookies(self):
        async def upstream(req):
            self.assertEqual(str(req.url), 'http://office:8080/api/office/a%2Fb?q=a%2Bb')
            self.assertEqual(req.headers['host'], 'buddy.example')
            self.assertEqual(req.headers['origin'], 'https://buddy.example')
            self.assertEqual(req.headers['cookie'], 'session=secret')
            self.assertNotIn('x-forwarded-user', req.headers)
            self.assertNotIn('x-auth-request-user', req.headers)
            self.assertEqual(await req.aread(), b'payload')
            return httpx.Response(200, headers=[('set-cookie', 'a=1'), ('set-cookie', 'b=2')], stream=Body(b'hello'))
        app = PluginGatewayMiddleware(None, environ={'BUDDY_OFFICE_ENABLED':'1', 'BUDDY_OFFICE_PLUGIN_URL': 'http://office:8080'}, transport=httpx.MockTransport(upstream))
        messages = await self.request(app, '/api/office/a%2Fb', b'q=a%2Bb', [(b'host', b'buddy.example'), (b'origin', b'https://buddy.example'), (b'cookie', b'session=secret'), (b'x-forwarded-user', b'admin'), (b'x-auth-request-user', b'admin')])
        self.assertEqual([v for k,v in messages[0]['headers'] if k == b'set-cookie'], [b'a=1', b'b=2'])
        self.assertEqual(b''.join(m.get('body', b'') for m in messages), b'hello')

    async def test_correlation_routing_and_sse_remain_byte_exact(self):
        metadata = {
            'x-correlation-id': 'corr-original',
            'idempotency-key': 'idem-original',
            'x-chat-id': 'chat-original',
            'x-user-message-id': 'user-msg-original',
            'x-assistant-message-id': 'assistant-msg-original',
        }
        payload = b'{ "workspace_id" : "workspace-original", "correlation_id":"corr-original", "text":"a\\nb" }'
        chunks = [b'event: update\n', b'data: {"workspace_id":"workspace-original",', b'"correlation_id":"corr-original"}\n\n', b': keepalive\n\n']
        class Events(httpx.AsyncByteStream):
            async def __aiter__(self):
                for chunk in chunks:
                    yield chunk
        async def upstream(req):
            self.assertEqual(req.url.raw_path, b'/api/community/stream?room=first&room=second&workspace_id=workspace-original&correlation_id=corr-original')
            self.assertEqual(await req.aread(), payload)
            self.assertEqual(req.headers['cookie'], 'session=real-cookie')
            for key, value in metadata.items():
                self.assertEqual(req.headers[key], value)
            return httpx.Response(200, headers={**metadata, 'content-type': 'text/event-stream'}, stream=Events())
        app = PluginGatewayMiddleware(None, environ={'BUDDY_PEOPLE_ENABLED':'1', 'BUDDY_PEOPLE_PLUGIN_URL':'http://chat:8081'}, transport=httpx.MockTransport(upstream))
        incoming = asyncio.Queue()
        await incoming.put({'type':'http.request', 'body':payload[:17], 'more_body':True})
        await incoming.put({'type':'http.request', 'body':payload[17:], 'more_body':False})
        sent = []
        async def send(message):
            sent.append(message)
        await app({'type':'http', 'method':'POST', 'path':'/api/community/stream', 'query_string':b'room=first&room=second&workspace_id=workspace-original&correlation_id=corr-original', 'headers':[(b'host', b'buddy.example'), (b'cookie', b'session=real-cookie')] + [(k.encode(), v.encode()) for k,v in metadata.items()]}, incoming.get, send)
        response_headers = dict(sent[0]['headers'])
        for key, value in metadata.items():
            self.assertEqual(response_headers[key.encode()], value.encode())
        self.assertEqual([m['body'] for m in sent[1:-1]], chunks)

    async def test_disabled_and_legacy_and_prefix_boundary(self):
        calls = []
        async def fallback(scope, receive, send):
            calls.append(scope['path'])
        app = PluginGatewayMiddleware(fallback, environ={'BUDDY_OFFICE_ENABLED':'false'})
        self.assertEqual((await self.request(app))[0]['status'], 503)
        await self.request(app, '/api/offices')
        await self.request(PluginGatewayMiddleware(fallback, environ={"BUDDY_OFFICE_ENABLED": "1"}))
        self.assertEqual(calls, ['/api/offices', '/api/office/files'])

    async def test_upstream_failure_and_redirect_rewrite(self):
        for location, expected in [('http://office/internal', b'/internal'), ('https://evil.example/', None)]:
            async def upstream(req):
                return httpx.Response(302, headers={'Location': location}, stream=Body())
            app = PluginGatewayMiddleware(None, environ={'BUDDY_OFFICE_ENABLED':'1', 'BUDDY_OFFICE_PLUGIN_URL':'http://office'}, transport=httpx.MockTransport(upstream))
            response = await self.request(app)
            self.assertEqual(dict((k.lower(), v) for k, v in response[0]['headers']).get(b'location'), expected)
        async def broken(req):
            raise httpx.ConnectError('offline')
        app = PluginGatewayMiddleware(None, environ={'BUDDY_OFFICE_ENABLED':'1', 'BUDDY_OFFICE_PLUGIN_URL':'http://office'}, transport=httpx.MockTransport(broken))
        self.assertEqual((await self.request(app))[0]['status'], 503)

    async def test_websocket_relays_and_keeps_public_origin(self):
        queue = asyncio.Queue()
        await queue.put({'type':'websocket.connect'})
        await queue.put({'type':'websocket.receive', 'text':'hello'})
        sent = []
        class Socket:
            subprotocol = None
            async def send(self, data):
                self.data = data
            async def close(self):
                pass
            def __aiter__(self):
                return self
            async def __anext__(self):
                await asyncio.sleep(0)
                if hasattr(self, 'data'):
                    value = self.data
                    del self.data
                    return value
                raise StopAsyncIteration
        class Context:
            async def __aenter__(self): return Socket()
            async def __aexit__(self, *args): pass
        def connect(url, **kwargs):
            self.assertEqual(url, 'ws://buddy.example:8443/api/community/ws?token=a%2Bb')
            self.assertEqual(kwargs['host'], 'chat')
            self.assertEqual(kwargs['port'], 8081)
            self.assertEqual(kwargs['origin'], 'https://buddy.example:8443')
            self.assertIn(('cookie', 'session=secret'), kwargs['additional_headers'])
            self.assertFalse(any(key.lower() == 'host' for key, _ in kwargs['additional_headers']))
            return Context()
        async def send(message): sent.append(message)
        app = PluginGatewayMiddleware(None, environ={'BUDDY_PEOPLE_ENABLED':'1', 'BUDDY_PEOPLE_PLUGIN_URL':'http://chat:8081'}, websocket_connect=connect)
        await app({'type':'websocket', 'path':'/api/community/ws', 'query_string':b'token=a%2Bb', 'headers':[(b'host',b'buddy.example:8443'),(b'origin',b'https://buddy.example:8443'),(b'cookie',b'session=secret')]}, queue.get, send)
        self.assertTrue(any(m.get('text') == 'hello' for m in sent))
        self.assertEqual(sent[-1]['type'], 'websocket.close')


if __name__ == '__main__':
    unittest.main()


class TetragonGatewayTests(unittest.IsolatedAsyncioTestCase):
    request = GatewayTests.request

    async def test_tetragon_screen_and_api_use_separate_service(self):
        seen = []
        async def upstream(req):
            seen.append(req.url.path)
            return httpx.Response(200, stream=Body(b'ok'))
        gateway = PluginGatewayMiddleware(None, environ={
            'BUDDY_TETRAGON_ENABLED': '1',
            'BUDDY_TETRAGON_PLUGIN_URL': 'http://tetragon-plugin:8080',
        }, transport=httpx.MockTransport(upstream))
        for path in ['/tetragon/', '/tetragon/assets/example.js', '/api/tetragon/status']:
            messages = await self.request(gateway, path)
            self.assertEqual(messages[0]['status'], 200)
        self.assertEqual(seen, ['/tetragon/', '/tetragon/assets/example.js', '/api/tetragon/status'])
