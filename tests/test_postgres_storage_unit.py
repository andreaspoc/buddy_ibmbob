"""Durable storage rules using temporary workspaces and database doubles."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from app import postgres_storage as storage


class PostgresStorageUnitTests(unittest.TestCase):
    def test_user_identity_read_and_exclusive_write(self):
        user_path = Path('/runtime/users/alice/.bob/settings.json')
        self.assertEqual(storage.user_file_identity(user_path), ('alice', '.bob/settings.json'))
        self.assertIsNone(storage.user_file_identity(Path('/runtime/users/INVALID/file')))
        with patch.object(storage, 'get_file', return_value={'content': b'saved'}) as get:
            self.assertEqual(storage.read_user_file(user_path), b'saved')
            get.assert_called_once_with('alice', 'user', '.bob/settings.json', internal=True)
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = (1,)
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        with patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect', connect), \
             patch.object(storage, '_upsert') as upsert:
            with self.assertRaises(FileExistsError):
                storage.write_user_file(user_path, b'new', exclusive=True)
            upsert.assert_not_called()

    def test_local_user_file_roundtrip_and_exclusive_create(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'notes' / 'file.txt'
            storage.write_user_file(path, b'hello', exclusive=True)
            self.assertEqual(storage.read_user_file(path), b'hello')
            with self.assertRaises(FileExistsError):
                storage.write_user_file(path, b'overwrite', exclusive=True)
            storage.remove_user_file(path)
            self.assertIsNone(storage.read_user_file(path))

    def test_public_listing_filters_private_files(self):
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = [
            {'path': 'report.txt'}, {'path': '.bob/config'}, {'path': 'folder/.secret'}, {'path': '.history.jsonl'}]
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        with patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect', connect):
            self.assertEqual(storage.list_files('alice', 'user'), [{'path': 'report.txt'}])
            self.assertEqual(len(storage.list_files('alice', 'user', internal=True)), 4)

    def test_public_paths_cannot_escape_or_reach_private_metadata(self):
        for path in ('', '../file', '/absolute', 'a/../b', 'a\\b', '.bob/settings', 'a//b', 'a\x00b'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                storage.validate_path(path)
        self.assertEqual(storage.validate_path('.bob/settings', internal=True), '.bob/settings')
        self.assertEqual(storage.validate_path('reports/one.txt'), 'reports/one.txt')

    def test_save_tree_ignores_private_files_and_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'report.txt').write_text('report')
            (root / '.history.jsonl').write_text('private')
            db = MagicMock()
            with patch.object(storage, '_upsert') as upsert:
                self.assertEqual(storage.save_tree('alice', 'session:one', root, db=db), 1)
            self.assertEqual(upsert.call_args.args[3:5], ('report.txt', b'report'))
            self.assertIn('.bob/artifacts/%', db.execute.call_args.args[1])
            (root / 'link').symlink_to(root / 'report.txt')
            with self.assertRaisesRegex(ValueError, 'symbolic links'):
                storage.save_tree('alice', 'session:one', root, db=db)

    def test_upsert_skips_unchanged_bytes_and_updates_changed_mode(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = {'sha256': hashlib.sha256(b'data').hexdigest(), 'mode': 0o600}
        with patch.object(storage.blob_storage, 'store') as store:
            storage._upsert(db, 'alice', 'user', 'report.txt', b'data', mode=0o600)
            store.assert_not_called()
            self.assertEqual(db.execute.call_count, 1)
            storage._upsert(db, 'alice', 'user', 'report.txt', b'data', mode=0o644)
            self.assertIn('UPDATE bob_storage_files SET mode', db.execute.call_args.args[0])
            store.assert_not_called()

    def test_mutation_rejects_deleted_active_or_missing_project(self):
        db = MagicMock()
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        with patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect', connect):
            db.execute.return_value.fetchone.return_value = (1,)
            with self.assertRaisesRegex(ValueError, 'being deleted'):
                with storage.mutation('alice', 'session:one', 'one'):
                    self.fail('must not mutate')
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaisesRegex(FileNotFoundError, 'Project not found'):
                with storage.mutation('alice', 'project:one'):
                    self.fail('must not mutate')
            db.execute.return_value.fetchone.return_value = (1,)
            with self.assertRaisesRegex(ValueError, 'active'):
                with storage.mutation('alice', 'session:one'):
                    self.fail('must not mutate')


if __name__ == '__main__':
    unittest.main()
