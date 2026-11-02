# Buddy

Security fixes and deployment requirements from the October 18 assessment are recorded in the [security remediation report](artifacts/security-remediation-2026-10-18.md). Hook testing is disabled, hook management requires an administrator, and presentation scripts run in an isolated live preview. Internal A2A destinations require explicit `BOB_A2A_ALLOWED_ORIGINS` configuration. Conditional findings remain unchanged.

For a new modular Docker installation, start with the [First deployment guide](docs/FIRST_DEPLOYMENT.md): core chat first, then optional Office and people chat using one PostgreSQL database.

A small test implementation that:

```text
Laptop / remote caller
        |
        | HTTP + A2A JSON-RPC
        v
 FastAPI bridge :8080
        |
        | ACP over stdin/stdout
        v
      bob acp (Bob run fallback if ACP rejects API-key auth)
        |
        +-- PostgreSQL: conversations, files, repositories, skills and settings
        +-- temporary tool workspace (removed after each run)
```

## What you need

You need a Bob API key. The Compose setup also uses a generated PostgreSQL password in the ignored local `.env` file.

IBM's current Bob Shell documentation uses `BOB_API_KEY` for API-key authentication in automation and other non-interactive environments.
The Compose service also maps it to `BOBSHELL_API_KEY`, which Bob's ACP mode checks.

## 1. Set the key

macOS/Linux:

```bash
export BOB_API_KEY='YOUR_BOB_KEY'
```

If you start Compose from a different terminal or tool, put `BOB_API_KEY=YOUR_BOB_KEY`
in a local `.env` file beside `docker-compose.yml` instead. This project ignores `.env`.
Add `POSTGRES_PASSWORD` there too (a long random value). The existing local setup already has one configured.

General Bob API keys also require `BOB_TEAM_ID=your-team-id` in `.env`. The bridge
passes it to Bob using `--team-id`. Inference API keys already include their team
context and do not require this setting. After changing it, recreate the API and
chat worker with `docker compose up -d --no-build bob-agent bob-worker`.

PowerShell:

```powershell
$env:BOB_API_KEY='YOUR_BOB_KEY'
```

Do **not** put the key in the Dockerfile or commit it.

## 2. Optional: review IBM's ACP license

The service uses Bob's `--accept-license` flag so the container can start unattended.

Before first start you can inspect the license with:

```bash
docker compose build
docker compose run --rm bob-agent bob --show-license acp
```

Starting the normal service records license acceptance inside the disposable container.

## 3. Start it

```bash
docker compose up --build
```

The service is then available from the laptop at:

```text
http://localhost:8080
```

### Queued Bob execution

The chat UI now writes Bob requests to PostgreSQL and streams persisted job events back to the browser. `bob-worker` runs the Bob process separately from the web request. Jobs have a 180-second renewable lease. New agent jobs are marked failed if a worker disappears; review possible external actions before submitting again. Jobs already queued before this change retain their previous retry budget and should be drained before rollout. At most one active job is accepted per conversation or shared project, and at most one job per user runs at a time to serialize work for each account.

`docker compose up -d --build` starts the API, PostgreSQL, and one worker. To run more workers for different users on this same host:

```bash
docker compose up -d --scale bob-worker=3
docker compose logs -f bob-worker
```

The browser keeps receiving the same NDJSON event types (`status`, `delta`, `tool`, `done`, `error`). A disconnected browser does not stop the job; an authenticated client can reconnect to `GET /jobs/<job-id>/events?after_id=<last-event-id>` using the job ID returned in the `X-Bob-Job-Id` response header. Opening an existing conversation automatically reconnects to its queued or running job, including after reloading its conversation URL. An unlinked home page still starts a blank chat. Conversation histories and files live in PostgreSQL. Each worker restores a private temporary workspace and commits its files before publishing completion; API and worker containers do not need a shared writable workspace. An interrupted job may already have performed external actions; review its work log and the target system before submitting again.

### Deleting a conversation

Use **✕** beside a conversation to remove its file bytes, history, jobs, events and Bob task records from PostgreSQL. Deleting a conversation linked to a project keeps the shared repository. Use the project delete button to delete its repository and all linked conversations. The **Files** section and generated page rows also have individual delete buttons. All operations enforce account ownership and refuse changes while a job is active in that conversation or project.

Deletion removes live database records, including `BYTEA` file contents. PostgreSQL reclaims dead row space through vacuuming; the database's physical files do not necessarily shrink immediately. Database backups and independently downloaded/exported copies follow their own retention policies. A minimal deletion marker remains to prevent late requests from recreating a deleted conversation.

Health check:

```bash
curl http://localhost:8080/health
```

Agent Card:

```bash
curl http://localhost:8080/.well-known/agent-card.json
```

## 4. Test the bundled Bob skill

The `/ask` and `/a2a` endpoints now require a signed-in user's session cookie. Sign in through the UI first; for curl, POST your username and password to `/auth/login` with `-c cookies.txt`, then pass `-b cookies.txt` to subsequent requests.

Open `http://localhost:8080/` to sign in, or `http://localhost:8080/register` to create an account. Each account has a separate workspace. The first account created is the administrator. The interface identifies the assistant as “Buddy” on the sign-in, registration, chat, and preview screens. The language selector supports English, Greek (Ελληνικά), Hindi (हिन्दी), and Maltese (Malti), and remembers the selection in this browser. The Maltese interface covers application controls, settings, quizzes, document previews, and presentation tools. Greek, Hindi, and Maltese set the default reply language for chat, research reports, and presentations; an explicit request for another output language takes priority.

Simple developer-friendly endpoint:

```bash
curl http://localhost:8080/ask \
  -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Briefly introduce yourself to Alice."}'
```

A successful skill activation should include:

```text
BOB_SKILL_OK
```

## 5. Call it using A2A JSON-RPC

```bash
curl http://localhost:8080/a2a \
  -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":"demo-1",
    "method":"message/send",
    "params":{
      "message":{
        "role":"user",
        "messageId":"laptop-msg-1",
        "parts":[
          {"kind":"text","text":"Briefly introduce yourself to Alice."}
        ]
      }
    }
  }'
```

There are ready-to-run examples in `examples/`.

## 6. Call it from another machine

Change Docker's published interface/firewall as appropriate and set the Agent Card URL:

```yaml
environment:
  PUBLIC_BASE_URL: "http://YOUR_HOSTNAME_OR_IP:8080"
```

Then the remote machine can POST to:

```text
http://YOUR_HOSTNAME_OR_IP:8080/a2a
```

For anything beyond a local/LAN test, put TLS + authentication in front of this service. Do not expose this demo directly to the public internet.

## Skills

Open [http://localhost:8080](http://localhost:8080) to chat with Bob. The first visitor creates the admin account; admins can add users from the sidebar. Each user has private conversations, project repositories and files. PostgreSQL stores accounts, sessions, conversation history, uploaded/generated file bytes, Git repositories, Bob task state, skills and settings in its persistent Docker volume. Previews and downloads retrieve bytes from their configured storage backend without a persistent local file cache.

### PostgreSQL file storage

By default, PostgreSQL stores file bytes as `BYTEA`. For minimal local storage, set `BOB_FILE_STORAGE=s3` and configure the `BOB_S3_*` settings to place workspace/project files and knowledge source bytes in Wasabi. PostgreSQL keeps ownership, size, checksum and object references, plus conversation history and knowledge indexes. See [Wasabi storage and verified migration](deploy/WASABI_STORAGE.md).

Bob and Git still require filesystem access while running. Each job/import/export gets a private temporary directory; generated files and repository changes are committed atomically before completion, then the temporary directory is removed. Failed and cancelled runs also save their files when the worker still owns its lease. Downloads and previews do not create a persistent file cache. Conversation PDF, DOCX, Markdown and text uploads are limited to 25 MB; other uploads remain limited to 50 MB. Stored/generated files are limited to 200 MB each.

Wasabi downloads share a process-local HTTPS connection pool across jobs. Workspace restores use up to eight download threads by default (`BOB_STORAGE_DOWNLOAD_WORKERS`, clamped to 1–16), with bounded pending work; every file still passes size and SHA-256 verification. The worker reads its restored skill catalog locally rather than downloading each skill again. Ordinary questions omit unrelated chart guidance, while analysis requests and ambiguous follow-ups retain it. No persistent file-content cache is introduced.

For an existing installation, stop Bob during migration. The first command previews the import; the second copies data and verifies every imported file while retaining the originals:

```bash
docker compose stop bob-agent bob-worker
docker compose run --rm --no-deps bob-agent python3 -m app.migrate_storage --private-home /root/.bob
docker compose run --rm --no-deps bob-agent python3 -m app.migrate_storage --apply --private-home /root/.bob
docker compose up -d bob-agent bob-worker
```

`--remove-local` additionally removes original user directories after commit and verification. Use it only when ready to remove those copies. An interrupted or repeated migration never overwrites a previously imported user's files. Directories lacking old conversation metadata are preserved as **Recovered conversation** records. Existing global generated files and the global Bob home belong to the administrator's legacy workspace. Retain shipped skills and presentation templates as application resources.

If old files exist only in Wasabi, provide the `BOB_S3_*` variables to the migration container; it retrieves and verifies missing copies before importing them. Existing remote objects are retained, so remove them separately if desired. Runtime operations use PostgreSQL metadata with either inline bytes or Wasabi objects, according to each file record.

Back up PostgreSQL to retain all application data. The workspace source directory contains shipped defaults and templates, rather than live conversation data.

Replies stream into the page. Each reply includes an expandable live work log with tool inputs and results. Generated HTML files appear under **Workspace Pages** and can be previewed or viewed as source. Bob can select a skill automatically; type `/` to choose one explicitly. The sidebar also lets you create skills and modes, register MCP servers, and select other A2A agents.

Skills created in the UI are stored in PostgreSQL and materialized at this relative path during tool runs:

```text
.bob/skills/<skill-name>/SKILL.md
```

Bob discovers project-local skills from `.bob/skills/`.

## Knowledge documents and local RAG

Administrators use **Knowledge base → Add sources**, or drop files into its upload area.
Choose a library and policy audience before uploading; use **Edit classification & description**
to change an existing document.
PDF, DOCX, UTF-8 TXT, Markdown, CSV, TSV and Excel files are supported (20 MB each).
Each document is available to **Everyone** or to one group created by an administrator.
Users without a matching group see only documents for everyone. If a group is deleted,
its documents become visible to administrators only. Ordinary chat attachments stay separate. External A2A agents do not automatically receive sources.

The dedicated `knowledge-worker` uses Docling to prepare PDF and Word documents
as Markdown, preserving document structure, tables and PDF page references.
English Tesseract OCR is enabled for scanned PDFs. Docling downloads its layout
and table models on the first PDF conversion and caches them in the
`bob-docling-models` Docker volume. The indexing container has a 4 GB memory
limit. TXT and Markdown files already contain text and bypass conversion.

Embeddings run through your local Ollama installation. Defaults are:

```dotenv
BOB_OLLAMA_URL=http://host.docker.internal:11434
BOB_EMBEDDING_MODEL=granite-embedding:278m
```

These defaults work with Docker Desktop on macOS when the container can reach
Ollama. For a remote Ollama server, set its reachable address in `.env`. On Linux,
configure a host gateway or use the Ollama service's container address.

Start or update the services with `docker compose up -d --build`. Keep Ollama
running. Watch preparation using `docker compose logs -f knowledge-worker`.
Wait until documents show **Ready**, then ask Bob a question. **Prepared text**
lets you review the extracted Markdown. **Retry/Reindex** rebuilds a document;
**Remove** deletes its original, prepared text and embedding passages.

Use `/rag <question>` to activate the bundled Bob RAG skill explicitly. Bob can
also select it for document requests and follow-up questions about the same source. It guides grounded answers, table
interpretation, citations, conflicting sources and incomplete evidence; retrieval
runs on demand when Bob determines the request needs document evidence. A change to an unrelated topic does not trigger retrieval. New bundled skills are copied into
existing users' workspaces on their next authenticated request without replacing
user-edited skills.

Bob uses the knowledge search command to retrieve up to six relevant passages when needed, including for contextual follow-ups, and cites the original documents. Source downloads require sign-in.
Pending and failed sources show their status while chats search ready sources.
If Ollama cannot search, the chat reports the retrieval error. Embedding model
digests are tracked; reindex after replacing or changing the model. Indexing
leases recover interrupted work once before reporting failure.

Original files, prepared text and normalized vectors are stored in PostgreSQL.
Deleting a conversation preserves shared sources. Only administrators can upload, classify, replace, or
remove a source; removal deletes its bytes, passages and saved citations.
This version uses exact cosine search over at most 5,000 shared passages
(200 documents and 500 passages per document), so no PostgreSQL extension or database image migration is required.
For substantially larger libraries, migrate the vector column and search to
pgvector. The default relevance cutoff is 0.25; evaluate it against your own
questions before treating missing matches as proof that a document lacks an
answer. Local embedding does not make Bob's inference local: retrieved excerpts
are passed to Bob to generate the response.

Authenticated document endpoints are under `/knowledge`, including upload/list,
`/{document-id}` deletion, `/{document-id}/retry`, source download at
`/{document-id}/file`, and prepared text at `/{document-id}/prepared`.
`POST /knowledge/search` searches source contents. Legacy session routes remain
compatible and enforce the same access rules. Chat, `/ask`, `/a2a`, research, and
workflow retrieval use current account assignments. Downloads, prepared text, and
citation previews check access too. Administrators can browse all source files for
classification; their chat retrieval uses the same group rules as everyone else.

Use **User groups & administrators** to create groups, add people to them, and manage
administrator access. A new installation starts with no groups. These assignments use stable Keycloak identities;
email domain and UI language do not grant group membership. Administrators can add
another administrator by selecting an existing account or reserving access for a
verified email at its next Keycloak sign-in. The last administrator cannot be removed.
Set `BUDDY_INITIAL_ADMIN_EMAIL` to reserve administrator access for a verified email. Changes
are recorded in `bob_access_audit`. Conflicting policies are cited rather than silently
assuming a group policy supersedes a common policy.

Verification: `docker compose exec -T bob-agent python3 - < tests/test_rag.py`
and `docker compose exec -T bob-agent python3 - < tests/shared_knowledge_integration.py`.
The integration check uses an isolated database schema and fake embeddings.
Docling preparation checks: `docker compose exec -T knowledge-worker python - < tests/docling_integration.py`.

Hover or focus a document citation to preview the exact supporting sentence or table row. Bob supplies a short quote for each claim, which the API verifies against the saved retrieved passage. Different claims from the same document can show different excerpts. Older answers without a supporting quote need to be asked again; their previews never fall back to the whole document.

## MCP servers

Administrators use **+** beside MCP Servers to create a shared connection. Choose Streamable HTTP, SSE, or stdio. For remote servers, enter the URL and optional JSON objects for query parameters and headers. For stdio servers, enter a command, a JSON array of arguments, and optional JSON environment values. The optional API key is placed in a named HTTP header or stdio environment variable. For a bearer token, use `Authorization` as the name and `Bearer ` as the prefix.

Connection definitions and credentials are stored in a shared PostgreSQL registry; protect the database and backups as credential stores. Existing global definitions and administrator-owned connections migrate once. Ordinary users cannot publish connections or retrieve their configurations. Microsoft delegated tokens remain personal; disconnecting an account does not remove the shared connection.

For each connection, administrators select **Everyone** or a group, using the same group rules as knowledge documents. **My access** and administrator **Access preview** show personal connections. Administrators can manage every connection, but their own chat still follows their employee assignments. Changes are recorded in **Audit history**, without credentials.

Assistant runs receive native MCP proxy definitions, with credentials held by an identity-bound service gateway. Tools, resources, and prompts recheck current group access on every request. Revocation blocks subsequent requests and suppresses results from requests whose access was revoked while they ran; it cannot undo an external action already performed. Stateful server sessions persist within a run. Brave search, including the research CLI fallback, uses this gateway. A stdio command must exist in the container. Use `host.docker.internal` in a remote URL when the MCP server runs on the host.

## Microsoft 365 & Tools Integration

The workspace includes a built-in Microsoft 365 integration that provides tools for **Outlook Mail, Calendar, and OneDrive**:

- **Connect via UI**: Users can click **"Connect Microsoft 365"** in the sidebar or **"Sign in with Microsoft"** on the sign-in modal.
- **Tools provided to Bob**:
  - `microsoft_get_me`: Get profile info of the connected user.
  - `microsoft_list_emails`: Search/list Outlook emails (search query, unread filter, folder).
  - `microsoft_send_email`: Send emails from Outlook.
  - `microsoft_list_calendar_events`: List upcoming meetings & calendar events.
  - `microsoft_create_calendar_event`: Schedule meetings in Outlook Calendar.
  - `microsoft_list_files`: Browse folders and files in OneDrive.
  - `microsoft_search_files`: Search files across OneDrive.
- **Isolated Credentials**: Each user's tokens are stored privately in PostgreSQL and automatically refreshed when expired.
- **Configuration** (add to `.env` beside `docker-compose.yml`):
  ```env
  AZURE_CLIENT_ID="your-entra-app-client-id"
  AZURE_CLIENT_SECRET="your-entra-app-client-secret"
  AZURE_TENANT_ID="common" # or your organization tenant UUID
  ```
  In your Microsoft Entra ID App Registration, add the Redirect URI: `http://localhost:8080/auth/microsoft/callback`.

## A2A agents

Use **+** beside A2A Agents and enter an Agent Card URL. The UI discovers a JSON-RPC endpoint and adds the agent to the sidebar. Select it to send messages to that agent, or use `/agent <slug>` from the slash menu. The optional endpoint override helps when the Agent Card advertises an address the container cannot reach. Both the sidebar and Buddy's `a2a ask` command use `message/stream` when the agent advertises streaming. Sidebar updates appear as the remote agent emits them; the CLI returns the assembled answer to Buddy. Completed streams return immediately, while interrupted task streams recover through `tasks/get`. Agents without streaming use `message/send` and bounded polling when needed. Remote agents may emit a whole answer in one artifact rather than individual tokens.

## Design choices

### One Bob ACP process per request

This demo launches a fresh `bob acp` child process for each request. Bob Shell
2.0.5 can reject API-key authentication in ACP mode even when the same key works
with `bob run`. For that specific error, the bridge retries the request through
Bob's non-interactive `run` mode. Each request remains isolated.

For production, you may want a pool of persistent ACP processes/sessions.

### Trust and auto-approval

Agent chat has a **Approvals** menu in the top toolbar. Choose **Auto-approve everything** to run without approval prompts, or **Choose processes to review** and select the action categories that must pause. New chats start with automatic approval. The UI remembers the setting per user and chat; each job captures its policy at submission. Existing API clients default to automatic approval.

Selected review runs Bob through interactive ACP without `--auto-approve`. Pending actions appear as review cards with **Approve once** and **Reject**. Decisions belong to the authenticated job owner, are recorded in durable history, and cannot authorize a stopped job or a replacement worker. Commands and connector tools require conservative review when any category is selected, because they can affect several categories. Unknown tool types require review; structured read/search operations can continue automatically.

Automatic mode retains the headless `bob run` path; direct ask requests may use `bob acp --trust --auto-approve --accept-license`. Selected review never falls back to non-interactive execution. Remote agents that cannot enforce ACP permission callbacks are rejected. Team API keys use a temporary loopback gateway adapter that supplies the configured team header to IBM’s official regional API, while preserving ACP permission callbacks. The key is unchanged; the adapter closes with the job.

Existing skills can be edited from the sidebar's **Skills** section. Each skill has an **Edit** button for its description and instructions. Changes are saved to the user's skill configuration, including overrides of shipped skills, while retaining the stable skill name and other metadata.

### Protocol version

The network adapter exposes the commonly deployed A2A 0.3 JSON-RPC shape (`message/send`) and Agent Card discovery at:

```text
/.well-known/agent-card.json
```

It also accepts `message.send` and the newer text-Part shape as small compatibility conveniences.

The internal Bob connection uses the official `agent-client-protocol` Python SDK and negotiates its ACP protocol version at runtime.

## Troubleshooting

### `Missing Bob API key`

Make sure the variable exists in the same shell that runs Compose:

```bash
echo "$BOB_API_KEY"
docker compose up --build
```

### Bob exits during ACP initialization

Inspect logs:

```bash
docker compose logs -f bob-agent
```

Also verify the key is an IBM Bob key suitable for non-interactive/inference use.

### Docker build cannot find `bob`

Bob Shell is distributed through IBM's installer as a versioned package, not as
`bobshell` on the public npm registry. The Dockerfile uses the installer with
`--pm npm` for a non-interactive build and checks `command -v bob` afterward.

## Security note

This is a development/test bridge. The UI and API use username/password sign-in with server-side cookies, and Docker publishes the app only on `127.0.0.1`. Bob runs with workspace trust; tool approval depends on the selected Agent chat policy. Put TLS and a suitable gateway in front of it before allowing remote clients to reach it.

## Projects and repository context

Use **Projects → +** in the sidebar to create an empty project, import a public HTTPS Git repository, or upload a ZIP. Git imports support GitHub, GitLab, and Bitbucket by default (`BOB_GIT_HOSTS` configures approved hosts). Branch selection is optional. Private Git credentials and local-folder connections are not implemented; upload a ZIP for private code.

ZIPs are extracted automatically into the signed-in user's new project. Archives are limited to 50 MB compressed, 200 MB expanded, and 10,000 entries. Traversal paths, symlinks, encrypted archives, and reserved `.git`, `.bob`, and `.home` paths are rejected. A single enclosing folder is removed. Imports do not execute application code or install dependencies.

Select a project, then use **Files & changes** to search files, edit text, review a Git diff, or download the project as a ZIP. Text editing is limited to UTF-8 files up to 1 MB. Stale edits return a conflict instead of overwriting newer changes. Git metadata and service configuration are excluded from downloads. Large diffs are capped at 1 MB and labelled when truncated; newly created files are listed separately.

New conversations started with a project selected run Bob in that project's directory. These chats share files while keeping separate histories; personal conversations have separate database file scopes. A single Bob run per project is allowed at a time. Project ownership, metadata, repositories (including Git history), and conversation histories are stored in PostgreSQL. Repository trees are restored only for Bob/Git work and removed afterward. Diffs compare with the current Git `HEAD` (initial import until a commit is made). No automatic push or remote write is performed.

**Execution isolation:** this version uses the existing shared Bob service container. A private directory and API authorization are not an operating-system sandbox. Use this deployment with trusted users and trusted repositories. Uploads do not provision an isolated runner. The Kubernetes guide describes the separate runner architecture needed for untrusted multi-tenant execution.

### Verification

With Compose running, execute:

```sh
docker compose exec -T -e PYTHONPATH=/opt/bob-a2a -e TEST_GIT_IMPORT=1 bob-agent python3 - < tests/projects_integration.py
```

The test uses temporary accounts, verifies isolation/import/edit/diff behavior, and removes its accounts and workspaces. `TEST_GIT_IMPORT=1` additionally checks a public Git clone.

## Kubernetes

Deployment manifests and instructions are in [deploy/k8s/README.md](deploy/k8s/README.md). They provide an app Deployment, a PostgreSQL StatefulSet, persistent storage, Secret references, readiness/liveness probes, and an optional TLS ingress example. File persistence and job leases use PostgreSQL; the existing Kubernetes manifests still need a separately configured Bob job worker. The manifests require your registry image, secrets, storage class, and ingress configuration; they do not deploy a cluster or provision isolated per-project runners.
# Live diagrams

Bob uses a `bobdiagram` fenced block containing one JSON record per line for conceptual flows and sequence diagrams. The header sets the diagram type/title, node records add shapes/participants, and edge records add connections/messages. Complete records render immediately during streaming; incomplete records wait, forward references are deferred, and malformed records preserve the valid diagram with a notice. Limits are 100 nodes and 200 edges. Labels are treated as plain text.

Flows use React Flow with ELK automatic layout and synchronized node/connector transitions. The viewport follows a growing diagram until you manually pan, zoom or drag; **Fit** resumes automatic fitting. Reduced-motion preferences disable animations. **SVG** and **JSON** download the diagram; **Save** stores a `.diagram.json` file in the conversation. Saved diagrams reopen in the artifact viewer, where the **Code** tab can edit the JSON and **Visual viewer** previews it. Existing Mermaid remains supported for older messages or explicit requests.

Data tables and the existing Carbon-styled bar, line, pie and doughnut charts keep their current renderers and controls.

Sequence diagrams support message selection from the toolbar or directly with a click, Enter or Space. Selecting a message dims the others; choose **All messages** to restore the overview. Existing Mermaid panels retain rendered SVGs, editor drafts and fullscreen controls when later prose updates the answer.

Interactive HTML scaffolds include `BobVisuals.echarts(element, option)` for richer data exploration: heatmaps, scatter plots, treemaps, sunbursts, Sankey and relationship graphs. The async helper returns `{chart, update, dispose}`. Use stable series IDs and `update` to preserve chart interaction state; provide a dedicated, explicitly sized responsive container and a source table outside it. The helper loads pinned ECharts 6.1.0 only when used, observes container resizing, respects reduced motion and disposes removed charts. Its CDN requires network access; loading failures show a message and leave the separate source table usable. Bob is instructed to provide relevant filters, drill-down, selection or zoom/reset controls and never invent data to fill a chart.

Rendering regressions cover Markdown/diagram lifecycle, chart interaction at 320/768/1440px, sequence selection, and ECharts resizing, keyboard filtering and CDN failure. See `tests/test_mermaid_lifecycle_browser.py`, `tests/test_chart_responsive_browser.py`, `tests/test_structured_diagram_browser.py` and `tests/test_visual_artifact_browser.py`.


# Interactive presentations in Bob

Open **Template Studio** in the sidebar, or choose **Create template** in presentation setup, to build a reusable personal template. Set the five theme colors, heading/body fonts, card shape, decoration, border width, and cards/comparison/timeline layout. Choose optional bar, line, or doughnut charts, with clearly illustrative values in design previews. HTML templates also support navigation and none/fade/slide transitions; PowerPoint retains native editable charts. Preview each layout before saving. Download HTML or PowerPoint samples, then **Save template** to add it to your account's catalog for either output format. Templates persist across conversations and logins.

For assistance, describe the design under **Design with Bob** and choose **Ask Bob to design**. Bob creates a design draft in the current conversation. Reopen Template Studio, choose **Refresh drafts**, select and load the draft, adjust the preview, then save it to the reusable catalog. Creating or copying a template adds a new catalog entry.

The presentation chooser supports two formats:

- **PowerPoint** asks for a `.bobdeck` template, then creates a deck with editable PowerPoint charts.
- **Interactive HTML** presentations open in Presentation Studio beside chat. Studio follows slides as Bob saves the file, supports browsing completed slides during generation, and expands for manual editing. PowerPoint workflows use editable `.bobdeck` source files. Each new presentation receives a unique file name.

The bundled `interactive-presentations` Bob skill is in `workspace/.bob/skills/interactive-presentations/SKILL.md`. Bob copies new bundled skills into existing user workspaces at sign in without replacing edited skills. You can also invoke it directly in Bob with `/interactive-presentations` for a custom HTML deck. Supply the report data or source files and ask Bob to verify every chart value and interaction before delivery. The starter contains example data that must be replaced for a real report.

To revise a saved HTML presentation, open Presentation Studio and select **Request changes**. Describe the changes and select **Apply changes with Bob**. Save any manual edits first and wait for the current task to finish. This sends the selected file path to the chat worker, which edits that saved file in place without asking for a new template or slide count. Presentation Studio shows file updates during the edit; existing approval settings still apply.

For manual edits, open completed HTML presentations in **Presentation Studio** beside chat or expand the workspace. Choose **Edit Text**, click slide text, and use the studio's **Save** button. The existing color, chart-data, and slide controls are also available. Studio saves update the same artifact with version history and reject conflicting writes; **Revert** discards unsaved changes. Save before asking Bob for further edits.

HTML files currently load Chart.js, GSAP, and Google Fonts from CDNs. Bundle those assets locally if the presentation must work without internet access.

For tablets and phones, the HTML starter stacks columns, scrolls long slides vertically, supports horizontal swipe between slides, keeps navigation above safe areas, and resizes charts when orientation changes. Before sharing a generated deck, check it on iOS Safari and Android Chrome in portrait and landscape. Use Open Full Page on a phone for the most usable viewing area.


The chat Stop button requests cancellation of the authenticated user's active job. Queued jobs are cancelled before execution; running jobs keep their workspace lock until the worker terminates Bob and its tool process group. Cancellation is recorded in conversation history and does not stop the worker service. Closing a browser tab alone does not cancel a durable job. Verify cancellation with `docker compose exec -T bob-agent python3 - < tests/stop_integration.py`.

Document citations appear as compact numbered markers. Each document is listed once in a collapsible Sources section; markers retain their claim-specific hover quotes. Browser alerts and confirmations use the app's styled dialogs.


Bob automatically chooses relevant installed skills from the current user's skill descriptions for ordinary chat requests. Skill activations appear in the work log; `/skill-name` is a manual override. Multiple skills can be combined when needed, while general coding uses Bob's normal capabilities if no installed skill matches. New presentation requests require template selection before generation. The top-right Executive Deck shortcut uses the current default template. Knowledge search is available on demand through `app/knowledge_cli.py`.


Streaming uses PostgreSQL LISTEN/NOTIFY to wake clients immediately after durable event commits. Each connected stream reuses an asynchronous database read connection. Tiny text fragments are coalesced over at most 16 ms after the immediate first fragment, including during continuous bursts. The browser batches text paints at roughly 30 frames per second, drains remaining text before completion, and memoizes earlier answers. Markdown patches preserve paragraphs and list items during streaming and completion; partial follow-up question fences stay hidden until complete cards are ready. Structured flow and sequence diagrams render as complete JSON records arrive during streaming. Charts retain their existing complete-block renderer; legacy Mermaid renders at completion. Auto-scroll follows content height changes, including final question cards, and pauses when you scroll up. Browser regressions use `tests/test_stream_stability_browser.py` against the Vite fixture at `/tests/streaming.html`; reveal batching and completion checks use `node tests/test_stream_reveal.mjs`. Verification: `docker compose exec -T bob-agent python3 - < tests/test_streaming.py` and `docker compose exec -T bob-agent python3 - < tests/streaming_integration.py`.

## Tasks and completion notifications

The sidebar **Tasks** view lists your latest 100 jobs across conversations. Filter active, completed,
failed or stopped work; select a task for its current activity, saved response and activity history.
**Open conversation & files** returns to the original conversation. **Stop task** uses the existing
server-side cancellation flow. Task APIs (`GET /tasks`, `GET /tasks/{id}`) enforce ownership even for
administrators and never return the worker payload or credentials.

Refreshing the app always opens a new blank personal chat; a conversation is saved when its first message is sent. Existing chats remain in the sidebar. Requests continue in the background when you refresh or switch browser tabs or conversations. Completion notices are limited to successful chat responses observed in progress that finish while you are away from their chat. Visible completions, historical results, failures, stopped jobs, research jobs and workflow runs do not send notifications. Clicking a desktop notification or its in-app notice opens the originating conversation, including project conversations. **Enable desktop notifications** requests browser permission; submitting a chat request also requests permission if it has not yet been decided.
The browser must remain open for desktop notices. Results remain available after closing it.
Notifications are deduplicated per signed-in account on this browser, including across reloads.

## SharePoint and Teams retrieval

Expand **Microsoft 365** in the sidebar and choose **Reconnect to enable SharePoint & Teams**.
The connection requests these additional Microsoft Graph **delegated** permissions:
`Sites.Read.All`, `Chat.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, and
`ChannelMessage.Read.All`. Configure them in the Entra application; tenant policy may require
administrator consent. These connectors need a Microsoft work or school account. Regular Microsoft
sign-in retains its existing permissions; the business connection explicitly adds the new scopes,
including when `GRAPH_SCOPES` is customized. The UI reports actually granted permissions.

Buddy can search SharePoint/OneDrive document excerpts, download a selected file up to 20 MB into
its private conversation workspace, list Teams chats and joined teams, and read recent chat
messages, channel posts and replies. Teams reading returns bounded recent pages, not an exhaustive
organization-wide search. Microsoft source links become numbered citations in the answer.

Every connector request uses the current user's delegated token. Microsoft filters search results
and authorizes file/message reads; access denials fail without returning content. Retrieved content
is not added to the shared uploaded-document RAG library. Downloads and conversation results remain
private to the Buddy account that requested them. Existing shared uploaded sources retain their
shared visibility.

Reference: [SharePoint search](https://learn.microsoft.com/en-us/graph/search-concept-files),
[Teams chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0).

Verification:

```sh
docker compose exec -T bob-agent python3 - < tests/test_business_connectors.py
docker compose exec -T bob-agent python3 - < tests/tasks_api_integration.py
```

## Automations, agent teams and voice input

Choose **Automations & teams** in the sidebar to save reusable workflows or run one immediately.
Daily and weekly schedules use an IANA timezone (for example `Europe/London`). You can select a
project, skill, live web search and presentation output. Scheduled presentations require a
template and slide count up front, so generation needs no interactive setup.

The scheduler runs inside each `bob-worker`, checks every 15 seconds and uses PostgreSQL row
locks to dispatch each occurrence once. Keep the worker and database running; the browser can
be closed. After downtime, missed occurrences are combined into one run. Busy projects and
workflows wait and retry after a minute. A deleted project pauses its schedule with a visible
error. A schedule runs once at the first occurrence of a repeated daylight-saving time and
skips a nonexistent spring-forward time. Pause or delete a workflow to stop future runs;
use **Tasks → Stop task** to cancel work already queued or running.

Each run creates a private conversation and appears in **Tasks**, using the existing result,
file and cancellation mechanisms. Scheduled workflows do not send chat-response notifications. Account ownership is enforced on all
workflow APIs. Scheduled execution does not bypass `UserPromptSubmit` policy hooks. Queue and
conversation creation commit together. Workflow runs are not automatically retried after a
worker failure, to avoid repeating external side effects.

Add up to three specialist role instructions (one per line) for a team. Each specialist uses
a fresh Bob session and passes its findings to the coordinator. Specialists execute sequentially
in the same job workspace, sharing the parent's lease, time limit and cancellation. This is
application-managed delegation; it does not enable Bob-native dynamic sub-agent tools or
parallel team execution. Specialist work is visible in the task activity history; the final
answer is the coordinator's response.

For agent loops, supply explicit **Completion criteria** and set **Maximum iterations** to 2 or 3.
An independent Bob session in `ask` mode reviews each candidate against those criteria and
provides feedback for the next attempt. Invalid review output or unmet criteria at the limit
fails the task visibly. Model review is evidence-based assistance, not a deterministic test;
include concrete build/test requirements in your instructions when appropriate. The total
workflow time limit is 60–3600 seconds, including specialist and review calls. Each Bob call
also retains the server's existing request timeout. Extra calls consume additional Bobcoins.

Web search uses the existing Brave MCP tools. Set `BRAVE_API_KEY` in `.env` and recreate the API
and worker to enable the search controls. No API key is returned to the browser. The capability
check reports key configuration, not provider availability or key validity.

**Voice** uses browser speech recognition to append dictated text to the chat input. Review
and edit it before pressing Send; dictation does not automatically submit instructions.
Availability depends on the browser, microphone permissions and its speech service. Your
browser may send audio to its speech provider. It uses the browser's preferred language,
stops during a request and when changing conversations, and reports microphone errors.
This is app-level dictation, not a native Bob audio feature or transcription of uploaded
recordings. Reference: [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

Workflow APIs: `GET/POST /workflows`, `POST /workflows/run`,
`POST /workflows/{id}/run`, `PATCH /workflows/{id}` with `{"enabled":false}`,
`DELETE /workflows/{id}`, and `GET /workflows/capabilities`. All require sign-in.

Verification:

```sh
docker compose exec -T bob-agent python3 - < tests/test_workflows.py
docker compose exec -T bob-agent python3 - < tests/workflows_integration.py
cd web && npm run build
```

### Conversation document attachments

Use the chat attachment button or drop a PDF, Word `.docx`, Markdown `.md`, or UTF-8 text file into the conversation (25 MB each). The original file is preserved. PDF and Word text/tables are prepared asynchronously by the existing Docling worker, with English OCR for scanned PDFs; Markdown/text does not require Docling conversion. Documents are private to the conversation or selected project and are not indexed into shared knowledge.

Choose **Preview document** on the attachment or open it from **Files** in the sidebar. PDFs show the original plus a readable extracted-text view; Word and Markdown show readable text. Use **Ask Bob** or **Summarize document** once preparation completes. Pending files show progress, failed files offer retry, and malformed, password-protected or excessive documents show an error. Legacy Word `.doc` files must be saved as `.docx` first. The document text is limited to one million characters, PDF conversion to 500 pages, and large previews are truncated while the full prepared text remains available to Bob.

### CSV and Excel follow-up questions

Chat attachments stay in the conversation (or its selected project's file scope). Every Bob turn
now receives a manifest of the current spreadsheet files and their restored workspace location.
Data follow-ups are instructed to read the full current file rather than reuse upload previews
or prior answer summaries. Private chat attachments are not searched through the shared RAG library.
If Bob's native task cannot be resumed, the worker also supplies bounded context from up to eight
previous conversation turns, including earlier attachment references. A new personal conversation
has its own files; switch back to the original conversation to continue analyzing its CSV.

Verification:

```sh
docker compose exec -T bob-agent python3 - < tests/test_conversation_context.py
docker compose exec -T bob-agent python3 - < tests/csv_followup_integration.py
# Optional live model verification (uses Bobcoins):
docker compose exec -T -e REAL_BOB=1 bob-agent python3 - < tests/csv_followup_integration.py
```

## Personal memory, assistant presets, sharing and artifact editing

The toolbar above chat includes **Memory & presets**, **Export & share**, and **Artifact editor**.
Memories are explicitly saved private preferences, with edit, delete and enable controls. Enabled
memories are supplied to Bob on every chat and workflow turn; current instructions take precedence.
They are not automatically extracted, and are not sent to external A2A agents.

Assistant presets save a name, instructions, Bob mode, optional skill and web-search setting.
Select one above chat before sending. Presentation setup and external A2A agents use their existing
controls. Presets do not restrict tool permissions or select a separate knowledge library.

Export saves visible conversation text as Markdown or JSON. Sharing creates an immutable read-only
snapshot available to anyone with the link. It excludes attached files and raw tool logs. Revoke all
links from the same panel; conversation deletion also makes its links inaccessible.

The artifact editor opens or creates UTF-8 HTML, React, Mermaid, Markdown and text/code files up to
2 MB. Save and restore use optimistic conflict checks and refuse changes during active workspace jobs.
Up to 40 manually saved revisions are retained. Preview frames are sandboxed. React preview supports
standalone default components and loads React/Babel from jsDelivr; arbitrary project imports require
a build. Agent-generated edits are captured as a baseline when next saved in the editor.

Live artifact and presentation snapshots are pushed through authenticated WebSockets at
`/jobs/{job_id}/artifacts/ws`, with job ownership checks and replay on reconnect. PostgreSQL
commit notifications wake the socket reader; the browser does not repeatedly poll artifact
sources. Visual previews keep the current frame visible while the next snapshot loads.
Chat text continues to use the existing HTTP stream and durable recovery.
Live previews preserve window and named-panel scroll positions and suppress repeated entrance
effects during generation. Flow diagrams retain their viewport as nodes arrive. New dashboard
scaffolds include native one-time section reveals and opt-in hover/pressed feedback; chart
updates animate briefly. New HTML presentation templates default to fade transitions, while
explicit template choices and reduced-motion preferences remain supported.
ECharts and Chart.js previews replay their entrance once they become visible, so background
loading does not consume the animation offscreen. A Replay chart animations control appears
for supported charts after generation. Existing chart values and zoom are retained; repeated
live snapshots suppress page entrances while user-triggered chart transitions remain available.

Refreshing or losing a chat connection recovers the existing job and committed partial response
without resubmitting instructions. Chat and workflow events are now persisted during execution;
small deltas are batched over at most 100 ms. Recovery retries while the conversation remains open.

For a document-based practice test, upload a document, wait for preparation, open its preview,
and choose **Create test from document**. You can also ask Bob to create a test on a topic or a
selected uploaded source. `bobquiz` forms support single-choice, multiple-select and written
responses, stack questions vertically, save drafts locally, and require the full test to be
completed before submission. Solutions, scores and explanations appear only after submission.
Choice questions use server-computed answer-key marks (exact-set scoring for multiple-select);
Bob grades written responses against the source answer and rubric, accepting equivalent wording
and partial credit. Feedback includes the correct answers, explanations and available source
sections/pages. Attempts and grading replies remain in conversation history; failed grading
requests can be submitted again with the saved answers. These are practice quizzes, with the
quiz specification retained in chat history, rather than a secure examination system.

Tests include progress, question navigation, review flags and saved answers. Follow-up forms
appear only after final results. Results offer expandable explanations, missed-question filters,
reading checklists and another practice test on missed concepts. Bob searches general study
topics through the user-authorized Brave connection and recommends only relevant pages that
the server has fetched; unavailable search is reported without blocking grades. Ambiguous
questions are marked for review and excluded from the score. The default display scale is
100% above 768px and 85% on smaller screens; explicit scale choices persist.

Verification: `tests/personal_features_integration.py`, `tests/artifacts_test.py`,
`tests/test_conversation_sharing.py`, `tests/test_stream_replay.py`, and `tests/test_chat_refresh.mjs`.

## Keycloak UI login and Microsoft Office connection

When `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, and `KEYCLOAK_CLIENT_SECRET` are set,
Buddy uses **Sign in with Keycloak**. Microsoft is only an Office connection available after
sign-in; its OAuth callback never creates a Buddy user or UI session.

Configure the Keycloak client with **Client authentication** and **Standard flow** enabled.
Add the exact **Valid redirect URI** `http://localhost:3000/auth/keycloak/callback` for the
local deployment. Set `KEYCLOAK_REDIRECT_URI` to an explicit callback for another deployment;
otherwise Buddy uses `PUBLIC_BASE_URL` plus `/auth/keycloak/callback`.
The issuer must use HTTPS and include the realm path. Secrets stay in server environment variables.

Login uses authorization code with S256 PKCE, browser-bound single-use state, and nonce.
RS256 ID-token signatures, issuer, audience, authorized party and expiry are validated.
Local login, setup and registration are disabled while Keycloak is configured, unless
`BOB_LOCAL_LOGIN_ENABLED=1` explicitly enables the existing local login fallback.
Existing sessions continue until logout/expiry.

Keycloak accounts are mapped by issuer and subject, never automatically by email or username.
Their private workspaces are separate from existing local accounts. Existing data is retained.
New accounts are ordinary users when an installation already has users; to designate a new
Keycloak administrator, set `KEYCLOAK_ADMIN_SUBJECTS` to its exact subject before its first login.
This does not change previously provisioned users' roles. A fresh installation's first account
is an administrator. Logout ends the Buddy session, while the realm SSO session remains active.

After changing `.env`, recreate services with `docker compose up -d --no-build bob-agent bob-worker`
using an image built from the updated requirements. Tests: `test_keycloak_auth.py`,
`test_microsoft_connection.py`, and `test_microsoft_integration.py`.

Emergency access: the local deployment keeps `BOB_LOCAL_LOGIN_ENABLED=1`, showing both
Keycloak and **Emergency local login**. Existing local account passwords continue to work
independently of Keycloak availability. Public local registration remains disabled when
Keycloak is configured; administrators can manage emergency local accounts separately.

Keycloak names: Buddy stores `given_name` plus `family_name` from the verified login token
as a display name, falling back to `name`, then `preferred_username`. The stable internal
account ID and all workspace ownership remain unchanged. Profile names refresh on each
Keycloak sign-in; accounts created before this change need to sign out and sign in once.

## Personalized Bob responses

Bob receives the authenticated account's display name and enabled private memories on every
chat, presentation, workflow, and authenticated `/ask` or `/a2a` request. Names come from the
stored Keycloak profile (or local username). Internal `kc-...` identifiers are not presented
as names. External A2A agents do not automatically receive profile or memory context.

Use **Memory & presets → Personal memory** to save role, preferred language, answer detail,
reporting style or relevant work context. Bob uses these when relevant; current instructions
win. Preferences do not grant permissions, imply a department, or expose other users' histories.
Saving remains explicit through the memory controls. Updated names and preferences are loaded
at execution time, including for scheduled workflows. Bob is instructed to address users
naturally without repeating their name in every response or inserting it into documents unasked.

Verification: `tests/test_user_personalization.py` and `tests/keycloak_integration.py`.

### Executive research reports

Use **Research reports** in the toolbar to start a private, durable task. Public web research plans multiple searches, fetches full readable pages, writes an executive report (summary, findings, comparisons, recommendations, limitations, sources), then reviews it against collected evidence. Standard depth allows two collection/review rounds. Reviewed reports require at least three fetched URLs across two publisher domains; distinct domains are a coverage heuristic, not proof of independence. Insufficient evidence preserves a draft and marks the task incomplete. Reports, plan, evidence, and review are saved in the conversation workspace; Markdown downloads are available in the report library.

Public web collection requires `BRAVE_API_KEY`. HTML, text, JSON and public PDFs are supported. Research can also use authorized internal knowledge and connected Microsoft OneDrive documents, independently or together with public sources. Office collection requires an authorized Microsoft connection and the requesting user’s delegated account; the collector reads up to six supported documents, capped at 2 MB each. Paywall access is not supported. Evidence signatures detect changed records but are not a security boundary against a process with the worker's credentials. Semantic citation support is reviewed by Bob and still requires human judgment. This workflow does not guarantee parity with Manus or Claude.

Research visuals: new research requests can enable Mermaid diagrams and source screenshots. Diagrams are created when useful for the topic; captured images appear with source URL and capture date and are included in PDF printing. Screenshots use an isolated Chromium context without saved credentials, block private addresses and non-read requests, and capture up to three public-source viewports. Unavailable or blocked pages are skipped with a progress notice. Chromium and Python Playwright are required in the worker image. Screenshots are documentary captures, not generated images or proof that a webpage's statements are true.

## Deployment storage

The Dockerfile compiles both frontends in a separate build stage. The service image
contains the compiled UI assets without frontend source trees or their Node
dependencies. Node, Bob, Chromium and the Python runtime remain available for
agent tools and existing features. This build works with the existing Compose
and Kubernetes deployments.

Build caches can be removed with `docker builder prune` after a successful build;
future builds may take longer. Preserve the PostgreSQL and Docling model volumes,
which contain application data and downloaded models. Unattached volumes may
contain data from an older deployment.

To move conversation history and file storage off the deployment host, use the
[remote PostgreSQL setup](deploy/REMOTE_DATABASE.md) and the standalone
`docker-compose.remote.yml`. Migrate existing data before switching databases.

For hybrid PostgreSQL/Wasabi storage and migration commands, see
[Wasabi storage](deploy/WASABI_STORAGE.md). Enable `BOB_FILE_STORAGE=s3` for new
writes and migrate existing database-backed files explicitly.

### Asking about selected chat text

Select text in a chat message and choose **Ask about this**. The passage appears as a removable quote in the composer while your existing draft stays intact. You can add multiple passages, including code with its original indentation. Write your question and send it when ready; selecting text never sends a message. The question and quoted passages are saved together in the conversation. Quotes clear when you switch conversations. The action, preview, and input guidance support English, Greek, and Hindi.

Browser verification: `docker compose exec -T bob-agent python3 - < tests/test_chat_selection_browser.py` uses explicit fixtures to check draft preservation, literal quote payloads, multiple quotes, removal, keyboard/touch activation, selection boundaries, and conversation isolation.

### Guiding a chat response
While Buddy is answering a local chat, type another instruction and press Enter or **Send guidance**. Shift+Enter adds a new line; **Stop** still cancels the response. Guidance pauses the current Bob process, waits for it to save, and resumes the same task and workspace with your instructions. If Bob has not yet saved a task, it continues using the original request, provisional answer and workspace. Accepted instructions are stored with the response and survive reconnection. Guidance is available for chats; presentation, research, workflow and remote agent runs retain their existing controls.

### Application authentication

`BOB_API_KEY` authenticates Bob Shell with the provider. It does not grant application access or create an administrator. A2A requests require an existing application session (cookie, Bearer token, or `x-api-key` session token). Configure an agent's explicit authentication credentials when a background worker calls a protected A2A endpoint; workers do not forward provider credentials. HTTPS A2A connections validate server certificates.


## Production readiness

See [the acceptance record](deploy/PRODUCTION_READINESS.md) for verified checks, outstanding release gates, recovery scripts, and monitoring limitations. Run `python3 scripts/verify_readiness.py` against the existing Compose installation for the focused regression gate.

For live chatbot response quality, follow-up understanding, session persistence,
and UI acceptance, use the [manual chatbot test plan](tests/manual/CHATBOT_UAT_PLAN.md)
and [results worksheet](tests/manual/CHATBOT_UAT_RESULTS.md). Synthetic attachment
fixtures are included beside the plan. These scenarios require live browser
execution; automated regression passes do not establish response quality.

## Portable server configuration

See [deploy/REMOTE_SETUP.md](deploy/REMOTE_SETUP.md) before upgrading a remote server.
Both Compose files read DATABASE_URL from .env. The bundled database also uses
POSTGRES_USER, POSTGRES_DB, and POSTGRES_PASSWORD; keep these consistent with the URL.
Remote deployments require PUBLIC_BASE_URL. See .env.example for all deployment settings.

### Unified presentation workspace

Ask for a presentation in chat or use **Create presentation**. Bob checks the request and offers the current template catalog, output format, and slide count together. Templates come from the server catalog; topics and outlines come from the request. **Presentation Studio** is a core workspace, also accessible with `/preview`, independently of extension settings. Reports and other documents open in **Artifacts**.

Studio displays saved HTML or deck snapshots during generation and can follow newly created slides automatically. Preview updates reflect actual file writes rather than predicted progress. Once generation completes, edit in Studio and save, or use **Request changes** to update the same saved file through chat. Unsaved edits must be saved or discarded before requesting changes. Saves check the file version and preserve artifact history, preventing silent overwrites of concurrent updates. Expanding Studio keeps the current editor and edits mounted.

Focused offline checks: `node tests/test_presentation_setup.mjs`, `node tests/test_presentation_indicator.mjs`, `node tests/test_bob_mods.mjs`, and the Python presentation routing and artifact edit request tests. A production frontend build and live browser acceptance remain necessary when deployment dependencies are available.

Presentation updates patch the existing iframe DOM through the current event stream; they do not navigate the frame on each snapshot. Unchanged chart canvases, script nodes, and scrollable containers retain their state. Chat follow scrolling is coalesced to animation frames and stops when the reader scrolls up. Manual HTML saves do not reload the preview. In **Edit Text**, Space and arrow keys retain their typing and caret behavior. Use **Select objects**, click a slide element, and **Select parent frame** to reach a surrounding card or container. **Delete object** removes it; **Undo removal** restores it before saving. Whole slides use the filmstrip delete control.

Additional checks: `node tests/test_presentation_dom.mjs` and `node tests/test_presentation_editing.mjs`. These verify DOM contracts and editing behavior offline; they do not replace live browser testing.

### Approval guide and controls during execution

Auto-approval is enabled by default. After signing in, an informational popup explains how to control it; it does not require choosing a policy. Dismiss it with **Got it**, and reopen it through **Approvals → How approvals work**. Saved conversation settings remain in effect.

Choose **Auto-approve everything**, **Ask before all processes**, or select specific processes to auto-approve. Checked categories run automatically; unchecked categories require review. Commands and connector tools are reviewed conservatively because they can affect several categories. Read, search, and thinking actions remain automatic.

For newly started local chats, presentations, and artifact edits, **Approvals** stays available during execution, including while an approval is pending. The same controls appear in running task details. Changes are persisted to the worker, apply to waiting/future permissions, and preserve explicit per-process review choices. Auto mode also applies to commands and connected tools. Already executed actions are not undone. Research runs, workflows, remote agents, and tasks started before this version display the reason runtime changes are unavailable.

Owner-authenticated `GET/PUT /jobs/{job_id}/approval-policy` provides the current policy, revision, and mutability. Local execution uses ACP permission callbacks even when starting in auto mode, so review can be enabled later without restarting the task. Existing live event streams broadcast policy changes; other views also refresh the durable policy periodically. Guidance interrupts the ACP prompt at a checkpoint and continues in the same session.

Validation: `node tests/test_approval_runtime.mjs`, `python3 -m unittest discover -s tests -p test_runtime_approval_policy.py`, and the existing task approval and artifact edit checks. Production ACP, PostgreSQL and browser acceptance still require the deployment environment.

Source hover previews preserve the original link title and URL when inline citations become numbered markers. Links in the Sources list use the same metadata. Document citations fetch their authenticated passage preview; external web links show only supplied titles, URLs, and supporting text. Research citations use viewport-positioned popups so report panels cannot clip them. Preview listeners remain mounted during streamed text updates, and requests are keyed to the current passage URL to avoid showing another source's response. Check with `node tests/test_source_preview.mjs`; live hover/focus acceptance still requires a browser.


## Access visibility, policy preview, audit history, and answer feedback

**My access** is available to every signed-in user and shows their current groups,
administrator status, applicable policy audiences, and personal
knowledge libraries. Administrator document-management access is described separately
from the group policies used for their chat answers.

In **User groups & administrators**, **Access preview** shows documents available to
a chosen combination of groups without changing any accounts. It uses
the same access predicate as retrieval. **Audit history** records administrator account
changes, document uploads/classification/description/replacement/deletion/reindexing,
and feedback review changes. Document changes include before/after metadata; history
can be filtered by action and actor name, email, or account ID and paged by cursor.
Historical changes made before auditing was enabled cannot be reconstructed.

Each completed saved answer has **Report an issue**. Users can flag an incorrect
answer, outdated policy, or other issue, optionally selecting an accessible cited
knowledge document. The service reads the actual saved answer, verifies conversation
ownership and current source access, and stores an immutable answer/source snapshot.
A report is accepted once per saved answer. Administrators review the **Answer feedback**
inbox and mark reports Open, Reviewed, or Resolved. Reports stay available after a
conversation or source is deleted so administrators can finish reviewing them.

Endpoints: authenticated `GET /access/me`, `GET /feedback/answer`, `POST /feedback`;
administrator-only `POST /admin/access-preview`, `GET /admin/audit`,
`GET /admin/feedback`, and `PATCH /admin/feedback/{id}`. Feedback and audits are stored
in PostgreSQL. No notifications or email are sent.

Verification: `tests/access_audit_integration.py`, `tests/feedback_http_integration.py`,
`tests/test_access_features_browser.py`, and the existing language catalog checks.
The browser checks use explicitly synthetic UI fixtures; database tests clean up their
fixtures and verify actual authorization and persistent records.

## Outgoing SMTP email

Administrators can configure a shared SMTP server under **User groups & administrators → Outgoing email (SMTP)**. Enter the host, port, security mode (STARTTLS, implicit TLS, or unencrypted relay), optional authentication, and sender address/name. Enable SMTP and save, then use **Send test email** with a recipient you control. Changes take effect without a restart.

Credentials are stored server-side in PostgreSQL, like the existing integration registry; protect database access and backups. The saved password is never returned by the settings API. Leaving the password blank preserves it when the username stays the same; clearing or changing the username removes the previous password unless a new one is supplied. Clearing the username supports relays without authentication.

Once enabled, the `smtp_send_email` tool sends from the configured shared address. MCP audience assignments control employee access to the `smtp` connection. Disabling SMTP prevents sending, including from already running conversations. SMTP acceptance confirms submission, not final delivery; uncertain failures are not automatically retried. The sender supports plain text or HTML and up to 50 comma-separated recipients. TLS certificates are verified using the server's trust store.

## Monday connection

The `monday-platform-local` connection is created disabled with an empty token. Administrators open **MCP connections → monday-platform-local → Configure**, enter the Monday API token in **Secret / API Key** (`MONDAY_TOKEN`), select **Enable connection**, and save. Use **Test** to verify the MCP handshake and tool discovery; this does not prove every operation is authorized by Monday.

The runtime image installs `@mondaydotcomorg/monday-api-mcp@1.11.3` and runs `mcp-server-monday-api` directly. This avoids downloading dependencies into each user's temporary home during connection checks. Newer releases currently pull in an incompatible native dependency under Node 24. Both API and task worker containers need the installed executable. MCP checks use a temporary working directory when a PostgreSQL workspace path has no local directory.


## Catalogs and productivity workspaces

**Tools → MCP server catalog** (also available under **Settings → MCP connections**) is
the main place to browse and assign MCP servers; the old sidebar MCP section is removed.
The library includes GitHub, Monday, Docmost, Microsoft 365/Office, Microsoft Learn, Notion
work documentation, Atlassian Jira/Confluence, Linear (including read-only), GitLab,
Cloudflare documentation, DeepWiki, Context7, Tavily, Exa, Firecrawl and Brave Search.
API-key variants are included where documented. Each entry has an icon, description,
category, provider documentation and setup requirements. New entries start with no grants.
Database, CRM, payment and private-messaging connectors are excluded from these presets.
Microsoft Office and the specifically requested Keycloak configuration connector are the
account-based exceptions.

Administrators use **Assign access** on each card to grant employee groups and individually
selected accounts together, independently of A2A permissions. Existing audience rules remain
in effect until edited. Access changes preserve account credentials; changing the server target
or OAuth client configuration invalidates its connections so secrets cannot silently follow a
changed destination. Catalog responses never return saved passwords, API keys or access tokens.
**Test** performs a real MCP handshake and tool discovery.

For OAuth providers, **Sign in to connect** opens a provider-login popup. The client discovers
OAuth metadata, uses PKCE S256, supports automatic registration or an administrator-configured
client ID, and stores tokens privately per user. State is single-use and bound to the existing
Buddy login session, account, template and endpoint. Refresh-token rotation is supported. Popup
messages are accepted only from the opened window and this application's origin. Sign-in failure
keeps an existing working connection. Provider discovery and token exchange require public HTTPS
endpoints; no credentials follow redirects or private-network discovery. Public documentation
servers need no account; API-key-only servers retain their credential forms.

Set `PUBLIC_BASE_URL` to the canonical application URL used by your users. OAuth callback:
`PUBLIC_BASE_URL/mcp-oauth/callback`. Providers without automatic registration need a registered
client with that exact callback. Confidential clients can reference a server environment variable
named `BOB_MCP_OAUTH_<PROVIDER>_CLIENT_SECRET`; pass that variable into both the API and task-worker
containers. The setting contains only the variable name; never put the actual client secret in
a catalog definition. Public PKCE clients do not need a client secret.

[Docmost](https://docmost.com/docs/user-guide/mcp) requires an administrator to configure the
instance's `/mcp` URL, enable MCP and have a Business/Enterprise license. Microsoft Office uses
the existing delegated account sign-in and tokens. Assigning the Microsoft catalog entry makes
its explicit catalog grants authoritative; until assigned, the existing Microsoft connection
policy remains in effect.

**Keycloak** is a native Buddy read-only configuration MCP, with its own popup sign-in separate
from application SSO. Configure a public HTTPS issuer ending in `/realms/<realm>` and a registered
OAuth client with Standard Flow and PKCE S256. Request only the realm/client configuration roles
needed. Five tools expose sanitized realm settings, client summaries, realm/client roles and
authentication flows. No user records, profiles, memberships, events, credentials or write tools
are exposed. Default OAuth scope is `openid`, without profile/email scopes. Configuration reads
use only the connected account's token and the configured issuer's realm. See the
[Keycloak REST contracts](https://www.keycloak.org/docs-api/latest/rest-api/index.html).

**Tools → A2A agent catalog** lets administrators register Agent Cards, choose display names,
icons and descriptions, and assign groups or individual accounts independently of MCP access.
Advertised capabilities and skills come from actual Agent Cards. Authorized users activate an
agent with private API-key or Bearer credentials. Existing personal agents remain available.
Catalog grants are checked again during execution, and changing a target invalidates its user
activations so credentials cannot silently follow a changed endpoint. Neither catalog treats
administrator management privileges as permission to execute an unassigned integration.

**Tools → Project memory** saves an editable brief for the selected project. The brief is
included in local Buddy project conversations and workflows; external A2A agents do not receive
it automatically. Revision checks prevent concurrent edits from overwriting one another.
**Branch conversation**, beneath a completed reply, forks saved history through that turn with
a fresh agent session. Personal forks copy the current file references, including Wasabi objects;
project forks continue to share the project repository. Files are current snapshots, not historical
versions corresponding to the selected message.

**Tools → Productivity workspace** includes meeting actions, data exploration, and private
reusable deliverable recipes. Meeting transcripts can be pasted or uploaded as text, extracted in
chat, and reviewed through editable action/owner/date fields before a Monday/email handoff is
proposed. Missing owners, destinations and recipients must be resolved before execution.
Recorded audio upload transcription is not included; existing voice input remains available.

The data explorer reads real CSV or XLSX/XLSM/XLTX files up to 2 MB, 10,000 data rows and 200
columns. Choose a worksheet, filter rows, compute numeric summaries, preview charts, and export
filtered CSV or calculation provenance. Formulas use cached values; macros and formulas are not
executed. Legacy XLS files require CSV conversion. Explorer uploads are transient; generated
chat deliverables continue through the existing persistent file storage.

Recipes save source requirements, structure, branding instructions and an output format, then
launch the existing chat or presentation generation flow. **Tools → Notifications** collects task
results, pending approvals, feedback updates, and accessible knowledge changes/review deadlines
with durable per-account read markers. Existing desktop completion-notification behavior remains
unchanged. Knowledge administrators can set document owners and review dates and mark a review
complete; the library exposes overdue sources.

These additions do not change `BOB_FILE_STORAGE`, Wasabi credentials, bucket settings, object
verification, or garbage-collection policy. PostgreSQL stores catalog definitions, access grants,
private credential records and recipe metadata. Existing database-backed and Wasabi-backed files
remain readable through their recorded storage references.

### Private sticky notes

Ask Buddy to “make notes from your previous response” or “research [topic] and make me notes”, or select **Make notes** below a reply. Completed `bobnotes` responses render as animated paper cards; **Save to Notes** explicitly saves individual cards. Source links remain in each note. After a successful save, the card flies to the Notes toolbar and disappears from the conversation. Moving every card leaves “All notes moved to My Notes.” Edited saved notes remain moved when the conversation is reopened. Reduced motion skips the flight, and failed saves retain the card for retry. Saved notes are a separate private library.

Open **Notes** at `/notes`, or from the top toolbar or sidebar to search, filter by paper color, organize notes into named collections, create notes, edit Markdown with a preview, or delete notes. New saves automatically use a daily `YYYY-MM-DD` collection in `DEFAULT_TIMEZONE` (UTC fallback). Explicit collections are respected; clearing a collection means Inbox. Existing notes are not reorganized automatically. Search spans every collection and matches title, Markdown content, collection name, and creation date; date collections appear newest first. Saved notes remain after their source conversation is removed. The editor’s **Enrich with Bob** panel can add detail, examples, action steps, or researched citations. It runs in a private internal workspace, excluded from conversation lists and conversation search, and presents a proposed revision; **Use this revision** updates only the draft, then **Save note** commits it. Suggestions can be discarded and requests stopped. The source conversation is not changed. The note CRUD API is `/api/notes`; `/notes` and `/notes/` serve the workspace and support browser history. Language selection is directly available in the top toolbar. Notes use authenticated, owner-scoped PostgreSQL storage: other users cannot list, edit, or delete them. Notes are excluded from shared knowledge and administrator screens. CSS animations respect reduced-motion settings and require no extra animation dependency.

The Notes library also supports favorites (shown first), comma-separated tags, structured HTTP(S) source links, wiki links (`[[title]]` or stable `[[note:123|label]]`) and backlinks. Ambiguous titles remain unresolved; insert stable links from the editor to keep links working after renaming. Version history saves the state before each change and can restore an earlier state without losing the current version. Attachments are private, limited to 20 files per note and 10 MB per file, and download without inline execution.

Select notes to ask Bob for a combined summary, comparison, or action plan; the result opens as a new draft and the original notes remain intact. Markdown and PDF exports work for individual selections or the current collection/search (up to 100 notes per export), including tags and sources. PDF generation disables scripts and network access. All note records, versions, and attachments enforce creator ownership. Deleting a note removes its versions and attachments. The eight-chapter tutorial includes interactive Notes and Office Suite chapters in all four supported languages. Bob may contextually offer to create notes when useful, without keyword triggers or an automatic save; acceptance is required before drafting and saving remains explicit.

Each saved note’s **Options → Send note as email** opens a recipient form and sends through the administrator-configured SMTP service. Configure and enable SMTP under administration first. The email includes a UTF-8 `.md` attachment with the note title, body, tags, and sources. On an iPhone running iOS 26 or later, hold the attachment in Mail and choose **Share → Notes → Save**. SMTP acceptance is submission, not confirmed delivery; failures are never automatically retried. This feature requires no hosted content or custom iPhone shortcut.

Verification: `node tests/test_sticky_notes_frontend.mjs`, `python3 -m unittest tests/test_sticky_notes_policy.py`; application-container tests `tests/test_notes.py` and `tests/test_notes_integration.py`. The synthetic browser fixture `/sticky_notes_fixture.html` uses the clarification Vite configuration and `tests/test_sticky_notes_browser.py` to check save/reload, collections, editing/preview, manual creation, search, deletion, mobile layout, and reduced motion.


### Interactive answer actions and saved selections

The main chatbot can emit reviewed `bobui` action cards for saving a note or emailing a Markdown attachment. Users edit the title/body, enter an email recipient, and explicitly click the action. Cards never send or save automatically. Email uses administrator SMTP settings and reports server acceptance rather than confirmed delivery.

Explore/comparison selections, checklist ticks, calculator inputs, and filters/sort/view settings in the new analysis workspace are stored per authenticated owner and conversation in PostgreSQL. Identical widgets in different messages have separate keys; changes to a widget’s source start a new state. Read-only/shared views do not load or change the owner’s state or expose action forms. Deleting a conversation removes its interactive state. Selections are included as context when using a widget’s follow-up prompt.

An optional `bobui` analysis card accepts source headers, rectangular rows, and attribution, and reuses the existing Carbon-styled grid/charts with search, sorting, heatmaps, chart views, copy and CSV controls where supported. Expand preserves the mounted view. Missing values remain blank and disable chart conversion for that card. Existing Markdown tables, chart/bobchart rendering, research reports, and their exports are unchanged; research reports should continue using those established formats.

Verification: `node tests/test_intelligent_ui.mjs`, `node tests/test_analysis_data.mjs`, `node tests/test_chart_colors.mjs`, `node tests/test_chart_quality.mjs`, `node tests/test_interactive_state.mjs`, `node tests/test_interactive_actions.mjs`, and `python3 -m unittest tests.test_interactive_widgets tests.test_note_email tests.test_smtp_settings`.

### Flow layout options and contextual selection

Flow diagrams now offer Auto, Layered, Swimlane, Tree, Radial, Force, Stress, Rectangle packing, Component packing, and Fixed positions. The layout control is shared between inline and maximized views, and Save/JSON export includes the selected layout. Sequence diagrams keep their participant/message view.

For new diagrams, Buddy supplies `layout:"auto"` plus a semantic `purpose`: `process`, `hierarchy`, `concept`, `relationships`, `inventory`, `components`, or `spatial`. The viewer combines that purpose with the actual graph: owner assignments use swimlanes, rooted hierarchies use trees, central concepts use radial layout, cross-links use force/stress, independent items use rectangle packing, and disconnected groups use component packing. Existing diagrams without layout intent keep Layered. Explicit selections remain available; the viewer explains a fallback when topology or coordinates make a requested layout unsuitable.

Fixed positions require validated, supplied `position:{"x":...,"y":...}` on every node; coordinates are never inferred from measurements or invented. Overlaps or unroutable connections fall back to Layered. Rectangle packing is restricted to diagrams without edges. Every accepted layout retains all nodes and connections. The installed JavaScript ELK bundle has no native DisCo provider, so Component packing composes ELK layered subgraph layouts with ELK rectangle packing.

These options apply only to conceptual flow diagrams. The report/data-analysis policy still prioritizes the established Carbon charts and Markdown tables. Chart, table, report-rendering, and report-export components are unchanged.

Verification: `node tests/test_structured_diagram.mjs`, `node tests/test_diagram_selection.mjs`, `node tests/test_diagram_layout.mjs`, `node tests/test_fixed_diagram_routing.mjs`, and `node tests/test_diagram_sizing.mjs`.


### First response latency

Normal chat and Project Buddy emit a brief model-written next action before tool
calls, except when the user requires output-only content. Independent read-only
lookups may run concurrently; dependent calls, permission checks and writes retain
their ordering. Project context and workspace discovery also overlap, and the worker
loads independent owner-scoped context sources concurrently.

`BOB_AGENT_PREWARM=1` starts an isolated ACP process during context preparation and
hands that same initialized connection to the request. It is scoped to the exact
job, lease, user, conversation, scratch workspace, HOME and mode. No prompt or tool
action runs before handoff. Cancellation and preparation failures close the process
before scratch cleanup. This deliberately does not keep processes or native sessions
across jobs because scratch paths, credentials and permissions can change. Set the
variable to `0` and recreate core services to initialize after context preparation.

Conversation replay keeps its existing eight-turn, 16k-character budget. Older
assistant answers use explicitly marked excerpts; newest exchanges have priority.
The current request, live file manifest, authorization rules and output policies
remain outside that history compaction. Durable `timing` events record
`agent_process_started`, `agent_ready` and `prompt_submitted`, in milliseconds from
warmup start. Existing delivery milestones identify the first actual text separately
from transport/start/status events. Model/provider latency and tool duration still
vary; a status indicator is not counted as a model token.

Focused checks: `tests/test_agent_warmup.py`, `tests/test_chat_response_policy.py`,
`tests/test_conversation_context.py`, `tests/test_runtime_approval_policy.py`,
`tests/test_delivery.py`, `tests/test_streaming.py`, and
`tests/portfolio_bob_context.mjs` (TypeScript-capable Node runtime).


### A2A custom ports and bearer credentials

A2A remains strict by default. Set `BOB_A2A_ALLOW_PUBLIC_PORTS=1` to permit public
HTTP(S) agents on custom ports without per-origin entries. Set
`BOB_A2A_RELAXED_ORIGINS=1` to trust the exact hostnames already listed in
`BOB_A2A_ALLOWED_ORIGINS` across HTTP(S) schemes and ports. That host trust can
resolve to private networks, but does not authorize other private hosts or sensitive
metadata/loopback destinations. Redirects and resolved IPs are checked on each
connection. These flags do not relax MCP connection policy. Recreate core API and
worker services after configuration changes.

Both **Define A2A agent** in Settings and **Add an A2A agent** have an optional
masked Bearer token field, independent of what the Agent Card declares. It is used
for card discovery and stored only in the current user's private agent credentials.
Shared catalogue definitions and audit records do not contain it. Discovery never
forwards the token across an origin-changing redirect; a card advertising an
unrelated authenticated endpoint requires separately configured endpoint credentials.
Blank edits preserve an existing token. Agents without authentication remain usable.


### DecisionsBuddy

The Decisions plugin now uses the DecisionsBuddy name, shared PostgreSQL persistence, Carbon typography/spacing, and saved administrator connections for IBM Knowledge Catalog and watsonx.data intelligence. Local and separate-service deployment follow the existing plugin patterns; Wasabi remains the shared binary-object backend. See [setup, governance and Docker cutover](docs/decisionsbuddy.md).

### Learning Buddy plugin

Optional EPUB reading and private folder-based assessments, associated with verified Keycloak users and groups. The `/teacher` group enables quiz authoring; creator approval is required before publication, and results remain admin-only. See [Learning Buddy](plugins/learning/README.md) for setup, deployment, and supported workflows.

### Workspace browser paths

Workspace screens use `/app/tasks`, `/app/knowledge`, `/app/research`,
`/app/connections`, and corresponding `/app/{screen}` paths. Individual tasks
append their ID. Existing Office file paths remain available. Notes open at
`/notes/{note_id}` and portfolio projects at `/projects/view/{project_id}`;
portfolio tabs use `/projects/tabs/{tab}`. Learning folders, books and quizzes
use `/learning/folders/{folder_id}` with `/books/{book_id}` or
`/quizzes/{quiz_id}`. Links preserve authentication and each resource's existing
access checks. Browser Back/Forward and reload restore these screens.

Learning books use paginated chapters, keyboard/swipe page turning and a private
notes palette. Colored notes are saved per reader and book; membership is
rechecked when listing, saving or deleting them. Page numbers depend on text size
and available reading width.
