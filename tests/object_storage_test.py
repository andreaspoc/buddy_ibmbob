"""Storage round trip and verified local eviction without a Office Suite account."""
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError
from app import object_storage


class FakePaginator:
    def __init__(self, client):
        self.client = client

    def paginate(self, Bucket, Prefix):
        yield {"Contents": [
            {"Key": key, "Size": len(data), "LastModified": datetime.now(timezone.utc)}
            for key, (data, _) in self.client.objects.items() if key.startswith(Prefix)
        ]}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.uploads = 0

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        data, metadata = self.objects[Key]
        return {"ContentLength": len(data), "Metadata": metadata}

    def upload_file(self, filename, bucket, key, ExtraArgs):
        self.uploads += 1
        self.objects[key] = (Path(filename).read_bytes(), ExtraArgs["Metadata"])

    def download_file(self, bucket, key, filename):
        if key not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "GetObject")
        Path(filename).write_bytes(self.objects[key][0])

    def get_paginator(self, name):
        return FakePaginator(self)


class FakeVersionedS3:
    def __init__(self):
        self.versions = [
            {"Key": "users/alice/sessions/" + "a" * 32 + "/files/deck.html", "VersionId": "v1"},
            {"Key": "users/alice/sessions/" + "a" * 32 + "/history.jsonl", "VersionId": "v2"},
        ]
        self.markers = [{"Key": self.versions[0]["Key"], "VersionId": "m1"}]

    def get_paginator(self, name):
        client = self
        class Paginator:
            def paginate(self, Bucket, Prefix):
                if name == "list_object_versions":
                    yield {"Versions": list(client.versions), "DeleteMarkers": list(client.markers)}
                else:
                    yield {"Contents": []}
        return Paginator()

    def delete_objects(self, Bucket, Delete):
        keys = {(item["Key"], item.get("VersionId")) for item in Delete["Objects"]}
        self.versions = [item for item in self.versions if (item["Key"], item["VersionId"]) not in keys]
        self.markers = [item for item in self.markers if (item["Key"], item["VersionId"]) not in keys]
        return {"Deleted": Delete["Objects"]}

    def list_object_versions(self, Bucket, Prefix, MaxKeys):
        return {"Versions": self.versions, "DeleteMarkers": self.markers}

    def list_objects_v2(self, Bucket, Prefix, MaxKeys):
        return {"Contents": []}


class ObjectStorageTest(unittest.TestCase):
    def test_rejects_private_traversal_and_symlink_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'visible.txt').write_text('visible')
            (root / '.secret').write_text('secret')
            (root / 'link').symlink_to(root / 'visible.txt')
            for path in (root / '.secret', root / 'link', root / 'missing'):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    object_storage._relative(root, path)
            for relative in ('../outside', '/absolute', '.hidden/file'):
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    object_storage._key('alice', 'a' * 32, relative)
            with self.assertRaises(ValueError):
                object_storage._key('../alice', 'a' * 32, 'visible.txt')

    def test_restore_rejects_corrupt_content_and_cleans_temporary_file(self):
        client = FakeS3()
        session_id = 'a' * 32
        key = object_storage._key('alice', session_id, 'nested/file.txt')
        client.objects[key] = (b'corrupt', {'sha256': 'wrong'})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'BOB_S3_BUCKET': 'test'}), \
             patch.object(object_storage, '_client', return_value=client), \
             patch.object(object_storage, 'personal_session', return_value=True):
            root = Path(directory)
            with self.assertRaisesRegex(OSError, 'checksum mismatch'):
                object_storage.restore_file('alice', session_id, root, 'nested/file.txt')
            self.assertFalse((root / 'nested/file.txt').exists())
            self.assertFalse((root / 'nested/file.txt.s3-download').exists())

    def test_disabled_storage_neither_reads_nor_deletes(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(object_storage, '_client') as client:
            self.assertEqual(object_storage.list_objects('alice', 'a' * 32), [])
            self.assertEqual(object_storage.delete_conversation_objects('alice', 'a' * 32), 0)
            self.assertIsNone(object_storage.restore_file('alice', 'a' * 32, Path('/unused'), 'file'))
            client.assert_not_called()

    def test_upload_archive_restore_and_skip_unchanged(self):
        client = FakeS3()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BOB_S3_BUCKET": "test"}), \
             patch.object(object_storage, "_client", return_value=client), \
             patch.object(object_storage, "_mark_backed"), \
             patch.object(object_storage, "personal_session", return_value=True):
            root = Path(directory)
            file = root / "presentation.html"
            file.write_text("<h1>Deck</h1>")
            (root / ".history.jsonl").write_text("private")
            session_id = "a" * 32
            self.assertEqual(object_storage.sync_workspace("alice", session_id, root), 1)
            self.assertEqual(object_storage.sync_workspace("alice", session_id, root), 1)
            self.assertEqual(client.uploads, 1)
            self.assertEqual(len(object_storage.list_objects("alice", session_id)), 1)
            file.write_text("changed since upload")
            self.assertFalse(object_storage.evict_verified_file("alice", session_id, root, file))
            self.assertTrue(file.exists())
            file.write_text("<h1>Deck</h1>")
            self.assertTrue(object_storage.evict_verified_file("alice", session_id, root, file))
            self.assertFalse(file.exists())
            self.assertEqual(object_storage.restore_file("alice", session_id, root, "presentation.html"), file)
            self.assertEqual(file.read_text(), "<h1>Deck</h1>")
            self.assertIsNone(object_storage.restore_file("alice", session_id, root, "missing.html"))
            history = root / ".history.jsonl"
            object_storage.backup_history("alice", session_id, root)
            history.unlink()
            object_storage.restore_history("alice", session_id, root)
            self.assertEqual(history.read_text(), "private")

    def test_deletes_prior_versions_and_delete_markers(self):
        client = FakeVersionedS3()
        with patch.dict(os.environ, {"BOB_S3_BUCKET": "test"}), patch.object(object_storage, "_client", return_value=client):
            self.assertEqual(object_storage.delete_conversation_objects("alice", "a" * 32), 3)
            self.assertEqual(client.versions, [])
            self.assertEqual(client.markers, [])

    def test_refuses_to_claim_success_when_office_suite_rejects_delete(self):
        class LockedS3(FakeVersionedS3):
            def delete_objects(self, Bucket, Delete):
                return {"Errors": [{"Key": Delete["Objects"][0]["Key"], "Code": "AccessDenied"}]}
        client = LockedS3()
        with patch.dict(os.environ, {"BOB_S3_BUCKET": "test"}), patch.object(object_storage, "_client", return_value=client):
            with self.assertRaises(OSError):
                object_storage.delete_conversation_objects("alice", "a" * 32)


if __name__ == "__main__":
    unittest.main()
