"""Core-to-Office contracts preserve auth and correlation without local Office code."""
import os
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch
from uuid import uuid4

import httpx
from starlette.requests import Request
from fastapi import HTTPException
from app import plugin_client


class OfficeClientContracts(IsolatedAsyncioTestCase):
    async def test_context_preserves_session_and_correlation_and_file_ids(self):
        file_id = uuid4()
        async def upstream(request):
            self.assertEqual(request.headers['cookie'], 'bob_ui_session=original')
            self.assertEqual(request.headers['host'], 'buddy.example')
            self.assertEqual(request.headers['origin'], 'https://buddy.example')
            self.assertEqual(request.headers['x-correlation-id'], 'original-correlation')
            self.assertEqual(request.headers['idempotency-key'], 'original-turn')
            import json
            self.assertEqual(json.loads(await request.aread()), {'file_ids': [str(file_id)]})
            return httpx.Response(200, json={'context': 'immutable evidence', 'references': [{'id': str(file_id), 'revision': 3}]})
        request = Request({'type': 'http', 'headers': [(b'host', b'buddy.example'),
            (b'origin', b'https://buddy.example'), (b'cookie', b'bob_ui_session=original'),
            (b'x-correlation-id', b'original-correlation'), (b'idempotency-key', b'original-turn')]})
        factory = httpx.AsyncClient
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1', 'BUDDY_OFFICE_PLUGIN_URL': 'http://office:8080'}), \
                patch.object(plugin_client.httpx, 'AsyncClient', side_effect=lambda **kwargs: factory(transport=httpx.MockTransport(upstream), **kwargs)):
            context, references = await plugin_client.office_context(request, 'owner', [file_id])
        self.assertEqual(context, 'immutable evidence')
        self.assertEqual(references[0]['id'], str(file_id))

    async def test_disabled_office_fails_before_importing_feature_package(self):
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '0'}):
            with self.assertRaises(HTTPException) as error:
                await plugin_client.save_office_file(Request({'type': 'http', 'headers': []}), 'owner', 'file.pdf', b'pdf')
            self.assertEqual(error.exception.status_code, 503)

    async def test_remote_research_export_preserves_file_bytes_and_auth(self):
        async def upstream(request):
            self.assertEqual(request.url.path, '/api/office/files')
            self.assertEqual(request.headers['authorization'], 'Bearer original-session')
            self.assertEqual(request.headers['x-chat-id'], 'original-conversation')
            body = await request.aread()
            self.assertIn(b'filename="report.pdf"', body)
            self.assertIn(b'%PDF-original-bytes', body)
            return httpx.Response(200, json={'id': 'existing-contract'})
        request = Request({'type': 'http', 'headers': [(b'host', b'buddy.example'),
            (b'authorization', b'Bearer original-session'), (b'x-chat-id', b'original-conversation')]})
        factory = httpx.AsyncClient
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1', 'BUDDY_OFFICE_PLUGIN_URL': 'http://office:8080'}), \
                patch.object(plugin_client.httpx, 'AsyncClient', side_effect=lambda **kwargs: factory(transport=httpx.MockTransport(upstream), **kwargs)):
            result = await plugin_client.save_office_file(request, 'owner', 'report.pdf', b'%PDF-original-bytes')
        self.assertEqual(result['id'], 'existing-contract')
