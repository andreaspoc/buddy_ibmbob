"""Remote verification must not succeed merely because store primed its cache."""
import hashlib
import io
import os
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import MagicMock, patch
from app import blob_storage


class RemoteVerificationTests(TestCase):
    def test_read_back_rejects_corrupt_upload_even_with_valid_cached_original(self):
        client = MagicMock()
        client.get_object.return_value = {'Body': io.BytesIO(b'corrupted')}
        with tempfile.TemporaryDirectory() as cache, \
                patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-only'}), \
                patch.object(blob_storage, 'enabled', return_value=True), \
                patch.object(blob_storage, '_client', return_value=client), \
                patch.object(blob_storage, '_cache_dir', return_value=Path(cache)), \
                patch('app.job_queue._connect', return_value=MagicMock()):
            with self.assertRaises(OSError):
                blob_storage.store(b'valid original', namespace='test-only', db=MagicMock())
            self.assertTrue((Path(cache) / hashlib.sha256(b'valid original').hexdigest()).exists())
            client.get_object.assert_called_once()

    def test_verified_cache_can_serve_reads_but_remote_audit_bypasses_it(self):
        raw = b'valid original'
        row = {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw),
               'object_bucket': 'test-only', 'object_key': 'test-only'}
        client = MagicMock()
        client.get_object.return_value = {'Body': io.BytesIO(b'corrupted')}
        with tempfile.TemporaryDirectory() as cache, \
                patch.object(blob_storage, '_cache_dir', return_value=Path(cache)), \
                patch.object(blob_storage, '_client', return_value=client):
            (Path(cache) / row['sha256']).write_bytes(raw)
            self.assertEqual(blob_storage.read(row), raw)
            client.get_object.assert_not_called()
            with self.assertRaises(OSError):
                blob_storage.read(row, use_cache=False)
            client.get_object.assert_called_once()
