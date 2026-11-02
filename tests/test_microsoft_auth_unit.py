"""Microsoft account status and sign-in initiation with no external account."""
import json
import unittest
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app import microsoft_auth as auth


class MicrosoftAuthTests(unittest.IsolatedAsyncioTestCase):
    def request(self, cookies=None):
        return SimpleNamespace(headers={'host': 'buddy.example'}, url=SimpleNamespace(scheme='https'), cookies=cookies or {})

    async def test_status_never_requires_a_signed_in_session(self):
        with patch.dict('os.environ', {'AZURE_CLIENT_ID': 'fixture'}, clear=True), \
             patch.object(auth, 'current_user', AsyncMock(side_effect=HTTPException(401))), \
             patch.object(auth.storage, 'read_user_file') as read:
            result = await auth.microsoft_status(self.request())
        self.assertTrue(result['configured'])
        self.assertFalse(result['signed_in'])
        read.assert_not_called()

    async def test_status_handles_missing_corrupt_and_valid_tokens(self):
        for content, connected in ((None, False), (b'not-json', False),
                                   (json.dumps({'access_token': 'fixture', 'account': 'a@example.test', 'scope': 'User.Read'}).encode(), True)):
            with self.subTest(content=content), patch.object(auth, 'current_user', AsyncMock(return_value={'username': 'alice'})), \
                 patch.object(auth, '_user_token_file', return_value='/fixture/token'), \
                 patch.object(auth.storage, 'read_user_file', return_value=content):
                result = await auth.microsoft_status(self.request())
                self.assertTrue(result['signed_in'])
                self.assertEqual(result['connected'], connected)
                if connected:
                    self.assertEqual(result['account'], 'a@example.test')
                    self.assertNotIn('access_token', result)

    async def test_login_requires_browser_session_and_configuration(self):
        with patch.object(auth, 'current_user', AsyncMock(return_value={'username': 'alice'})), \
             patch.dict('os.environ', {}, clear=True):
            with self.assertRaises(HTTPException) as error:
                await auth.microsoft_login(self.request(), False)
            self.assertEqual(error.exception.status_code, 401)
            result = await auth.microsoft_login(self.request({auth.COOKIE: 'session'}), False)
            self.assertEqual(result.status_code, 503)

    async def test_login_binds_state_and_uses_secure_cookie(self):
        request = self.request({auth.COOKIE: 'session'})
        with patch.object(auth, 'current_user', AsyncMock(return_value={'username': 'alice'})), \
             patch.object(auth, '_create_state', return_value='fixture-state') as create, \
             patch.dict('os.environ', {'AZURE_CLIENT_ID': 'fixture', 'AZURE_TENANT_ID': 'tenant'}, clear=True):
            response = await auth.microsoft_login(request, False)
        query = parse_qs(urlsplit(response.headers['location']).query)
        self.assertEqual(query['state'], ['fixture-state'])
        self.assertEqual(query['redirect_uri'], ['https://buddy.example/auth/microsoft/callback'])
        self.assertEqual(create.call_args.args[:2], ('alice', 'session'))
        self.assertIn('Secure', response.headers['set-cookie'])
        self.assertEqual(response.headers['cache-control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
