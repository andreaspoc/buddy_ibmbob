"""Exercise the editor proxy's streaming and WebSocket boundaries."""
import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import HTTPException
from starlette.requests import Request

from app import office_proxy as proxy


class OfficeProxyTransportTests(IsolatedAsyncioTestCase):
    async def test_http_connection_failure_closes_client_and_returns_503(self):
        request = Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': []})
        client = MagicMock()
        client.build_request.return_value = object()
        client.send = AsyncMock(side_effect=httpx.ConnectError('offline'))
        client.aclose = AsyncMock()
        with patch.object(proxy.httpx, 'AsyncClient', return_value=client), \
             patch.object(proxy, 'internal_url', return_value='http://office'):
            with self.assertRaises(HTTPException) as error:
                await proxy.proxy('web-apps/editor', request)
        self.assertEqual(error.exception.status_code, 503)
        client.aclose.assert_awaited_once()

    async def test_websocket_forwards_text_and_binary_in_both_directions(self):
        socket = MagicMock()
        socket.headers = {'origin': 'https://buddy.test', 'host': 'buddy.test', 'x-forwarded-proto': 'https'}
        socket.url = SimpleNamespace(query='session=abc')
        socket.accept = AsyncMock()
        socket.close = AsyncMock()
        socket.send_text = AsyncMock()
        socket.send_bytes = AsyncMock()
        forwarded = asyncio.Event()
        sent = []

        async def receive():
            if not sent:
                sent.append('text')
                return {'type': 'websocket.receive', 'text': 'hello'}
            if len(sent) == 1:
                sent.append('bytes')
                return {'type': 'websocket.receive', 'bytes': b'payload'}
            await forwarded.wait()
            return {'type': 'websocket.disconnect'}
        socket.receive = receive

        class Upstream:
            def __init__(self):
                self.received = []
            async def send(self, value):
                self.received.append(value)
            def __aiter__(self):
                return self.messages()
            async def messages(self):
                yield 'server text'
                yield b'server bytes'
                forwarded.set()
                await asyncio.Event().wait()
        upstream = Upstream()
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=upstream)
        manager.__aexit__ = AsyncMock(return_value=False)
        with patch('websockets.connect', return_value=manager) as connect, \
             patch.object(proxy, 'internal_url', return_value='https://office.internal'):
            await asyncio.wait_for(proxy.socket_proxy(socket, 'socket/123'), timeout=2)
        connect.assert_called_once_with(
            'wss://office.internal/socket/123?session=abc', origin='https://buddy.test',
            additional_headers={'X-Forwarded-Host': 'buddy.test/office-editor', 'X-Forwarded-Proto': 'https'},
            max_size=proxy.MAX_WS_BYTES,
        )
        socket.accept.assert_awaited_once()
        self.assertEqual(upstream.received, ['hello', b'payload'])
        socket.send_text.assert_awaited_once_with('server text')
        socket.send_bytes.assert_awaited_once_with(b'server bytes')
        socket.close.assert_not_awaited()
        manager.__aexit__.assert_awaited_once()

    async def test_websocket_upstream_failure_reports_internal_error(self):
        socket = MagicMock()
        socket.headers = {'host': 'buddy.test'}
        socket.url = SimpleNamespace(query='')
        socket.close = AsyncMock()
        socket.accept = AsyncMock()
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(side_effect=OSError('connection refused'))
        manager.__aexit__ = AsyncMock()
        with patch('websockets.connect', return_value=manager), \
             patch.object(proxy, 'internal_url', return_value='http://office'):
            await proxy.socket_proxy(socket, 'socket/123')
        socket.accept.assert_not_awaited()
        socket.close.assert_awaited_once_with(code=1011)

    async def test_websocket_invalid_path_does_not_connect(self):
        socket = MagicMock()
        socket.headers = {'host': 'buddy.test'}
        socket.close = AsyncMock()
        with patch('websockets.connect') as connect:
            await proxy.socket_proxy(socket, 'coauthoring/secret')
        socket.close.assert_awaited_once_with(code=1008)
        connect.assert_not_called()

    async def test_websocket_failure_tolerates_an_already_closed_client(self):
        socket = MagicMock()
        socket.headers = {'host': 'buddy.test'}
        socket.url = SimpleNamespace(query='')
        socket.close = AsyncMock(side_effect=RuntimeError('already closed'))
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(side_effect=OSError('connection refused'))
        manager.__aexit__ = AsyncMock()
        with patch('websockets.connect', return_value=manager), \
             patch.object(proxy, 'internal_url', return_value='http://office'):
            await proxy.socket_proxy(socket, 'socket/123')
        socket.close.assert_awaited_once_with(code=1011)
