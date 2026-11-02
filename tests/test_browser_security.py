"""Regression tests for browser trust boundaries and streaming response headers."""
import asyncio
from unittest import TestCase
from unittest.mock import patch

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app.browser_security import BrowserSecurityMiddleware


async def echo(request):
    return JSONResponse({'body': (await request.body()).decode()})


def client(base_url='http://testserver'):
    return TestClient(BrowserSecurityMiddleware(Starlette(routes=[
        Route('/{path:path}', echo, methods=['GET', 'POST', 'PUT', 'DELETE']),
    ])), base_url=base_url)


class BrowserSecurityTests(TestCase):
    def test_write_origin_includes_scheme_host_and_port(self):
        with patch.dict('os.environ', {'PUBLIC_BASE_URL': ''}), client() as http:
            headers = {'Cookie': 'bob_ui_session=ambient'}
            for origin in ('https://testserver', 'http://testserver:81', 'http://evil.test', 'null', 'http://testserver@evil.test'):
                response = http.post('/jobs/id/cancel', headers={**headers, 'Origin': origin})
                self.assertEqual(response.status_code, 403, origin)
            self.assertEqual(http.post('/jobs/id/cancel', headers={**headers, 'Origin': 'http://testserver:80'}).status_code, 200)

    def test_cookie_writes_require_provenance_and_reject_sibling_sites(self):
        with client() as http:
            cookie = {'Cookie': 'bob_ui_session=ambient'}
            self.assertEqual(http.post('/upload', headers=cookie).status_code, 403)
            self.assertEqual(http.post('/upload', headers={**cookie, 'Sec-Fetch-Site': 'same-site'}).status_code, 403)
            self.assertEqual(http.post('/upload', headers={**cookie, 'Sec-Fetch-Site': 'same-origin'}, content='upload').json(), {'body': 'upload'})
            self.assertEqual(http.post('/upload', headers={**cookie, 'Referer': 'http://testserver/office'}).status_code, 200)
            self.assertEqual(http.post('/upload', headers={**cookie, 'Referer': 'http://evil.test/', 'Sec-Fetch-Site': 'same-origin'}).status_code, 403)

    def test_public_login_is_guarded_before_cookie_exists(self):
        with client() as http:
            self.assertEqual(http.post('/auth/login', headers={'Origin': 'http://evil.test'}).status_code, 403)
            self.assertEqual(http.post('/auth/login', headers={'Origin': 'http://testserver'}).status_code, 200)

    def test_token_clients_and_signed_callbacks_reach_their_authenticators(self):
        with client() as http:
            for headers in ({'Authorization': 'Bearer explicit'}, {'X-API-Key': 'explicit'}):
                self.assertEqual(http.post('/upload', headers=headers, content='bytes').json(), {'body': 'bytes'})
                self.assertEqual(http.post('/upload', headers={**headers, 'Cookie': 'bob_ui_session=ambient', 'Origin': 'http://evil.test'}).status_code, 403)
            for path in ('/api/office/callback', '/api/office/app-actions', '/api/projects/agent-context'):
                self.assertEqual(http.post(path, content='signed body').json(), {'body': 'signed body'})
            self.assertEqual(http.post('/a2a', headers={'Cookie': 'bob_ui_session=ambient', 'Origin': 'http://evil.test'}).status_code, 403)
            self.assertEqual(http.post('/a2a', headers={'Authorization': 'Bearer explicit'}, content='rpc body').json(), {'body': 'rpc body'})
            self.assertEqual(http.post('/a2a', headers={'Cookie': 'bob_ui_session=ambient', 'Origin': 'http://testserver'}, content='rpc body').json(), {'body': 'rpc body'})
            self.assertEqual(http.post('/api/office/callback/extra', headers={'Origin': 'http://evil.test'}).status_code, 403)

    def test_configured_https_proxy_origin_does_not_trust_forwarding_headers(self):
        with patch.dict('os.environ', {'PUBLIC_BASE_URL': 'https://testserver'}), client() as http:
            self.assertEqual(http.post('/upload', headers={'Origin': 'https://testserver'}).status_code, 200)
            self.assertEqual(http.post('/upload', headers={'Origin': 'http://testserver'}).status_code, 403)
            self.assertEqual(http.post('/upload', headers={'Origin': 'https://evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https'}).status_code, 403)
        with patch.dict('os.environ', {'PUBLIC_BASE_URL': 'https://production.test'}), client() as http:
            self.assertEqual(http.post('/upload', headers={'Origin': 'http://testserver'}).status_code, 200)

    def test_headers_preserve_stricter_file_and_oauth_policy_and_office_embedding(self):
        with client() as http:
            response = http.get('/')
            self.assertIn("base-uri 'none'", response.headers['content-security-policy'])
            self.assertIn("frame-ancestors 'self'", response.headers['content-security-policy'])
            self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
            self.assertEqual(response.headers['referrer-policy'], 'no-referrer')
            self.assertNotIn('strict-transport-security', response.headers)
            self.assertIn("base-uri 'self'", http.get('/office-editor/web-apps/editor.html').headers['content-security-policy'])
            self.assertEqual(http.post('/upload', headers={'Origin': 'http://evil.test'}).headers['x-content-type-options'], 'nosniff')
        with client('https://testserver') as http:
            self.assertEqual(http.get('/').headers['strict-transport-security'], 'max-age=31536000; includeSubDomains')

        async def check():
            sent = []
            policy = b"sandbox; default-src 'none'; frame-ancestors 'none'"
            async def downstream(scope, receive, send):
                await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-security-policy', policy)]})
                for part in (b'first', b'second'):
                    await send({'type': 'http.response.body', 'body': part, 'more_body': True})
                    self.assertEqual(sent[-1]['body'], part)
            async def receive():
                raise AssertionError('Middleware must not read the body')
            async def send(message):
                sent.append(message)
            await BrowserSecurityMiddleware(downstream)({'type': 'http', 'method': 'GET', 'path': '/', 'scheme': 'http',
                                                        'server': ('testserver', 80), 'headers': [(b'host', b'testserver')], 'query_string': b''}, receive, send)
            self.assertEqual(dict(sent[0]['headers'])[b'content-security-policy'], policy)
            self.assertEqual(len(sent), 3)
        asyncio.run(check())
