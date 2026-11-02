"""Saved conversation exports retain only the owner's persisted, undeleted text."""
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from app.conversation_office_export import saved_chat


class ConversationOfficeExportTests(unittest.TestCase):
    def export(self, events, content='conversation', record=None):
        with patch('app.conversation_office_export.sessions.get_session', return_value=record or {'title': 'A conversation'}), \
             patch('app.conversation_office_export.sessions.read_history', return_value=events):
            return saved_chat('owner', 'session-1', content)

    def test_snapshot_distinguishes_partial_completed_replaced_and_deleted_content(self):
        events = [
            {'type': 'request', 'display_prompt': 'First question'},
            {'type': 'delta', 'text': 'old response'},
            {'type': 'delta', 'text': 'final response', 'replace': True}, {'type': 'done'},
            {'type': 'request', 'prompt': 'Second question'},
            {'type': 'delta', 'text': 'unfinished answer'}, {'type': 'error'},
            {'type': 'request', 'prompt': 'Removed prompt', 'user_deleted': True, 'assistant_deleted': True},
            {'type': 'delta', 'text': 'deleted secret'}, {'type': 'done'},
        ]
        body = self.export(events)['body']
        self.assertIn('First question', body)
        self.assertIn('final response', body)
        self.assertIn('saved partial response (interrupted)', body)
        self.assertNotIn('old response', body)
        self.assertNotIn('deleted secret', body)
        self.assertNotIn('Removed prompt', body)
        latest = self.export(events, 'latest_answer')['body']
        self.assertIn('final response', latest)
        self.assertNotIn('unfinished answer', latest)

    def test_rejects_invalid_or_unavailable_content(self):
        for events, content, record, expected in [
            ([], 'invalid', None, 422),
            ([], 'conversation', None, 422),
            ([{'type':'request', 'prompt':'Q'}, {'type':'delta', 'text':'partial'}], 'latest_answer', None, 422),
            ([{'type':'request', 'prompt':'Q'}], 'conversation', {'purpose':'note_enrichment'}, 422),
            ([{'type':'request', 'prompt':'x' * 200001}], 'conversation', None, 413),
            ([{'type':'request', 'prompt':'Q'}] * 101, 'conversation', None, 413),
        ]:
            with self.subTest(content=content, expected=expected):
                with self.assertRaises(HTTPException) as error:
                    self.export(events, content, record)
                self.assertEqual(error.exception.status_code, expected)
        with patch('app.conversation_office_export.sessions.get_session', side_effect=FileNotFoundError):
            with self.assertRaises(HTTPException) as error:
                saved_chat('owner', 'missing')
            self.assertEqual(error.exception.status_code, 404)


class ConversationOfficeRenderTests(unittest.IsolatedAsyncioTestCase):
    async def test_export_uses_saved_content_and_sanitizes_filename(self):
        from unittest.mock import AsyncMock
        from app.conversation_office_export import export_chat
        row = {'title': 'Plan / review', 'body': 'persisted body'}
        with patch('app.conversation_office_export.saved_chat', return_value=row), \
             patch('app.visual_document_export.render_document', new_callable=AsyncMock, return_value=b'file') as render:
            name, raw = await export_chat('owner', 'session', 'pdf', content='latest_answer')
        self.assertEqual(name, 'Plan _ review - answer.pdf')
        self.assertEqual(raw, b'file')
        render.assert_awaited_once_with('Plan / review', 'persisted body', 'pdf')

    async def test_rejects_unsupported_format(self):
        from app.conversation_office_export import export_chat
        with self.assertRaises(HTTPException) as error:
            await export_chat('owner', 'session', 'exe')
        self.assertEqual(error.exception.status_code, 422)
