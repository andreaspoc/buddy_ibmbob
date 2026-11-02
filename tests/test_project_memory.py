import unittest
import json
from unittest.mock import patch
from app.project_memory import context_for_session, MemoryUpdate
from pydantic import ValidationError

class ProjectMemoryTests(unittest.TestCase):
    @patch('app.sessions.get_session', return_value={'id': 'chat'})
    def test_personal_conversation_has_no_project_context(self, get_session):
        self.assertEqual(context_for_session('alice', 'chat'), '')

    @patch('app.project_memory.read_memory', return_value={'brief': 'Goals: launch\nReview policy', 'revision': 1, 'needs_renewal': False, 'expired': False})
    @patch('app.sessions.get_session', return_value={'project_id': 'owned'})
    def test_owner_project_context_is_quoted_and_labeled(self, get_session, read_memory):
        context = context_for_session('alice', 'chat')
        read_memory.assert_called_once_with('alice', 'owned')
        self.assertIn('current user request takes precedence', context)
        self.assertIn(json.dumps('Goals: launch\nReview policy'), context)

    @patch('app.sessions.get_session', return_value={'project_id': 'owned'})
    def test_expired_or_legacy_memory_is_excluded(self, get_session):
        for state in ({'needs_renewal': True}, {'expired': True}):
            with self.subTest(state=state), patch('app.project_memory.read_memory',
                    return_value={'brief': 'must not enter inference', 'revision': 1, **state}):
                self.assertEqual(context_for_session('alice', 'chat'), '')

    @patch('app.project_memory.read_memory', return_value={'brief': 'password=fixture-secret', 'revision': 1,
                                                        'needs_renewal': False, 'expired': False})
    @patch('app.sessions.get_session', return_value={'project_id': 'owned'})
    def test_context_rechecks_sensitive_data(self, get_session, read_memory):
        context = context_for_session('alice', 'chat')
        self.assertNotIn('fixture-secret', context)
        self.assertIn('[redacted]', context)

    def test_retention_defaults_and_custom_bounds(self):
        self.assertEqual(MemoryUpdate(brief='Facts', revision=0).expires_in_days, 30)
        for days in (1, 365):
            self.assertEqual(MemoryUpdate(brief='Facts', revision=0, expires_in_days=days).expires_in_days, days)

    def test_limits_and_revision_validation(self):
        for values in ({'brief': 'x' * 20001, 'revision': 0}, {'brief': '', 'revision': -1},
                       {'brief': '', 'revision': 0, 'expires_in_days': 0},
                       {'brief': '', 'revision': 0, 'expires_in_days': 366}):
            with self.assertRaises(ValidationError):
                MemoryUpdate(**values)

if __name__ == '__main__':
    unittest.main()
