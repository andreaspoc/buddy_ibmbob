"""Session-bound MCP OAuth popup flows with private tokens and PKCE.

Implements RFC 9728 resource discovery, RFC 8414 server discovery, RFC 7591
registration and RFC 7636 S256. Provider HTTP connections pin validated public
DNS addresses; credentials never follow redirects. State survives app restarts.
"""
from __future__ import annotations
from app.branding import brand_name, brand_text
import base64
import hashlib
import html
import ipaddress
import json
import os
import re
import secrets
import socket
import time
from threading import Lock
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpcore
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from psycopg.types.json import Jsonb
from starlette.concurrency import run_in_threadpool
from app.auth import COOKIE, _connect, current_user, knowledge_access

router = APIRouter(prefix='/mcp-oauth', tags=['MCP OAuth'])
MAX_JSON = 128 * 1024
STATE_TTL = 900
_lock = Lock()
_database = None

class OAuthError(ValueError):
    """Only messages safe to display to users belong in this exception."""

def ensure_schema():
    global _database
    database = os.getenv('DATABASE_URL')
    if database and _database == database:
        return
    with _lock:
        if database and _database == database:
            return
        with _connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS bob_mcp_oauth_states (
                state_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                session_hash TEXT NOT NULL, template_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                payload JSONB NOT NULL, expires BIGINT NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_mcp_oauth_state_owner ON bob_mcp_oauth_states(username,template_id)')
            db.execute('''CREATE TABLE IF NOT EXISTS bob_mcp_oauth_tokens (
                username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                template_id TEXT NOT NULL, fingerprint TEXT NOT NULL, record JSONB NOT NULL,
                PRIMARY KEY(username,template_id))''')
        _database = database

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def fingerprint(definition):
    keys = ('transport', 'url', 'command', 'args', 'auth_mode', 'oauth_client_id', 'oauth_scopes',
            'oauth_client_secret_env', 'oauth_token_auth_method')
    return digest(json.dumps({key: definition.get(key, '') for key in keys}, sort_keys=True))

def public_url(url):
    if not isinstance(url, str) or len(url) > 4096:
        raise OAuthError('The provider returned an invalid endpoint URL.')
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise OAuthError('The provider returned an invalid endpoint URL.')
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.fragment or port not in (None, 443)):
        raise OAuthError('OAuth providers must use public HTTPS endpoints without embedded credentials.')
    try:
        address = ipaddress.ip_address(parts.hostname)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise OAuthError('Private and local OAuth provider endpoints are not allowed.')
    return url

class PublicNetworkBackend(httpcore.SyncBackend):
    """Resolve once per connection and connect to that validated IP with host TLS."""
    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        hostname = host.decode('ascii') if isinstance(host, bytes) else host
        try:
            addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise OAuthError('Could not resolve the OAuth provider.') from exc
        ips = list(dict.fromkeys(item[4][0] for item in addresses))
        if not ips or any(not ipaddress.ip_address(value).is_global for value in ips):
            raise OAuthError('Private and local OAuth provider endpoints are not allowed.')
        # httpcore applies TLS with the original server hostname after connecting.
        return super().connect_tcp(ips[0], port, timeout, local_address, socket_options)

def http_request(method, url, *, data=None, body=None, auth=None, read_body=True):
    public_url(url)
    transport = httpx.HTTPTransport(retries=0)
    transport._pool._network_backend = PublicNetworkBackend()
    try:
        deadline = time.monotonic() + 15
        with httpx.Client(transport=transport, timeout=httpx.Timeout(12, connect=6), follow_redirects=False, trust_env=False) as client:
            with client.stream(method, url, data=data, json=body, auth=auth, headers={'Accept': 'application/json'}) as response:
                code, headers = response.status_code, dict(response.headers)
                content = bytearray()
                if read_body:
                    for chunk in response.iter_bytes():
                        if time.monotonic() > deadline:
                            raise OAuthError('The OAuth provider response took too long. Try again.')
                        content.extend(chunk)
                        if len(content) > MAX_JSON:
                            raise OAuthError('The provider metadata or token response is too large.')
                if 300 <= code < 400:
                    raise OAuthError('OAuth endpoints must respond directly without redirects.')
                if not read_body:
                    return code, headers, None
                try:
                    result = json.loads(content)
                except (ValueError, UnicodeError):
                    result = None
                return code, headers, result
    except (httpx.HTTPError, httpcore.NetworkError, httpcore.TimeoutException) as exc:
        raise OAuthError('Could not reach the OAuth provider. Try again.') from exc

def origin(url):
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, '', '', ''))

def resource_matches(endpoint, resource):
    """A server may advertise its parent path as the protected resource."""
    public_url(resource)
    a, b = urlsplit(endpoint), urlsplit(resource)
    requested, configured = a.path.rstrip('/'), b.path.rstrip('/')
    return origin(endpoint) == origin(resource) and (requested == configured or requested.startswith(configured + '/')) and not b.query

def json_metadata(url):
    code, _, result = http_request('GET', url)
    return result if code == 200 and isinstance(result, dict) else None

def discover(definition):
    if definition.get('auth_mode') == 'keycloak':
        return discover_keycloak(definition)
    endpoint = public_url(definition.get('url', ''))
    resource = urlunsplit(urlsplit(endpoint)._replace(query='', fragment=''))
    parts = urlsplit(endpoint)
    code, headers, _ = http_request('GET', endpoint, read_body=False)
    challenge = re.search(r'\bresource_metadata\s*=\s*"([^"\r\n]+)"', headers.get('www-authenticate', ''), re.I)
    candidates = []
    if challenge:
        candidates.append(challenge.group(1))
    base = origin(endpoint)
    path = parts.path.rstrip('/')
    candidates.extend([base + '/.well-known/oauth-protected-resource' + path, base + '/.well-known/oauth-protected-resource'])
    metadata = None
    for candidate in dict.fromkeys(candidates):
        metadata = json_metadata(candidate)
        if metadata:
            break
    if not metadata or not isinstance(metadata.get('authorization_servers'), list) or not metadata['authorization_servers']:
        raise OAuthError('This MCP endpoint does not advertise OAuth. Ask an administrator to check its setup.')
    declared_resource = metadata.get('resource')
    if not declared_resource or not resource_matches(endpoint, declared_resource):
        raise OAuthError('The provider metadata does not match this MCP resource.')
    resource = declared_resource
    issuer = public_url(metadata['authorization_servers'][0]).rstrip('/')
    iparts = urlsplit(issuer)
    if iparts.query:
        raise OAuthError('The OAuth issuer URL cannot contain a query.')
    ibase, ipath = origin(issuer), iparts.path.rstrip('/')
    auth_candidates = [ibase + '/.well-known/oauth-authorization-server' + ipath,
                       ibase + '/.well-known/openid-configuration' + ipath]
    if ipath:
        auth_candidates.append(issuer + '/.well-known/openid-configuration')
    auth = None
    for candidate in dict.fromkeys(auth_candidates):
        auth = json_metadata(candidate)
        if auth:
            break
    if not auth or not isinstance(auth.get('issuer'), str) or auth['issuer'].rstrip('/') != issuer:
        raise OAuthError('The OAuth authorization server metadata has an invalid issuer.')
    if not isinstance(auth.get('code_challenge_methods_supported'), list) or 'S256' not in auth['code_challenge_methods_supported']:
        raise OAuthError('This OAuth provider must support PKCE S256 to connect securely.')
    if 'code' not in auth.get('response_types_supported', ['code']):
        raise OAuthError('This provider does not support OAuth authorization code sign-in.')
    for key in ('authorization_endpoint', 'token_endpoint'):
        public_url(auth.get(key, ''))
    if auth.get('registration_endpoint'):
        public_url(auth['registration_endpoint'])
    scopes = definition.get('oauth_scopes', '').split() or metadata.get('scopes_supported', [])
    if not isinstance(scopes, list) or any(not isinstance(scope, str) or len(scope) > 200 for scope in scopes) or len(scopes) > 100:
        raise OAuthError('Invalid OAuth scope metadata.')
    methods = auth.get('token_endpoint_auth_methods_supported', ['client_secret_basic'])
    if not isinstance(methods, list) or any(not isinstance(method, str) for method in methods):
        raise OAuthError('Invalid OAuth client authentication metadata.')
    return {'issuer': issuer, 'resource': resource, 'authorization_endpoint': auth['authorization_endpoint'],
            'token_endpoint': auth['token_endpoint'], 'registration_endpoint': auth.get('registration_endpoint'),
            'client_metadata_supported': auth.get('client_id_metadata_document_supported') is True,
            'response_issuer_required': auth.get('authorization_response_iss_parameter_supported') is True,
            'auth_methods': methods,
            'scope': ' '.join(scopes)}

def discover_keycloak(definition):
    """Discover only the configured realm, without altering application SSO."""
    issuer = public_url(definition.get('url', '')).rstrip('/')
    parts = urlsplit(issuer)
    if parts.query or not re.fullmatch(r'.*/realms/[A-Za-z0-9._-]+', parts.path) or parts.path.rsplit('/', 1)[-1] in {'.', '..'}:
        raise OAuthError('Configure the public HTTPS Keycloak realm issuer URL, ending in /realms/REALM.')
    if not definition.get('oauth_client_id', '').strip():
        raise OAuthError('An administrator must register a Keycloak OAuth client and configure its client ID first.')
    metadata = json_metadata(issuer + '/.well-known/openid-configuration')
    if not metadata or metadata.get('issuer') != issuer:
        raise OAuthError('The Keycloak discovery metadata does not match the configured realm issuer.')
    methods = metadata.get('code_challenge_methods_supported')
    if not isinstance(methods, list) or 'S256' not in methods:
        raise OAuthError('The Keycloak OAuth client must support PKCE S256.')
    for key, suffix in (('authorization_endpoint', '/protocol/openid-connect/auth'), ('token_endpoint', '/protocol/openid-connect/token')):
        endpoint = public_url(metadata.get(key, ''))
        if origin(endpoint) != origin(issuer) or urlsplit(endpoint).path != parts.path + suffix:
            raise OAuthError('Keycloak OAuth endpoints must stay on the configured realm and origin.')
    auth_methods = metadata.get('token_endpoint_auth_methods_supported', ['client_secret_basic'])
    if not isinstance(auth_methods, list) or any(not isinstance(method, str) for method in auth_methods):
        raise OAuthError('Invalid Keycloak client authentication metadata.')
    # Keycloak supports pre-registered public clients but some releases omit
    # "none" from discovery (upstream keycloak/keycloak issue #49730). The
    # administrator explicitly chooses a public client; PKCE remains mandatory.
    if definition.get('oauth_token_auth_method', 'none') == 'none':
        auth_methods = list(dict.fromkeys([*auth_methods, 'none']))
    scopes = definition.get('oauth_scopes', '').split() or ['openid']
    if any(scope in {'profile', 'email'} for scope in scopes):
        raise OAuthError('The Keycloak administration connector does not request profile or email scopes.')
    return {'issuer': issuer, 'resource': '', 'authorization_endpoint': metadata['authorization_endpoint'],
            'token_endpoint': metadata['token_endpoint'], 'registration_endpoint': None,
            'client_metadata_supported': False, 'response_issuer_required': metadata.get('authorization_response_iss_parameter_supported') is True,
            'auth_methods': auth_methods, 'scope': ' '.join(scopes)}

def app_base(request=None):
    url = os.getenv('PUBLIC_BASE_URL', '').strip().rstrip('/') or (str(request.base_url).rstrip('/') if request else '')
    parts = urlsplit(url)
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ('', '/'):
        raise OAuthError('Configure PUBLIC_BASE_URL as the application origin before using OAuth.')
    if parts.scheme != 'https' and not (parts.scheme == 'http' and parts.hostname in ('localhost', '127.0.0.1', '::1')):
        raise OAuthError('The application OAuth callback requires HTTPS, except on localhost.')
    return origin(url)

def allowed_definition(username, template_id, expected=None, db=None):
    from app.mcp_catalog import permitted
    profile = knowledge_access(username)
    if db is None:
        with _connect() as connection:
            row = connection.execute('SELECT definition FROM bob_mcp_catalog WHERE id=%s', (template_id,)).fetchone()
    else:
        row = db.execute('SELECT definition FROM bob_mcp_catalog WHERE id=%s FOR SHARE', (template_id,)).fetchone()
    if not row or row[0].get('auth_mode') not in {'oauth', 'keycloak'} or not permitted(row[0], profile, username):
        raise OAuthError('This MCP connection is no longer available to your account.')
    if expected is not None and fingerprint(row[0]) != fingerprint(expected):
        raise OAuthError('The MCP definition changed. Sign in again.')
    return row[0]

def registration(provider, definition, base):
    client_id = definition.get('oauth_client_id', '').strip()
    method = definition.get('oauth_token_auth_method', 'none')
    secret_env = definition.get('oauth_client_secret_env', '')
    if secret_env and not re.fullmatch(r'BOB_MCP_OAUTH_[A-Z0-9_]+', secret_env):
        raise OAuthError('OAuth client secrets must use a dedicated BOB_MCP_OAUTH_ environment variable.')
    client_secret = os.getenv(secret_env, '') if secret_env else ''
    if client_id:
        if method not in ('none', 'client_secret_basic', 'client_secret_post') or method not in provider['auth_methods']:
            raise OAuthError('The configured client authentication method is not supported by this provider.')
        if method != 'none' and not client_secret:
            raise OAuthError('An administrator must configure this provider’s OAuth client secret environment variable.')
        return {'client_id': client_id, 'client_secret': client_secret, 'auth_method': method}
    # Registration works for internal deployments without requiring the
    # provider to fetch a metadata document from our private/self-signed URL.
    if not provider['registration_endpoint'] and provider['client_metadata_supported'] and base.startswith('https://'):
        hostname = urlsplit(base).hostname
        try:
            private_host = not ipaddress.ip_address(hostname).is_global
        except ValueError:
            private_host = hostname == 'localhost'
        if private_host:
            raise OAuthError(brand_text('This provider must retrieve Buddy’s client metadata from a publicly reachable HTTPS URL with a trusted certificate. Configure a public hostname or a registered OAuth client ID.'))
        return {'client_id': base + '/mcp-oauth/client-metadata.json', 'client_secret': '', 'auth_method': 'none'}
    if not provider['registration_endpoint']:
        raise OAuthError('This provider requires an administrator to register an OAuth client and configure its client ID first.')
    body = {'client_name': brand_text('Buddy'), 'redirect_uris': [base + '/mcp-oauth/callback'],
            'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'], 'token_endpoint_auth_method': 'none'}
    if provider['scope']:
        body['scope'] = provider['scope']
    code, _, result = http_request('POST', provider['registration_endpoint'], body=body)
    if code not in (200, 201) or not isinstance(result, dict) or not isinstance(result.get('client_id'), str) or not result['client_id']:
        raise OAuthError(brand_text('This provider could not register Buddy automatically. An administrator may need to configure a client ID.'))
    if result.get('redirect_uris') and body['redirect_uris'] != result['redirect_uris']:
        raise OAuthError('The OAuth registration returned a different callback URL.')
    method = result.get('token_endpoint_auth_method', 'none')
    if method != 'none':
        raise OAuthError('Automatic OAuth registration must allow a public PKCE client.')
    return {'client_id': result['client_id'], 'client_secret': '', 'auth_method': 'none'}

def create_start(username, session, template_id, base):
    if not session:
        raise OAuthError(brand_text('Sign in to Buddy before connecting a provider.'))
    ensure_schema()
    definition = allowed_definition(username, template_id)
    provider = discover(definition)
    registered = registration(provider, definition, base)
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    payload = {**provider, **registered, 'verifier': verifier, 'origin': base, 'redirect_uri': base + '/mcp-oauth/callback'}
    with _connect() as db:
        # Revalidate after network discovery, so an intervening admin edit cannot bind stale credentials.
        allowed_definition(username, template_id, definition, db)
        db.execute('DELETE FROM bob_mcp_oauth_states WHERE expires<=%s', (int(time.time()),))
        db.execute('INSERT INTO bob_mcp_oauth_states VALUES (%s,%s,%s,%s,%s,%s,%s)',
                   (digest(state), username, digest(session), template_id, fingerprint(definition), Jsonb(payload), int(time.time()) + STATE_TTL))
    parameters = {'response_type': 'code', 'client_id': registered['client_id'], 'redirect_uri': payload['redirect_uri'],
                  'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'}
    if provider['resource']:
        parameters['resource'] = provider['resource']
    if provider['scope']:
        parameters['scope'] = provider['scope']
    parts = urlsplit(provider['authorization_endpoint'])
    existing = [(key, value) for key, value in parse_qsl(parts.query) if key not in parameters]
    return urlunsplit(parts._replace(query=urlencode(existing + list(parameters.items()))))

def consume_state(state, username, session):
    if not state or len(state) > 500 or not session:
        raise OAuthError('This sign-in request is invalid or expired. Start again.')
    ensure_schema()
    with _connect() as db:
        row = db.execute('''DELETE FROM bob_mcp_oauth_states WHERE state_hash=%s AND username=%s AND session_hash=%s
            AND expires>%s RETURNING template_id,fingerprint,payload''', (digest(state), username, digest(session), int(time.time()))).fetchone()
    if not row:
        raise OAuthError('This sign-in request is invalid or expired. Start again.')
    return row

def token_exchange(record, parameters):
    parameters = {**parameters, 'client_id': record['client_id']}
    if record['resource']:
        parameters['resource'] = record['resource']
    auth = None
    if record['auth_method'] == 'client_secret_basic':
        auth = httpx.BasicAuth(record['client_id'], record['client_secret'])
    elif record['auth_method'] == 'client_secret_post':
        parameters['client_secret'] = record['client_secret']
    code, _, token = http_request('POST', record['token_endpoint'], data=parameters, auth=auth)
    if code != 200 or not isinstance(token, dict) or not isinstance(token.get('access_token'), str) or not token['access_token']:
        raise OAuthError('The provider did not issue an access token. Start sign-in again.')
    if str(token.get('token_type', '')).lower() != 'bearer':
        raise OAuthError('This provider must issue a Bearer access token.')
    if len(token['access_token']) > 32000 or '\n' in token['access_token'] or '\r' in token['access_token']:
        raise OAuthError('The provider returned an invalid access token.')
    expires = token.get('expires_in', 3600)
    if not isinstance(expires, (int, float)) or isinstance(expires, bool) or not 0 < expires <= 31536000:
        raise OAuthError('The provider returned an invalid token lifetime.')
    refresh = token.get('refresh_token', record.get('refresh_token'))
    if refresh is not None and (not isinstance(refresh, str) or len(refresh) > 32000):
        raise OAuthError('The provider returned an invalid refresh token.')
    return {**record, 'access_token': token['access_token'], 'refresh_token': refresh,
            'expires_at': int(time.time()) + int(expires), 'scope': token.get('scope', record.get('scope', ''))}

def complete(username, session, state, code, error='', response_issuer=''):
    template_id, expected, record = consume_state(state, username, session)
    try:
        return complete_consumed(username, template_id, expected, record, code, error, response_issuer)
    except OAuthError as exc:
        # The state was authenticated and consumed, so its popup target is safe.
        exc.template_id, exc.popup_origin = template_id, record['origin']
        raise

def complete_consumed(username, template_id, expected, record, code, error, response_issuer):
    if error:
        raise OAuthError('Provider sign-in was cancelled or denied. Your existing connection was kept.')
    if not code or len(code) > 8000:
        raise OAuthError('The provider did not return an authorization code. Start again.')
    if record.get('response_issuer_required') and not response_issuer:
        raise OAuthError('The provider did not identify its authorization response issuer.')
    if response_issuer and response_issuer.rstrip('/') != record['issuer'].rstrip('/'):
        raise OAuthError('The authorization response came from a different issuer.')
    definition = allowed_definition(username, template_id)
    if fingerprint(definition) != expected:
        raise OAuthError('The MCP definition changed during sign-in. Start again.')
    token = token_exchange(record, {'grant_type': 'authorization_code', 'code': code,
                                     'redirect_uri': record['redirect_uri'], 'code_verifier': record['verifier']})
    # The one-use verifier is no longer required after token exchange.
    token.pop('verifier', None)
    with _connect() as db:
        allowed_definition(username, template_id, definition, db)
        db.execute('''INSERT INTO bob_mcp_oauth_tokens(username,template_id,fingerprint,record) VALUES(%s,%s,%s,%s)
            ON CONFLICT(username,template_id) DO UPDATE SET fingerprint=excluded.fingerprint,record=excluded.record''',
            (username, template_id, expected, Jsonb(token)))
    return template_id, record['origin']

def access_token(username, template_id, definition):
    ensure_schema()
    try:
        allowed_definition(username, template_id, definition)
        with _connect() as db:
            # Keep lock order consistent with admin template invalidation:
            # template first, then this user's private token row.
            allowed_definition(username, template_id, definition, db)
            row = db.execute('SELECT fingerprint,record FROM bob_mcp_oauth_tokens WHERE username=%s AND template_id=%s FOR UPDATE', (username, template_id)).fetchone()
            if not row or row[0] != fingerprint(definition):
                return None
            record = row[1]
            if record.get('expires_at', 0) <= int(time.time()) + 60:
                if not record.get('refresh_token'):
                    return None
                updated = token_exchange(record, {'grant_type': 'refresh_token', 'refresh_token': record['refresh_token']})
                allowed_definition(username, template_id, definition, db)
                db.execute('UPDATE bob_mcp_oauth_tokens SET record=%s WHERE username=%s AND template_id=%s', (Jsonb(updated), username, template_id))
                record = updated
            return record.get('access_token')
    except OAuthError:
        return None

def status(username, template_id, definition):
    ensure_schema()
    with _connect() as db:
        row = db.execute('SELECT fingerprint,record FROM bob_mcp_oauth_tokens WHERE username=%s AND template_id=%s', (username, template_id)).fetchone()
    valid = bool(row and row[0] == fingerprint(definition))
    record = row[1] if valid else {}
    expiry = record.get('expires_at', 0)
    usable = bool(record.get('access_token') and (expiry > int(time.time()) + 60 or record.get('refresh_token')))
    return {'connected': usable, 'expires_at': expiry or None, 'needs_reconnect': bool(row and not usable)}

def disconnect(username, template_id):
    ensure_schema()
    with _connect() as db:
        db.execute('DELETE FROM bob_mcp_oauth_tokens WHERE username=%s AND template_id=%s', (username, template_id))
        db.execute('DELETE FROM bob_mcp_oauth_states WHERE username=%s AND template_id=%s', (username, template_id))

def invalidate_template(template_id, db=None):
    if db is None:
        ensure_schema()
        with _connect() as connection:
            invalidate_template(template_id, connection)
        return
    db.execute('DELETE FROM bob_mcp_oauth_tokens WHERE template_id=%s', (template_id,))
    db.execute('DELETE FROM bob_mcp_oauth_states WHERE template_id=%s', (template_id,))

def popup_response(base, template_id='', success=False, message=''):
    nonce = secrets.token_urlsafe(20)
    # Re-validate base is a safe HTTPS origin before embedding in the script tag.
    if base:
        _parts = urlsplit(base)
        if _parts.scheme not in ('http', 'https') or not _parts.hostname or _parts.path not in ('', '/'):
            base = ''
    payload = {'type': 'buddy-mcp-oauth', 'template_id': template_id, 'status': 'success' if success else 'error'}
    # Base64 contains no HTML/script delimiters. JSON's ASCII escapes retain
    # Unicode values when the browser parses the decoded payload.
    encoded = base64.b64encode(json.dumps({'payload': payload, 'origin': base}).encode('ascii')).decode('ascii')
    text = message or ('Connected. You can close this window.' if success else brand_text('Could not complete sign-in. Start again from Buddy.'))
    document = ('<!doctype html><html><head><meta charset="utf-8"><title>{brand_name()} · Provider sign-in</title>'
                f'<style nonce="{nonce}">body{{font:16px system-ui;background:#faf7fd;color:#281937;margin:48px}}h1{{color:#7b00e0;font-size:24px}}p{{max-width:560px;line-height:1.6}}</style>'
                '</head><body><h1>{brand_name()}</h1><p>' + html.escape(text) + '</p>'
                f'<script nonce="{nonce}">const data=JSON.parse(atob("{encoded}"));'
                'if(window.opener){window.opener.postMessage(data.payload,data.origin||window.location.origin);}'
                + ('window.close();' if success else 'window.setTimeout(function(){window.close();},1500);') + '</script></body></html>')
    return HTMLResponse(document, headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"})

@router.get('/client-metadata.json')
def client_metadata():
    try:
        base = app_base()
    except OAuthError as exc:
        raise HTTPException(503, str(exc)) from exc
    if not base.startswith('https://'):
        raise HTTPException(503, 'OAuth client metadata requires a public HTTPS application URL')
    return JSONResponse({'client_id': base + '/mcp-oauth/client-metadata.json', 'client_name': brand_text('Buddy'),
                         'redirect_uris': [base + '/mcp-oauth/callback'], 'grant_types': ['authorization_code', 'refresh_token'],
                         'response_types': ['code'], 'token_endpoint_auth_method': 'none'}, headers={'Cache-Control': 'public, max-age=300'})

@router.get('/callback')
async def callback(request: Request):
    base, template_id = '', ''
    try:
        base = app_base(request)
        user = await current_user(request)
        template_id, base = await run_in_threadpool(complete, user['username'], request.cookies.get(COOKIE, ''),
                                                  request.query_params.get('state', ''), request.query_params.get('code', ''),
                                                  request.query_params.get('error', ''), request.query_params.get('iss', ''))
        return popup_response(base, template_id, True)
    except (OAuthError, HTTPException) as exc:
        template_id = getattr(exc, 'template_id', template_id)
        base = getattr(exc, 'popup_origin', base)
        return popup_response(base, template_id, False, str(exc) if isinstance(exc, OAuthError) else brand_text('Sign in to Buddy and start the provider connection again.'))

@router.get('/{template_id}/start')
async def start(template_id: str, request: Request, user=Depends(current_user)):
    base = ''
    try:
        base = app_base(request)
        target = await run_in_threadpool(create_start, user['username'], request.cookies.get(COOKIE, ''), template_id, base)
        return RedirectResponse(target, status_code=302, headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
    except OAuthError as exc:
        return popup_response(base, template_id, False, str(exc))
