"""Document download transport keeps identity fixed and returns private attachments."""
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import conversation_sharing as sharing


class VisualExportRouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(sharing.router)
        app.dependency_overrides[sharing.current_user] = lambda: {'username': 'fixture-owner'}
        self.client = TestClient(app)

    def test_attachment_format_and_server_owner(self):
        for fmt, media in [('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), ('pdf', 'application/pdf')]:
            with patch('app.conversation_office_export.export_chat', new=AsyncMock(return_value=('Flow & table.' + fmt, b'synthetic-export'))) as render:
                result = self.client.get('/sessions/' + 'a'*32 + '/export', params={'format': fmt, 'content': 'latest_answer', 'username': 'other'})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers['content-type'], media)
            self.assertEqual(result.headers['cache-control'], 'private, no-store')
            self.assertEqual(result.headers['x-content-type-options'], 'nosniff')
            self.assertIn('Flow%20%26%20table.', result.headers['content-disposition'])
            render.assert_awaited_once_with('fixture-owner', 'a'*32, fmt, content='latest_answer')

    def test_unauthorized_and_failed_render_never_return_document(self):
        for code in (404, 413, 503):
            with patch('app.conversation_office_export.export_chat', new=AsyncMock(side_effect=HTTPException(code, 'Fixture failure'))):
                result = self.client.get('/sessions/' + 'b'*32 + '/export?format=pdf')
            self.assertEqual(result.status_code, code)
            self.assertNotIn('content-disposition', result.headers)
