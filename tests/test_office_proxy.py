"""Older ONLYOFFICE builds must not expose the native AI alongside Ask Bob."""
import asyncio
from unittest import TestCase, main
from unittest.mock import patch
from fastapi import HTTPException
from starlette.requests import Request
from app import office_proxy as proxy

class OfficeProxyTests(TestCase):
    def test_vendor_ai_filtered_without_changing_other_plugins(self):
        guid=proxy.NATIVE_AI_GUID
        catalog={'pluginsData':['../sdkjs-plugins/'+guid+'/config.json','/sdkjs-plugins/ai/config.json','/sdkjs-plugins/macros/config.json','/static/office-bridge/config.json'],
                 'autostart':['asc.{'+guid+'}','asc.{BUDDY}'], 'other':{'retained':True}}
        filtered=proxy.without_native_ai(catalog)
        self.assertEqual(filtered['pluginsData'],['/sdkjs-plugins/macros/config.json','/static/office-bridge/config.json'])
        self.assertEqual(filtered['autostart'],['asc.{BUDDY}'])
        self.assertEqual(filtered['other'],catalog['other'])
        self.assertEqual(len(catalog['pluginsData']),4)
    def test_malformed_catalog_fails_closed(self):
        for catalog in ([],None,{'pluginsData':'invalid'},{'autostart':{}}):
            with self.assertRaises(ValueError):proxy.without_native_ai(catalog)
    def test_native_ai_assets_blocked_before_upstream(self):
        request=Request({'type':'http','method':'GET','path':'/','headers':[]})
        with patch.object(proxy.httpx,'AsyncClient') as client:
            with self.assertRaises(HTTPException) as failure:
                asyncio.run(proxy.proxy('sdkjs-plugins/'+proxy.NATIVE_AI_GUID.lower()+'/index.html',request))
            self.assertEqual(failure.exception.status_code,404)
            client.assert_not_called()


class OfficeProxyRoutingTests(TestCase):
    def test_disallowed_paths_and_vendor_logos_do_not_contact_upstream(self):
        for path in ('example/index.html', '../secret', 'path\\file'):
            request = Request({'type':'http', 'method':'GET', 'path':'/', 'headers':[]})
            with self.subTest(path=path), self.assertRaises(HTTPException) as error:
                asyncio.run(proxy.proxy(path, request))
            self.assertEqual(error.exception.status_code, 404)
        request = Request({'type':'http', 'method':'GET', 'path':'/', 'headers':[]})
        with patch.object(proxy.httpx, 'AsyncClient') as client:
            response = asyncio.run(proxy.proxy('assets/logo.svg', request))
            self.assertEqual(response.status_code, 200)
            self.assertIn(b'<svg', response.body)
            client.assert_not_called()

    def test_plugin_catalog_filters_ai_and_fails_closed_on_upstream_error(self):
        from unittest.mock import AsyncMock, MagicMock
        request = Request({'type':'http', 'method':'GET', 'path':'/', 'headers':[]})
        response = MagicMock()
        response.json.return_value = {'pluginsData': ['/ai/config.json', '/macros/config.json']}
        client = MagicMock()
        client.get = AsyncMock(return_value=response)
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=client)
        manager.__aexit__ = AsyncMock(return_value=None)
        with patch.object(proxy.httpx, 'AsyncClient', return_value=manager), patch.object(proxy, 'internal_url', return_value='http://office'):
            result = asyncio.run(proxy.proxy('plugins.json', request))
        self.assertEqual(result.status_code, 200)
        self.assertIn(b'/macros/config.json', result.body)
        self.assertNotIn(b'/ai/config.json', result.body)
        client.get = AsyncMock(side_effect=proxy.httpx.ConnectError('down'))
        with patch.object(proxy.httpx, 'AsyncClient', return_value=manager), self.assertRaises(HTTPException) as error:
            asyncio.run(proxy.proxy('plugins.json', request))
        self.assertEqual(error.exception.status_code, 503)

    def test_streaming_preserves_safe_headers_and_closes_upstream(self):
        from unittest.mock import AsyncMock, MagicMock
        async def exercise():
            request = Request({'type':'http', 'method':'GET', 'path':'/', 'query_string':b'page=1', 'scheme':'https', 'server':('example.test', 443), 'headers':[(b'host', b'example.test'), (b'cookie', b'secret')]})
            upstream = MagicMock(status_code=206, headers={'content-type':'text/plain', 'content-length':'2', 'connection':'close'})
            async def chunks():
                yield b'ok'
            upstream.aiter_raw = chunks
            upstream.aclose = AsyncMock()
            client = MagicMock()
            client.send = AsyncMock(return_value=upstream)
            client.aclose = AsyncMock()
            client.build_request.return_value = object()
            with patch.object(proxy.httpx, 'AsyncClient', return_value=client), patch.object(proxy, 'internal_url', return_value='http://office'):
                response = await proxy.proxy('editor/index', request)
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response.headers['content-length'], '2')
                self.assertNotIn('connection', response.headers)
                self.assertEqual([chunk async for chunk in response.body_iterator], [b'ok'])
                await response.background()
            self.assertEqual(client.build_request.call_args.args[1], 'http://office/editor/index?page=1')
            self.assertNotIn('cookie', client.build_request.call_args.kwargs['headers'])
            upstream.aclose.assert_awaited_once()
            client.aclose.assert_awaited_once()
        asyncio.run(exercise())

    def test_websocket_rejects_cross_origin_and_blocked_paths(self):
        from unittest.mock import AsyncMock, MagicMock
        for origin, path in [('https://other.example', 'socket'), ('https://same.example', '../bad')]:
            socket = MagicMock()
            socket.headers = {'origin': origin, 'host': 'same.example'}
            socket.close = AsyncMock()
            asyncio.run(proxy.socket_proxy(socket, path))
            socket.close.assert_awaited_once_with(code=1008)

if __name__ == '__main__':
    main()
