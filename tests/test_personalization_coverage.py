"""Behavioral tests for account-owned preferences and presets."""
import json
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from app import personalization as p


class PersonalizationCoverageTests(unittest.TestCase):
    def test_context_filters_bounds_and_keeps_request_precedence(self):
        context = p.format_user_context('  Alice  ', [
            {'content': 'short'}, {'content': 'disabled', 'enabled': False},
            {'content': 'x' * 1100}, {'content': 42},
        ])
        payload = json.loads(context.split('\n')[-3])
        self.assertEqual(payload['display_name'], 'Alice')
        self.assertEqual(payload['saved_preferences'], ['short', 'x' * 1000])
        self.assertIn('current request takes precedence', context)
        self.assertEqual(p.format_user_context('kc-' + 'a' * 40, []), '')
        self.assertEqual(len(json.loads(p.format_user_context('a' * 500, []).split('\n')[-3])['display_name']), 400)
        self.assertEqual(len(json.loads(p.format_user_context(None, [{'content': str(i)} for i in range(60)]).split('\n')[-3])['saved_preferences']), 50)

    def test_memory_and_preset_lookup(self):
        with patch.object(p, 'records', return_value=[{'id': 'a', 'content': 'tea'}, {'id': 'b', 'content': 'coffee', 'enabled': False}]):
            self.assertEqual(p.get_preset('u', 'a')['content'], 'tea')
            self.assertIsNone(p.get_preset('u', 'missing'))
            self.assertIn('- tea', p.memory_context('u'))
            self.assertNotIn('coffee', p.memory_context('u'))
        with patch.object(p, 'records', return_value=[]):
            self.assertEqual(p.memory_context('u'), '')

    def test_save_validation_and_update(self):
        db = MagicMock()
        conn = MagicMock()
        conn.__enter__.return_value = db
        db.execute.return_value.rowcount = 1
        with patch.object(p, 'ensure_schema'), patch('app.postgres_storage.ensure_schema'), \
             patch('app.postgres_storage._lock') as lock, patch.object(p.job_queue, '_connect', return_value=conn):
            with self.assertRaises(HTTPException) as error:
                p.save('alice', 'memories', 'id', {'content': '  '})
            self.assertEqual(error.exception.status_code, 422)
            result = p.save('alice', 'memories', 'id', {'content': 'tea'})
            self.assertEqual(result, {'id': 'id', 'content': 'tea'})
            lock.assert_called_with(db, 'alice', 'user')
            db.execute.return_value.rowcount = 0
            with self.assertRaises(HTTPException) as error:
                p.save('alice', 'memories', 'missing', {'content': 'tea'})
            self.assertEqual(error.exception.status_code, 404)

    def test_creation_limit_and_deleted_skills(self):
        db = MagicMock()
        conn = MagicMock()
        conn.__enter__.return_value = db
        with patch.object(p, 'ensure_schema'), patch('app.postgres_storage.ensure_schema'), \
             patch('app.postgres_storage._lock'), patch.object(p.job_queue, '_connect', return_value=conn), \
             patch('app.workspace_config.resolve_skill_name', return_value='research'):
            db.execute.return_value.fetchone.return_value = {'n': 50}
            with self.assertRaises(HTTPException) as error:
                p.save('alice', 'memories', 'id', {'content': 'tea'}, create=True)
            self.assertEqual(error.exception.status_code, 409)
            with self.assertRaises(HTTPException) as error:
                p.save('alice', 'presets', 'id', {'name': 'Test', 'skill_name': 'research'})
            self.assertEqual(error.exception.status_code, 422)
            with self.assertRaises(HTTPException) as error:
                p.save('alice', 'presets', 'id', {'name': 'Test', 'web_search': True})
            self.assertEqual(error.exception.status_code, 422)

    def test_tutorial_legacy_and_invalid_kinds(self):
        with patch.object(p, 'records', return_value=[{'disabled': True}]):
            self.assertEqual(p.get_tutorial_settings({'username': 'u'}), {'disabled': False})
        with patch.object(p, 'records', return_value=[{'disabled': True, 'welcome_version': 1}]):
            self.assertEqual(p.get_tutorial_settings({'username': 'u'}), {'disabled': True})
        for fn, args in [(p.list_entries, ('invalid',)), (p.delete_entry, ('invalid', 'id'))]:
            with self.assertRaises(HTTPException) as error:
                fn(*args, user={'username': 'u'})
            self.assertEqual(error.exception.status_code, 404)


if __name__ == '__main__':
    unittest.main()
