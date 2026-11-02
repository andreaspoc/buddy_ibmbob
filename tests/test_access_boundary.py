"""Exercise the boundary before any handler reads a body or exposes a resource."""
import asyncio
from unittest import TestCase, main

from fastapi import HTTPException
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.access_boundary import AccessBoundaryMiddleware


async def authenticate(request):
    if request.cookies.get('session') == 'valid' or request.headers.get('authorization') == 'Bearer valid':
        return {'username': 'alice'}
    raise HTTPException(401)


async def content(request):
    if request.url.path == '/identity':
        return JSONResponse({'username': request.state.boundary_user['username']})
    return JSONResponse({'content': 'private'})


async def echo(request):
    return JSONResponse({'body': (await request.body()).decode()})


async def socket(websocket):
    await websocket.accept()
    await websocket.send_text(await websocket.receive_text())


def client():
    app = Starlette(routes=[
        Route('/{path:path}', content, methods=['GET', 'HEAD']),
        Route('/{path:path}', echo, methods=['POST']),
        WebSocketRoute('/{path:path}', socket),
    ])
    return TestClient(AccessBoundaryMiddleware(app, authenticate))


class AccessBoundaryTests(TestCase):
    def test_anonymous_content_and_unrecognized_routes_are_closed(self):
        with client() as http:
            for path in ('/api/office/files', '/office/document/123', '/workspace/pages',
                         '/static/generated/report.html', '/static/office-bridge/index.html',
                         '/s/public-token', '/share/token', '/docs', '/openapi.json',
                         '/office-editor/cache/files/secret', '/new-future-route'):
                response = http.get(path)
                self.assertEqual(response.status_code, 401, path)
                self.assertNotIn('private', response.text)
                self.assertEqual(response.headers['cache-control'], 'no-store')

    def test_login_bootstrap_remains_available(self):
        with client() as http:
            for path in ('/', '/register', '/favicon.svg', '/assets/app-123.js',
                         '/static/styles.css', '/auth/status', '/auth/keycloak/login',
                         '/auth/keycloak/callback', '/ready'):
                self.assertEqual(http.get(path).status_code, 200, path)
            for path in ('/auth/setup', '/auth/login', '/auth/register'):
                self.assertEqual(http.post(path, content='bootstrap').status_code, 200)
            self.assertEqual(http.post('/auth/status').status_code, 401)

    def test_machine_capabilities_reach_their_own_validators_only(self):
        with client() as http:
            for method, path in (('GET', '/api/office/source/signed-session'),
                                 ('POST', '/api/office/callback'), ('POST', '/a2a')):
                self.assertEqual(http.request(method, path).status_code, 200)
            for path in ('/api/office/source/', '/api/office/source/session/extra',
                         '/api/office/callback/extra'):
                self.assertEqual(http.get(path).status_code, 401)

    def test_browser_navigation_redirects_to_login_without_content(self):
        with client() as http:
            response = http.get('/share/secret', headers={'Accept': 'text/html'}, follow_redirects=False)
            self.assertEqual(response.status_code, 303)
            self.assertEqual(response.headers['location'], '/?next=%2Fshare%2Fsecret')

    def test_authenticated_cookie_and_bearer_allow_content_with_private_cache(self):
        with client() as http:
            for headers in ({'Cookie': 'session=valid'}, {'Authorization': 'Bearer valid'}):
                response = http.get('/office-editor/editor.js', headers=headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers['cache-control'], 'private, no-store')
            self.assertEqual(http.get('/api/office/files', headers={'Cookie': 'session=expired'}).status_code, 401)
            self.assertEqual(http.get('/identity', headers={'Authorization': 'Bearer valid'}).json(), {'username': 'alice'})

    def test_authenticated_request_body_is_not_consumed(self):
        with client() as http:
            response = http.post('/api/office/files', content='original upload', headers={'Authorization': 'Bearer valid'})
            self.assertEqual(response.json(), {'body': 'original upload'})

    def test_websocket_requires_login_before_accept_and_preserves_frames(self):
        with client() as http:
            for path in ('/office-editor/doc/socket', '/', '/assets/app.js', '/api/office/source/signed-session'):
                with self.assertRaises(WebSocketDisconnect) as denied:
                    with http.websocket_connect(path):
                        pass
                self.assertEqual(denied.exception.code, 1008)
            with self.assertRaises(WebSocketDisconnect) as expired:
                with http.websocket_connect('/office-editor/doc/socket', headers={'Cookie': 'session=expired'}):
                    pass
            self.assertEqual(expired.exception.code, 1008)
            with http.websocket_connect('/office-editor/doc/socket', headers={'Cookie': 'session=valid'}) as ws:
                ws.send_text('unchanged frame')
                self.assertEqual(ws.receive_text(), 'unchanged frame')

    def test_health_probe_does_not_disclose_configuration(self):
        with client() as http:
            self.assertEqual(http.get('/health').json(), {'ok': True})

    def test_stream_chunks_forward_immediately(self):
        async def check():
            sent = []
            async def downstream(scope, receive, send):
                await send({'type': 'http.response.start', 'status': 200, 'headers': []})
                for chunk in (b'first', b'second'):
                    await send({'type': 'http.response.body', 'body': chunk, 'more_body': True})
                    self.assertEqual(sent[-1]['body'], chunk)
                await send({'type': 'http.response.body', 'body': b'', 'more_body': False})
            async def receive():
                raise AssertionError('Boundary consumed the request body')
            async def send(message):
                sent.append(message)
            scope = {'type': 'http', 'method': 'GET', 'path': '/api/office/ai/stream',
                     'headers': [(b'authorization', b'Bearer valid')]}
            await AccessBoundaryMiddleware(downstream, authenticate)(scope, receive, send)
            self.assertEqual(len(sent), 4)
        asyncio.run(check())


if __name__ == '__main__':
    main()
