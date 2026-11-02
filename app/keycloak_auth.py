"""Keycloak authorization-code login with PKCE, nonce and verified ID tokens."""
from __future__ import annotations
import base64
import hashlib
import hmac
import os
import re
import secrets
import socket
import time
from urllib.parse import urlencode, urlsplit
import httpx
import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from app.auth import _connect, _hasher, start_session, user_profile

_orig_getaddrinfo = socket.getaddrinfo

def _keycloak_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    try:
        return _orig_getaddrinfo(host, port, family, type, proto, flags)
    except socket.gaierror:
        custom_ip = os.getenv('KEYCLOAK_HOST_IP', '').strip()
        expected_host = urlsplit(os.getenv('KEYCLOAK_ISSUER', '')).hostname
        if custom_ip and host == expected_host:
            return _orig_getaddrinfo(custom_ip, port, family, type, proto, flags)
        raise

socket.getaddrinfo = _keycloak_getaddrinfo

router = APIRouter(prefix='/auth/keycloak', tags=['keycloak'])
STATE_COOKIE = 'bob_keycloak_state'


def configured():
    return bool(os.getenv('KEYCLOAK_ISSUER', '').strip() and os.getenv('KEYCLOAK_CLIENT_ID', '').strip() and os.getenv('KEYCLOAK_CLIENT_SECRET', '').strip())


def local_login_enabled():
    return not configured() or os.getenv('BOB_LOCAL_LOGIN_ENABLED', '0') == '1'


def issuer():
    value = os.getenv('KEYCLOAK_ISSUER', '').strip().rstrip('/')
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.query or parsed.fragment or parsed.username:
        raise HTTPException(503, 'Keycloak issuer must be an HTTPS URL')
    return value


def redirect_uri(request: Request | None = None):
    explicit = os.getenv('KEYCLOAK_REDIRECT_URI', '').strip()
    if explicit:
        return explicit
    base = os.getenv('PUBLIC_BASE_URL', '').strip().rstrip('/')
    if base and base != 'http://localhost:3000':
        return base + '/auth/keycloak/callback'
    if request is not None:
        scheme = request.headers.get('x-forwarded-proto') or request.url.scheme
        host = request.headers.get('x-forwarded-host') or request.headers.get('host')
        if host:
            return f"{scheme}://{host}/auth/keycloak/callback"
    return (base or 'http://localhost:3000') + '/auth/keycloak/callback'


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS bob_keycloak_flows (
        state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL, expires BIGINT NOT NULL)''')
    db.execute("ALTER TABLE bob_keycloak_flows ADD COLUMN IF NOT EXISTS return_path TEXT NOT NULL DEFAULT '/'")
    db.execute('''CREATE TABLE IF NOT EXISTS bob_keycloak_identities (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, username TEXT NOT NULL REFERENCES users(username),
        PRIMARY KEY(issuer,subject))''')
    from app.keycloak_groups import schema as group_schema
    group_schema(db)


async def discovery(client):
    expected = issuer()
    response = await client.get(expected + '/.well-known/openid-configuration')
    response.raise_for_status()
    data = response.json()
    if data.get('issuer') != expected: raise ValueError('Issuer mismatch')
    for key in ('authorization_endpoint', 'token_endpoint', 'jwks_uri'):
        # Only the configured realm may supply endpoints to receive tokens/secrets.
        if not isinstance(data.get(key), str) or not data[key].startswith(expected + '/'):
            raise ValueError('Unexpected endpoint')
    return data


def validate_token(token, jwks, nonce):
    header = jwt.get_unverified_header(token)
    if header.get('alg') != 'RS256': raise ValueError('Unsupported signing algorithm')
    keys = [key for key in jwks.get('keys', []) if key.get('kid') == header.get('kid') and key.get('kty') == 'RSA' and key.get('use', 'sig') == 'sig' and key.get('alg', 'RS256') == 'RS256']
    if len(keys) != 1: raise ValueError('Signing key not found')
    claims = jwt.decode(token, jwt.PyJWK.from_dict(keys[0]).key, algorithms=['RS256'],
        audience=os.environ['KEYCLOAK_CLIENT_ID'], issuer=issuer(),
        options={'require':['iss','sub','aud','exp','iat','nonce']}, leeway=30)
    if not isinstance(claims['sub'], str) or not claims['sub'] or not isinstance(claims['nonce'], str) or not hmac.compare_digest(claims['nonce'], nonce):
        raise ValueError('Invalid identity or nonce')
    if claims.get('azp', os.environ['KEYCLOAK_CLIENT_ID']) != os.environ['KEYCLOAK_CLIENT_ID']:
        raise ValueError('Authorized party mismatch')
    if isinstance(claims['aud'], list) and len(claims['aud']) > 1 and 'azp' not in claims:
        raise ValueError('Authorized party missing')
    return claims


def profile_name(claims):
    def text(key):
        value = claims.get(key)
        return value.strip()[:200] if isinstance(value, str) else ''
    return (' '.join(part for part in (text('given_name'), text('family_name')) if part)
            or text('name') or text('preferred_username'))[:400]


def resolve_identity(claims):
    realm = issuer()
    subject = claims['sub']
    name = profile_name(claims)
    email = claims.get('email')
    email = email.strip().lower() if isinstance(email, str) and '@' in email and len(email.strip()) <= 320 else None
    verified = claims.get('email_verified') is True
    with _connect() as db:
        schema(db)
        db.execute("SELECT pg_advisory_xact_lock(hashtext('keycloak_identity'))")
        db.execute("SELECT pg_advisory_xact_lock(hashtext('administrator_assignments'))")
        row = db.execute('SELECT u.username,u.is_admin FROM bob_keycloak_identities i JOIN users u ON i.username=u.username WHERE i.issuer=%s AND i.subject=%s', (realm, subject)).fetchone()
        if row:
            username, admin = row[0], bool(row[1])
        else:
            # Keep the stable internal identity; display names never select an account.
            username = 'kc-' + hashlib.sha256((realm + '\x00' + subject).encode()).hexdigest()[:40]
            admin_subjects = set(os.getenv('KEYCLOAK_ADMIN_SUBJECTS', '').split(','))
            admin = subject in admin_subjects or not db.execute('SELECT 1 FROM users LIMIT 1').fetchone()
            if db.execute('SELECT 1 FROM users WHERE username=%s', (username,)).fetchone():
                raise ValueError('Identity allocation conflict')
            db.execute('INSERT INTO users VALUES (%s,%s,%s)', (username, _hasher.hash(secrets.token_urlsafe(48)), admin))
            db.execute('INSERT INTO bob_keycloak_identities VALUES (%s,%s,%s)', (realm, subject, username))
        db.execute("INSERT INTO bob_user_profiles(username,display_name,email,email_verified) VALUES (%s,%s,%s,%s) ON CONFLICT(username) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,email_verified=excluded.email_verified", (username, name or username, email, verified))
        duplicate_email = email and verified and db.execute("SELECT 1 FROM bob_user_profiles WHERE email=%s AND email_verified=TRUE AND username<>%s", (email, username)).fetchone()
        if email and verified and not duplicate_email and db.execute("SELECT 1 FROM bob_admin_email_grants WHERE email=%s", (email,)).fetchone():
            db.execute("UPDATE users SET is_admin=TRUE WHERE username=%s", (username,))
            db.execute("DELETE FROM bob_admin_email_grants WHERE email=%s", (email,))
            db.execute("INSERT INTO bob_access_audit(actor,action,target) VALUES ('verified-keycloak-login','grant-administrator',%s)", (username,))
            admin = True
        from app.keycloak_groups import sync as sync_groups
        sync_groups(db, realm, subject, claims)
    return user_profile(username, admin)


def sign_in_return_path(value: str) -> str:
    if len(value) > 2048 or any(ord(char) < 32 for char in value) or '\\' in value:
        return '/'
    try:
        parsed = urlsplit(value)
    except ValueError:
        return '/'
    if parsed.scheme or parsed.netloc or value.startswith('//'):
        return '/'
    if parsed.path not in {'/', '/projects', '/projects/', '/learning', '/learning/'} and not re.fullmatch(r'/shared/(?:(?:legacy|[a-f0-9]{32})/)?[A-Za-z0-9_-]{43}', parsed.path):
        return '/'
    return parsed.path + ('?' + parsed.query if parsed.query else '')


@router.get('/login')
async def login(request: Request, next: str = '/'):
    if not configured(): raise HTTPException(503, 'Keycloak is not configured')
    try:
        async with httpx.AsyncClient(timeout=20) as client: data = await discovery(client)
    except Exception as exc: raise HTTPException(503, 'Cannot load Keycloak configuration') from exc
    state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    callback = redirect_uri(request)
    with _connect() as db:
        schema(db)
        db.execute('DELETE FROM bob_keycloak_flows WHERE expires < %s', (int(time.time()),))
        db.execute('INSERT INTO bob_keycloak_flows(state_hash,nonce,verifier,redirect_uri,expires,return_path) VALUES (%s,%s,%s,%s,%s,%s)', (hashlib.sha256(state.encode()).hexdigest(), nonce, verifier, callback, int(time.time())+600, sign_in_return_path(next)))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    params = {'client_id':os.environ['KEYCLOAK_CLIENT_ID'], 'response_type':'code', 'scope':'openid profile email', 'redirect_uri':callback,
        'state':state, 'nonce':nonce, 'code_challenge':challenge, 'code_challenge_method':'S256'}
    response = RedirectResponse(data['authorization_endpoint'] + '?' + urlencode(params), status_code=302)
    response.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, secure=callback.startswith('https://'), samesite='lax', path='/auth/keycloak')
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/callback')
async def callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    def failure():
        response = RedirectResponse('/?keycloak_error=Sign-in+failed.+Please+try+again.', status_code=302)
        response.delete_cookie(STATE_COOKIE, path='/auth/keycloak')
        return response
    cookie = request.cookies.get(STATE_COOKIE)
    if not configured() or not state or not cookie or not hmac.compare_digest(state, cookie): return failure()
    with _connect() as db:
        schema(db)
        row = db.execute('DELETE FROM bob_keycloak_flows WHERE state_hash=%s AND expires>%s RETURNING nonce,verifier,redirect_uri,return_path', (hashlib.sha256(state.encode()).hexdigest(), int(time.time()))).fetchone()
    if not row or not code or error: return failure()
    nonce, verifier, callback_url, return_path = row
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            config = await discovery(client)
            tokens = await client.post(config['token_endpoint'], data={'grant_type':'authorization_code','code':code,'redirect_uri':callback_url,'client_id':os.environ['KEYCLOAK_CLIENT_ID'],'client_secret':os.environ['KEYCLOAK_CLIENT_SECRET'],'code_verifier':verifier})
            tokens.raise_for_status()
            keys = await client.get(config['jwks_uri']); keys.raise_for_status()
            claims = validate_token(tokens.json()['id_token'], keys.json(), nonce)
        user = resolve_identity(claims)
    except Exception: return failure()
    response = RedirectResponse(sign_in_return_path(return_path), status_code=302)
    start_session(response, user, request)
    response.delete_cookie(STATE_COOKIE, path='/auth/keycloak')
    return response
