"""Exercise callback, account isolation and replay rejection with real PostgreSQL and signed test tokens."""
import asyncio
import json
import os
import time
import uuid
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs
import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from app.main import app
from app import keycloak_auth as kc
from app.auth import _connect

subject = 'integration-' + uuid.uuid4().hex
realm = 'https://identity.test/realms/company'
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())); jwk.update({'kid':'test','use':'sig','alg':'RS256'})
username = None
state_hash = None
nonce = None
config = {'issuer':realm,'authorization_endpoint':realm+'/protocol/openid-connect/auth','token_endpoint':realm+'/protocol/openid-connect/token','jwks_uri':realm+'/protocol/openid-connect/certs'}
class IdentityClient:
    def __init__(self, *args, **kwargs): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def get(self, url):
        return httpx.Response(200,json={'keys':[jwk]} if url.endswith('/certs') else config,request=httpx.Request('GET',url))
    async def post(self, url, data):
        assert data['code_verifier'] and data['client_secret'] == 'test-secret'
        token = jwt.encode({'iss':realm,'sub':subject,'aud':'buddy','iat':int(time.time()),'exp':int(time.time())+120,'nonce':nonce,'preferred_username':'admin','given_name':'Test','family_name':'Person'},key,algorithm='RS256',headers={'kid':'test'})
        return httpx.Response(200,json={'id_token':token},request=httpx.Request('POST',url))
try:
    with patch.dict(os.environ,{'KEYCLOAK_ISSUER':realm,'KEYCLOAK_CLIENT_ID':'buddy','KEYCLOAK_CLIENT_SECRET':'test-secret','BOB_LOCAL_LOGIN_ENABLED':'0'}), patch.object(kc.httpx,'AsyncClient',IdentityClient):
        client = TestClient(app)
        return_path = '/shared/' + 'a' * 32 + '/' + 'b' * 43
        response = client.get('/auth/keycloak/login',params={'next':return_path},follow_redirects=False)
        assert response.status_code == 302
        params = parse_qs(urlsplit(response.headers['location']).query)
        state, nonce = params['state'][0], params['nonce'][0]
        state_hash = kc.hashlib.sha256(state.encode()).hexdigest()
        assert params['code_challenge_method'] == ['S256']
        assert TestClient(app).get('/auth/keycloak/callback?code=test&state=wrong',follow_redirects=False).headers['location'].startswith('/?keycloak_error=')
        response = client.get('/auth/keycloak/callback',params={'code':'test','state':state},follow_redirects=False)
        assert response.headers['location'] == return_path
        assert 'bob_ui_session=' in response.headers['set-cookie']
        assert 'SameSite=lax' in response.headers['set-cookie']
        status = client.get('/auth/status').json()
        username = status['user']['username']
        assert username.startswith('kc-') and username != 'admin'
        assert status['user']['display_name'] == 'Test Person'
        updated = kc.resolve_identity({'sub':subject,'given_name':'Updated','family_name':'Person'})
        assert updated['username'] == username
        assert client.get('/auth/status').json()['user']['display_name'] == 'Updated Person'
        from app.personalization import user_context
        assert 'Updated Person' in user_context(username)
        assert 'kc-' not in user_context(username)
        assert status['local_login_enabled'] is False
        assert client.post('/auth/login',json={'username':'admin','password':'unused'}).status_code == 403
        assert client.get('/auth/keycloak/callback',params={'code':'test','state':state},follow_redirects=False).headers['location'].startswith('/?keycloak_error=')
        client.post('/auth/logout')
        assert client.get('/auth/status').json()['user'] is None
        assert client.get('/auth/microsoft/login').status_code == 401
    print('Keycloak callback, validated session, account isolation, replay rejection, logout and Office auth checks passed')
finally:
    with _connect() as db:
        if state_hash: db.execute('DELETE FROM bob_keycloak_flows WHERE state_hash=%s',(state_hash,))
        row = db.execute('DELETE FROM bob_keycloak_identities WHERE issuer=%s AND subject=%s RETURNING username',(realm,subject)).fetchone()
        if row:
            username = row[0]
            db.execute('DELETE FROM sessions WHERE username=%s',(username,))
            for table in ('bob_storage_files','bob_storage_users'):
                db.execute('DELETE FROM '+table+' WHERE username=%s',(username,))
            db.execute('DELETE FROM bob_user_profiles WHERE username=%s',(username,))
            db.execute('DELETE FROM users WHERE username=%s',(username,))
