"""Unit tests for app.presentation_delete utility functions and deletion logic."""
import json
import unittest
from unittest.mock import MagicMock, patch

from app.presentation_delete import (
    _strip_source,
    _artifact_filename,
    _inline_artifact_matches,
    delete_presentation,
)


class PresentationDeleteTests(unittest.TestCase):
    def test_artifact_filename_hashing(self):
        deck = {'title': 'Quarterly Strategy', 'slides': []}
        filename = _artifact_filename(deck)
        self.assertTrue(filename.startswith('presentation-'))
        self.assertTrue(filename.endswith('.bobdeck'))

    def test_strip_source_html(self):
        raw = 'Here is the overview:\n```html\n<!DOCTYPE html><html><body><h1>Slide</h1></body></html>\n```\nDone.'
        clean = _strip_source(raw, html=True)
        self.assertNotIn('<!DOCTYPE html>', clean)
        self.assertNotIn('```html', clean)
        self.assertIn('Here is the overview:', clean)
        self.assertIn('Done.', clean)

    def test_strip_source_bobdeck(self):
        deck = {'title': 'Deck', 'slides': [{'elements': []}]}
        raw = f'Introduction:\n```bobdeck\n{json.dumps(deck)}\n```\nConclusion.'
        clean = _strip_source(raw, html=False)
        self.assertNotIn('```bobdeck', clean)
        self.assertNotIn('"slides"', clean)
        self.assertIn('Introduction:', clean)
        self.assertIn('Conclusion.', clean)

    def test_inline_artifact_matches(self):
        deck = {'title': 'Match Deck', 'slides': []}
        name = _artifact_filename(deck)
        content = f'Some commentary {json.dumps(deck)} trailing text'
        self.assertTrue(_inline_artifact_matches(content, {name}))
        self.assertFalse(_inline_artifact_matches(content, {'other-deck.bobdeck'}))

    def test_delete_presentation_not_found_returns_false(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchall.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.postgres_storage.mutation', return_value=mock_ctx):
            result = delete_presentation('alice', 'session:s1', 'presentation.pptx', 's1')
            self.assertFalse(result)

    def test_delete_presentation_success_html(self):
        mock_db = MagicMock()
        # Conversation history: a request and a delta with HTML presentation
        history_rows = [
            {'id': 1, 'event': {'type': 'request', 'mode': 'presentation', 'presentation_format': 'html'}},
            {'id': 2, 'event': {'type': 'delta', 'text': 'Intro: ```html\n<!DOCTYPE html><html><body><h1>Slide</h1></body></html>\n```'}},
        ]
        # Completed job with events
        job_rows = [{'id': 'job-1', 'payload': {'mode': 'presentation', 'presentation_format': 'html'}}]
        job_events = [
            {'id': 10, 'event': {'type': 'delta', 'text': 'presentation.html ```html\n<html>Slide</html>```'}},
        ]

        def router(query, *args):
            q = str(query)
            m = MagicMock()
            if 'DELETE FROM bob_storage_files' in q and 'RETURNING path' in q:
                m.fetchall.return_value = [{'path': 'presentation.html'}]
            elif 'FROM bob_conversation_history' in q:
                m.fetchall.return_value = history_rows
            elif 'FROM bob_jobs' in q:
                m.fetchall.return_value = job_rows
            elif 'FROM bob_job_events' in q:
                m.fetchall.return_value = job_events
            else:
                m.fetchall.return_value = []
            return m

        mock_db.execute.side_effect = router
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.postgres_storage.mutation', return_value=mock_ctx):
            result = delete_presentation('alice', 'session:s1', 'presentation.html', 's1')
            self.assertTrue(result)

    def test_delete_presentation_success_bobdeck_project_scope(self):
        mock_db = MagicMock()
        deck = {'title': 'Quarterly Review', 'slides': [{'elements': ['chart']}]}
        deck_json = json.dumps(deck)

        # 1. source_files query
        # 2. DELETE FROM bob_storage_files
        # 3. SELECT id FROM bob_conversations
        # 4. SELECT history
        # 5. SELECT jobs
        # 6. SELECT job_events
        conv_rows = [{'id': 'c1'}]
        history_rows = [
            {'id': 1, 'event': {'type': 'request', 'mode': 'presentation', 'presentation_format': 'powerpoint'}},
            {'id': 2, 'event': {'type': 'delta', 'text': f'Here is the deck: ```bobdeck\n{deck_json}\n```'}},
        ]
        job_rows = [{'id': 'job-2', 'payload': {'mode': 'presentation', 'presentation_format': 'powerpoint'}}]
        job_events = [
            {'id': 20, 'event': {'type': 'delta', 'text': f'Deck: {deck_json}'}},
        ]

        def router(query, *args):
            q = str(query)
            m = MagicMock()
            if 'SELECT content,sha256' in q:
                m.fetchall.return_value = [{'content': deck_json.encode()}]
            elif 'DELETE FROM bob_storage_files' in q and 'RETURNING path' in q:
                m.fetchall.return_value = [{'path': 'presentation.bobdeck'}]
            elif 'FROM bob_conversations' in q:
                m.fetchall.return_value = conv_rows
            elif 'FROM bob_conversation_history' in q:
                m.fetchall.return_value = history_rows
            elif 'FROM bob_jobs' in q:
                m.fetchall.return_value = job_rows
            elif 'FROM bob_job_events' in q:
                m.fetchall.return_value = job_events
            else:
                m.fetchall.return_value = []
            return m

        mock_db.execute.side_effect = router
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.postgres_storage.mutation', return_value=mock_ctx), \
             patch('app.blob_storage.read', return_value=deck_json.encode()):
            result = delete_presentation('alice', 'project:p1', 'presentation.bobdeck', None)
            self.assertTrue(result)


if __name__ == '__main__':
    unittest.main()
