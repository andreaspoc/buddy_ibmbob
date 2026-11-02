"""Artifact attribution uses exact owned events and survives revision saves."""
import contextlib
import hashlib
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from app.artifact_provenance import generated_provenance
from app.artifacts import ArtifactSave, save, read, capture_generated_revisions, history_path


class Result:
    def __init__(self, row=None, rows=None): self.row, self.rows = row, rows
    def fetchone(self): return self.row
    def fetchall(self): return self.rows


class DB:
    def __init__(self): self.files, self.events, self.queries = {}, {}, []
    def execute(self, sql, args):
        self.queries.append((sql, args))
        if 'bob_job_events' in sql:
            return Result(self.events.get(tuple(args)))
        if 'path NOT LIKE' in sql:
            return Result(rows=[dict(v, path=k) for k,v in self.files.items() if not k.startswith('.')])
        return Result(self.files.get(args[2]))


class ArtifactProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.db = DB()
        self.patches = [patch('app.artifacts.scope_for', return_value='session:chat'),
            patch('app.artifacts.storage.mutation', return_value=contextlib.nullcontext(self.db)),
            patch('app.artifact_provenance.job_queue._connect', return_value=contextlib.nullcontext(self.db)),
            patch('app.artifacts.storage._upsert', side_effect=self.upsert),
            patch('app.artifacts.storage.get_file', side_effect=lambda u,s,p,**kw: self.db.files.get(p)),
            patch('app.artifacts.storage.blob_storage.read', side_effect=lambda row: row['content'])]
        for patcher in self.patches: patcher.start()
    def tearDown(self):
        for patcher in reversed(self.patches): patcher.stop()
    def upsert(self, db, user, scope, path, data):
        db.files[path] = {'content':data, 'sha256':hashlib.sha256(data).hexdigest(), 'size':len(data)}
    def generated(self):
        self.upsert(self.db, 'alice', 'session:chat', 'page.html', b'<p>generated</p>')
        digest = self.db.files['page.html']['sha256']
        self.db.events[('alice','chat','page.html',digest)] = {
            'event': {'correlation_id':'corr', 'user_message_id':'user-msg', 'assistant_message_id':'assistant-msg'},
            'created_at': datetime(2026,10,15,12,tzinfo=timezone.utc), 'id':12, 'job_id':'job'}
        return digest
    def test_exact_owner_path_hash_and_real_timestamp(self):
        digest = self.generated()
        provenance = generated_provenance('alice','chat','page.html',digest)
        self.assertEqual(provenance['created_at'], '2026-10-15T12:00:00+00:00')
        self.assertEqual(provenance['assistant_message_id'], 'assistant-msg')
        self.assertNotIn('tool_call_id', provenance)
        for args in [('other','chat','page.html',digest),('alice','other','page.html',digest),('alice','chat','other.html',digest),('alice','chat','page.html','a'*64)]:
            self.assertIsNone(generated_provenance(*args))
    def test_capture_only_final_matched_content_and_manual_revision(self):
        digest = self.generated()
        self.upsert(self.db,'alice','session:chat','legacy.md',b'unknown')
        capture_generated_revisions('alice','chat','session:chat',self.db)
        capture_generated_revisions('alice','chat','session:chat',self.db)
        versions = json.loads(self.db.files[history_path('page.html')]['content'])
        self.assertEqual(len(versions),1)
        self.assertEqual(versions[0]['created'], versions[0]['provenance']['created_at'])
        self.assertNotIn(history_path('legacy.md'), self.db.files)
        result = save('alice','chat',ArtifactSave(path='page.html',content='edited',expected_sha256=digest))
        self.assertEqual(result['provenance']['origin'],'manual')
        self.assertNotIn('correlation_id',result['provenance'])
        self.assertEqual(read('alice','chat','page.html')['provenance'],result['provenance'])
        restored = save('alice','chat',ArtifactSave(path='page.html',content='',expected_sha256=result['sha256']),digest)
        self.assertEqual(restored['provenance']['origin'],'restored')
        self.assertEqual(restored['provenance']['source_provenance']['job_id'],'job')
    def test_unattributed_legacy_source_stays_unknown(self):
        self.upsert(self.db,'alice','session:chat','legacy.md',b'unknown')
        self.assertIsNone(read('alice','chat','legacy.md')['provenance'])


if __name__ == '__main__': unittest.main()
