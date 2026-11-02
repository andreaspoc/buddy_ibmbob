import hashlib
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from app import postgres_storage as storage

class RestoreTests(unittest.TestCase):
    def rows(self):
        return [dict(path=f'file-{i}.txt',content=b'verified',sha256=hashlib.sha256(b'verified').hexdigest(),size=8,mode=0o640,modified=1234567890) for i in range(4)]
    def database(self, rows):
        db = MagicMock()
        db.cursor.return_value.__enter__.return_value.fetchmany.side_effect = [rows, []]
        return db
    def test_parallel_verified_restore_preserves_metadata(self):
        rows = self.rows()
        barrier = threading.Barrier(4)
        original = storage.blob_storage.read
        def read(row):
            barrier.wait(timeout=3)
            return original(row)
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect') as connect, patch.object(storage.blob_storage, 'read', side_effect=read), patch.dict('os.environ', {'BOB_STORAGE_DOWNLOAD_WORKERS':'4'}):
            connect.return_value.__enter__.return_value = self.database(rows)
            storage.restore_tree('test', 'test', Path(directory))
            for row in rows:
                path = Path(directory)/row['path']
                self.assertEqual(path.read_bytes(), b'verified')
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)
                self.assertEqual(path.stat().st_mtime_ns, row['modified'])
    def test_corrupt_file_stops_restore(self):
        rows=self.rows(); rows[0]['sha256']='invalid'
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect') as connect:
            connect.return_value.__enter__.return_value = self.database(rows)
            with self.assertRaisesRegex(OSError, 'checksum'):
                storage.restore_tree('test','test',Path(directory))
            self.assertFalse((Path(directory)/rows[0]['path']).exists())

    def test_workspace_restore_ignores_legacy_runtime_metadata(self):
        for scope in ('session:fixture', 'project:fixture'):
            with self.subTest(scope=scope):
                rows = self.rows()[:1]
                rows.append({**rows[0], 'path': '.bob/settings.json'})
                rows.append({**rows[0], 'path': '.home/token'})
                with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect') as connect:
                    connect.return_value.__enter__.return_value = self.database(rows)
                    root = Path(directory)
                    storage.restore_tree('test', scope, root)
                    self.assertTrue((root / 'file-0.txt').is_file())
                    self.assertFalse((root / '.bob').exists())
                    self.assertFalse((root / '.home').exists())
                    # The worker can now attach the user settings link safely.
                    (root / '.bob').symlink_to(root / 'user-settings', target_is_directory=True)
                    self.assertTrue((root / '.bob').is_symlink())

    def test_user_and_home_scopes_keep_bob_settings(self):
        for scope in ('user', 'home:fixture'):
            with self.subTest(scope=scope):
                row = {**self.rows()[0], 'path': '.bob/settings.json'}
                with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'ensure_schema'), patch.object(storage.job_queue, '_connect') as connect:
                    connect.return_value.__enter__.return_value = self.database([row])
                    storage.restore_tree('test', scope, Path(directory))
                    self.assertEqual((Path(directory) / row['path']).read_bytes(), b'verified')
