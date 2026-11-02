"""Real DB and popup HTTP tests with explicitly synthetic provider HTTP fixtures.

No operational external account is connected. Temporary accounts, tokens,
states, definitions, and audit records are removed after verification.
"""
import base64
import hashlib
import json
import re
import os
import secrets
import time
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.auth import COOKIE, _connect, current_user
from app import mcp_catalog as mcp, mcp_oauth as oauth, postgres_storage as storage

suffix = secrets.token_hex(5)
alice, bob = ['oauthtest-' + kind + '-' + suffix for kind in ('alice', 'bob')]
template_id = 'oauth-fixture-' + suffix
native_template_id = 'keycloak-fixture-' + suffix
calls = []
refreshes = []
current = {'username': alice, 'is_admin': False}

def popup_status(response):
    encoded = re.search(r'JSON.parse\(atob\("([A-Za-z0-9+/=]+)"\)\)', response.text)
    assert encoded, 'OAuth popup lacks encoded status payload'
    return json.loads(base64.b64decode(encoded.group(1)))['payload']['status']

def provider(method, url, **kwargs):
    calls.append((method, url, kwargs))
    native_issuer = 'https://synthetic-keycloak.example/realms/work'
    if url == native_issuer + '/.well-known/openid-configuration':
        return 200, {}, {'issuer': native_issuer, 'authorization_endpoint': native_issuer + '/protocol/openid-connect/auth',
                         'token_endpoint': native_issuer + '/protocol/openid-connect/token',
                         'code_challenge_methods_supported': ['S256'], 'token_endpoint_auth_methods_supported': ['client_secret_basic']}
    if url == native_issuer + '/protocol/openid-connect/token':
        assert 'resource' not in kwargs['data']
        return 200, {}, {'access_token': 'synthetic-keycloak-private-token', 'token_type': 'Bearer', 'expires_in': 300, 'refresh_token': 'synthetic-keycloak-refresh'}
    if url == 'https://synthetic-resource.example/mcp':
        return 401, {'www-authenticate': 'Bearer resource_metadata="https://synthetic-resource.example/prm"'}, None
    if url == 'https://synthetic-resource.example/prm':
        return 200, {}, {'resource': 'https://synthetic-resource.example/mcp', 'authorization_servers': ['https://synthetic-auth.example'], 'scopes_supported': ['read:docs']}
    if url == 'https://synthetic-auth.example/.well-known/oauth-authorization-server':
        return 200, {}, {'issuer': 'https://synthetic-auth.example', 'authorization_endpoint': 'https://synthetic-auth.example/authorize',
                         'token_endpoint': 'https://synthetic-auth.example/token', 'registration_endpoint': 'https://synthetic-auth.example/register',
                         'code_challenge_methods_supported': ['S256'], 'token_endpoint_auth_methods_supported': ['none']}
    if url == 'https://synthetic-auth.example/register':
        assert kwargs['body']['redirect_uris'] == ['http://localhost:3000/mcp-oauth/callback']
        return 201, {}, {'client_id': 'synthetic-client', 'token_endpoint_auth_method': 'none'}
    if url == 'https://synthetic-auth.example/token':
        data = kwargs['data']
        assert data['resource'] == 'https://synthetic-resource.example/mcp'
        if data['grant_type'] == 'authorization_code':
            assert len(data['code_verifier']) >= 43 and data['redirect_uri'] == 'http://localhost:3000/mcp-oauth/callback'
            return 200, {}, {'access_token': 'synthetic-access-' + current['username'], 'token_type': 'Bearer', 'expires_in': 300, 'refresh_token': 'synthetic-refresh-' + current['username']}
        refreshes.append(data['refresh_token'])
        return 200, {}, {'access_token': 'synthetic-new-access', 'token_type': 'Bearer', 'expires_in': 300, 'refresh_token': 'synthetic-rotated-refresh'}
    raise AssertionError('Unexpected provider endpoint: ' + url)

app = FastAPI()
app.include_router(oauth.router)
app.dependency_overrides[current_user] = lambda: dict(current)
client = TestClient(app, base_url='http://localhost:3000')
try:
    mcp.ensure_schema(); oauth.ensure_schema(); storage.ensure_schema()
    with _connect() as db:
        for username in (alice, bob):
            db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES(%s,%s,false)', (username, 'unused-synthetic-password'))
            db.execute('INSERT INTO bob_user_profiles(username,display_name) VALUES(%s,%s)', (username, 'Synthetic fixture'))
            # Authentication should not seed defaults or create remote objects.
            db.execute('INSERT INTO bob_storage_users(username) VALUES(%s)', (username,))
        for session_token, owner in [('synthetic-session-alice', alice), ('synthetic-other-session', alice), ('synthetic-session-bob', bob)]:
            db.execute('INSERT INTO sessions(token_hash,username,expires) VALUES(%s,%s,%s)', (oauth.digest(session_token), owner, int(time.time()) + 900))
    definition = mcp.Template(id=template_id, name='Synthetic OAuth fixture', url='https://synthetic-resource.example/mcp', auth_mode='oauth', groups=['company'])
    mcp.save_template(definition, alice)
    with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'http://localhost:3000'}), patch('app.mcp_oauth.http_request', side_effect=provider):
        client.cookies.set(COOKIE, 'synthetic-session-alice')
        response = client.get('/mcp-oauth/' + template_id + '/start', follow_redirects=False)
        assert response.status_code == 302, response.text
        query = parse_qs(urlsplit(response.headers['location']).query)
        assert query['code_challenge_method'] == ['S256'] and query['resource'] == [definition.url]
        state = query['state'][0]
        with _connect() as db:
            row = db.execute('SELECT payload FROM bob_mcp_oauth_states WHERE state_hash=%s', (oauth.digest(state),)).fetchone()
        expected = base64.urlsafe_b64encode(hashlib.sha256(row[0]['verifier'].encode()).digest()).decode().rstrip('=')
        assert query['code_challenge'] == [expected]
        # A different session cannot consume this state; the original can still finish.
        client.cookies.set(COOKIE, 'synthetic-other-session')
        failed = client.get('/mcp-oauth/callback', params={'state': state, 'code': 'synthetic-code'})
        assert popup_status(failed) == 'error' and 'invalid or expired' in failed.text
        client.cookies.set(COOKIE, 'synthetic-session-alice')
        # callback calls current_user directly; patch it instead of only dependency override.
        async def fixture_user(request):
            return dict(current)
        with patch('app.mcp_oauth.current_user', side_effect=fixture_user):
            completed = client.get('/mcp-oauth/callback', params={'state': state, 'code': 'synthetic-code', 'iss': 'https://synthetic-auth.example'})
            assert popup_status(completed) == 'success', completed.text
            assert 'synthetic-access-' not in completed.text
            assert completed.headers['cache-control'] == 'no-store'
            assert popup_status(client.get('/mcp-oauth/callback', params={'state': state, 'code': 'synthetic-code'})) == 'error'
        assert oauth.access_token(alice, template_id, definition.model_dump()) == 'synthetic-access-' + alice
        assert oauth.access_token(bob, template_id, definition.model_dump()) is None
        public = oauth.status(alice, template_id, definition.model_dump())
        assert public['connected'] and 'access_token' not in public and 'refresh_token' not in public
        current['username'] = bob
        client.cookies.set(COOKIE, 'synthetic-session-bob')
        bob_start = client.get('/mcp-oauth/' + template_id + '/start', follow_redirects=False)
        bob_state = parse_qs(urlsplit(bob_start.headers['location']).query)['state'][0]
        with patch('app.mcp_oauth.current_user', side_effect=fixture_user):
            assert popup_status(client.get('/mcp-oauth/callback', params={'state': bob_state, 'code': 'synthetic-bob-code'})) == 'success'
        assert oauth.access_token(bob, template_id, definition.model_dump()) == 'synthetic-access-' + bob
        assert oauth.access_token(alice, template_id, definition.model_dump()) == 'synthetic-access-' + alice
        current['username'] = alice
        client.cookies.set(COOKIE, 'synthetic-session-alice')
        # Expiring tokens refresh once with the private owner's refresh token.
        with _connect() as db:
            db.execute("UPDATE bob_mcp_oauth_tokens SET record=jsonb_set(record,'{expires_at}',%s::jsonb) WHERE username=%s AND template_id=%s", (json.dumps(int(time.time()) - 1), alice, template_id))
        assert oauth.access_token(alice, template_id, definition.model_dump()) == 'synthetic-new-access'
        expired_start = client.get('/mcp-oauth/' + template_id + '/start', follow_redirects=False)
        expired_state = parse_qs(urlsplit(expired_start.headers['location']).query)['state'][0]
        with _connect() as db:
            db.execute('UPDATE bob_mcp_oauth_states SET expires=0 WHERE state_hash=%s', (oauth.digest(expired_state),))
        with patch('app.mcp_oauth.current_user', side_effect=fixture_user):
            assert 'invalid or expired' in client.get('/mcp-oauth/callback', params={'state': expired_state, 'code': 'synthetic-expired-code'}).text
        assert refreshes == ['synthetic-refresh-' + alice]
        with _connect() as db:
            rotated = db.execute('SELECT record FROM bob_mcp_oauth_tokens WHERE username=%s AND template_id=%s', (alice, template_id)).fetchone()[0]
        assert rotated['refresh_token'] == 'synthetic-rotated-refresh'
        # Cancelling a new login leaves a prior saved connection intact.
        new = client.get('/mcp-oauth/' + template_id + '/start', follow_redirects=False)
        new_state = parse_qs(urlsplit(new.headers['location']).query)['state'][0]
        with patch('app.mcp_oauth.current_user', side_effect=fixture_user):
            denied = client.get('/mcp-oauth/callback', params={'state': new_state, 'error': 'access_denied', 'error_description': 'provider-secret'})
        assert popup_status(denied) == 'error' and 'provider-secret' not in denied.text
        assert oauth.access_token(alice, template_id, definition.model_dump()) == 'synthetic-new-access'
        # Changed resource and grants never reuse an old owner's bearer token.
        changed = definition.model_copy(update={'access_mode': 'users', 'users': [bob]})
        mcp.save_template(changed, alice)
        assert oauth.access_token(alice, template_id, changed.model_dump()) is None
        assert oauth.access_token(bob, template_id, changed.model_dump()) == 'synthetic-access-' + bob
        changed = changed.model_copy(update={'url': 'https://changed-synthetic-resource.example/mcp'})
        mcp.save_template(changed, alice)
        assert not oauth.status(alice, template_id, changed.model_dump())['connected']
        oauth.disconnect(alice, template_id)
        # Isolate a synthetic catalogue row while validating the real built-in
        # adapter definition. Never overwrite the shared Keycloak preset.
        native_definition = mcp.Template(id='keycloak', name='Synthetic Keycloak fixture', auth_mode='keycloak',
                                         transport='stdio', command='python3', args=['-m', 'app.mcp_keycloak'],
                                         url='https://synthetic-keycloak.example/realms/work', oauth_client_id='buddy-readonly', groups=['company'])
        from psycopg.types.json import Jsonb
        with _connect() as db:
            db.execute('INSERT INTO bob_mcp_catalog(id,definition) VALUES(%s,%s)', (native_template_id, Jsonb(native_definition.model_dump())))
        native_start = oauth.create_start(alice, 'synthetic-session-alice', native_template_id, 'http://localhost:3000')
        native_query = parse_qs(urlsplit(native_start).query)
        assert native_query['scope'] == ['openid'] and 'resource' not in native_query
        oauth.complete(alice, 'synthetic-session-alice', native_query['state'][0], 'synthetic-native-code')
        native_config = mcp.allowed_connections(alice)['catalog-' + native_template_id]
        assert native_config['command'] == 'python3' and native_config['args'] == ['-m', 'app.mcp_keycloak']
        assert native_config['env']['BOB_KEYCLOAK_MCP_TOKEN'] == 'synthetic-keycloak-private-token'
        assert native_config['env']['BOB_KEYCLOAK_MCP_ISSUER'] == native_definition.url
        assert 'Authorization' not in native_config.get('headers', {})
        assert oauth.access_token(bob, native_template_id, native_definition.model_dump()) is None
        oauth.disconnect(alice, native_template_id)
        assert 'catalog-' + native_template_id not in mcp.allowed_connections(alice)
    print('PASS synthetic OAuth popup: PKCE, session binding, callback one-use, private tokens, refresh rotation, cancelled-login preservation, grant revocation and endpoint invalidation')
    print('PASS native Keycloak OAuth: realm discovery, public PKCE client, openid-only scope, no MCP resource, private adapter token env and disconnect')
finally:
    oauth.invalidate_template(template_id)
    oauth.invalidate_template(native_template_id)
    with _connect() as db:
        db.execute('DELETE FROM bob_mcp_catalog WHERE id=ANY(%s)', ([template_id, native_template_id],))
        db.execute('DELETE FROM bob_access_audit WHERE actor=ANY(%s)', ([alice, bob],))
        db.execute('DELETE FROM bob_user_profiles WHERE username=ANY(%s)', ([alice, bob],))
        db.execute('DELETE FROM sessions WHERE username=ANY(%s)', ([alice, bob],))
        db.execute('DELETE FROM bob_storage_files WHERE username=ANY(%s)', ([alice, bob],))
        db.execute('DELETE FROM bob_storage_users WHERE username=ANY(%s)', ([alice, bob],))
        db.execute('DELETE FROM users WHERE username=ANY(%s)', ([alice, bob],))
    print('Synthetic OAuth fixtures cleaned up')
