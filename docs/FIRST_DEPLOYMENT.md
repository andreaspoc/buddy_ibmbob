# Buddy: first deployment

This guide starts a **new installation with main Buddy AI chat**, then adds Office Suite and people chat when needed. All components use **one PostgreSQL instance and one database**. Each add-on has its own package, Docker image and schema.

Use this guide in a new deployment directory. Do not overwrite an existing installation's `.env`, database credentials, volumes or deployment manifest. For upgrades and schema migration, see [Feature services and releases](feature-plugin-services.md).

## 1. Prepare the host

Install:

- Docker Engine and Docker Compose v2, with support for profiles and `up --wait`.
- Python 3.11 or newer on the host, for the deployment helper.
- The complete Buddy source/release directory, including `app`, `web`, `frontend`, `plugins`, `workspace`, Dockerfiles and Compose files.
- A valid Bob API key for AI requests.

The build needs outbound access to its image registries, package repositories and the Bob installer. The local deployment also downloads its embedding model on first startup. Runtime needs access to the configured Bob API and any enabled external integrations.

From the deployment directory, confirm Docker access:

```bash
docker version
docker compose version
python3 --version
```

The account running deployment must be able to access the Docker daemon. Size the host for the enabled services and expected workload; the Compose resource limits are configuration defaults, not a measured capacity guarantee. Office and document indexing add substantial work beyond main chat.

## 2. Choose where PostgreSQL runs

Choose one approach:

| Deployment | Database location | Helper option |
| --- | --- | --- |
| Bundled PostgreSQL | One PostgreSQL container on this host | Default |
| Existing PostgreSQL | Your existing PostgreSQL server and one Buddy database | `--remote` |

Do not combine `docker-compose.yml` and `docker-compose.remote.yml`. The helper selects the correct base file.

Database organization:

| Schema | Contents |
| --- | --- |
| `public` | Shared login, AI conversations, jobs, notes and storage metadata |
| `office` | Office files, folders, permissions and editor sessions |
| `people_chat` | People-chat rooms, messages, reactions, tasks and away replies |

Core-only installation does not initialize the add-on schemas. Enabling an add-on initializes its own schema before it reports ready. No separate database is created for Office or people chat. The configured database role must be able to create and alter the required tables, indexes and schemas. The initial deployment shares that role; schemas organize ownership of features, rather than enforce separate database security boundaries.

## 3. Create the environment file

For a fresh directory:

```bash
cp -n .env.example .env
chmod 600 .env
mkdir -p .bob-private
chmod 700 .bob-private
```

Edit `.env` in a text editor. Do not paste real credentials into documentation or commit the file.

### Bundled PostgreSQL

Generate a password locally:

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Use that same generated value in both PostgreSQL settings below. Every `REPLACE_...` value is a placeholder:

```dotenv
BOB_API_KEY=REPLACE_WITH_BOB_API_KEY
BOB_TEAM_ID=

POSTGRES_USER=bob
POSTGRES_DB=bob
POSTGRES_PASSWORD=REPLACE_WITH_GENERATED_HEX
DATABASE_URL=postgresql://bob:REPLACE_WITH_GENERATED_HEX@postgres:5432/bob

BOB_PORT=3000
BOB_ALT_PORT=8080
PUBLIC_BASE_URL=http://REPLACE_WITH_SERVER_HOSTNAME:3000
DEFAULT_TIMEZONE=Europe/London

BOB_FILE_STORAGE=postgres
BUDDY_OFFICE_ENABLED=0
BUDDY_PEOPLE_ENABLED=0
```

`postgres` is the internal Docker hostname; browsers use `PUBLIC_BASE_URL`. A hexadecimal password avoids URL-encoding ambiguity. If you choose another password, percent-encode special characters in `DATABASE_URL` while keeping the original value in `POSTGRES_PASSWORD`.

### Existing PostgreSQL

Set the same application settings, but point `DATABASE_URL` to your existing server:

```dotenv
DATABASE_URL=postgresql://REPLACE_WITH_USER:REPLACE_WITH_URL_ENCODED_PASSWORD@REPLACE_WITH_DB_HOST:5432/REPLACE_WITH_DATABASE
PUBLIC_BASE_URL=https://REPLACE_WITH_BUDDY_HOSTNAME
```

The database must already exist and be reachable from the Docker network. Use the TLS connection parameters required by your database administrator. The remote Compose file does not start PostgreSQL or Ollama. If embedding/indexing is required, configure a reachable `BOB_OLLAMA_URL` with the configured embedding model.

## 4. Configure login

Choose your login method before onboarding users.

### Local accounts

For local account setup, leave Keycloak settings empty and explicitly enable local login:

```dotenv
KEYCLOAK_ISSUER=
KEYCLOAK_CLIENT_ID=
KEYCLOAK_CLIENT_SECRET=
BOB_LOCAL_LOGIN_ENABLED=1
```

After deployment, open Buddy and create the first administrator account. Local passwords must contain at least 12 characters.

### Company Keycloak login

Set your realm issuer, client and secret:

```dotenv
KEYCLOAK_ISSUER=https://REPLACE_WITH_IDENTITY_HOST/realms/REPLACE_WITH_REALM
KEYCLOAK_CLIENT_ID=REPLACE_WITH_CLIENT_ID
KEYCLOAK_CLIENT_SECRET=REPLACE_WITH_CLIENT_SECRET
KEYCLOAK_REDIRECT_URI=https://REPLACE_WITH_BUDDY_HOSTNAME/auth/keycloak/callback
BOB_LOCAL_LOGIN_ENABLED=0
```

Configure the Keycloak client with client authentication and standard authorization-code flow enabled. Register the exact callback above as a valid redirect URI. If Web origins are restricted, include the Buddy origin.

The first account on an empty installation becomes administrator. For a designated new Keycloak administrator, configure `KEYCLOAK_ADMIN_SUBJECTS` with its exact subject before the account's first sign-in. Do not allow general onboarding before the intended administrator signs in.

Local and Keycloak accounts have separate identities and private histories. Switching login providers does not merge accounts. Microsoft connection settings are optional integrations after Buddy login; they are not the Buddy login provider.

## 5. Start main Buddy chat

### Local database, HTTP bootstrap

Check configuration, then build and deploy:

```bash
python3 scripts/deploy_buddy.py --features --check
python3 scripts/deploy_buddy.py --features --build-runtime --build
```

Here `--features` with no names means **core only**. On a new installation it starts:

- `bob-agent`: UI, login, AI chat and shared features.
- `bob-worker`: background AI jobs and existing shared background tasks.
- `postgres`: the single bundled database server.
- Local embedding services and their first-start model initialization.

Office, ONLYOFFICE, people chat and its worker remain off. The shared runtime image is a base image, not another running service. Host Node/npm and Python application dependencies are not required for these Docker builds.

The first build and model download can take time. If the helper times out while dependencies are still initializing, inspect their logs and rerun the deployment command after resolving the cause; do not delete database volumes.

### Existing PostgreSQL

Use the remote selection on first deployment:

```bash
python3 scripts/deploy_buddy.py --features --remote --check
python3 scripts/deploy_buddy.py --features --remote --build-runtime --build
```

## 6. Enable HTTPS

For the bundled HTTPS proxy:

1. Point the chosen hostname at this server.
2. Place the trusted certificate chain at `deploy/https/certs/fullchain.pem` and its private key at `deploy/https/certs/privkey.pem`.
3. Set `PUBLIC_BASE_URL=https://YOUR_HOSTNAME` in `.env`.
4. Update the Keycloak callback registration and `KEYCLOAK_REDIRECT_URI` to that HTTPS origin, when Keycloak is enabled.
5. Deploy with HTTPS:

```bash
python3 scripts/deploy_buddy.py --https --check
python3 scripts/deploy_buddy.py --https
```

You can use `--https` on the initial build command instead, once certificates and callbacks are ready. For an existing database, combine it with `--remote` on that initial command.

The HTTPS overlay enables secure Buddy session cookies. Use the HTTPS address afterward. It keeps HTTP listeners on ports 3000 and 8080; restrict those listeners appropriately at your network boundary. Port 443 serves the HTTPS proxy. See [HTTPS configuration](../deploy/https/README.md) for proxy details; use this guide's deployment helper for the modular installation.

## 7. Verify the core installation

Open the configured Buddy URL and:

1. Complete first-admin setup or sign in through Keycloak.
2. Create a conversation, send a short AI request and confirm a streamed response.
3. Refresh and reopen the conversation; verify its history remains available.
4. Sign out and sign back in.
5. Confirm Office and people-chat launchers are absent until enabled.

Check readiness:

```bash
docker compose ps
docker compose logs --tail 80 bob-agent bob-worker
curl --fail https://YOUR_HOSTNAME/ready
```

For HTTP bootstrap, use `http://YOUR_HOSTNAME:3000/ready`. A successful readiness request verifies application/database availability; the real AI request verifies your Bob credentials and upstream access.

The helper saves feature selection, HTTPS and local/remote mode in `deploy/buddy-installation.json`. It contains no credentials. Later helper runs retain omitted choices. Preserve this file on the deployment host; do not ship another installation's manifest as a first-install default.

### How apps appear in the interface

Open **Apps** in the top navigation or Settings menu. Built-in tools appear under **Included with Buddy**; enabled Office, people chat and permitted Docmost appear under **Installed apps**. Existing direct buttons and the command palette remain available. Office is excluded on mobile. The list refreshes on browser focus and every 30 seconds while visible, with a manual Refresh button.

Additional deployed applications can register a launcher through an administrator-managed JSON file under `deploy/apps`. Their links then appear in Apps and workspace commands without a frontend rebuild. See [App registration](../deploy/apps/README.md). A launcher registration does not install the application or grant access within it.

## 8. Add people chat

People chat uses the existing login and database. From core only:

```bash
python3 scripts/deploy_buddy.py --features people --check
python3 scripts/deploy_buddy.py --features people --build
```

This starts `people-plugin` and `people-worker`, initializes `people_chat`, and enables the launcher. Core stops owning the away-reply loop. People-chat attachment bytes remain in PostgreSQL; shared files follow the existing storage backend.

Verify a direct conversation or channel, sending/receiving a message, an attachment, unread state, and reconnect after refresh.

## 9. Add Office Suite

Configure Wasabi/S3 and a stable editor JWT secret:

```dotenv
BOB_S3_BUCKET=REPLACE_WITH_EXISTING_OR_NEW_BUCKET
BOB_S3_ENDPOINT=https://REPLACE_WITH_S3_ENDPOINT
BOB_S3_REGION=REPLACE_WITH_BUCKET_REGION
BOB_S3_ACCESS_KEY_ID=REPLACE_WITH_ACCESS_KEY
BOB_S3_SECRET_ACCESS_KEY=REPLACE_WITH_SECRET_KEY
OFFICE_JWT_SECRET=REPLACE_WITH_RANDOM_64_CHARACTER_SECRET
```

Generate the editor secret with the same hexadecimal generator used above. Office always needs S3/Wasabi configuration, even when core uses `BOB_FILE_STORAGE=postgres`. Use bucket permissions that support the required upload/download/delete operations.

From core only:

```bash
python3 scripts/deploy_buddy.py --features office --check
python3 scripts/deploy_buddy.py --features office --build
```

If people chat is already enabled, retain it explicitly:

```bash
python3 scripts/deploy_buddy.py --features office people --build
```

The local deployment starts `office-plugin` and the existing ONLYOFFICE server. Office initializes the `office` schema. Keep the editor secret and persistent editor volumes stable.

For `--remote` deployments, the remote base does not start ONLYOFFICE. Configure `OFFICE_INTERNAL_URL` for a reachable document server, with matching JWT configuration. Its network must also reach Buddy's source/callback address; the default is `http://bob-agent:8080`. A server on another machine needs network/DNS routing for that address before editing will work. An external PostgreSQL server by itself does not provide an Office document server.

Verify uploading a file, opening it, making an edit, saving, closing and reopening it. Also verify an Office reference in Buddy chat and a saved research export. Office editing remains desktop-only; mobile retains the existing non-Office experience.

**Feature selection replaces the full list.** If both components should remain enabled, use `--features office people`. Omitting `--features` retains the saved selection.

## 10. Update and operate the installation

Rebuild/deploy the current selection:

```bash
python3 scripts/deploy_buddy.py --build
```

Release one existing component without recreating the others:

```bash
python3 scripts/deploy_buddy.py --only core --build
python3 scripts/deploy_buddy.py --only office --build
python3 scripts/deploy_buddy.py --only people --build
```

Use `--only` only for an enabled component on an installation with saved choices. To change enabled components, run without `--only`. The Office and people images share the pinned runtime SDK image; rebuild that image with `--build-runtime` when intentionally changing shared SDK code or dependencies, then rebuild the affected service images.

For prebuilt registry releases, set the corresponding `BUDDY_*_IMAGE` tags in `.env` and use `--pull` instead of `--build`. The project must first publish those images to your registry; placeholder local tags do not imply a hosted release exists.

Core-only services can be inspected with plain Compose commands. To include optional services when inspecting a local deployment with both enabled:

```bash
docker compose -f docker-compose.yml -f docker-compose.office.yml -f docker-compose.people.yml -f docker-compose.https.yml --profile office --profile people ps
docker compose -f docker-compose.yml -f docker-compose.office.yml -f docker-compose.people.yml -f docker-compose.https.yml --profile office --profile people logs --tail 80 office-plugin people-plugin people-worker
```

Omit the HTTPS file for HTTP deployments. For an existing database deployment, replace the first file with `docker-compose.remote.yml`. Prefer the helper for deployment changes so saved feature choices and routing stay aligned. The helper also retains the previous release’s hashed frontend assets in `.bob-private/frontend-assets` before replacing core. Buddy serves these as a fallback so tabs opened before deployment can still load Office and other deferred modules. Keep this directory with the existing persistent `.bob-private` mount.

Before upgrades, back up PostgreSQL, `.env`, the deployment manifest, required workspace/private runtime configuration, and editor volumes. Retain previous image tags. If using Wasabi, preserve the original bucket and object keys along with the database references. Protect all backup copies containing credentials or user content.

Do not use `docker compose down -v` for routine restarts: it removes named volumes. Do not change database passwords or database names in an existing volume by editing `.env` alone. Do not change an existing Office bucket to an empty bucket and expect existing documents to appear.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker socket permission denied | Run with an account authorized to access this host's Docker daemon. |
| Runtime image cannot be found | Build it first with `--build-runtime`; verify the configured `BUDDY_RUNTIME_IMAGE` tag. |
| Core remains unhealthy | Inspect core/PostgreSQL logs, database reachability, credentials and schema permissions. |
| Model initialization is slow/fails | Inspect `ollama-init` logs and outbound/model-service connectivity. Remote installations need their own configured embedding service. |
| Login loop after enabling HTTPS | Use the HTTPS URL, a trusted certificate and the exact registered callback. |
| Keycloak rejects the redirect URI | Compare the configured public origin/callback with the Keycloak client registration. |
| Add-on disappears after a deployment command | Check the saved feature selection; explicit `--features` replaces the previous list. |
| Office opens but documents do not load/save | Check Wasabi configuration, matching editor JWT secrets, editor-to-Buddy callback/source reachability and Office logs. |
| Chat works but documents remain unindexed | Check the optional knowledge worker and embedding service. Core-only deployment does not start the knowledge indexing worker. |

Document indexing is a separate optional worker. To add it, build/start `knowledge-worker` with the appropriate local or remote base Compose file and verify `BOB_OLLAMA_URL`; it reuses the same database and storage configuration. Docmost, Microsoft integrations, web search and SMTP are also optional and can be configured after the core installation is verified.

For service boundaries, compatibility, migration and rollback details, see [Feature services and releases](feature-plugin-services.md).
