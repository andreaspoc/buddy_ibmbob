"""Unit tests covering app/sessions.py conversation storage, history, and naming."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
import uuid

from app import sessions


class SessionsUnitTests(unittest.TestCase):
    def setUp(self):
        self.user = 'alice'
        self.session_id = uuid.uuid4().hex

    def test_user_root_validation(self):
        with self.assertRaises(ValueError):
            sessions.user_root('123_invalid_user')
        with self.assertRaises(ValueError):
            sessions.user_root('bad/user')

        with patch('app.postgres_storage.seed_user') as mock_seed, \
             patch('app.postgres_storage.runtime_root', return_value=Path('/runtime')):
            p = sessions.user_root('alice', create=True)
            self.assertEqual(p, Path('/runtime/users/alice'))
            mock_seed.assert_called_once_with('alice')

    def test_get_session(self):
        # Invalid ID
        with self.assertRaises(ValueError):
            sessions.get_session('not-a-valid-id', 'alice')

        # Legacy
        self.assertEqual(sessions.get_session('legacy', 'alice')['id'], 'legacy')

        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # Deleted
        with patch.object(sessions.storage, 'ensure_schema'), patch('app.sessions.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'record': {'id': self.session_id}}),
                MagicMock(fetchone=lambda: (1,)), # deleted
            ]
            with self.assertRaises(FileNotFoundError):
                sessions.get_session(self.session_id, 'alice')

        # Not found
        with patch.object(sessions.storage, 'ensure_schema'), patch('app.sessions.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: None),
                MagicMock(fetchone=lambda: None),
            ]
            with self.assertRaises(FileNotFoundError):
                sessions.get_session(self.session_id, 'alice')

        # Success
        with patch.object(sessions.storage, 'ensure_schema'), patch('app.sessions.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'record': {'id': self.session_id, 'title': 'Chat'}}),
                MagicMock(fetchone=lambda: None),
            ]
            rec = sessions.get_session(self.session_id, 'alice')
            self.assertEqual(rec['title'], 'Chat')

    def test_storage_scope_and_workspace_key(self):
        with patch.object(sessions, 'get_session', return_value={'id': self.session_id}):
            scope = sessions.storage_scope(self.session_id, 'alice')
            self.assertEqual(scope, 'session:' + self.session_id)
            key = sessions.workspace_key(self.session_id, 'alice')
            self.assertEqual(key, f'alice:session:{self.session_id}')

        with patch.object(sessions, 'get_session', return_value={'id': self.session_id, 'project_id': 'proj1'}), \
             patch('app.projects.project_root', return_value=Path('/runtime/users/alice/projects/proj1')):
            scope_p = sessions.storage_scope(self.session_id, 'alice')
            self.assertEqual(scope_p, 'project:proj1')

    def test_workspace_for_and_session_storage(self):
        with patch.object(sessions, 'get_session', return_value={'id': self.session_id}), \
             patch.object(sessions, 'user_root', return_value=Path('/runtime/users/alice')):
            path = sessions.session_storage(self.session_id, 'alice')
            self.assertEqual(path, Path(f'/runtime/users/alice/sessions/{self.session_id}'))

            ws = sessions.workspace_for(self.session_id, 'alice')
            self.assertEqual(ws, Path(f'/runtime/users/alice/sessions/{self.session_id}'))

        with patch.object(sessions, 'get_session', return_value={'id': self.session_id, 'project_id': 'p1'}), \
             patch('app.projects.project_root', return_value=Path('/runtime/users/alice/projects/p1')):
            ws_p = sessions.workspace_for(self.session_id, 'alice')
            self.assertEqual(ws_p, Path('/runtime/users/alice/projects/p1'))

    def test_create_session(self):
        with self.assertRaises(ValueError):
            sessions.create_session('alice', purpose='bad_purpose')

        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(sessions.storage, 'ensure_schema'), patch('app.sessions.job_queue._connect', mock_conn):
            rec = sessions.create_session('alice', purpose='note_enrichment')
            self.assertEqual(rec['purpose'], 'note_enrichment')
            self.assertEqual(rec['title'], 'New conversation')
            self.assertEqual(db.execute.call_count, 1)

    def test_touch_session(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(sessions, 'get_session', return_value={'id': self.session_id}), \
             patch('app.sessions.job_queue._connect', mock_conn):
            sessions.touch_session(self.session_id, 'alice', title='Create a presentation about marketing')
            self.assertEqual(db.execute.call_count, 1)

    def test_list_sessions(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        rows = [
            {'record': {'id': self.session_id, 'title': 'New conversation'}, 'prompts': ['hello world']},
        ]
        with patch.object(sessions.storage, 'ensure_schema'), \
             patch.object(sessions, 'mark_note_enrichment_sessions'), \
             patch('app.sessions.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchall=lambda: rows),
                MagicMock(fetchone=lambda: None), # legacy check
            ]
            sess_list = sessions.list_sessions('alice')
            self.assertEqual(len(sess_list), 1)

    def test_append_and_read_history(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        @contextmanager
        def mock_guard(u, sid):
            yield

        with patch.object(sessions, 'get_session', return_value={'id': self.session_id}), \
             patch('app.sessions.job_queue.session_guard', mock_guard), \
             patch('app.sessions.job_queue._connect', mock_conn):
            sessions.append_history(self.session_id, 'alice', {'type': 'request', 'prompt': 'hi'})
            self.assertEqual(db.execute.call_count, 1)

        # read_history
        hist_rows = [
            {'id': 1, 'event': {'type': 'request', 'prompt': 'hi'}},
            {'id': 2, 'event': {'type': 'done', 'text': 'bye'}},
        ]
        with patch.object(sessions, 'get_session', return_value={'id': self.session_id}), \
             patch('app.sessions.job_queue._connect', mock_conn), \
             patch('app.message_deletion.message_ids', return_value=('u1', 'a1')), \
             patch('app.task_usage.recover_usage', return_value=[{'type': 'done', 'text': 'bye'}]):
            db.execute.return_value.fetchall.return_value = hist_rows
            history = sessions.read_history(self.session_id, 'alice')
            self.assertEqual(len(history), 2)
            self.assertEqual(history[0]['user_message_id'], 'u1')


if __name__ == '__main__':
    unittest.main()
