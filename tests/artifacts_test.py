"""Artifact revisions use one workspace mutation and reject stale writes."""
import contextlib
import hashlib
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from app.artifacts import ArtifactSave, save, validate

class Result:
    def __init__(self, row): self.row = row
    def fetchone(self): return self.row

class DB:
    def __init__(self, files): self.files = files
    def execute(self, sql, args): return Result(None if 'bob_job_events' in sql else self.files.get(args[2]))

class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.files = {'notes.md': {'content': b'original', 'sha256': hashlib.sha256(b'original').hexdigest()}}
        self.patches = [patch('app.artifacts.scope_for', return_value='session:test'), patch('app.artifacts.storage.mutation', side_effect=lambda *args: contextlib.nullcontext(DB(self.files))), patch('app.artifacts.storage._upsert', side_effect=self.upsert)]
        for p in self.patches: p.start()
    def tearDown(self):
        for p in reversed(self.patches): p.stop()
    def upsert(self, db, username, scope, path, content):
        self.files[path] = {'content': content, 'sha256': hashlib.sha256(content).hexdigest()}
    def test_original_preserved_and_restore_creates_revision(self):
        original = self.files['notes.md']['sha256']
        updated = save('alice', 'test', ArtifactSave(path='notes.md', content='updated', expected_sha256=original))
        restored = save('alice', 'test', ArtifactSave(path='notes.md', content='', expected_sha256=updated['sha256']), original)
        self.assertEqual(restored['content'], 'original')
        import json
        versions = json.loads(next(v['content'] for k, v in self.files.items() if k.startswith('.bob/')))
        self.assertEqual([v['content'] for v in versions], ['original', 'updated', 'original'])
    def test_stale_write_does_not_mutate(self):
        with self.assertRaises(HTTPException) as raised:
            save('alice', 'test', ArtifactSave(path='notes.md', content='bad', expected_sha256='a'*64))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.files['notes.md']['content'], b'original')
    def test_reserved_and_unsupported_paths(self):
        for path in ('../notes.md', '.bob/settings.json', 'image.png'):
            with self.assertRaises(ValueError): validate(path)

if __name__ == '__main__': unittest.main()
