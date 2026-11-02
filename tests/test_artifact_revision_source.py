"""Revision comparison reads only owned history and never mutates it."""
import asyncio
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from app.artifacts import revision_source

class RevisionSourceTests(unittest.TestCase):
    def test_returns_exact_saved_source_for_authenticated_owner(self):
        rows = [{'id': 'a' * 64, 'content': 'older <script>source</script>', 'created': '2026-01-01'}]
        with patch('app.artifacts.history', return_value=rows) as history:
            result = asyncio.run(revision_source('chat', 'notes.md', 'a' * 64, {'username': 'alice'}))
        history.assert_called_once_with('alice', 'chat', 'notes.md')
        self.assertEqual(result['content'], rows[0]['content'])
        self.assertEqual(result['path'], 'notes.md')

    def test_missing_revision_is_not_replaced_with_current_source(self):
        with patch('app.artifacts.history', return_value=[]):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(revision_source('chat', 'notes.md', 'b' * 64, {'username': 'alice'}))
        self.assertEqual(error.exception.status_code, 404)

    def test_ownership_failure_propagates(self):
        with patch('app.artifacts.history', side_effect=HTTPException(404, 'Conversation not found')):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(revision_source('other-chat', 'notes.md', 'a' * 64, {'username': 'alice'}))
        self.assertEqual(error.exception.status_code, 404)

    def test_utf8_byte_limit_applies_to_saved_revision(self):
        with patch('app.artifacts.LIMIT', 3), patch('app.artifacts.history', return_value=[{'id': 'a' * 64, 'content': 'αα'}]):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(revision_source('chat', 'notes.md', 'a' * 64, {'username': 'alice'}))
        self.assertEqual(error.exception.status_code, 413)

if __name__ == '__main__': unittest.main()
