# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## UI foundation

`src/carbonFoundation.css` defines the app's Carbon-based productive typography,
spacing, focus, and control rules with Buddy purple accents. It loads last in
`main.tsx`; the root `data-design-system="carbon"` marker gives its shared rules
precedence over legacy component styles, including lazy-loaded screens and portals.
Use the `--cds-*` tokens for new UI rather than introducing another type scale.
The base interface uses 14/20px text, reading text 16/24px, labels 12/16px, and
semibold (600) headings. Touch inputs use at least 16px to avoid browser zoom.

IBM Plex Sans 1.1.0 is bundled locally under the SIL Open Font License in
`src/assets/fonts/`; there is no external font service. Embedded documents and
presentation content retain their own formatting. This adapts Carbon's foundations
to existing React components; it does not replace them with `@carbon/react`.

Run `tests/test_carbon_foundation_browser.py` with `CARBON_PREVIEW_URL` against a
built preview for font loading, translated headers, responsive composing,
workspace navigation, and dialog typography checks using synthetic API responses.

AI interaction surfaces share `TaskStateIndicator` and `AnswerContext`. Task labels
prefer explicit terminal events, and only the current response reader indicates
live work; a saved partial response does not imply continued execution. Stop stays
pending until the server confirms its terminal outcome. Answer context lists links
in the answer separately from request-scoped notes/files and reported skills/tools;
it does not infer retrieval, claim verification, model identity, or confidence.
Context pairing uses the original turn or correlation ID to avoid borrowing inputs
from another request after deletion. Run `node tests/test_ai_transparency.mjs` from
the repository root and `tests/test_ai_transparency_browser.py` against a built
preview using `AI_TRANSPARENCY_PREVIEW_URL` for synthetic lifecycle and source checks.

UI geometry uses `--cds-border-radius-none` for classic Carbon square controls and
surfaces. The scoped geometry override also covers legacy inline radii; it excludes
authored slide/editor content and retains status dots, avatars, and tag shapes.
Member chat is an intentional circular floating launcher with server-backed unread
counts (visual `99+`, full accessible total). Its launcher/panel offsets measure the
whole composer in viewport pixels and convert through UI zoom once. Resize, display
scale/density, and workspace changes update those measurements. Run
`tests/test_member_chat_position_browser.py` with `CARBON_PREVIEW_URL` to check Send
clearance at 75/85/100%, multiline drafts, panel bounds, and unread updates.

Display scale defaults to 85% across desktop, tablet, and phone layouts. Settings offers session overrides of 75%, 85%, or 100%; Automatic restores 85%.

Chat replies use one collapsed **Answer details** disclosure for recorded delivery steps, progress, tools, supplied context, and AI transparency. Active and exceptional states remain visible in its summary. Successful replies omit completion banners and separate timelines. RAG citations and links from recorded retrieval appear in its Sources section; inline citation previews remain available. Generic links alone are not labelled retrieval sources.


Dashboard answers and follow-up forms use a readable type scale in
`src/carbonFoundation.scss`: reading text 16/24px, controls and supporting text
14/20px, status tags 12/16px, card headings 20/28px, and section headings 24/32px.
Sizes use rem units to respect text enlargement. These scoped rules resolve legacy
component overrides without changing authored document typography.

Run `tests/readable_typography_browser.mjs` against Vite with
`CARBON_PREVIEW_URL` and, if needed, `CARBON_PLAYWRIGHT_MODULE`. The synthetic
fixture checks computed sizes, default scale, four viewport widths and 200% text
resizing.


New chats start with the real skill catalog rather than prompt templates. Selecting
an available skill preserves the draft and focuses the composer; only Send submits
it, with the selected skill name passed through the existing routing. Skills can be
searched, changed or cleared to Automatic. Selection is scoped to the conversation.
The Skills toolbar button opens the catalog in existing chats. Saved prompt-template
customization is no longer read or rendered. Slide themes remain a separate part of
presentation setup.

`tests/skill_selection_browser.mjs` uses a synthetic catalog with the actual ChatView
to verify selection, draft preservation, submission arguments, search, keyboard,
conversation isolation, busy/empty states and responsive layout.


The collapsed answer-details control shows the current reported activity and a
count of recorded steps. Status events take precedence, with work-log/tool-name
fallbacks; approval, stopping, queue and terminal states retain priority. It does
not infer steps from answer text or show tool inputs. Long labels clamp to two
lines; the full activity remains in the expanded details. Run
`tests/current_activity_browser.mjs` against Vite for synthetic progress updates,
keyboard interaction, masking, terminal cleanup and responsive checks.

Generated HTML dashboards use the actual `@carbon/charts` core library, pinned in
package-lock.json. `carbon-charts.ts` builds a standalone IIFE and CSS with embedded
IBM Plex fonts via `build-carbon-charts.mjs`. The normal build includes both assets.
Author dashboards with `await BobVisuals.carbon(element,{type,data,options})`, retain
the returned handle and use `handle.update({data,options})` for real data/filter
changes. Shared group colors remain stable across charts. Native Carbon transitions
use 700ms data updates and 1400ms graph entrances/replays with the main UI's productive easing. Keep hover/focus feedback immediate. See [chart motion guidance](docs/chart-motion.md).

`bob:chart-activate` with `detail.element` replays visible chart/section entrances
after a tab/screen is shown; `BobVisuals.replayVisible()` supports Replay controls.
Visibility transitions also replay entrances. Reduced-motion preferences suppress
motion, and live preview snapshots avoid replaying whole pages. Legacy ECharts
helpers remain for saved artifacts; new authoring instructions require Carbon.

Completed, changed Carbon dashboards are packaged before persistence: the trusted
local library/style assets are inlined for offline export, including fonts. The
scaffold stays small during authoring. Tests use explicitly synthetic data:
`tests/carbon_dashboard_browser.mjs`, `tests/carbon_dashboard_export_browser.mjs`,
`tests/carbon_preview_browser.mjs`, and `tests/test_html_artifact_policy.py`.
