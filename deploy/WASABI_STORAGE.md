# Minimize local storage with Wasabi

Workspace and project files, Bob state files and knowledge source documents can
now store their bytes in a private Wasabi/S3 bucket. PostgreSQL retains ownership,
file size/checksum, object references, conversation history, job events, users,
settings, knowledge text and embeddings. Existing database bytes remain readable.

## Configure

Add to the ignored root `.env` (never put credentials in chat or source control):

```dotenv
BOB_FILE_STORAGE=s3
BOB_S3_BUCKET=YOUR_PRIVATE_BUCKET
BOB_S3_ENDPOINT=https://YOUR_WASABI_REGION_ENDPOINT
BOB_S3_REGION=YOUR_REGION
BOB_S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY
BOB_S3_SECRET_ACCESS_KEY=YOUR_SECRET_KEY
```

Use the same bucket access configuration for the API, chat worker and knowledge
worker. Both Compose files pass these settings. The knowledge image needs the
updated `requirements-knowledge.txt`, which includes boto3.

New writes use random immutable objects. Upload and read-back SHA-256 verification
finish before the SQL reference commits. Existing small files are also moved by
the migration, rather than maintaining a permanent local cache. Downloads and
previews fetch bytes directly; jobs restore only temporary workspaces. Identical
file writes reuse the existing reference.

## Migrate existing data

Let active jobs finish and stop the three application services. Preserve the
local PostgreSQL service and volume. Keep a verified database backup until the
new storage has been verified. A backup may be held on another server or in
Wasabi rather than permanently on your laptop.

```sh
docker compose stop bob-agent bob-worker knowledge-worker
docker compose build bob-agent bob-worker knowledge-worker
# Preview the number of remaining database files and bytes:
docker compose run --rm --no-deps bob-agent python3 -m app.migrate_blobs
# Upload each file, verify it, and release its BYTEA in one transaction:
docker compose run --rm --no-deps bob-agent python3 -m app.migrate_blobs --apply
# Verify all workspace and knowledge file bytes again:
docker compose run --rm --no-deps bob-agent python3 -m app.migrate_blobs --verify
docker compose up -d --no-build bob-agent bob-worker knowledge-worker
```

Migration is resumable and processes one file at a time. A failed upload or
verification preserves that file's original database bytes. Files already moved
are skipped on rerun. Check old history, file downloads, project editing and a new
chat after restart. Test knowledge downloads and indexing too.

Changing `BOB_FILE_STORAGE` back to `postgres` makes new writes inline; existing
remote files still need bucket credentials and remain remotely readable. It does
not copy migrated bytes back. Preserve bucket access and backups.

## Deletion and cleanup

SQL triggers queue obsolete objects when a file is replaced or deleted, including
project/conversation deletions and workspace saves. The chat worker cleans the
queue every five minutes after a 24-hour grace period, checking that no live file
or knowledge record references the object. Failed cleanup is retried. Interrupted
uploads/rolled-back transactions also get cleanup records. To run a batch manually:

```sh
docker compose run --rm --no-deps bob-agent python3 -m app.migrate_blobs --gc
```

Use an unversioned live-data bucket if you want physical object deletion with this
collector. Bucket versioning, Object Lock and backup retention can preserve older
copies independently; configure backup storage separately. Existing legacy
archive objects are not deleted by this migration.

## Reclaim physical disk space

Removing BYTEA leaves reusable PostgreSQL page space; it does not immediately
shrink the Docker database volume. After migration and verification, stop all
application services and compact the file tables during this maintenance window:

```sh
docker compose exec -T postgres psql -U bob -d bob -v ON_ERROR_STOP=1 \
  -c 'VACUUM FULL bob_storage_files;'
docker compose exec -T postgres psql -U bob -d bob -v ON_ERROR_STOP=1 \
  -c 'VACUUM FULL bob_knowledge_documents;'
```

These commands lock their tables and need temporary disk space for rewriting.
Restart the application services afterward. Never remove PostgreSQL while it
still holds the only copy of history and metadata.

For the smallest local footprint, also move PostgreSQL using
[REMOTE_DATABASE.md](REMOTE_DATABASE.md), then deploy the workers and their model
images on a server. Wasabi alone cannot run the database, containers or models.
Local frontend `node_modules` are unnecessary for Docker deployment; reinstall
with `npm ci` only when using the local frontend development tools.

References:
- https://docs.wasabi.com/apidocs/wasabi-api
- https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work

## Recovery backup

The deployment's verified full database recovery backup is under `bob-backups/`
in Wasabi. Its exact key, byte count and SHA-256 are recorded in the ignored
`.bob-private/storage-migration.json`. This backup includes account records,
conversation history and integration settings, in addition to inline file bytes.
Keep it private. Download it with an authenticated S3 client and restore with
PostgreSQL 17's `pg_restore --no-owner --no-acl --exit-on-error` into an empty
database. Preserve runtime `.env` configuration and the bucket credentials.

The pre-migration backup contains original inline file bytes and can restore
that snapshot independently of the new live object references. Subsequent backups
of the database will contain Wasabi references instead; those backups also need
the referenced objects to be retained.
