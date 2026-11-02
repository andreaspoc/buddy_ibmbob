# Independent Office and people-chat releases

Buddy supports a core-only first installation, adding Office and people chat later, and updating one component without recreating the others. They use one PostgreSQL server and one database. Office owns the `office` schema; people chat owns `people_chat`; shared authentication, AI conversation history, jobs, notes, and storage metadata remain in `public`.

## Packages and images

| Component | Source | Image setting | Services |
| --- | --- | --- | --- |
| Core UI and AI chat | `app`, `web` | `BUDDY_CORE_IMAGE` | `bob-agent`, `bob-worker` |
| Office backend and editor assets | `plugins/office/buddy_office` | `BUDDY_OFFICE_IMAGE` | `office-plugin` |
| People chat and away replies | `plugins/people/buddy_people` | `BUDDY_PEOPLE_IMAGE` | `people-plugin`, `people-worker` |
| Shared SDK and Bob runtime | `app`, `Dockerfile.runtime` | `BUDDY_RUNTIME_IMAGE` | Base image only; no extra running container |

Office and people have separate Python distributions, Dockerfiles, versions, application entry points, and image tags. A plugin build skips the frontend build and does not include the other plugin package. The shared runtime image contains authentication, storage, notes/artifacts, ACP helpers, and legacy import adapters. Core does not install either feature package. Compatibility imports alias the real module, preserving shared state and existing monkeypatch contracts.

The user interface remains in the core shell, including its translations and existing design. UI changes still require a core UI release. Database schemas and shared SDK/API version 1 remain coordinated contracts: schema separation is not a database permission boundary, and destructive schema/API changes require a compatibility rollout. This does not create separate databases, a marketplace, or separate source repositories.

## First installation: main Buddy chat

1. Copy `.env.example` to `.env`. Configure `BOB_API_KEY`, `DATABASE_URL`, PostgreSQL credentials for the local deployment, `PUBLIC_BASE_URL`, and your login provider. Keep credentials out of source control. The database URL must point to the one database you intend to retain.
2. Build the shared runtime and core, then start only the main application:

```sh
python3 scripts/deploy_buddy.py --features --build-runtime --build
```

For an existing external PostgreSQL server, add `--remote`. For HTTPS, install the certificate/key under `deploy/https/certs` according to the existing HTTPS deployment, configure the canonical public URL, and add `--https`. No additional PostgreSQL database is provisioned for either plugin.

The local core starts its existing PostgreSQL and embedding-model dependencies. Office, ONLYOFFICE, people chat, and the people worker do not start. Plugin launchers are disabled. Shared tables initialize as their core features are used. Complete first-admin setup for local login, or sign in with the configured company identity provider.

The helper saves only feature choices, HTTPS, and local/remote selection in `deploy/buddy-installation.json`. It stores no secrets. On later runs, omitted choices retain the saved installation configuration. `--check` validates configuration without changing containers or saving choices.

## Add Office later

Configure the existing Wasabi bucket, endpoint, region and credentials (`BOB_S3_*`) and a stable `OFFICE_JWT_SECRET`. Office stores documents in S3/Wasabi even if `BOB_FILE_STORAGE=postgres` for core storage. Keep the bucket unchanged when upgrading: existing Office rows store object keys, without bucket names.

```sh
python3 scripts/deploy_buddy.py --features office --build
```

On a local deployment this also starts the existing ONLYOFFICE document server. On a remote deployment, configure `OFFICE_INTERNAL_URL` for your reachable document server; the remote base does not provision one. Its JWT secret must match Buddy. Keep the existing editor volumes and `OFFICE_CALLBACK_BASE_URL=http://bob-agent:8080`; the editor must reach this callback address on the deployment network.

Office initializes its schema before passing readiness. The helper validates required storage/JWT configuration. The core waits for Office readiness, then exposes its launcher and forwards its original public API/editor paths. No host port is exposed for the Office backend.

## Add people chat later

From a core-only installation:

```sh
python3 scripts/deploy_buddy.py --features people --build
```

If Office is already enabled, retain it in the selected feature list:

```sh
python3 scripts/deploy_buddy.py --features office people --build
```

People chat initializes its schema before readiness, then starts its durable away-reply worker. Existing Buddy sessions authenticate both services. People attachments retain PostgreSQL storage; shared conversation artifacts continue using the configured storage backend. The core worker does not run a duplicate away-reply loop.

`--features` explicitly replaces the enabled feature list. Omit it when updating the existing selection. Finish active editor saves before disabling Office. Removing a plugin stops its service after core routing is updated; its database schema, files and volumes remain intact for re-enabling.

## Release just one component

Set the appropriate versioned image tag in `.env`. Keep the shared runtime tag pinned unless intentionally releasing shared SDK changes. Then build/recreate only the selected component:

```sh
python3 scripts/deploy_buddy.py --only office --build
python3 scripts/deploy_buddy.py --only people --build
python3 scripts/deploy_buddy.py --only core --build
```

For a prebuilt registry image, use `--pull` in place of `--build`. An Office-only release targets only `office-plugin`; a people-only release targets its API and away worker. Core/UI and the other plugin retain their containers. Changing enabled features requires a full helper run, without `--only`.

Each plugin's release version is declared in its `pyproject.toml`, `__init__.py`, and Docker image label. Plugin manifests report the release version, shared runtime API version and database schema. Keep these aligned when releasing. The runtime image is built separately with `--build-runtime`; rebuilding it alone does not silently update already-built plugin images.

Direct Compose users can combine the local or remote base with `docker-compose.office.yml` / `docker-compose.people.yml`, their corresponding profiles, and the existing HTTPS override. `docker-compose.plugins.yml --profile plugins` remains a shorthand for both. Keep using the same overlays for subsequent deployments.

## Upgrade existing tables in public

The 2026-10-18 installation was backed up and migrated in place. Five Office and thirteen people-chat tables moved into their feature schemas. No rows, IDs or object keys were copied/replaced. `public.bob_chat_submissions` remains with AI conversation routing.

For another existing installation, build the new images first, back up the existing database, finish editor saves and active AI jobs, then stop core/plugin writers before applying the migration. Use a core image with the existing `DATABASE_URL`:

```sh
python3 -m app.feature_schemas --check
python3 -m app.feature_schemas --apply
```

Run these inside the deployment network/container environment. The migration uses one transaction, bounded locks, an explicit table allowlist and conflict detection. Duplicate source/target tables or unexpected relations are refused. Existing foreign keys, indexes, table identities and owned sequences are retained by PostgreSQL. Startup initialization creates missing feature tables on fresh installations; it does not move legacy tables automatically.

`scripts/verify_feature_schema_migration.py record FILE` before migration and `verify FILE` after migration check table identities/counts, foreign keys, owned sequences, conversation tables and a checksum of Office storage keys. Run while writers are stopped. Output contains no document content or raw object keys.

## Verification and rollback

After deployment, check readiness/HTTPS, authenticated existing file and room history, editor load/save/reopen, Office references and research export, attachments, WebSocket reconnect/logout, and a correlated AI turn. Transport/unit tests do not replace an interactive editor-save test. `tests/core_first_install_integration.py` exercises first setup/login and conversation creation in a disposable schema of the same database; it creates no database and removes the schema afterward.

Before a release, retain the prior image tags and a PostgreSQL backup. For an application-only rollback, pin compatible previous image tags and release the affected component. For a rollback to the old public-table layout, stop writers, use `python3 -m app.feature_schemas --rollback`, and deploy the corresponding old application images/configuration together. New qualified SQL cannot run against rolled-back table locations. The migration never drops feature schemas or user data. A backup restore is a recovery action, not a routine plugin toggle.

Shared storage credentials, Wasabi object keys, editor JWT secret, workspace/private runtime mounts, public URLs, cookies, room/message/conversation IDs, correlation/idempotency headers and streamed event bodies remain compatible. Core blob garbage collection retains its existing scope; Office revision objects are not added to that collector.

Upload read-back and `migrate_blobs --verify` bypass the local blob cache, ensuring a valid cached copy cannot mask a missing/corrupt remote upload. Normal reads retain checksum-validated caching. Storage integration tests use an in-memory S3 service, an isolated cache and a disposable schema; real Wasabi checks are read-only and reported separately.

## Projects portfolio plugin

`plugins/projects/buddy_projects` is an independent feature service (`bob-acp-projects:1.1.0`),
with schema `projects` and authenticated same-origin `/api/projects` transport. It uses only
verified identities provisioned after successful login through the configured Keycloak issuer.
It does not import the external realm directory or disable Keycloak accounts. Portfolio departures
are recorded availability changes. Administrators manage records; members see only assigned or
backup projects and visible dependency paths. No sample projects or people are seeded.

Add `projects` to the installation features, for example:

```sh
python3 scripts/deploy_buddy.py --features office people projects --https --build
```

For an existing installation, preserve its current feature, HTTPS and database choices. Direct Compose
users add `-f docker-compose.projects.yml --profile projects` to their existing Compose command.
The Projects interface uses the shared core CSS and therefore requires a core UI build on first install.
Subsequent backend releases can use `--only projects --build` after saving the feature configuration.

The plugin provides project and responsibility editing, backup coverage, directed dependencies,
nonmutating change previews, audited changes and historical impact evidence. Bob stays embedded
in the Projects workspace and uses the existing core chat runtime in a dedicated portfolio session.
Each request loads fresh caller-authorized context and forces the local Bob agent. Bob proposes
changes; this conversation does not expose portfolio mutation tools. Existing personal code-workspace
`/projects` are distinct from this portfolio service.

Verification: `plugins/projects/tests/test_impact.py`, `plugins/projects/tests/http_integration.py`,
`tests/test_projects_plugin_integration.py`, `tests/test_projects_workspace_browser.mjs`, and
`tests/projects_bob_browser.mjs`. Browser records/model output are explicitly synthetic; the PostgreSQL
HTTP checks roll back all test records.

### PM workspace and contextual Bob

Projects now opens on an operational overview of recorded overdue/blocked work, pending decisions,
missing active owners, backup gaps, recorded allocation and upcoming dates. The portfolio supports
status/owner/attention filtering. Each project has a work plan, risks/issues/decisions, people and
responsibilities, and dependency views. Task completion is shown only against recorded task counts,
not an invented overall project completion percentage. Date comparisons use UTC.

The `projects.work_items` table stores tasks, risks, issues and decisions with typed lifecycle status,
priority, owner, due date, description and resolution. Platform administrators create/reassign/delete
work and manage portfolio records. Assigned Keycloak work owners can update their own item's status
and resolution, without permission to edit its ownership, dates or priority. Work ownership also grants
read access to the associated project. Member-visible graph paths and impact history remain scoped.

Contextual Bob entry points are available on the overview, project, person, responsibility, dependency,
work item, impact finding and scenario views. `web/src/lib/portfolioBob.ts` loads a fresh authorized
snapshot and validates every focused record. Unsaved scenario questions re-run `/impact/preview`;
no apply route is called. The serialized scenario is explicitly marked unsaved. Context lookup failures
preserve the question; accepted turns stream through the existing dedicated portfolio conversation.
The assistant can draft project plans, review agendas, handovers and status updates from recorded facts.
Historical saved-change analyses and current findings are distinct.

Additional verification: `tests/portfolio_bob_context.mjs` tests record authorization, scenario filtering,
cancellation and context limits. PostgreSQL integration covers work lifecycle and owner-only updates.

### Projects URL and timeline

Browser navigation to `/projects` or `/projects/` opens the authenticated portfolio SPA. Existing
code-workspace JSON clients still receive their existing `/projects` response when requesting JSON
or using the default fetch Accept header. Responses vary on Accept and remain private/no-store.
The launcher, refresh, history navigation, sign-in return and embedded Bob preserve the portfolio URL.

Projects and work records support nullable `start_date` alongside `due_date`; when both are supplied,
the start cannot follow the due date. Old records retain unknown dates. The Timeline view uses those
recorded dates for Gantt bars, uses due-date markers when the duration is unknown, and keeps undated
items explicitly unscheduled. Timeline records can be discussed with contextual Bob. No dates,
durations or project completion percentages are synthesized.

### Projects layout hierarchy

The dedicated Projects workspace uses one integrated local navigation header; the Buddy chat toolbar
is not repeated above it. Portfolio selection opens a project detail workspace with a return action,
rather than stacking the full project list over its details. Work plan, risks/issues/decisions, people,
and dependencies appear as headed modules with their own relevant actions, without a second menu.
Cards use consistent grid gutters and surface boundaries, while related records use internal dividers.
The design follows Carbon MCP tile structure (16px content padding), 2x-grid layout modules,
spacing hierarchy, and contained-list row divider guidance:
https://carbondesignsystem.com/building-blocks/core/components/tile/specifications/#clickable-tile-structure
https://carbondesignsystem.com/building-blocks/foundations/2x-grid/guidelines/#layout-modules-and-micro-layouts
https://carbondesignsystem.com/building-blocks/core/components/contained-list/guidelines/#inset-row-dividers


## DecisionsBuddy

The fourth optional feature uses the `decisions` plugin ID, `/api/decisions` API prefix and a dedicated PostgreSQL `decisions` schema. It shares authentication and Wasabi configuration conventions with the other apps. Connector secrets and governance snapshots are database records, not local files.

Enable with `docker-compose.decisions.yml` or include `decisions` in `scripts/deploy_buddy.py --features`. The legacy saved installation feature name is normalized during deployment; successful deployments save the new name. See [DecisionsBuddy setup and cutover](decisionsbuddy.md).
