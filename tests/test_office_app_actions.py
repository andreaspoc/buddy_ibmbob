"""Synthetic fixtures for identity-bound Office actions and service capabilities."""
import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import office_actions as actions
from app import office_action_client as transport
from app.office_app_actions import router


class OfficeActionsTests(unittest.IsolatedAsyncioTestCase):
    def test_models_reject_identity_and_path_scope(self):
        for model, values in [(actions.ListFiles, {'username': 'bob'}),
                              (actions.ImportFile, {'path': 'a.docx', 'session_id': 'other'}),
                              (actions.CreateDocument, {'name': 'a.html', 'content': 'test', 'username': 'bob'})]:
            with self.assertRaises(ValidationError):
                model.model_validate(values)

    async def test_disabled_and_writes_require_authenticated_turn(self):
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '0'}):
            self.assertEqual(actions.tools(), [])
            with self.assertRaises(RuntimeError):
                await actions.dispatch('alice', 'office_list', {}, {})
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}):
            with self.assertRaises(PermissionError):
                await actions.dispatch('alice', 'office_create', {'name': 'a.html', 'content': 'test'}, {})

    async def test_saved_chat_uses_real_history_helper_then_opens(self):
        file_id = str(uuid4())
        emit = AsyncMock()
        ctx = {'username': 'alice', 'workspace_id': 'a' * 32, 'assistant_message_id': 'reply', 'emit': emit}
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}), \
             patch('app.conversation_office_export.export_chat', new=AsyncMock(return_value=('Chat.docx', b'fixture-docx'))) as export, \
             patch.object(transport, 'office_request', new=AsyncMock(return_value={'id': file_id, 'name': 'Chat.docx'})) as save:
            result = await actions.dispatch('alice', 'office_save_chat', {'format': 'docx'}, ctx)
        export.assert_awaited_once_with('alice', 'a' * 32, 'docx')
        self.assertTrue(result['saved'])
        self.assertEqual(save.call_args.args[:2], ('alice', 'save_chat'))
        self.assertEqual(len(save.call_args.args[2]['action_key']), 64)
        self.assertEqual(emit.await_args_list[-1].args[0], {'type': 'app_action', 'action': 'office_open', 'file_id': file_id, 'name': 'Chat.docx'})

    async def test_open_only_after_read_authorized_and_close_event(self):
        file_id = str(uuid4())
        emit = AsyncMock()
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}), patch.object(transport, 'office_request', new=AsyncMock(side_effect=PermissionError)):
            with self.assertRaises(PermissionError):
                await actions.dispatch('alice', 'office_open', {'file_id': file_id}, {'emit': emit})
        emit.assert_not_awaited()
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}):
            self.assertEqual(await actions.dispatch('alice', 'office_close', {}, {'emit': emit}), {'closed': True})
        emit.assert_awaited_once_with({'type': 'app_action', 'action': 'office_close'})

    async def test_remote_identity_is_signed_and_secret_not_sent(self):
        secret = 'synthetic-secret-' * 3
        response = type('Response', (), {'status_code': 200, 'json': lambda self: {'items': []}})()
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.post.return_value = response
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1', 'BUDDY_OFFICE_PLUGIN_URL': 'http://office', 'OFFICE_JWT_SECRET': secret}), \
             patch.object(transport.httpx, 'AsyncClient', return_value=client):
            await transport.office_request('alice', 'folders', {})
        call = client.post.call_args
        token = call.kwargs['headers']['Authorization'].removeprefix('Bearer ')
        claims = jwt.decode(token, secret, algorithms=['HS256'], audience='buddy-office-actions')
        self.assertEqual(claims['sub'], 'alice')
        self.assertEqual(claims['exp'] - claims['iat'], 60)
        self.assertEqual(claims['body_sha256'], hashlib.sha256(call.kwargs['content']).hexdigest())
        self.assertNotIn(secret, str(call))


class OfficeEndpointTests(unittest.TestCase):
    def setUp(self):
        self.secret = 'synthetic-office-secret-' * 2
        self.env = patch.dict(os.environ, {'OFFICE_JWT_SECRET': self.secret})
        self.env.start()
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def tearDown(self):
        self.env.stop()

    def headers(self, raw, **overrides):
        now = int(time.time())
        claims = {'sub': 'alice', 'aud': 'buddy-office-actions', 'iat': now, 'exp': now + 60,
                  'body_sha256': hashlib.sha256(raw).hexdigest(), **overrides}
        return {'Authorization': 'Bearer ' + jwt.encode(claims, self.secret, algorithm='HS256')}

    def test_cookie_alone_wrong_audience_expiry_and_body_tampering_denied(self):
        raw = transport.encode_payload('folders', {})
        self.assertEqual(self.client.post('/api/office/app-actions', content=raw, cookies={'bob_session': 'fixture'}).status_code, 401)
        for overrides in [{'aud': 'office-source'}, {'exp': int(time.time()) - 1}, {'exp': int(time.time()) + 1000}]:
            self.assertEqual(self.client.post('/api/office/app-actions', content=raw, headers=self.headers(raw, **overrides)).status_code, 401)
        self.assertEqual(self.client.post('/api/office/app-actions', content=raw + b' ', headers=self.headers(raw)).status_code, 401)

    def test_write_receipt_serializes_retry_and_checks_content(self):
        from buddy_office import office_app_actions as endpoint, office
        from app import job_queue
        db = MagicMock()
        db.__enter__.return_value = db
        key = 'a' * 64
        args = {'name': 'fixture.html', 'content': '<p>fixture</p>', 'action_key': key}
        digest = hashlib.sha256(json.dumps(['save', {k: v for k, v in args.items() if k != 'action_key'}], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        db.execute.return_value.fetchone.return_value = {'digest': digest, 'result': {'id': 'fixture-id'}}
        with patch.object(office, 'ensure_schema'), patch.object(job_queue, '_connect', return_value=db), patch.object(endpoint, '_execute') as write:
            self.assertEqual(endpoint.execute('alice', 'save', args), {'id': 'fixture-id'})
            write.assert_not_called()
            with self.assertRaises(ValueError):
                endpoint.execute('alice', 'save', {**args, 'content': 'different'})
        self.assertIn(('alice', key), [call.args[1] for call in db.execute.call_args_list if len(call.args) > 1])

    def test_chat_retry_returns_original_snapshot_for_same_intent(self):
        from buddy_office import office_app_actions as endpoint, office
        from app import job_queue
        db = MagicMock()
        db.__enter__.return_value = db
        intent = 'b' * 64
        args = {'name': 'Chat.pdf', 'content_base64': 'YQ==', 'folder_id': None, 'action_key': 'a' * 64, 'intent_digest': intent}
        digest = hashlib.sha256(json.dumps(['save_chat', {'intent_digest': intent, 'name': 'Chat.pdf', 'folder_id': None}], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        db.execute.return_value.fetchone.return_value = {'digest': digest, 'result': {'id': 'initial-snapshot'}}
        with patch.object(office, 'ensure_schema'), patch.object(job_queue, '_connect', return_value=db), patch.object(endpoint, '_execute') as write:
            self.assertEqual(endpoint.execute('alice', 'save_chat', {**args, 'content_base64': 'YmI='}), {'id': 'initial-snapshot'})
            write.assert_not_called()
            for change in [{'name': 'Changed.pdf'}, {'intent_digest': 'c' * 64}]:
                with self.assertRaises(ValueError):
                    endpoint.execute('alice', 'save_chat', {**args, **change})

    def test_valid_capability_fixes_owner_and_allows_only_its_body(self):
        raw = transport.encode_payload('folders', {})
        with patch('buddy_office.office_app_actions.execute', return_value={'items': []}) as execute:
            response = self.client.post('/api/office/app-actions', content=raw, headers=self.headers(raw))
        self.assertEqual(response.status_code, 200)
        execute.assert_called_once_with('alice', 'folders', {})


if __name__ == '__main__':
    unittest.main()
