# Native interactive answers

Ordinary worker conversations can emit fenced `bobui` JSON alongside Markdown.
The policy in `app/intelligent_ui.py` describes the schema and the situations in
which the assistant should choose it. Presentations, artifact edits, research,
and automated workflows keep their existing response protocols.

The client validates all data before rendering native React views:

- `explore`: keyboard-accessible topic tabs.
- `comparison`: responsive side-by-side option cards.
- `steps`: a local checklist with progress and reset. It does not run tasks or
  save completion across reloads.
- `split`: an editable equal bill splitter, with bounded numeric inputs and a
  displayed formula. Per-person amounts are rounded for display; this is not a
  payment settlement tool.

Each view accepts optional `actions` containing a label and a follow-up prompt.
A click submits the prompt through the existing chat path. Actions are disabled
while streaming and omitted from shared read-only conversations. Other local
exploration remains available in shared conversations.

No generated JavaScript, HTML, arbitrary formulas, or network requests execute.
Invalid or unfinished output remains inspectable through the source fallback;
open streaming blocks show a pending view. Existing Markdown, citations, chart,
diagram, quiz, approval, and artifact renderers remain in use. View state survives
additional streamed text when the underlying interface source stays unchanged.

The welcome screen's task starters populate and focus the composer. They never
submit a request until the user sends it. Existing customizable templates remain.

## Verification

Run `tests/test_intelligent_ui.mjs` with Node and the installed TypeScript package.
The Playwright test `tests/test_intelligent_ui_browser.py` uses the existing
structured diagram fixture served on port 3012. `test_workspace_enhancements_browser.py`
accepts `WORKSPACE_FIXTURE_URL` for its workspace fixture. When serving these pages,
exclude the `/workspace` API proxy: it otherwise captures the workspace fixture URL.

Tests use explicitly synthetic content. They verify the rendering and submission
contract; they do not establish that every model response will select a native UI.
Model adherence and task-specific output quality still depend on the configured
model. Lint requires a working native oxlint installation.

## Ordinary-chat response restraint

`app/chat_response_policy.py` selects brief-first guidance for ordinary chat and
replaces the mandatory-visual paragraph only for that scope. The original shared
`DIAGRAM_POLICY` is unchanged. The worker appends chat guidance after other response
policies so optional UI suggestions cannot turn a short answer into a full report.

Research jobs, presentations, automated workflows, artifact edits, delegated
agents, specialized/custom skills, data analysis, and note creation/enrichment
retain their original policy. Scope checks conservatively preserve specialized
flows when earlier user requests or spreadsheet attachments indicate analysis,
reports, presentations, or notes. This also protects short or non-English follow-ups
in an established specialized conversation. The model-facing guidance additionally
exempts specialized deliverables and honors explicitly requested detail.

Ordinary chat leads with the answer; one purposeful visual is optional, repeated
summaries/checklists are discouraged, and extra background can be collapsed.
Security claims and remediation instructions require verified authoritative sources.
Saved Notes remain distinct from local answer checklists; the bobnotes draft/save
flow is unchanged. No existing messages or artifacts are rewritten.

`tests/test_chat_response_policy.py` covers the linked breach-roundup/follow-up
requests and exact policy preservation for the protected flows. These are scope and
prompt-contract checks, not a guarantee of the configured model's word count or
source adherence in every future answer.

## Paired rows for in-chat flow diagrams

Chat answers opt into `compactDiagrams`. Simple directed paths render in centered,
alternating two-node rows when the diagram has at least 600px of available width.
The answer bubble can use up to 1100px so the diagram uses the chat area rather
than inheriting a narrow text column. Narrow screens retain readable vertical nodes.

This is a view layout only: node IDs, edges, labels and saved JSON are unchanged.
Branches, cycles, disconnected graphs, swimlanes, radial/tree/force layouts and
sequence diagrams keep their existing graph layout. Other Markdown consumers,
including reports and Notes, do not opt in. The original layout remains the default
for callers of `layoutDiagram`; reports and presentations have no policy changes.

`test_diagram_layout.mjs` checks paths with even/odd node counts, captions, graph
traversal, mobile and unchanged complex graphs. `test_paired_flow_browser.py` checks
paired rows, centering, bounds and JSON export through the real Markdown renderer.
