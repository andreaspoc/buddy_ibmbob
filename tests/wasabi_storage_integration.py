"""Hybrid blob round trips against isolated PostgreSQL and an in-memory S3 service.

Run with DATABASE_URL configured. This never accesses a real object store or
modifies application records: all tables live in a disposable PostgreSQL schema.
"""
import asyncio
import hashlib
import io
import os
import secrets
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app import blob_storage, job_queue, postgres_storage as storage, artifacts, projects, rag, migrate_blobs


class MemoryS3:
    def __init__(self):
        self.objects = {}
        self.metadata = {}
        self.fail_put = False
        self.fail_delete = False
        self.deleted = []
        self.corrupt_put = False
        self.missing_put = False

    def put_object(self, *, Bucket, Key, Body, **kwargs):
        if self.fail_put:
            raise OSError('Injected object upload failure')
        self.objects[Bucket, Key] = bytes(Body)
        self.metadata[Bucket, Key] = kwargs.get('Metadata', {})
        if self.corrupt_put:
            self.objects[Bucket, Key] = b'corrupt upload'
        if self.missing_put:
            self.objects.pop((Bucket, Key))
        return {'ETag': hashlib.md5(bytes(Body)).hexdigest()}

    def get_object(self, *, Bucket, Key, **kwargs):
        return {'Body': io.BytesIO(self.objects[Bucket, Key])}

    def head_object(self, *, Bucket, Key, **kwargs):
        from botocore.exceptions import ClientError
        if (Bucket, Key) not in self.objects:
            raise ClientError({'Error': {'Code': '404', 'Message': 'Not found'}}, 'HeadObject')
        return {'Metadata': self.metadata.get((Bucket, Key), {})}

    def get_paginator(self, operation):
        assert operation == 'list_object_versions'
        class EmptyVersions:
            def paginate(self, **kwargs):
                return iter([{}])
        return EmptyVersions()

    def delete_object(self, *, Bucket, Key, **kwargs):
        if self.fail_delete:
            raise OSError("Injected cleanup failure")
        self.deleted.append((Bucket, Key))
        self.objects.pop((Bucket, Key), None)
        self.metadata.pop((Bucket, Key), None)
        return {}


def raw_file(username, scope, path):
    with job_queue._connect() as db:
        return db.execute('SELECT * FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s',
                          (username, scope, path)).fetchone()


def assert_raises(kind, fn):
    try:
        fn()
    except kind:
        return
    raise AssertionError(f'Expected {kind.__name__}')


def raw_document(document_id):
    with job_queue._connect() as db:
        return db.execute('SELECT * FROM bob_knowledge_documents WHERE id=%s', (document_id,)).fetchone()


def exercise_knowledge_and_migration(fake, username, scope):
    rag._schema_ready = False
    rag.ensure_schema()
    document = rag.add_document(username, 'shared', 'source.txt', b'original knowledge', 'source', admin=True)
    document_id = document['id']
    original = raw_document(document_id)
    assert original['content'] is None
    assert rag.get_document(username, 'shared', document_id)['content'] == b'original knowledge'
    assert rag.list_documents(username)[0]['size'] == len(b'original knowledge')
    assert rag.add_document(username, 'shared', 'duplicate.txt', b'original knowledge', admin=True)['id'] == document_id
    # Workers receive a raw remote reference; indexing must fetch the original bytes.
    assert rag.extract(original['filename'], blob_storage.read(original)) == [('text', 'original knowledge')]
    async def embed(client, chunk):
        return [dict(chunk, embedding=[1.0, 0.0])]
    with patch.object(rag, 'model_digest', AsyncMock(return_value='test-model')), \
            patch.object(rag, 'embed_passage', side_effect=embed), patch.object(rag, 'save_index') as saved:
        asyncio.run(rag.index_document(original))
        assert saved.call_args.args[1][0]['text'] == 'original knowledge'
        assert 'original knowledge' in saved.call_args.args[3]
    fake.fail_put = True
    try:
        assert_raises(OSError, lambda: rag.replace_document(username, 'shared', document_id, 'new.txt', b'failed', admin=True))
        assert_raises(OSError, lambda: rag.add_document(username, 'shared', 'failed.txt', b'failed new', admin=True))
    finally:
        fake.fail_put = False
    assert raw_document(document_id)['object_key'] == original['object_key']
    assert rag.get_document(username, 'shared', document_id)['content'] == b'original knowledge'
    rag.replace_document(username, 'shared', document_id, 'new.txt', b'replacement knowledge', admin=True)
    assert rag.get_document(username, 'shared', document_id)['content'] == b'replacement knowledge'
    assert raw_document(document_id)['object_key'] != original['object_key']
    assert rag.remove_document(username, 'shared', document_id, admin=True)
    assert rag.get_document(username, 'shared', document_id) is None

    with patch.dict(os.environ, {'BOB_FILE_STORAGE': 'postgres'}):
        storage.put_file(username, scope, 'migration.bin', b'migrate file')
        inline = rag.add_document(username, 'shared', 'migration.txt', b'migrate knowledge', admin=True)
    dry = migrate_blobs.migrate()
    assert dry['files'] == 3  # existing inline.txt plus the two migration fixtures
    assert raw_file(username, scope, 'migration.bin')['content'] is not None
    assert raw_document(inline['id'])['content'] is not None
    before = set(fake.objects)
    assert migrate_blobs.migrate() == dry
    assert set(fake.objects) == before, 'Dry run must not upload'
    fake.corrupt_put = True
    try:
        assert_raises(OSError, lambda: migrate_blobs.migrate(apply=True))
    finally:
        fake.corrupt_put = False
    assert bytes(raw_file(username, scope, 'migration.bin')['content']) == b'migrate file'
    assert bytes(raw_document(inline['id'])['content']) == b'migrate knowledge'
    fake.missing_put = True
    try:
        assert_raises(KeyError, lambda: migrate_blobs.migrate(apply=True))
    finally:
        fake.missing_put = False
    assert bytes(raw_file(username, scope, 'migration.bin')['content']) == b'migrate file'
    assert bytes(raw_document(inline['id'])['content']) == b'migrate knowledge'
    applied = migrate_blobs.migrate(apply=True)
    assert applied['files'] == dry['files'] and applied['bytes'] == dry['bytes']
    assert raw_file(username, scope, 'migration.bin')['content'] is None
    assert raw_document(inline['id'])['content'] is None
    assert storage.get_file(username, scope, 'migration.bin')['content'] == b'migrate file'
    assert rag.get_document(username, 'shared', inline['id'])['content'] == b'migrate knowledge'
    assert migrate_blobs.migrate(apply=True)['files'] == 0
    assert migrate_blobs.verify()['verified_files'] > 0
    corrupt = raw_document(inline['id'])
    remote = corrupt['object_bucket'], corrupt['object_key']
    fake.objects[remote] = b'corrupt'
    assert_raises(OSError, migrate_blobs.verify)
    fake.objects[remote] = b'migrate knowledge'
    assert rag.remove_document(username, 'shared', inline['id'], admin=True)


def exercise(fake):
    username, scope = 'blob-test', 'session:blob-test'
    from app.auth import create_user
    create_user(username, secrets.token_urlsafe(20), admin=True)
    storage.ensure_schema()
    storage.put_file(username, scope, 'nested/file.bin', b'\x00\xffremote')
    row = raw_file(username, scope, 'nested/file.bin')
    assert row['content'] is None, 'Remote files must leave no BYTEA copy'
    identity = row['object_bucket'], row['object_key']
    assert fake.objects[identity] == b'\x00\xffremote'
    assert storage.get_file(username, scope, 'nested/file.bin')['content'] == b'\x00\xffremote'
    assert storage.list_files(username, scope)[0]['size'] == 8
    with tempfile.TemporaryDirectory(prefix='bob-blob-test-') as directory:
        root = Path(directory)
        storage.restore_tree(username, scope, root)
        assert (root / 'nested/file.bin').read_bytes() == b'\x00\xffremote'
        (root / 'nested/file.bin').unlink()
        (root / 'result.txt').write_bytes(b'worker output')
        storage.save_tree(username, scope, root)
    assert storage.get_file(username, scope, 'nested/file.bin') is None
    assert storage.get_file(username, scope, 'result.txt')['content'] == b'worker output'
    old = raw_file(username, scope, 'result.txt')
    fake.fail_put = True
    try:
        assert_raises(OSError, lambda: storage.put_file(username, scope, 'result.txt', b'failed replacement'))
    finally:
        fake.fail_put = False
    assert raw_file(username, scope, 'result.txt')['object_key'] == old['object_key']
    assert storage.get_file(username, scope, 'result.txt')['content'] == b'worker output'
    remote = old['object_bucket'], old['object_key']
    fake.objects[remote] = b'corrupt'
    # Exercise an uncached download; a verified cached copy remains valid data.
    (blob_storage._cache_dir() / old['sha256']).unlink(missing_ok=True)
    assert_raises(OSError, lambda: storage.get_file(username, scope, 'result.txt'))
    fake.objects[remote] = b'worker output'
    with patch.dict(os.environ, {'BOB_FILE_STORAGE': 'postgres'}):
        assert storage.get_file(username, scope, 'result.txt')['content'] == b'worker output'
        storage.put_file(username, scope, 'inline.txt', b'inline')
        assert bytes(raw_file(username, scope, 'inline.txt')['content']) == b'inline'
    # Rollback after an upload must not create a database reference.
    before = set(fake.objects)
    try:
        with job_queue._connect() as db:
            storage._upsert(db, username, scope, 'rollback.txt', b'orphan')
            raise RuntimeError('Injected transaction rollback')
    except RuntimeError:
        pass
    assert storage.get_file(username, scope, 'rollback.txt') is None
    assert set(fake.objects) - before, 'Rollback scenario must upload an orphan'
    # Artifact history performs transactional reads, not only get_file reads.
    with patch.object(artifacts, 'scope_for', return_value=scope):
        first = artifacts.save(username, 'blob-test', artifacts.ArtifactSave(path='page.html', content='first'))
        second = artifacts.save(username, 'blob-test', artifacts.ArtifactSave(
            path='page.html', content='second', expected_sha256=first['sha256']))
        assert artifacts.read(username, 'blob-test', 'page.html')['content'] == 'second'
        versions = artifacts.history(username, 'blob-test', 'page.html')
        assert [v['content'] for v in versions] == ['first', 'second']
        restored = artifacts.save(username, 'blob-test', artifacts.ArtifactSave(
            path='page.html', content='', expected_sha256=second['sha256']), revision=first['sha256'])
        assert restored['content'] == 'first'
    # Project editing checks original bytes transactionally.
    project_id = secrets.token_hex(16)
    with projects.database() as db:
        db.execute('INSERT INTO projects(id,username,name,source) VALUES(%s,%s,%s,%s)',
                   (project_id, username, 'Blob test', 'empty'))
    project_scope = 'project:' + project_id
    storage.put_file(username, project_scope, 'app.py', b'original\n')
    assert projects.stored_read_file(username, project_id, 'app.py')['content'] == 'original\n'
    projects.stored_edit_file(username, project_id, 'app.py', 'changed\n', 'original\n')
    assert storage.get_file(username, project_scope, 'app.py')['content'] == b'changed\n'
    storage.delete_scope(username, project_scope)
    exercise_knowledge_and_migration(fake, username, scope)
    # An expired registration must never delete a live referenced object.
    with job_queue._connect() as db:
        db.execute("UPDATE bob_blob_gc SET available_at=now()-interval '1 day' WHERE bucket=%s AND object_key=%s", remote)
    blob_storage.collect_garbage()
    assert remote in fake.objects, 'Collector must preserve referenced objects'
    storage.delete_file(username, scope, 'result.txt')
    assert remote in fake.objects, 'Deletion must defer object cleanup'
    storage.delete_scope(username, scope)
    assert not storage.list_files(username, scope, internal=True)
    assert blob_storage.collect_garbage() == 0, 'Newly deleted blobs require the grace period'
    with job_queue._connect() as db:
        db.execute("UPDATE bob_blob_gc SET available_at=now()-interval '1 day'")
    fake.fail_delete = True
    assert_raises(OSError, lambda: blob_storage.collect_garbage(limit=100))
    with job_queue._connect() as db:
        assert db.execute('SELECT count(*) AS n FROM bob_blob_gc').fetchone()['n'] > 0, 'Failed cleanup must remain queued'
    fake.fail_delete = False
    assert blob_storage.collect_garbage(limit=100) > 0
    assert not fake.objects, 'Deleted and rollback-orphan objects must all be collected'
    return before


def main():
    original = os.environ['DATABASE_URL']
    schema = 'bob_blob_test_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    fake = MemoryS3()
    try:
        with tempfile.TemporaryDirectory(prefix='buddy-blob-test-cache-') as cache, patch.dict(os.environ, {
            'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'),
            'BOB_BLOB_CACHE_DIR': cache,
            'BOB_FILE_STORAGE': 's3', 'BOB_S3_BUCKET': 'isolated-test-bucket',
            'BOB_S3_ENDPOINT': 'https://s3.invalid', 'BOB_S3_ACCESS_KEY_ID': 'test',
            'BOB_S3_SECRET_ACCESS_KEY': 'test',
        }), patch.object(blob_storage, '_client', return_value=fake):
            exercise(fake)
            print('PASS: remote put/get/list/tree persistence, knowledge indexing and replacement, inline compatibility, migration dry run/apply/idempotence, migration corruption and missing object rollback, failed upload atomicity, checksum verification, rollback, artifact revisions, deferred deletion, orphan collection and live-reference protection')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
