"""Unit tests for app.conversation_delete cleanup, tombstone, and task deletion logic."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.conversation_delete import (
    _history_task_ids,
    _delete_bob_tasks,
    _delete_bob_shell_logs,
    delete_conversation,
    delete_project,
)


class ConversationDeleteTests(unittest.TestCase):
    def test_history_task_ids_extraction(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", encoding="utf-8") as f:
            f.write(json.dumps({'type': 'delta', 'text': 'hi'}) + '\n')
            f.write(json.dumps({'type': 'done', 'session_id': 'sess-123'}) + '\n')
            f.write(json.dumps({'type': 'error', 'session_id': 'sess-456'}) + '\n')
            f.write('invalid json\n')
            f.flush()

            task_ids = _history_task_ids(Path(f.name))
            self.assertEqual(task_ids, {'sess-123', 'sess-456'})

    def test_history_task_ids_nonexistent_file(self):
        self.assertEqual(_history_task_ids(Path("/tmp/nonexistent_history.jsonl")), set())

    def test_delete_bob_shell_logs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dir_path = Path(temp_dir)
            conv_dir = Path("/workspace/users/alice/sessions/session-abc")
            
            # File that contains conversation marker
            log1 = dir_path / "bob-shell-1.log"
            log1.write_bytes(b"Starting session in " + str(conv_dir).encode() + b" ...")

            # File that does not contain marker
            log2 = dir_path / "bob-shell-2.log"
            log2.write_bytes(b"Different session...")

            deleted = _delete_bob_shell_logs(dir_path, conv_dir)
            self.assertEqual(deleted, 1)
            self.assertFalse(log1.exists())
            self.assertTrue(log2.exists())

    def test_delete_bob_tasks_nonexistent_database(self):
        self.assertEqual(_delete_bob_tasks(Path("/tmp/nonexistent_bob.db"), {"task-1"}, None), 0)

    def test_delete_bob_tasks_in_sqlite(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            db_path = Path(f.name)
            with sqlite3.connect(db_path) as db:
                db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, first_message TEXT)")
                db.execute("CREATE TABLE task_messages (task_id TEXT, message TEXT)")
                
                db.execute("INSERT INTO tasks VALUES ('t-root', NULL, '/dir1', 'prompt 1')")
                db.execute("INSERT INTO tasks VALUES ('t-child', 't-root', '/dir1', 'prompt 2')")
                db.execute("INSERT INTO tasks VALUES ('t-other', NULL, '/dir2', 'prompt 3')")
                
                db.execute("INSERT INTO task_messages VALUES ('t-root', 'hello')")
                db.execute("INSERT INTO task_messages VALUES ('t-child', 'world')")
                db.execute("INSERT INTO task_messages VALUES ('t-other', 'keep')")

            deleted = _delete_bob_tasks(db_path, {"t-root"}, None)
            self.assertEqual(deleted, 2)

            with sqlite3.connect(db_path) as db:
                remaining_tasks = [row[0] for row in db.execute("SELECT id FROM tasks")]
                self.assertEqual(remaining_tasks, ["t-other"])
                remaining_messages = [row[0] for row in db.execute("SELECT task_id FROM task_messages")]
                self.assertEqual(remaining_messages, ["t-other"])

    def test_delete_conversation_invalid_id_raises(self):
        with self.assertRaises(ValueError):
            delete_conversation('alice', 'invalid id with spaces!')

    def test_delete_conversation_already_deleted(self):
        with patch('app.postgres_storage.ensure_schema'), patch('app.rag.ensure_schema'):
            with patch('app.job_queue.deletion_record', return_value={'status': 'deleted'}):
                result = delete_conversation('alice', 'a' * 32)
                self.assertEqual(result, {'objects': 0, 'bob_tasks': 0})

    def test_delete_project_calls_storage_cleanup(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchall.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.projects.project_root'), \
             patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.postgres_storage.mutation', return_value=mock_ctx), \
             patch('app.postgres_storage.delete_scope', return_value=3):
            result = delete_project('alice', 'proj-123')
            self.assertEqual(result, {'files': 3, 'conversations': 0})


if __name__ == '__main__':
    unittest.main()
