"""Email note ownership and actual MIME construction; no network submissions."""
import unittest
from unittest.mock import patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import note_exports, smtp_settings
from app.auth import current_user


class NoteEmailTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(note_exports.router)
        app.dependency_overrides[current_user] = lambda: {'username': 'owner'}
        self.client = TestClient(app)

    def test_attachment_and_owner_scope(self):
        row = {'title': 'Ελληνικά / note', 'body': '**Content**\n- item', 'tags': ['tag']}
        config = smtp_settings.SMTPSettings(enabled=True, host='mail.example.com', from_address='sender@example.com').model_dump()
        with patch.object(note_exports, 'select_notes', return_value=[row]) as select, patch.object(smtp_settings, 'load_config', return_value=config), patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            response = self.client.post('/api/notes/7/email', json={'to': 'me@example.com'})
            self.assertEqual(response.status_code, 200, response.text)
            select.assert_called_once_with('owner', '7')
            smtp.send_message.assert_called_once()
            message = smtp.send_message.call_args.args[0]
            attachment, = list(message.iter_attachments())
            self.assertEqual(attachment.get_content_type(), 'text/markdown')
            self.assertEqual(attachment.get_content_charset(), 'utf-8')
            self.assertEqual(attachment.get_filename(), 'Ελληνικά _ note.md')
            self.assertTrue(attachment.get_content().startswith('# Ελληνικά / note\n'))
            self.assertIn('**Content**\n- item', attachment.get_content())
            self.assertIn('Tags: tag', attachment.get_content())

    def test_invalid_recipient_and_unowned_note_never_send(self):
        with patch.object(smtp_settings, 'send_message') as send, patch.object(note_exports, 'select_notes', side_effect=HTTPException(404, 'Note not found')):
            self.assertEqual(self.client.post('/api/notes/7/email', json={'to': 'invalid'}).status_code, 422)
            self.assertEqual(self.client.post('/api/notes/7/email', json={'to': 'me@example.com'}).status_code, 404)
            send.assert_not_called()

    def test_disabled_smtp_returns_actionable_error(self):
        with patch.object(note_exports, 'select_notes', return_value=[{'title': 'Note', 'body': 'Content'}]), patch.object(smtp_settings, 'load_config', return_value=smtp_settings.SMTPSettings().model_dump()):
            response = self.client.post('/api/notes/7/email', json={'to': 'me@example.com'})
            self.assertEqual(response.status_code, 400)
            self.assertIn('administrator', response.json()['detail'])
