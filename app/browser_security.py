"""Browser response policy and write provenance checks without buffering streams.

Machine endpoints retain their own signed-capability/protocol authentication.
The configured public origin supplies the scheme behind the HTTPS proxy; arbitrary
Forwarded headers never grant trust to an origin.
"""
import os
from urllib.parse import urlsplit

from starlette.requests import Request
from starlette.responses import JSONResponse

from app.access_boundary import _machine

_SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS', 'TRACE'}
_BASE_POLICY = "object-src 'none'; base-uri 'none'; frame-ancestors 'self'"


def origin_tuple(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
            return None
        return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return None


def request_origin(request):
    actual = origin_tuple(str(request.base_url))
    configured = origin_tuple(os.getenv('PUBLIC_BASE_URL', '').strip())
    # Only use the canonical scheme for its own host/port. Local development on
    # another address continues to use the actual request origin.
    if configured and actual and configured[1] == actual[1]:
        host = request.headers.get('host', '')
        if origin_tuple(configured[0] + '://' + host) == configured:
            return configured
    return actual


def browser_write_allowed(request):
    expected = request_origin(request)
    origin = request.headers.get('origin')
    if origin is not None:
        return expected is not None and origin_tuple(origin) == expected
    referer = request.headers.get('referer')
    if referer is not None:
        return expected is not None and origin_tuple(referer) == expected
    fetch_site = request.headers.get('sec-fetch-site')
    if fetch_site is not None:
        return fetch_site == 'same-origin'
    # A cookie is ambient authority. Browser writes without trustworthy metadata
    # must fail closed; nonbrowser token clients do not rely on ambient cookies.
    return not request.cookies.get('bob_ui_session')


class BrowserSecurityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        request = Request(scope)

        async def secure_send(message):
            if message['type'] == 'http.response.start':
                message = dict(message)
                headers = list(message.get('headers', []))
                present = {key.lower() for key, _ in headers}
                defaults = {
                    # Vendor editor documents may use a same-origin base element.
                    b'content-security-policy': (_BASE_POLICY.replace("base-uri 'none'", "base-uri 'self'")
                                                if scope.get('path', '').startswith('/office-editor/')
                                                else _BASE_POLICY).encode(),
                    b'x-content-type-options': b'nosniff',
                    b'referrer-policy': b'no-referrer',
                }
                if scope.get('scheme') == 'https':
                    defaults[b'strict-transport-security'] = b'max-age=31536000; includeSubDomains'
                headers.extend((key, value) for key, value in defaults.items() if key not in present)
                message['headers'] = headers
            await send(message)

        # Explicit auth headers only exempt clients when no session cookie can
        # take precedence in current_user. Never treat header presence as auth.
        token_client = not request.cookies.get('bob_ui_session') and (
            request.headers.get('authorization', '').startswith('Bearer ') or request.headers.get('x-api-key'))
        # A2A also accepts ambient session cookies, so its browser calls need
        # provenance checks even though the access boundary delegates its login.
        machine_callback = scope.get('path') != '/a2a' and _machine(scope.get('path', '/'), request.method)
        if (request.method not in _SAFE_METHODS and not machine_callback
                and not token_client and not browser_write_allowed(request)):
            response = JSONResponse({'detail': 'Same-origin browser request required'}, status_code=403,
                                    headers={'Cache-Control': 'no-store'})
            return await response(scope, receive, secure_send)
        await self.app(scope, receive, secure_send)
