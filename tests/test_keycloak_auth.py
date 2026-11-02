import os
import time
import unittest
from unittest.mock import patch
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from app.keycloak_auth import validate_token, configured, local_login_enabled, redirect_uri, profile_name, sign_in_return_path

class KeycloakTests(unittest.TestCase):
    def test_return_to_shared_conversation_after_login(self):
        path = '/shared/' + 'a' * 32 + '/' + 'b' * 43
        self.assertEqual(sign_in_return_path(path), path)
        self.assertEqual(sign_in_return_path('/?conversation=' + 'a' * 32), '/?conversation=' + 'a' * 32)
        for invalid in ('https://example.test', '//example.test', '/\\example.test', '/unrelated', '/\nLocation: evil', 'http://[bad'):
            self.assertEqual(sign_in_return_path(invalid), '/')

    def test_projects_return_path(self):
        self.assertEqual(sign_in_return_path('/projects'), '/projects')
        self.assertEqual(sign_in_return_path('/projects/'), '/projects/')
        self.assertEqual(sign_in_return_path('/projects?conversation=abc'), '/projects?conversation=abc')
        self.assertEqual(sign_in_return_path('/projects/unsafe'), '/')

    def setUp(self):
        self.env = patch.dict(os.environ, {'KEYCLOAK_ISSUER':'https://identity.test/realms/company','KEYCLOAK_CLIENT_ID':'buddy','KEYCLOAK_CLIENT_SECRET':'test-secret','PUBLIC_BASE_URL':'http://localhost:3000','KEYCLOAK_REDIRECT_URI':'','BOB_LOCAL_LOGIN_ENABLED':'0'})
        self.env.start()
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        import json
        self.jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        self.jwk.update({'kid':'test-key','use':'sig','alg':'RS256'})
        self.claims = {'iss':'https://identity.test/realms/company','sub':'subject-123','aud':'buddy','exp':int(time.time())+60,'iat':int(time.time()),'nonce':'expected-nonce'}
    def tearDown(self): self.env.stop()
    def signed(self, changes=None):
        return jwt.encode({**self.claims, **(changes or {})}, self.key, algorithm='RS256', headers={'kid':'test-key'})
    def test_valid_token(self):
        self.assertEqual(validate_token(self.signed(), {'keys':[self.jwk]}, 'expected-nonce')['sub'],'subject-123')
    def test_reject_issuer_audience_expiry_nonce(self):
        for changes in ({'iss':'https://evil.test'},{'aud':'other'},{'exp':int(time.time())-60},{'nonce':'other'},{'azp':'other'}):
            with self.subTest(changes=changes), self.assertRaises(Exception): validate_token(self.signed(changes), {'keys':[self.jwk]}, 'expected-nonce')
    def test_reject_unsigned_or_unknown_key(self):
        with self.assertRaises(Exception): validate_token(jwt.encode(self.claims, '', algorithm='none'), {'keys':[self.jwk]}, 'expected-nonce')
        with self.assertRaises(Exception): validate_token(self.signed(), {'keys':[]}, 'expected-nonce')
    def test_profile_name(self):
        self.assertEqual(profile_name({'given_name':' Alice ', 'family_name':'Smith', 'name':'Other'}), 'Alice Smith')
        self.assertEqual(profile_name({'name':'Alice Smith'}), 'Alice Smith')
        self.assertEqual(profile_name({'preferred_username':'alice'}), 'alice')
        self.assertEqual(profile_name({'given_name':[], 'family_name':None}), '')

    def test_config_and_callback(self):
        self.assertTrue(configured()); self.assertFalse(local_login_enabled())
        self.assertEqual(redirect_uri(),'http://localhost:3000/auth/keycloak/callback')
        with patch.dict(os.environ, {'BOB_LOCAL_LOGIN_ENABLED':'1'}): self.assertTrue(local_login_enabled())

if __name__ == '__main__': unittest.main()
