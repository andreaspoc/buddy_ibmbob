# Carbon review and fixes

Reviewed 2026-10-21. This work preserves the branding and the existing chat backend.

## Changes

- Added official Carbon React components and Sass styles. Login uses TextInput, PasswordInput, Button, Stack, InlineLoading, and InlineNotification. Navigation and confirmation actions use Carbon buttons; application feedback uses Carbon notifications.
- Replaced the hand-maintained foundation with `src/carbonFoundation.scss`, using Carbon theme, spacing, typography, layout, and breakpoint modules. The foundation loads after the legacy appearance layers. The former rounded-controls sheet now contains only picker positioning and is named `referencePicker.css`.
- Removed competing rounded control overrides across navigation, menus, notes, member chat, and Office assistant controls. Avatars, status markers, and the floating chat launcher retain their identity shapes. The chat composer uses 16px rounded corners by user preference; clicking it does not add focus outlines, while Tab navigation shows one outer focus indicator.
- Added skip navigation, corrected nested main landmarks in Knowledge, Administration, Office, and Research, and restored visible keyboard focus where legacy styles suppressed it.
- Fixed Office storage contrast, tutorial help text, notes color swatches, and small sidebar/PDF badge contrast. Notes outline indentation now uses Sass spacing instead of inline styles.
- Kept native modal semantics for confirmations. Feedback portals move inside the active native modal so dismiss buttons remain interactive. Confirmation queueing, default Cancel focus, Escape, notice pause/resume, and persistent errors have regression coverage.
- Separated unavailable and loaded slide-viewer lifecycles so changing deck availability cannot change React hook order. Renamed the ordinary notes template helper to avoid incorrectly treating it as a React hook.

## Verification

Use Node 24, matching the Docker frontend build. TypeScript, Vite production bundling, and lint run against the installed dependencies. Lint warnings outside this change remain; they are not suppressed.

Browser tests intercept backend calls and use explicitly synthetic data. They do not verify live persistence, account configuration, provider connections, or model output.

| Coverage | Checks |
| --- | --- |
| Login, 320/390/768/1440px | Local login, registration, password visibility, failed credentials, error dismissal, SSO-only presentation, unconfigured/unavailable authentication, refusal to unlock without a verified session |
| Chat, six widths from 320 to 1920px | Header bounds, horizontal overflow, 4px navigation controls, rounded composer, quiet pointer focus, single outer keyboard focus indicator, landmarks |
| Notes and editor, four widths | Create, edit, save, favorites, Write/Preview keyboard tabs, dialog bounds, color swatches and filter geometry |
| Main workspaces and settings, mobile/desktop | Tasks, Knowledge, Administration and its tabs, access, memory/presets, comparison, notifications |
| Additional screens, 390/1440px | Connections, MCP/A2A catalogs and editors, workflows, Template Studio, Mods, research/search, productivity tabs, apps, member chat, Office, welcome tutorial |
| Native dialog fixture | Queueing, Cancel focus, Escape, feedback timer behavior, dismissal above an open native modal |
| Slide viewer fixture | StrictMode loading/valid/invalid/empty transitions, SVG rendering, navigation and reset behavior |
| Accessibility scan, 13 representative cases | No violations for the checked contrast, label, button-name, nested-interactive, landmark, dialog-name, and ARIA-value rules; login, notes/editor, workflows, administration, member chat at mobile/desktop sizes, and desktop Office |

Regression scripts live in `tests/carbon_*_browser.mjs`. Start the Vite development server, install Playwright in a test environment, and point the scripts to its module if it is not locally resolvable:

```sh
cd web
npm ci
npm run dev -- --host 127.0.0.1 --port 3177
```

From the repository root, in another terminal:

```sh
export CARBON_PREVIEW_URL=http://127.0.0.1:3177
# Optional when Playwright is installed outside the repository:
export CARBON_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
node tests/carbon_migration_browser.mjs
node tests/carbon_screens_browser.mjs
node tests/carbon_dialog_browser.mjs
node tests/carbon_slide_viewer_browser.mjs
```

The dialog and slide fixtures require the development server. Screenshot output can be directed with `CARBON_SCREENSHOT_DIR`.

For the accessibility scan, install `@axe-core/playwright` in the test environment and run `tests/carbon_accessibility_browser.mjs`. If installed externally, set `CARBON_AXE_MODULE` to its absolute module path alongside `CARBON_PLAYWRIGHT_MODULE`.

## Carbon MCP results

The original six-file audit is retained in `carbon-audit.json`; `carbon-audit-after.json` records the rerun and manual disposition. The original audit reported 238 flags. Five of the six updated files return zero flags. The foundation retains analyzer findings for supported Sass font-family calls, font-face metadata, CSS role selectors, and compatibility aliases. These are documented analyzer limitations or intentional metadata, not rendered-element accessibility failures. The raw tool result is preserved rather than hidden.

This is a review of reachable UI and selected states, not certification of every possible screen state. Populated histories, real uploads, SSO redirects, provider setup, generated decks, messages, and execution results require representative real integrations or dedicated fixtures. Carbon AI Chat was researched but has not replaced Buddy's existing chat framework.

Geometry customization uses Carbon radius tokens: 4px controls, 8px cards/dialogs, and 16px chat composer. These are brand choices, not universal Carbon defaults. Carbon MCP popover guidance specifies 2px floating corners and straight joins when attached to a toolbar: https://carbondesignsystem.com/building-blocks/core/components/popover/guidelines/#corners. Avatars remain circular and document content keeps its authored shapes.

Chat document uploads now retain queued attachments when creating a session, recover from transient status-check failures, and expose preparation failures with an inline retry. Browser fixtures cover PDF/DOCX readiness, polling recovery, authorization errors, and session changes; real backend extraction and authenticated upload checks passed separately.

Standalone attach, notification, menu, and icon-only dismiss actions use circular 44px targets, following Carbon MCP icon touch-target guidance. Search fields and independent filter/metadata chips use the maximum radius token. History items, attachments, dropzones and welcome suggestions use 8px corners. Text buttons and connected toolbars retain their previous shapes; keyboard focus indicators remain visible.

## Typography and spacing follow-up — 2026-10-23

Carbon owns typography and spacing; ChatGPT-inspired rounded geometry is retained.
Office title, subtitle, connection badge, suggestions, composer, actions, reply labels,
preview lists, warnings and status text now use Carbon type styles. Header, badge,
composer and preview spacing use the installed Sass spacing tokens. Reading text
uses body-02, UI descriptions/actions use body-01, and metadata uses label-01.
Main suggestion descriptions no longer use caption styling. Answer/clarification
headings use heading-03 (20/28) rather than a custom 24/32 scale. Remaining People
sender labels also use a Carbon heading style. Legacy important declarations are
resolved with a helper that reads the installed Carbon type-token map and preserves
Carbon CSS custom-property overrides.

Verification: Node 24 production build and lint passed (existing lint warnings remain).
`tests/office_typography_browser.mjs` passed for docx/xlsx/pptx/pdf/html, Carbon and
Copilotkit themes, 320/390/768/1440 widths, generated synthetic replies/previews, and
200% reading text. `tests/carbon_migration_browser.mjs` passed. The existing readable
typography suite passed size assertions but stopped at its unrelated expectation that
no catalog card is selected. A temporary copy skipping only that assertion passed the
remaining responsive, tab/custom-answer and 200% resizing checks. The original
selected-card assertion is unchanged. These checks use synthetic content, not live
Office/model services. Production assets were built; running services were not redeployed.

## Shared motion and rendering follow-up — 2026-10-23

App chrome now shares the installed `@carbon/motion` durations and productive curves
through Sass tokens and `src/lib/motion.ts`. Routine transitions across workspace
style sheets use those variables; broad `transition: all` rules were replaced with
explicit visual properties. Sidebar/split-layout resizing no longer continuously
animates widths. Entrances use a short 4px movement, while transfer feedback uses
Carbon's 400ms duration. Periodic loading indicators retain their separate cadence.
Authored documents retain their own presentation styling.

The interface observer batches entrance measurements once per frame, skips Markdown
and editable content, and removes the old repeated measurement/exit-cloning path.
Reduced motion applies across lazy workspaces, portals and pseudo-elements; JavaScript
feedback finishes when the preference changes. Explicit scroll navigation respects
the preference, while streamed content follows directly and preserves reader scroll
position. Project Buddy now follows its own log rather than scrolling its ancestors.
Mobile viewport updates are batched and only scroll a focused input when obscured.
SVG charts, the Carbon chart bridge and supported embedded-chart replay use the shared
shorter durations. Reduced motion also bypasses map camera movement and chart updates.

The stream buffer batches bursts per frame with a bounded 240ms catch-up window.
It preserves queued text order when background/reduced-motion delivery begins, keeps
Unicode pairs intact across transport chunks, and resolves concurrent completion
callers with a background-frame timeout fallback.

Verification: production build and lint passed with existing warnings. Ten stream
buffer tests, App stream integration, chart color/quality tests, Office typography
matrix, conversation-mode transfer tests, and the new `tests/app_motion_browser.mjs`
passed. The new browser check covers Carbon timing, live reduced-motion changes,
immediate close without cloned content, lazy Office/Projects, stable streamed DOM,
reader scrolling, and typing during streaming. `tests/carbon_screens_browser.mjs`
reported no page errors or layout failures across its desktop/mobile workspace matrix.
The map unit test still fails its location-count-badge expectation; removing this
change's map modifications reproduces that same failure. No production service has
been restarted. Browser checks use synthetic data and do not establish a device-wide
frame-rate guarantee or verify external Office editor behavior.

Mode-switch pacing adjustment: A2A agents ↔ Skills now uses Carbon slow-02
(700ms), giving the morph more time to read. Note-save feedback stays at 400ms;
reduced-motion switching stays immediate. Desktop/mobile mode-switch regression passed.

Docker deployment completed 2026-10-23: rebuilt the core image and started it with
Office, People and Projects profiles enabled using the existing HTTPS configuration.
All three plugin services and the app report healthy; the People worker is running.
Wasabi bucket, endpoint, region and credential fingerprints match their predeployment
values for every deployed service. HTTP and HTTPS health endpoints returned 200.

Minimal mode-switch update: replaced the conversation's flying/morphing panel with
a stationary 36px outlined skill spark and connected-agent symbol in a 72px cue.
The symbols crossfade with a small scale change over 1.4 seconds (two Carbon slow-02
intervals). The conversation stays in place, with no content clone or full-page fade.
Reduced-motion switching skips the cue; changing that preference during the cue
completes the switch and removes it. Desktop/mobile mode-switch regression and the
production build passed. Other note-transfer feedback retains its separate timing.

Dashboard chart repair — 2026-10-23: the reported sales_analysis.html used nonexistent
.min Carbon asset paths, false embedded markers on external tags, and lacked the
BobVisuals adapter. Its stored file now embeds the trusted Carbon assets/adapter,
retains its supplied data, uses a numeric donut center with a formatter, and caches
successful/pending tab initialization instead of recreating charts on every visit.
Original and repaired artifact revisions are retained. All 11 charts were tested
across every tab, repeated visits, offline operation and the app's CSP/sandbox preview.
The packager now repairs those malformed markers/known asset paths and supplies a
missing adapter; eight policy tests and the existing offline chart regression passed.
Shared diagnostics use safe textContent. Core app/worker Docker deployment passed
health checks; storage remains on Wasabi.

Slower chart pacing and Office verification — 2026-10-23:
- Shared chart entrances/replays use 1400ms; data and legend updates use 700ms.
  Carbon productive easing remains shared with the UI. Reduced motion is immediate.
- Added `web/docs/chart-motion.md`, updated dashboard authoring guidance and refreshed
  the reported dashboard's embedded bundle through artifact revision-aware saving.
- Production build/lint, Carbon rendering/replay/update/reduced-motion regression,
  offline export regression, policy tests, and SVG chart quality/color tests passed.
- Tested the real authenticated Save a copy to Office Suite button against the live
  services: HTTP 200, confirmation shown, saved bytes read back identically from Wasabi.
  The saved HTML opens in Office with charts. The reported storage error was not
  reproducible; no storage configuration change was needed. A temporary assistant-save
  transport test and idempotent retry also passed; its synthetic file/receipt were removed.
- The source Download button and Office download return the same saved dashboard bytes.
  App/worker Docker deployment passed health checks; all plugin Wasabi fingerprints
  remain unchanged. The temporary verification login is revoked after testing.
