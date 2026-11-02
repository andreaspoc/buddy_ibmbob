"""Unit tests for app.migrate_blobs BYTEA to S3 migration tool."""
import json
import unittest
from unittest.mock import MagicMock, patch

from app import migrate_blobs


class MigrateBlobsTests(unittest.TestCase):
    def test_migrate_dry_run(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.side_effect = [
            {'n': 3, 'bytes': 1500},
            {'n': 2, 'bytes': 2000},
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.job_queue._connect', return_value=mock_ctx):
            result = migrate_blobs.migrate(apply=False)
            self.assertEqual(result['files'], 5)
            self.assertEqual(result['bytes'], 3500)
            self.assertFalse(result['applied'])

    def test_migrate_apply_without_blob_storage_enabled_raises(self):
        with patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.blob_storage.enabled', return_value=False):
            with self.assertRaises(ValueError):
                migrate_blobs.migrate(apply=True)

    def test_migrate_apply_success(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.side_effect = [
            {'username': 'alice', 'scope': 'user', 'path': 'doc.txt'},  # table 1, row 1
            None,  # table 1, row 2 (end)
            {'id': 'doc-123'},  # table 2, row 1
            None,  # table 2, row 2 (end)
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.blob_storage.enabled', return_value=True), \
             patch('app.blob_storage.read', return_value=b'file-content'), \
             patch('app.blob_storage.store', return_value={'object_key': 'k1', 'object_bucket': 'b1', 'size': 12}), \
             patch('app.job_queue._connect', return_value=mock_ctx):
            result = migrate_blobs.migrate(apply=True)
            self.assertEqual(result['files'], 2)
            self.assertEqual(result['bytes'], 24)
            self.assertTrue(result['applied'])

    def test_verify_success(self):
        mock_cursor = MagicMock()
        mock_cursor.__iter__.return_value = iter([
            {'content': b'xyz', 'sha256': '123', 'size': 3, 'object_key': None, 'object_bucket': None}
        ])
        mock_db = MagicMock()
        mock_db.cursor.return_value.__enter__.return_value = mock_cursor
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.blob_storage.read', return_value=b'xyz'), \
             patch('app.job_queue._connect', return_value=mock_ctx):
            result = migrate_blobs.verify()
            self.assertGreater(result['verified_files'], 0)
            self.assertGreater(result['verified_bytes'], 0)

    def test_main_cli_gc(self):
        with patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.blob_storage.collect_garbage', return_value=4), \
             patch('sys.argv', ['migrate_blobs.py', '--gc']), \
             patch('builtins.print') as mock_print:
            migrate_blobs.main()
            mock_print.assert_called_once()
            self.assertIn('"deleted_objects": 4', mock_print.call_args[0][0])

    def test_main_cli_verify(self):
        with patch.object(migrate_blobs, 'verify', return_value={'verified_files': 10, 'verified_bytes': 100}), \
             patch('sys.argv', ['migrate_blobs.py', '--verify']), \
             patch('builtins.print') as mock_print:
            migrate_blobs.main()
            mock_print.assert_called_once()
            self.assertIn('"verified_files": 10', mock_print.call_args[0][0])

    def test_main_cli_apply(self):
        with patch.object(migrate_blobs, 'migrate', return_value={'files': 5, 'bytes': 50, 'applied': True}) as mock_mig, \
             patch('sys.argv', ['migrate_blobs.py', '--apply']), \
             patch('builtins.print') as mock_print:
            migrate_blobs.main()
            mock_mig.assert_called_once_with(apply=True)
            mock_print.assert_called_once()


if __name__ == '__main__':
    unittest.main()
