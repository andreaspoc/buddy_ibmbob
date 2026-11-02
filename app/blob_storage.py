"""Verified S3 file bytes with PostgreSQL references and durable deferred cleanup."""
from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path
import stat

from psycopg import sql

from app import job_queue
from app.private_directories import private_directory, scratch_directory

TABLES = ('bob_storage_files', 'bob_knowledge_documents')


def enabled():
    backend = os.getenv('BOB_FILE_STORAGE', 'postgres')
    if backend not in ('postgres', 's3'):
        raise ValueError('BOB_FILE_STORAGE must be postgres or s3')
    if backend == 's3':
        for name in ('BOB_S3_BUCKET', 'BOB_S3_ENDPOINT', 'BOB_S3_ACCESS_KEY_ID', 'BOB_S3_SECRET_ACCESS_KEY'):
            if not os.getenv(name):
                raise ValueError(f'{name} is required for S3 file storage')
        return True
    return False


def _client():
    from app.s3_client import client
    return client()


def schema(db, table):
    if table not in TABLES:
        raise ValueError('Unsupported blob table')
    db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_blob_schema'))")
    name = sql.Identifier(table)
    db.execute(sql.SQL('ALTER TABLE {} ALTER COLUMN content DROP NOT NULL').format(name))
    for column, kind in (('object_key', 'TEXT'), ('object_bucket', 'TEXT'), ('size', 'BIGINT')):
        db.execute(sql.SQL('ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} {}').format(name, sql.Identifier(column), sql.SQL(kind)))
    db.execute(sql.SQL('UPDATE {} SET size=octet_length(content) WHERE size IS NULL AND content IS NOT NULL').format(name))
    db.execute('''CREATE TABLE IF NOT EXISTS bob_blob_gc (
        bucket TEXT NOT NULL, object_key TEXT NOT NULL,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
        PRIMARY KEY(bucket,object_key))''')
    # Triggers cover every existing SQL deletion path, including cascades and tree saves.
    db.execute('''CREATE OR REPLACE FUNCTION bob_queue_old_blob() RETURNS trigger AS $$
        BEGIN
            IF OLD.object_key IS NOT NULL AND
               (TG_OP='DELETE' OR OLD.object_key IS DISTINCT FROM NEW.object_key
                OR OLD.object_bucket IS DISTINCT FROM NEW.object_bucket) THEN
                INSERT INTO bob_blob_gc(bucket,object_key) VALUES(OLD.object_bucket,OLD.object_key)
                ON CONFLICT(bucket,object_key) DO UPDATE
                SET available_at=now() + interval '24 hours';
            END IF;
            RETURN NULL;
        END; $$ LANGUAGE plpgsql''')
    db.execute(sql.SQL('CREATE INDEX IF NOT EXISTS {} ON {} (object_bucket,object_key) WHERE object_key IS NOT NULL').format(sql.Identifier(table + '_blob_reference'), name))
    trigger = sql.Identifier(table + '_blob_cleanup')
    db.execute(sql.SQL('DROP TRIGGER IF EXISTS {} ON {}').format(trigger, name))
    db.execute(sql.SQL('CREATE TRIGGER {} AFTER DELETE OR UPDATE ON {} FOR EACH ROW EXECUTE FUNCTION bob_queue_old_blob()').format(trigger, name))
    constraint = sql.Identifier(table + '_blob_location')
    if not db.execute('SELECT 1 FROM pg_constraint WHERE conname=%s AND conrelid=%s::regclass',
                      (table + '_blob_location', table)).fetchone():
        db.execute(sql.SQL('''ALTER TABLE {} ADD CONSTRAINT {} CHECK (
            size IS NOT NULL AND size >= 0 AND (
                (content IS NOT NULL AND object_key IS NULL AND object_bucket IS NULL)
                OR (content IS NULL AND object_key IS NOT NULL AND object_bucket IS NOT NULL)))''').format(name, constraint))


def store(content, *, namespace, db):
    content = bytes(content)
    result = dict(content=content, object_key=None, object_bucket=None, size=len(content))
    if not enabled():
        return result
    # Random immutable objects keep replacement/rollback isolated from older file bytes.
    tenant = hashlib.sha256(namespace.encode()).hexdigest()
    key = f'bob-blobs/v1/{tenant}/{uuid.uuid4().hex}'
    bucket = os.environ['BOB_S3_BUCKET']
    db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('blob:' + bucket + ':' + key,))
    # Commit this registration independently: rollback after upload still leaves a cleanup record.
    with job_queue._connect() as registry:
        registry.execute('INSERT INTO bob_blob_gc(bucket,object_key) VALUES(%s,%s)', (bucket, key))
    digest = hashlib.sha256(content).hexdigest()
    try:
        _write_cache(digest, content)
    except Exception:
        pass
    _client().put_object(Bucket=bucket, Key=key, Body=content, Metadata={'sha256': digest})
    remote = dict(object_key=key, object_bucket=bucket, size=len(content), sha256=digest, content=None)
    read(remote, use_cache=False)  # Verify the uploaded object before releasing database bytes.
    return dict(content=None, object_key=key, object_bucket=bucket, size=len(content))


def _cache_dir() -> Path:
    base = Path(os.getenv('BOB_BLOB_CACHE_DIR', '/workspace/.cache/blobs'))
    try:
        return private_directory(base)
    except OSError:
        return scratch_directory('blob-cache')


def _cache_name(digest):
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('Invalid cache digest')
    return digest


def _write_cache(digest, content):
    target = _cache_dir() / _cache_name(digest)
    # Immutable digest entries: never follow or truncate a pre-existing entry.
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(content)


def _read_cache(digest):
    descriptor = os.open(_cache_dir() / _cache_name(digest), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise OSError('Cache entry is not a regular file')
        return stream.read()


def read(row, *, use_cache=True):
    sha = row.get('sha256')
    if sha:
        if use_cache:
            try:
                data = _read_cache(sha)
                if (row.get('size') is None or len(data) == row['size']) and hashlib.sha256(data).hexdigest() == sha:
                    return data
            except Exception:
                pass

    if row.get('object_key'):
        response = _client().get_object(Bucket=row['object_bucket'], Key=row['object_key'])
        body = response['Body']
        try:
            content = body.read()
        finally:
            body.close()
    elif row.get('content') is not None:
        content = bytes(row['content'])
    else:
        raise OSError('Stored file has no content or object reference')
    if row.get('size') is not None and len(content) != row['size']:
        raise OSError('Stored file size mismatch')
    if sha and hashlib.sha256(content).hexdigest() != sha:
        raise OSError('Stored file checksum mismatch')

    if sha:
        try:
            _write_cache(sha, content)
        except Exception:
            pass

    return content


def collect_garbage(limit=100):
    """Delete unreferenced objects after a grace period; retry failures next run."""
    deleted = 0
    with job_queue._connect() as db:
        if not db.execute("SELECT to_regclass('bob_blob_gc') AS name").fetchone()['name']:
            return 0
        candidates = db.execute('''SELECT bucket,object_key FROM bob_blob_gc
            WHERE available_at < now() ORDER BY available_at LIMIT %s''', (limit,)).fetchall()
    for item in candidates:
        with job_queue._connect() as db:
            lock = db.execute('SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS acquired',
                              ('blob:' + item['bucket'] + ':' + item['object_key'],)).fetchone()
            if not lock['acquired']:
                continue
            pending = db.execute('''SELECT 1 FROM bob_blob_gc WHERE bucket=%s AND object_key=%s
                AND available_at < now() FOR UPDATE SKIP LOCKED''', (item['bucket'], item['object_key'])).fetchone()
            if not pending:
                continue
            referenced = False
            for table in TABLES:
                if db.execute('SELECT to_regclass(%s) AS name', (table,)).fetchone()['name']:
                    referenced = bool(db.execute(sql.SQL('SELECT 1 FROM {} WHERE object_bucket=%s AND object_key=%s LIMIT 1').format(sql.Identifier(table)),
                                                 (item['bucket'], item['object_key'])).fetchone())
                    if referenced:
                        break
            if not referenced:
                _erase_object(_client(), item['bucket'], item['object_key'])
                deleted += 1
            db.execute('DELETE FROM bob_blob_gc WHERE bucket=%s AND object_key=%s', (item['bucket'], item['object_key']))
    return deleted


def _erase_object(client, bucket, key):
    """Remove every version of an unreferenced immutable cache object."""
    from botocore.exceptions import ClientError
    try:
        metadata = client.head_object(Bucket=bucket, Key=key).get('Metadata', {})
        digest = metadata.get('sha256', '')
        if len(digest) == 64 and all(c in '0123456789abcdef' for c in digest):
            (_cache_dir() / digest).unlink(missing_ok=True)
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') not in {'404', 'NoSuchKey', 'NotFound'}:
            raise
    found = False
    for page in client.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=key):
        versions = [{'Key': entry['Key'], 'VersionId': entry['VersionId']}
                    for entry in page.get('Versions', []) + page.get('DeleteMarkers', []) if entry['Key'] == key]
        if versions:
            found = True
            for start in range(0, len(versions), 1000):
                result = client.delete_objects(Bucket=bucket, Delete={'Objects': versions[start:start + 1000]})
                if result.get('Errors'):
                    raise OSError('Stored message cache deletion failed')
    if not found:
        client.delete_object(Bucket=bucket, Key=key)


def purge_message_caches(username, session_id):
    """Immediately erase unreferenced transcript blobs; failures remain queued."""
    import logging
    prefixes = ['bob-blobs/v1/' + hashlib.sha256(f'{username}:{scope}'.encode()).hexdigest() + '/'
                for scope in ('home:' + session_id, 'user')]
    pending = False
    # Older cache revisions have no reference row after replacement. This is a
    # disposable byte cache; flush its hashes so stale native transcripts cannot
    # survive deletion even when the primary backend stores bytes in PostgreSQL.
    for cached in _cache_dir().iterdir():
        if cached.is_file() and len(cached.name) == 64 and all(c in '0123456789abcdef' for c in cached.name):
            cached.unlink(missing_ok=True)
    with job_queue._connect() as db:
        if not db.execute("SELECT to_regclass('bob_blob_gc') AS name").fetchone()['name']:
            return False
        rows = db.execute('SELECT bucket,object_key FROM bob_blob_gc WHERE object_key LIKE %s OR object_key LIKE %s',
                          tuple(prefix + '%' for prefix in prefixes)).fetchall()
    for item in rows:
        try:
            with job_queue._connect() as db:
                db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('blob:' + item['bucket'] + ':' + item['object_key'],))
                referenced = False
                for table in TABLES:
                    if db.execute('SELECT to_regclass(%s) AS name', (table,)).fetchone()['name']:
                        referenced = bool(db.execute(sql.SQL('SELECT 1 FROM {} WHERE object_bucket=%s AND object_key=%s LIMIT 1').format(sql.Identifier(table)),
                                                    (item['bucket'], item['object_key'])).fetchone())
                        if referenced:
                            break
                if referenced:
                    continue
                # Keep the normal collector retryable if remote storage fails.
                db.execute('UPDATE bob_blob_gc SET available_at=now() WHERE bucket=%s AND object_key=%s', (item['bucket'], item['object_key']))
            with job_queue._connect() as db:
                db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('blob:' + item['bucket'] + ':' + item['object_key'],))
                # Immutable object references can be copied by branching between
                # transactions; check once more before deleting any bytes.
                if any(db.execute(sql.SQL('SELECT 1 FROM {} WHERE object_bucket=%s AND object_key=%s LIMIT 1').format(sql.Identifier(table)),
                                  (item['bucket'], item['object_key'])).fetchone()
                       for table in TABLES if db.execute('SELECT to_regclass(%s) AS name', (table,)).fetchone()['name']):
                    continue
                client = _client()
                _erase_object(client, item['bucket'], item['object_key'])
                db.execute('DELETE FROM bob_blob_gc WHERE bucket=%s AND object_key=%s', (item['bucket'], item['object_key']))
        except Exception:
            pending = True
            logging.getLogger(__name__).exception('Message cache cleanup queued for retry')
    return pending
