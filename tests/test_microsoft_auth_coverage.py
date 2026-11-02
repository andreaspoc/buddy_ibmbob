"""Microsoft OAuth rejects unbound callbacks and keeps tokens private."""
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException, Response
from starlette.requests import Request
from app import microsoft_auth as auth


def request(cookie=b''):
    return Request({'type':'http', 'method':'GET', 'path':'/', 'scheme':'https', 'server':('test',443), 'headers':[(b'host',b'test'), (b'cookie',cookie)]})


class MicrosoftAuthCoverageTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_never_returns_token_and_reports_missing_permissions(self):
        with patch.object(auth, 'current_user', AsyncMock(return_value={'username':'alice'})), patch.object(auth, '_user_token_file', return_value=Path('/tmp/fake')), patch.object(auth.storage, 'read_user_file', return_value=b'{"access_token":"secret","scope":"User.Read https://graph.microsoft.com/Sites.Read.All"}'):
            result = await auth.microsoft_status(request())
        self.assertTrue(result['connected'])
        self.assertIn('Sites.Read.All', result['scopes'])
        self.assertIn('Chat.Read', result['missing_scopes'])
        self.assertNotIn('secret', str(result))
        with patch.object(auth, 'current_user', AsyncMock(side_effect=HTTPException(401))):
            self.assertFalse((await auth.microsoft_status(request()))['signed_in'])
        with patch.object(auth, 'current_user', AsyncMock(return_value={'username':'alice'})), patch.object(auth, '_user_token_file', return_value=Path('/tmp/fake')), patch.object(auth.storage, 'read_user_file', return_value=b'invalid'):
            self.assertFalse((await auth.microsoft_status(request()))['connected'])

    async def test_callback_rejects_invalid_state_without_contacting_provider(self):
        with patch.object(auth, 'current_user', AsyncMock(return_value={'username':'alice'})), patch.object(auth, '_verify_state', return_value=False), patch.object(auth.httpx, 'AsyncClient') as client:
            result = await auth.microsoft_callback(request(), Response(), code='code', state='invalid', error=None, error_description=None)
        self.assertIn('Invalid+or+expired', result.headers['location'])
        client.assert_not_called()

    async def test_callback_records_tokens_only_after_valid_state(self):
        token = MagicMock(status_code=200); token.json.return_value = {'access_token':'synthetic', 'refresh_token':'refresh', 'scope':'User.Read'}
        profile = MagicMock(status_code=200); profile.json.return_value = {'mail':'alice@example.test', 'displayName':'Alice'}
        client = MagicMock(); client.post = AsyncMock(return_value=token); client.get = AsyncMock(return_value=profile)
        manager = MagicMock(); manager.__aenter__ = AsyncMock(return_value=client); manager.__aexit__ = AsyncMock(return_value=None)
        with patch.object(auth, 'current_user', AsyncMock(return_value={'username':'alice'})), patch.object(auth, '_verify_state', return_value=True), patch.object(auth.httpx, 'AsyncClient', return_value=manager), patch.object(auth, '_user_token_file', return_value=Path('/tmp/fake')), patch.object(auth.storage, 'write_user_file') as save, patch.object(auth, 'user_root', return_value=Path('/tmp')), patch.object(auth, 'select_root'), patch.object(auth, 'ensure_microsoft_mcp') as register:
            result = await auth.microsoft_callback(request(), Response(), code='code', state='valid', error=None, error_description=None)
        self.assertEqual(result.headers['location'], '/?microsoft=connected')
        save.assert_called_once(); register.assert_called_once()
        self.assertNotIn('synthetic', str(result.headers))
