"""Comprehensive unit tests covering app/postgres_storage.py and app/blob_storage.py."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from app import blob_storage, postgres_storage as storage


class PostgresStorageCoverageTests(unittest.TestCase):
    def setUp(self):
        self.username = 'alice'

    def test_ensure_schema_and_create_schema(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.dict(os.environ, {'DATABASE_URL': 'postgres://test:5432/db'}), \
             patch('app.job_queue.ensure_schema'), \
             patch('app.job_queue._connect', mock_conn):
            storage._schema_urls.clear()
            storage.ensure_schema()
            self.assertIn('postgres://test:5432/db', storage._schema_urls)
            self.assertGreater(db.execute.call_count, 5)

    def test_runtime_root_and_paths(self):
        with tempfile.TemporaryDirectory() as td:
            rpath = Path(td)
            token = storage._runtime.set(rpath)
            try:
                self.assertEqual(storage.runtime_root(), rpath)
            finally:
                storage._runtime.reset(token)

        # Path validation
        self.assertEqual(storage.validate_path('notes/file.txt'), 'notes/file.txt')
        self.assertEqual(storage.validate_path('.bob/config.json', internal=True), '.bob/config.json')
        with self.assertRaises(ValueError):
            storage.validate_path('.bob/config.json', internal=False)
        with self.assertRaises(ValueError):
            storage.validate_path('/absolute/path')
        with self.assertRaises(ValueError):
            storage.validate_path('../escape')

    def test_upsert_size_limit_and_tombstone_check(self):
        db = MagicMock()
        # Size limit
        with self.assertRaises(ValueError) as exc:
            storage._upsert(db, 'alice', 'user', 'big.bin', b'x' * (storage.MAX_FILE_BYTES + 1))
        self.assertIn('200 MB', str(exc.exception))

        # Skill deleted tombstone
        db.execute.return_value.fetchone.return_value = (1,)
        storage._upsert(db, 'alice', 'user', '.bob/skills/deleted_skill/SKILL.md', b'content')
        # Does not insert into bob_storage_files
        self.assertFalse(any('INSERT INTO bob_storage_files' in c.args[0] for c in db.execute.call_args_list))

    def test_put_get_delete_file_and_scope(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        content = b'Hello Postgres Storage'
        sha = hashlib.sha256(content).hexdigest()

        # get_file
        with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn):
            db.execute.return_value.fetchone.return_value = {
                'content': content, 'mode': 0o600, 'modified': 100, 'sha256': sha,
                'object_key': None, 'object_bucket': None, 'size': len(content)
            }
            row = storage.get_file('alice', 'session:s1', 'note.txt')
            self.assertEqual(row['content'], content)

        # put_file
        with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn), \
             patch.object(storage, '_upsert') as mock_upsert:
            db.execute.return_value.fetchone.return_value = None
            storage.put_file('alice', 'session:s1', 'note.txt', content)
            mock_upsert.assert_called_once()

        # delete_file
        def exec_del(sql, *args):
            cur = MagicMock()
            if 'FROM bob_jobs' in sql or 'FROM bob_deleted_conversations' in sql:
                cur.fetchone.return_value = None
            elif 'DELETE FROM bob_storage_files' in sql:
                cur.fetchone.return_value = {'path': 'note.txt'}
            else:
                cur.fetchone.return_value = None
            return cur

        with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn):
            db.execute.side_effect = exec_del
            self.assertTrue(storage.delete_file('alice', 'session:s1', 'note.txt'))

        # delete_scope
        with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'name': 'bob_conversation_documents'}), # to_regclass
                MagicMock(), # delete conversation documents
                MagicMock(rowcount=3), # delete storage files
            ]
            rc = storage.delete_scope('alice', 'session:s1')
            self.assertEqual(rc, 3)

    def test_restore_file_and_tree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            row = {'path': 'sub/hello.txt', 'content': b'restored content', 'mode': 0o644, 'modified': 1000,
                   'object_key': None, 'object_bucket': None, 'size': 16}
            storage._restore_file(row, root)
            self.assertEqual((root / 'sub' / 'hello.txt').read_bytes(), b'restored content')

            # restore_tree with thread pool
            db = MagicMock()
            cursor = MagicMock()
            cursor.fetchmany.side_effect = [[row], []]
            db.cursor.return_value.__enter__.return_value = cursor
            @contextmanager
            def mock_conn():
                yield db

            with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn):
                storage.restore_tree('alice', 'session:s1', root)
            self.assertTrue((root / 'sub' / 'hello.txt').exists())

    def test_save_tree_rejections_and_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'valid.txt').write_text('content')
            db = MagicMock()

            # Symlink inside directory
            (root / 'bad_link').symlink_to(root / 'valid.txt')
            with self.assertRaises(ValueError) as exc:
                storage.save_tree('alice', 'session:s1', root, db=db)
            self.assertIn('symbolic links', str(exc.exception))
            (root / 'bad_link').unlink()

            # Normal save_tree success
            with patch.object(storage, '_upsert'):
                count = storage.save_tree('alice', 'session:s1', root, db=db, merge=False)
                self.assertEqual(count, 1)

    def test_user_file_helpers(self):
        user_p = Path('/runtime/users/alice/.bob/skills/custom/SKILL.md')
        self.assertEqual(storage.user_file_identity(user_p), ('alice', '.bob/skills/custom/SKILL.md'))

        # read_user_file via get_file
        with patch.object(storage, 'get_file', return_value={'content': b'skill metadata'}):
            res = storage.read_user_file(user_p)
            self.assertEqual(res, b'skill metadata')

        # write_user_file
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn), \
             patch.object(storage, '_upsert') as mock_up:
            db.execute.return_value.fetchone.return_value = None
            storage.write_user_file(user_p, b'new skill', exclusive=True, recreate_skill=True)
            mock_up.assert_called_once()

        # remove_user_file
        with patch.object(storage, 'delete_file') as mock_del:
            storage.remove_user_file(user_p)
            mock_del.assert_called_once_with('alice', 'user', '.bob/skills/custom/SKILL.md', internal=True)

    def test_resolve_skill_alias_and_deleted_skill_folders(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(storage, 'ensure_schema'), patch('app.job_queue._connect', mock_conn):
            db.execute.return_value.fetchone.return_value = {'name': 'canonical-skill'}
            name = storage.resolve_skill_alias('alice', 'old-alias')
            self.assertEqual(name, 'canonical-skill')

            db.execute.return_value.fetchall.return_value = [{'folder': 'deleted-folder'}]
            folders = storage.deleted_skill_folders('alice')
            self.assertIn('deleted-folder', folders)

    def test_delete_skill_tree(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'users' / 'alice' / '.bob' / 'skills' / 'my-skill'
            path.mkdir(parents=True)
            (path / 'SKILL.md').write_text('# My Skill')

            db = MagicMock()
            @contextmanager
            def mock_conn():
                yield db

            with patch.object(storage, 'ensure_schema'), \
                 patch('app.personalization.ensure_schema'), \
                 patch('app.job_queue._connect', mock_conn):
                db.execute.side_effect = [
                    MagicMock(), # lock
                    MagicMock(fetchone=lambda: None), # active jobs check
                    MagicMock(), # advisory lock
                    MagicMock(), # insert deleted skill
                    MagicMock(fetchall=lambda: []), # skill aliases
                    MagicMock(), # insert deleted skill loop
                    MagicMock(), # delete files
                    MagicMock(), # update personalization
                    MagicMock(fetchone=lambda: {'name': 'bob_workflows'}), # to_regclass
                    MagicMock(), # update workflows
                ]
                storage.delete_skill_tree(path, 'my-skill')
            self.assertFalse(path.exists())

    def test_blob_storage_inband_and_verify(self):
        content = b'Small in-band payload'
        db = MagicMock()
        stored = blob_storage.store(content, namespace='test', db=db)
        self.assertEqual(stored['content'], content)
        self.assertIsNone(stored['object_key'])
        self.assertEqual(stored['size'], len(content))

        read_back = blob_storage.read(stored)
        self.assertEqual(read_back, content)

        # enabled check
        with patch.dict(os.environ, {'BOB_FILE_STORAGE': 'postgres'}):
            self.assertFalse(blob_storage.enabled())
        with patch.dict(os.environ, {'BOB_FILE_STORAGE': 'invalid'}):
            with self.assertRaises(ValueError):
                blob_storage.enabled()


if __name__ == '__main__':
    unittest.main()
