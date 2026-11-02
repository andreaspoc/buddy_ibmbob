"""Unit tests for app.blob_storage operations, garbage collection, and cache purging."""
import os
import unittest
from unittest.mock import MagicMock, patch

from app import blob_storage


class BlobStorageOpsTests(unittest.TestCase):
    def test_enabled_checks(self):
        with patch.dict(os.environ, {'BOB_FILE_STORAGE': 'invalid'}):
            with self.assertRaises(ValueError):
                blob_storage.enabled()

        with patch.dict(os.environ, {'BOB_FILE_STORAGE': 's3'}, clear=True):
            with self.assertRaises(ValueError):
                blob_storage.enabled()

        with patch.dict(os.environ, {
            'BOB_FILE_STORAGE': 's3',
            'BOB_S3_BUCKET': 'my-bucket',
            'BOB_S3_ENDPOINT': 'https://s3.example.com',
            'BOB_S3_ACCESS_KEY_ID': 'key',
            'BOB_S3_SECRET_ACCESS_KEY': 'secret',
        }):
            self.assertTrue(blob_storage.enabled())

        with patch.dict(os.environ, {'BOB_FILE_STORAGE': 'postgres'}):
            self.assertFalse(blob_storage.enabled())

    def test_schema_unsupported_table_raises(self):
        mock_db = MagicMock()
        with self.assertRaises(ValueError):
            blob_storage.schema(mock_db, 'invalid_table')

    def test_schema_success(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = None  # constraint check
        blob_storage.schema(mock_db, 'bob_storage_files')
        mock_db.execute.assert_called()

    def test_collect_garbage(self):
        mock_db = MagicMock()
        def router(query, *args):
            q = str(query)
            m = MagicMock()
            if 'to_regclass' in q:
                m.fetchone.return_value = {'name': 'bob_blob_gc'}
            elif 'available_at < now()' in q and 'candidates' in q or 'FROM bob_blob_gc' in q:
                m.fetchall.return_value = [{'bucket': 'b1', 'object_key': 'k1'}]
                m.fetchone.return_value = True
            elif 'pg_try_advisory_xact_lock' in q:
                m.fetchone.return_value = {'acquired': True}
            elif 'WHERE object_bucket=' in q:
                m.fetchone.return_value = None  # not referenced
            return m

        mock_db.execute.side_effect = router
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.job_queue._connect', return_value=mock_ctx), \
             patch('app.blob_storage._client') as mock_client, \
             patch('app.blob_storage._erase_object') as mock_erase:
            deleted = blob_storage.collect_garbage()
            self.assertEqual(deleted, 1)
            mock_erase.assert_called_once()

    def test_collect_garbage_no_table(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = {'name': None}
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.job_queue._connect', return_value=mock_ctx):
            deleted = blob_storage.collect_garbage()
            self.assertEqual(deleted, 0)

    def test_erase_object_versions(self):
        mock_client = MagicMock()
        mock_client.head_object.return_value = {'Metadata': {'sha256': 'a' * 64}}
        mock_paginator = MagicMock()
        mock_paginator.paginate.return_value = [
            {'Versions': [{'Key': 'my-key', 'VersionId': 'v1'}], 'DeleteMarkers': []}
        ]
        mock_client.get_paginator.return_value = mock_paginator
        mock_client.delete_objects.return_value = {}

        with patch('app.blob_storage._cache_dir') as mock_cache:
            mock_file = MagicMock()
            mock_cache.return_value.__truediv__.return_value = mock_file
            blob_storage._erase_object(mock_client, 'b', 'my-key')
            mock_client.delete_objects.assert_called_once()

    def test_purge_message_caches(self):
        mock_db = MagicMock()
        def router(query, *args):
            q = str(query)
            m = MagicMock()
            if 'to_regclass' in q:
                m.fetchone.return_value = {'name': 'bob_blob_gc'}
            elif 'bob_blob_gc' in q and 'SELECT bucket' in q:
                m.fetchall.return_value = [{'bucket': 'b1', 'object_key': 'bob-blobs/v1/xyz/k1'}]
            elif 'WHERE object_bucket=' in q:
                m.fetchone.return_value = None  # not referenced
            return m

        mock_db.execute.side_effect = router
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.job_queue._connect', return_value=mock_ctx), \
             patch('app.blob_storage._cache_dir') as mock_cache_dir, \
             patch('app.blob_storage._client') as mock_client, \
             patch('app.blob_storage._erase_object') as mock_erase:
            mock_cache_dir.return_value.iterdir.return_value = []
            pending = blob_storage.purge_message_caches('alice', 'session-123')
            self.assertFalse(pending)
            mock_erase.assert_called_once()


if __name__ == '__main__':
    unittest.main()
