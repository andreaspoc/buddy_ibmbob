# Buddy, Office Suite and Docmost integration

For the newer built-in Office tools, Notes transfers and chat DOCX/PDF export with preview controls, see [Buddy workspace integration](buddy-workspace-integration.md). The historical implementation notes below describe the earlier integration stage.

## Existing functionality reviewed

Office Suite stores private Office files in object storage with checksums, folder metadata, owner/read/write access, sharing, authenticated downloads and editor save callbacks. Supported formats are DOCX, XLSX, PPTX, CSV, PDF and HTML. HTML has its own editor. The ONLYOFFICE bridge supplies document/selection context and applies typed actions; the model does not execute arbitrary code in the editor. The in-editor Buddy assistant drafts changes for review and requires a separate confirmation for document replacement. Source editing and saving remain explicit actions.

Main chat already supports conversation uploads, prepared document previews, projects, notes, presentations, artifacts, research, tasks, knowledge retrieval, configurable connections and user-scoped tools. Main chat, research, workflow runs and the Office assistant send the current interface language. The selected English response policy previously followed the prompt's language, whereas the other three selections explicitly enforced their language.

Office's small-screen restriction previously existed only in CSS: its component could mount and contact the editor despite being invisible. Mobile uses the existing chat/notes/knowledge experience; this change does not create native phone or desktop applications.

## Implemented connections

- Desktop chat has **Use Office files**, supporting up to three owned or explicitly shared files. Each submission resolves file permissions on the server before reading any object. File names and reference metadata appear with the request and survive history reloads.
- Saved document snapshots are read-only evidence with file/location labels. Each file contributes at most 18,000 text characters. Partial context is marked. There is no OCR or claim to see unsaved edits. Spreadsheet formulas are source text, not evaluated calculations. Parsing has input/expanded archive limits and runs in a child process with CPU, memory and wall-time limits.
- Office's file actions include **Use in Buddy chat**, connecting a selected file to the main chatbot.
- Supported saved conversation documents and HTML artifacts have **Save a copy to Office Suite** with a folder destination. The server resolves the authenticated conversation scope, reads its saved file and uses existing Office content/destination validation. This creates a separate copy; it does not synchronize or overwrite the source. Save unsaved artifact edits first.
- Desktop Office is loaded on demand only above the existing 1,100px cutoff. Narrow screens do not mount its editor or send Office references. Direct Office URLs show an explanation and a return-to-chat action. Phones use 100% scale and touch-friendly navigation; desktop scale preferences remain available.
- English, Greek, Hindi and Maltese selections now explicitly govern new Buddy replies, with an explicit requested translation/output language taking precedence. Existing conversation text and user documents are preserved. New locale catalogs cover all 2,051 statically declared `t()` strings checked by the audit; dynamic user/server content requires separate handling.

## Language boundaries

The app interface and Buddy response policy are separate from third-party software. The existing ONLYOFFICE configuration uses English ribbon text for Hindi and Maltese and already displays that limitation. Docmost's own interface/login language is managed by Docmost. Switching Buddy language does not translate historical responses, user-owned content, names, code or direct quotations. In-flight requests retain their submission language; new requests use the current selection.

The audit verifies literal and conditional `t()` labels and placeholders. It is not a claim that arbitrary server exceptions, raw unwrapped JSX, all runtime action descriptions, or third-party plugins are fully translated. Native-speaker review remains useful for terminology.

## Docmost launcher and permissions

Configured URL: `https://docs.example.com:3000`. This is a different machine; the browser loads it directly. No Buddy cookie, API key or bearer token is forwarded. Buddy visibility does not grant Docmost permissions and the iframe does not make Docmost content available to the chatbot.

The authenticated `GET /integrations/docmost` returns the URL only for explicitly allowed users/profile groups and sends `Cache-Control: no-store`. Empty allowlists hide the button from everyone, including administrators. Disallowed users receive only `enabled: false`.

Configure Buddy's environment:

```dotenv
DOCMOST_URL=https://docs.example.com:3000
DOCMOST_ALLOWED_USERS=
DOCMOST_ALLOWED_GROUPS=
DOCMOST_EMBED=0
```

`DOCMOST_ALLOWED_USERS` is a comma-separated list of exact Buddy usernames. Available existing profile groups are `administrators`, `buddy`, `company_b` and `project_team`. Group/user grants are additive. Select the intended people before filling these values; no audience has been assumed.

The default panel offers an external link. Set `DOCMOST_EMBED=1` after verifying framing and login work from Buddy's actual public origin. The panel keeps **Open in new tab** visible because browser cross-origin restrictions prevent reliable detection of blocked iframe content. Users must be able to resolve/reach the URL and trust its TLS certificate.

Current Docmost documentation describes `IFRAME_EMBED_ALLOWED=true` and `IFRAME_ALLOWED_ORIGINS=<Buddy origin>` on the **Docmost machine**. Use the exact Buddy origin including scheme and nondefault port. Verify support in your installed Docmost version. Do not enable embedding for arbitrary origins. If Docmost or its reverse proxy still supplies restrictive framing headers, its administrator must resolve them on that machine. Shared SSO is a separate identity-provider configuration; embedding alone does not sign users in.

Reference: https://docmost.com/docs/self-hosting/environment-variables

The development environment could not resolve the supplied internal hostname, so remote headers, installed version and login behavior have not been verified.

## Further chatbot integration opportunities

1. **Docmost retrieval:** add a server-side connector using Docmost-supported APIs for the installed edition/version. Search and read under each user's Docmost permissions; preserve space/page grants, cite page URLs and track updates/deletions. A global service-account index must not reveal private spaces. Validate API availability and authentication before implementation.
2. **Office references across projects:** introduce explicit project/file links and cross-file retrieval with per-turn access checks. Avoid silently importing a user's entire private library.
3. **Reviewed editing from main chat:** reuse typed Office action plans, revision checks and the existing preview/apply/save workflow. The current read-only chat context intentionally does not imply the source has been edited.
4. **Persistent provenance:** record the source conversation/message and revision on imported Office copies, then expose backlinks and refresh/copy choices. Define conflict behavior before offering synchronization.
5. **Unified search:** merge conversation artifacts, Office files and authorized Docmost pages while retaining source-specific permissions and citations.

## Deployment

Compose bind-mounts `./app` over `/opt/bob-a2a/app`. Building the image alone therefore does not update served frontend assets. Build `web` with a supported Node runtime into `app/static/dist`, then recreate `bob-agent` and `bob-worker` to load Python routes and environment changes. The frontend checks `/api/office/chat-capabilities` before offering Office reference/import actions, so an older backend cannot silently ignore the new context. Verify `/integrations/docmost` as allowed/disallowed users, health, the served index's asset hashes, Office read permissions, and mobile/desktop behavior after deployment.


## Signing into Docmost inside Buddy

The requested flow is: sign into Buddy → open Docmost → use Docmost's own login form inside the panel → continue in Docmost. If an existing valid Docmost browser session is available in this embedding context, Docmost can reuse it. Buddy never asks for or forwards the Docmost password. This is separate authentication, not automatic SSO.

Buddy's local `.env` now sets `DOCMOST_EMBED=1`. The audience allowlist is still required before its button appears. Recreate `bob-agent` after environment changes. This setting alone does not make the remote Docmost login work.

On the Docmost machine, for a version supporting these settings:

```dotenv
IFRAME_EMBED_ALLOWED=true
IFRAME_ALLOWED_ORIGINS=<exact HTTPS origin used to open Buddy>
```

The angle-bracket value above is a placeholder, not a hostname to deploy. Include Buddy's port when nondefault. Restart Docmost after applying its environment changes, and check that its reverse proxy does not override the permitted framing policy.

The Buddy environment currently declares `PUBLIC_BASE_URL=https://192.0.2.10`; the actual browser URL has not been confirmed. Docmost is at `https://docs.example.com:3000`. These are cross-site if Buddy is opened using that IP. Current upstream Docmost's `setAuthCookie` uses `SameSite=Lax`; such cookies are not available to cross-site iframe requests. Permitting frames alone therefore may show a login form without allowing a persistent authenticated session.

For embedded login, host Buddy at an HTTPS hostname under `example.com`, using valid DNS and TLS, and set Buddy's `PUBLIC_BASE_URL` and Docmost's `IFRAME_ALLOWED_ORIGINS` to that actual origin. Separate machines and ports are compatible with this same-site arrangement. Confirm browser cookie behavior and your installed Docmost version before considering sign-in validated. External SSO identity providers can have additional frame restrictions and may require a top-level login flow.

Do not disable browser cookie protections, collect Docmost passwords in Buddy, strip framing headers broadly, or publish private pages as public shares to make login work. If an HTTPS same-site hostname cannot be provided, use Docmost in a separate tab while choosing an authentication architecture supported by your deployment.

Sources:
- https://docmost.com/docs/self-hosting/environment-variables
- https://github.com/docmost/docmost/blob/main/apps/server/src/core/auth/auth.controller.ts

Remote DNS resolution and Docker access are unavailable in this agent session, so live sign-in has not been tested.
