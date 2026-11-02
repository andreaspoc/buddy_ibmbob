# DecisionsBuddy

DecisionsBuddy is the renamed Decisions feature. The Python implementation is in
`app/decisions_buddy`, the Carbon frontend in `decisions-buddy`, and the optional
service distribution in `plugins/decisions`. The API namespace is
`/api/decisions`; the application opens at `/decisions/`.

## Persistence and identity

Models, immutable rule versions, governance snapshots, encrypted connection
credentials, mutation events and evaluation evidence are stored in the existing
PostgreSQL database, in the `decisions` schema. There is no runtime fallback to a
source-tree SQLite file and no automatic production example seeding.

The existing login/session is validated at core and feature-service boundaries.
Private models are owner/admin scoped; a shared read does not grant mutation
permission. Writes require the current version and use transactional row locks.
Graph changes invalidate approvals and synchronization evidence. Execution logs
are scoped to their actor except for administrators. Imported Python/JavaScript
function execution is disabled; rule expressions use a bounded AST interpreter.

Wasabi remains the shared binary-file backend (`BOB_FILE_STORAGE=s3`). Decision
definitions, governance records and settings are relational metadata, so they
remain in PostgreSQL. These changes do not claim that old inline file bytes have
already been migrated to Wasabi. See [Wasabi storage](../deploy/WASABI_STORAGE.md).

## Admin setup and governance

Open **DecisionsBuddy → Catalog governance → Administrator integration settings**.
The same settings accordion is available in the empty workspace to administrators.
Configure IKC and watsonx.data intelligence separately, save, then test each saved
connection. Password/API-key/token values are write-only and encrypted; keep the
service encryption key stable across restarts and replicas.

The workflow is: save draft → map each table field to an active business term →
synchronize the exact saved version to every enabled catalog service → submit
for review → obtain independent approval → publish. The author cannot approve
their own changes, including through an administrator override. Production-mode
evaluation requires a published production version and fresh matching evidence.
Simulation remains available before integration setup and never publishes data.

Changing terms, rules or connection settings invalidates the old release
evidence. Catalog synchronization confirms metadata registration; it does not
certify legal compliance or apply IBM data-protection rules to arbitrary runtime
records. Local lineage is a design document, not claimed Manta ingestion. See
[IBM integration details](decisions-cp4d.md).

## Docker deployment

The existing deployer supports all four plugins, preserves saved local/remote and
HTTPS choices, and recognizes the old saved `zen` choice as `decisions`:

```sh
python3 scripts/deploy_buddy.py --features office people projects decisions --check
python3 scripts/deploy_buddy.py --features office people projects decisions --build-runtime --build
```

The Decisions frontend is built into the core image. Its API can run embedded
(`BUDDY_DECISIONS_ENABLED=1`, plugin URL empty) or as the separate service selected
by `docker-compose.decisions.yml`. Existing Wasabi credentials are reused, not
overwritten. No database volume or bucket is removed by this deployment.

After deployment, verify container readiness, sign in as an administrator, save
and reopen a model, reopen saved connector settings, and test both actual IBM
connections. Check a second user cannot mutate a private model. These live checks
have not run in this workspace: Docker daemon access is denied.

## Legacy data cutover

Both legacy SQLite files are preserved privately in
`.bob-private/decisions-migration/embedded.sqlite3` and `standalone.sqlite3`, outside
the application-code mount exposed to model sandboxes. Only the embedded file
should normally be authoritative. Temporary old database-path aliases point to
the existing containers' `/root/.bob/decisions-migration/` private-state mount until
replacement; the aliases are excluded from new images. These container-path aliases
can be dangling on the development host. The new runtime never opens them.

Before exposing the PostgreSQL-backed feature to users, stop legacy writers and
take a consistent SQLite backup plus the normal verified PostgreSQL backup. Mount
the SQLite backup read-only into the new feature container and run:

```sh
python3 -m app.decisions_buddy.migrate_sqlite /migration/legacy.sqlite3 --check
python3 -m app.decisions_buddy.migrate_sqlite /migration/legacy.sqlite3 --apply
```

Run these commands in the configured runtime, with its existing `DATABASE_URL`.
The importer reads the source without modifying it, preserves versions and audit
IDs, refuses conflicting destination records, and commits target records in one
transaction. Rerunning the same content is idempotent. Historical synthetic CP4D
claims are marked unverified, not trusted as live synchronization evidence. No
live PostgreSQL migration has been performed during this change.

## Verification

The backend/security/storage/migration tests use explicitly synthetic adapters;
they are not evidence of a live PostgreSQL or IBM deployment. Current checks:

- 46 Python checks, including deployment feature selection, pass.
- Eight UI state/API-boundary checks and three Carbon Sass/source checks pass.
- Both production frontend builds pass using Node 24.
- All-plugin local/remote Compose definitions validate.
- Both legacy SQLite sources were validated read-only.

The [Carbon typography and spacing report](decisions-carbon.md) describes the
IBM Plex type hierarchy and spacing tokens used across the panels. New controls
use Carbon components and focus-managed confirmation dialogs. Full manual visual
and assistive-technology certification is not claimed by build/source tests.
