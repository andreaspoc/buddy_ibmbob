import hashlib
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request
from app.auth import COOKIE, current_user


def request(headers=None):
    return Request({'type': 'http', 'headers': [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]})


class SessionBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_key_cannot_authenticate_or_bootstrap(self):
        for headers in ({'Authorization': 'Bearer provider-secret'}, {'x-api-key': 'provider-secret'}, {'Cookie': f'{COOKIE}=provider-secret'}):
            with self.subTest(headers=headers), patch.dict(os.environ, {'BOB_API_KEY': 'provider-secret'}), patch('app.auth._connect') as connect, patch('app.auth.create_user') as create:
                db = connect.return_value.__enter__.return_value
                db.execute.return_value.fetchone.return_value = None
                with self.assertRaises(HTTPException) as error:
                    await current_user(request(headers))
                self.assertEqual(error.exception.status_code, 401)
                create.assert_not_called()
                self.assertIn('FROM sessions', db.execute.call_args.args[0])

    async def test_valid_sessions_resolve_only_their_owner(self):
        for headers in ({'Authorization': 'Bearer session-secret'}, {'x-api-key': 'session-secret'}, {'Cookie': f'{COOKIE}=session-secret'}):
            with self.subTest(headers=headers), patch('app.auth._connect') as connect, patch('app.auth.user_profile', return_value={'username': 'alice', 'is_admin': False}), patch('app.sessions.user_root', return_value='/tmp/alice') as root, patch('app.workspace_config.select_root') as select:
                db = connect.return_value.__enter__.return_value
                db.execute.return_value.fetchone.return_value = ('alice', False)
                self.assertEqual((await current_user(request(headers)))['username'], 'alice')
                self.assertEqual(db.execute.call_args.args[1][0], hashlib.sha256(b'session-secret').hexdigest())
                self.assertIn('expires >', db.execute.call_args.args[0])
                root.assert_called_once_with('alice', create=True)
                select.assert_called_once_with('/tmp/alice')

    def test_end_session_invalidates_cookie_bearer_and_api_key(self):
        from starlette.responses import Response
        from app.auth import end_session
        for headers in ({'Authorization': 'Bearer session-secret'}, {'x-api-key': 'session-secret'}, {'Cookie': f'{COOKIE}=session-secret'}):
            with self.subTest(headers=headers), patch('app.auth._connect') as connect:
                db = connect.return_value.__enter__.return_value
                response = Response()
                end_session(request(headers), response)
                db.execute.assert_called_once()
                self.assertIn('DELETE FROM sessions', db.execute.call_args.args[0])
                self.assertEqual(db.execute.call_args.args[1][0], hashlib.sha256(b'session-secret').hexdigest())


if __name__ == '__main__':
    unittest.main()
