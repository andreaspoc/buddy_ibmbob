"""Fail-closed browser access boundary, without buffering streams or websocket frames.

Endpoint-level ownership checks still apply. Machine callbacks bypass this login
gate only because their endpoints verify signed capabilities / protocol auth.
"""
from urllib.parse import quote

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse


_PUBLIC = {
    '/': {'GET', 'HEAD'},
    '/register': {'GET', 'HEAD'},
    '/favicon.svg': {'GET', 'HEAD'},
    '/icons.svg': {'GET', 'HEAD'},
    '/auth/status': {'GET'},
    # The sign-in page shows the instance name and logo before anyone is authenticated.
    '/branding': {'GET'},
    '/branding/logo': {'GET', 'HEAD'},
    '/auth/setup': {'POST'},
    '/auth/login': {'POST'},
    '/auth/register': {'POST'},
    '/auth/logout': {'POST'},
    '/auth/keycloak/login': {'GET'},
    '/auth/keycloak/callback': {'GET'},
    '/ready': {'GET', 'HEAD'},
    '/mcp-oauth/client-metadata.json': {'GET'},
    '/.well-known/agent-card.json': {'GET'},
    '/.well-known/agent.json': {'GET'},
}
_LOGIN_FILES = {
    '/static/styles.css', '/static/app.js', '/static/renderer.bundle.js',
    '/static/projects.js', '/static/import-fab.js',
}


def _public(path, method):
    if method in _PUBLIC.get(path, set()):
        return True
    # Build output contains application assets, never user uploads. Do not allow
    # arbitrary /static: generated files and plugin bridges require a login.
    if method in ('GET', 'HEAD') and '..' not in path and '\\' not in path:
        return path in _LOGIN_FILES or path.startswith('/assets/') or path.startswith('/decisions/assets/')
    return False


def _machine(path, method):
    if path == '/a2a' and method == 'POST':
        return True  # current_user enforced by the JSON-RPC endpoint itself.
    if path == '/api/projects/agent-context' and method == 'POST':
        return True  # Purpose- and body-bound capability verified by the endpoint.
    if path == '/api/office/app-actions' and method == 'POST':
        return True  # Purpose-scoped signed JWT and body hash verified by endpoint.
    if path == '/api/office/callback' and method == 'POST':
        return True  # ONLYOFFICE JWT signature and editor session validation.
    if method == 'GET' and path.startswith('/api/office/source/'):
        session_id = path.removeprefix('/api/office/source/')
        return bool(session_id) and '/' not in session_id
    return False


class AccessBoundaryMiddleware:
    def __init__(self, app, authenticate=None):
        self.app = app
        if authenticate is None:
            from app.auth import current_user
            authenticate = current_user
        self.authenticate = authenticate

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        path = scope.get('path', '/')
        method = scope.get('method', 'GET')
        if scope['type'] == 'http':
            # Existing /health exposes configuration; anonymous probes only need
            # a liveness result. Database readiness remains /ready.
            if path == '/health' and method in ('GET', 'HEAD'):
                return await JSONResponse({'ok': True}, headers={'Cache-Control': 'no-store'})(scope, receive, send)
            if _public(path, method) or _machine(path, method):
                return await self.app(scope, receive, send)
        # Request reads headers/cookies only: no request body or frame is consumed.
        request = Request({**scope, 'type': 'http'})
        try:
            user = await self.authenticate(request)
            if not user:
                raise HTTPException(401, 'Sign in required')
            # Internal ASGI state, never derived from client headers. Let route
            # dependencies reuse the validated identity within this request.
            if scope['type'] == 'http':
                scope.setdefault('state', {})['boundary_user'] = user
        except HTTPException as exc:
            if exc.status_code not in (401, 403):
                raise
            if scope['type'] == 'websocket':
                return await send({'type': 'websocket.close', 'code': 1008})
            if method in ('GET', 'HEAD') and 'text/html' in request.headers.get('accept', ''):
                response = RedirectResponse('/?next=' + quote(path, safe=''), status_code=303,
                                            headers={'Cache-Control': 'no-store'})
            else:
                response = JSONResponse({'detail': 'Sign in required'}, status_code=401,
                                        headers={'Cache-Control': 'no-store'})
            return await response(scope, receive, send)

        async def private_send(message):
            if message['type'] == 'http.response.start':
                message = dict(message)
                message['headers'] = [(k, v) for k, v in message.get('headers', [])
                                      if k.lower() != b'cache-control']
                message['headers'].append((b'cache-control', b'private, no-store'))
            await send(message)

        await self.app(scope, receive, private_send)
