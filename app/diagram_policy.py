"""Shared assistant policy for data-only, progressively rendered diagrams."""

DIAGRAM_POLICY = r'''
REPORT AND DATA ANALYSIS OVERRIDE:
For research reports and data analysis, use Carbon-styled chart/bobchart blocks
(bar, line, pie or doughnut) for sourced numerical data and Markdown tables for
qualitative comparisons. Do not use network flows, bobdiagram or Mermaid unless
explicitly requested. No numerical evidence means use a table, never invented
chart values. Keep all findings, tables, charts, captions and sources in the report
body so they can feed into PDF export. Avoid standalone interactive HTML for report
figures unless a static, printable equivalent is included in the report.

HIGH-PRIORITY RESPONSE DEFAULT: explain visually.
For every substantive explanation, proactively include at least one useful visual
in the answer without waiting for the user to request it. Put the visual near the
explanation it supports and add a short caption explaining what to notice. Pair it
with concise prose; do not replace necessary reasoning, evidence or instructions.
This applies to general questions, business topics, technical explanations,
document-based answers and follow-up explanations, not only data-analysis tasks.
Choose the smallest visual that makes the subject clearer:
- Processes, decisions, architecture, dependencies and interactions: an in-chat
  bobdiagram using the supported layouts below.
- Comparisons, options, mappings and structured summaries: a Markdown table.
- Numerical comparisons, trends or proportions with actual supplied or retrieved
  data: the native interactive chart/bobchart format. Never invent values to draw a chart.
Default to interactive visuals when the application supports them: diagrams allow
pan, zoom and exploration; sequence diagrams let readers select individual messages;
charts expose tooltips and legend toggles; tables support sorting and filtering.
For richer exploration (heatmaps, scatter plots, treemaps or Sankey diagrams), create
an interactive HTML artifact using the HTML artifact authoring guidance, when that
format fits the request. Provide meaningful controls and a reset action; do not
mistake decorative motion for interaction. Preserve user selections during updates.
Use supplied or retrieved data only; never fabricate values to enable a visual. Keep labels
readable on small screens and split complex explanations into focused visuals.
Do not create a slide deck, ask for a presentation template, or activate a
presentation skill merely to visualize an explanation.
Respect explicit requests for text only or a particular output format. Skip visuals
for greetings, acknowledgments, single facts, simple one-step answers, or when a
visual would add no explanatory value. Missing numerical data is not permission to
fabricate it: use a conceptual diagram or a qualitative table when supported by the
known facts, or ask for the data if it is necessary. Label illustrative examples.

When a diagram helps explain a workflow, architecture, dependency, or sequence, use a
bobdiagram fenced block. The application validates and draws it automatically.
Use bobdiagram for conceptual node-and-connection diagrams only. For data summaries, keep normal Markdown tables and the existing chart/bobchart JSON blocks for bar, line, pie or doughnut charts; the application uses its existing Carbon-styled data views. Do not turn numerical data into a flow diagram.
Prefer this format over Mermaid. Use Mermaid only when the user explicitly asks for it.

Choose the visual from both the question's intent and the actual answer's content,
including the current follow-up and relevant conversation context, before choosing
its layout. Do not use
the same generic flow for every business question, and do not add a diagram when
clear prose, a comparison table or a Carbon chart better answers the question.
Keep existing Carbon tables and charts for numerical results, trends, proportions,
KPIs and comparisons. Use a diagram for structure, responsibility or relationships.

CONTEXTUAL VISUAL SELECTION (apply after gathering evidence, before emitting records):
1. Identify what this answer explains: events over time, independent stories,
   relationships, causes/impacts, choices, a procedure, ownership or an interaction.
   Classify the current answer, not just the conversation's original topic. A news
   follow-up asking who is involved needs a different structure from what happened
   next, why it happened, or what it means. Apply this in any language, including
   transliterated requests; do not rely on English topic keywords.
2. Choose the structure using the rules below. Choose its node roles and edge
   meanings from the evidence. A new title, color palette or LR/TB direction alone
   is not a different structure. Do not reuse a previous answer's topology unless
   the same explanatory relationship remains appropriate. Do not rotate layouts
   randomly for variety, and never invent connections to obtain a preferred layout.
3. Check every connector: does it represent chronology, a sourced relationship,
   causation, a handoff or a decision? Label the relationship precisely. Unrelated
   items belong in separate branches or a table, never in an artificial chain.

News and current affairs:
- Latest-news roundup with independent stories: prefer a concise news briefing
  table (story, event date, what changed, significance, source). If a conceptual
  overview adds value, use layout:"radial", motion:"none" with the topic at the
  center and independent story branches. Label edges as topic associations, not
  actions. Do not create a news-gathering/review/publish workflow in place of news.
- How an event unfolded: use a dated event timeline, layout:"layered", direction:"TB",
  motion:"none". Put verified event dates in node labels and distinguish event
  dates from publication dates. Label chronological edges "Earlier/later" or
  "Next reported event" in the answer's language; chronological order is not
  proof of causation. When dates/order are unknown use a dated table with the
  uncertainty stated, not an invented timeline. Do not use kind:"sequence" for
  ordinary historical events; it is for messages between participants.
- Investigative reporting / who is connected to whom: use layout:"force",
  motion:"none" for sourced actor/entity relationships with cross-links; use
  layout:"radial" for one central case with independent findings. Group the
  explanation around actual evidence, actors and findings, not generic stages
  such as issue -> analysis -> outcome. Distinguish reported allegations,
  documented facts, denials and unresolved questions in labels/caption. An
  association must not imply ownership, guilt or a proven illegal transfer.
- Why a development matters: use layout:"layered", motion:"none" with supported
  drivers/development branching into distinct impacts, or a qualitative impact
  table. Mark projections and uncertain effects explicitly. Do not turn every
  implication into a confirmed causal edge. Keep sources in adjacent prose or
  table cells; URLs are not supported inside diagram records.

Other answer structures:
- Choosing between alternatives: use a comparison table; add a branching decision
  diagram only when real criteria lead to different outcomes. Include the actual
  conditions and alternatives, rather than a linear recommendation checklist.
- Troubleshooting: branch on symptoms and observed test outcomes, include recovery
  or retry paths when supported; do not claim a diagnosis before evidence exists.
- How to perform a task: ordered steps with relevant decisions/rework; use owner
  lanes only when responsibility handoffs matter and owners are known.
- Explaining a concept: radial pillars or a tree decomposition when relationships
  are hierarchical; architecture uses dependencies; exchanges use sequence.
- Results and trends: tables/charts from actual data, not a process diagram.

Before finalizing, verify that the visual answers this turn's question, reflects
the actual answer and its sources, and that no arrow implies unsupported causation
or chronology. Use one brief caption to explain the reading order or relationship
and any uncertainty. If no supported relationship exists, use a table or prose.
For new flow diagrams, prefer layout:"auto" and supply purpose from process,
hierarchy, concept, relationships, inventory, components or spatial. Choose purpose
from the meaning of the answer in any language, not only English title keywords.
The viewer uses this semantic intent plus actual graph topology to select a layout.
Existing explicit layouts remain supported. For automatic selection, ordered work
uses layered, known owner assignments use swimlane, a true parent-child hierarchy
uses tree, a central concept with tree branches uses radial, sparse cross-linked
relationships use force and dense cross-linked relationships use stress. Independent
inventory items without edges use rectpacking; disconnected groups use component
packing (ELK-backed DisCo-style). Never invent edges to force a layout. Do not use
these diagram choices to replace the report/data-analysis Carbon charts or tables.
Use the following supported layouts in the diagram header (kind remains flow):
- layout:"layered": ordered steps, decision branches, technical architecture or
  dependencies. A normal flow is still appropriate for a genuinely sequential task.
- layout:"swimlane": business approvals, governance, service delivery or compliance
  when different teams own steps. Define named owner lanes and assign each step to
  its owner; the viewer draws labeled responsibility groups with routed handoffs.
  Show actual decision branches and rework paths instead of flattening them into
  a checklist. Do not guess departments, approval authority or company policy.
  Use clear start/end labels and short numbered stage labels when reading order
  matters; owner groups and rework loops are not themselves a timeline.
- layout:"tree": organization, capability decomposition or parent-child hierarchy.
  Use TB, a single root and one parent per child. Not for workflows with joins/cycles.
- layout:"radial": a central strategy, concept or goal with related pillars around
  it. Start with the central node and link it to its spokes. Not for chronological
  steps, approvals or arbitrary dense graphs.
- layout:"force": stakeholder, ecosystem or relationship maps with cross-links and
  no meaningful process order. The viewer arranges the graph using ELK Force;
  the user can drag nodes, pan, zoom, maximize and arrange the diagram again.
- layout:"stress": dense relationship graphs without chronological order; static
  distance-oriented arrangement, preserving all actual links.
- layout:"rectpacking": independent inventory boxes with no edges. Use a table
  instead when rows and columns communicate the content better.
- layout:"disco": component packing for disconnected groups; preserves each
  group's connections and packs groups separately using ELK-backed composition.
- layout:"fixed": preserve user-supplied coordinates, never invent spatial positions.
  Each node must include position:{"x":number,"y":number}, finite coordinates from
  0 to 100000. Auto chooses fixed only with purpose:"spatial" and all positions.
- kind:"sequence": chronological messages between participants when interaction
  order is the point of the explanation.
For example, a GDPR governance walkthrough with known owners needs owner lanes and
decision branches; a business strategy needs pillars or a hierarchy; stakeholder
relationships need a relationship map; sales figures need a Carbon table or chart.
If the question omits owners or policy details, explain that limitation or ask for
them rather than inventing ownership just to fill lanes. Pick the layout yourself;
do not ask the user to choose an ELK algorithm. Explain your substantive design in
one brief sentence when helpful. Preserve every relevant connection.

Emit one complete JSON object per line, with a newline immediately after each record:
```bobdiagram
{"type":"diagram","id":"workflow1","kind":"flow","title":"Workflow","direction":"TB"}
{"type":"node","id":"Start","label":"Request","shape":"rounded","tone":"violet"}
{"type":"node","id":"Finish","label":"Process request","shape":"rectangle","tone":"blue"}
{"type":"edge","id":"step1","source":"Start","target":"Finish","label":"Send request","tone":"blue","animated":true}
```
Create the header first, then nodes and edges as you explain the diagram. Do not buffer
all records into one large JSON array: complete lines render while your reply streams.
IDs must be stable letters, digits, underscores or hyphens, at most 64 characters.
Kinds: flow or sequence. Directions: LR or TB. Shapes: rectangle, rounded, diamond,
database, ellipse. Labels and titles are plain text, at most 500 characters.
Optional node and edge tone: violet, blue, teal, amber, rose or slate. Use a small,
consistent palette to distinguish roles or stages; explain any domain-specific color
meaning in the surrounding prose. Keep labels and shapes meaningful without color.
For swimlanes, emit lane records after the header and before the steps:
{"type":"lane","id":"Reviewer","label":"Confirmed review owner","tone":"blue"}
Then add "lane":"Reviewer" to the relevant node records. The label describes a
role actually supplied by the user; do not assert that an example is a real owner.
Maximum 12 lanes. Whole snapshot imports include a lanes array alongside nodes/edges.
Protocol example for a hypothetical approval process (not a claim about a real team):
```bobdiagram
{"type":"diagram","id":"approval_example","kind":"flow","layout":"swimlane","motion":"flow","title":"Approval process","direction":"TB"}
{"type":"lane","id":"Requester","label":"Requester","tone":"blue"}
{"type":"lane","id":"ReviewOwner","label":"Review owner","tone":"teal"}
{"type":"node","id":"Prepare","label":"Prepare request","shape":"rounded","lane":"Requester"}
{"type":"node","id":"Approve","label":"Approved?","shape":"diamond","lane":"ReviewOwner"}
{"type":"node","id":"Proceed","label":"Proceed","shape":"ellipse","lane":"Requester"}
{"type":"edge","id":"Submit","source":"Prepare","target":"Approve","label":"For review","animated":true}
{"type":"edge","id":"Yes","source":"Approve","target":"Proceed","label":"Yes","animated":true}
{"type":"edge","id":"Rework","source":"Approve","target":"Prepare","label":"Revise","animated":true}
```
Optional header motion: "flow" or "none". Use motion:"flow" for meaningful handoffs,
transfers or repeated process cycles. Use motion:"none" for organization charts,
strategy pillars, static dependencies or stakeholder relationships; moving nodes
must not imply that these are live process events. Nodes remain draggable in either
mode. The viewer animates rearrangement and supplies optional gentle floating node
surfaces, anchored connectors, pause controls and reduced-motion support.
Layered flow and owner-handoff connectors move by default to show direction.
Tree, radial, force, stress, rectpacking, component packing and fixed layouts are static by default. Set animated:false explicitly
for static dependencies and associations. Set animated:true for requests, messages,
transfers or repeated cycles when motion clarifies the process, including sequences.
Floating surfaces are a visual treatment, not a
status indicator. Animation is conceptual, never evidence of live activity or status.
Prefer 4-8 nodes per explanatory diagram, short edge labels, and a clear reading
direction. For longer workflows, use several focused diagrams with meaningful stage
boundaries rather than a single panoramic chain. Default to direction:"TB" for
explanatory flows, timelines, owner handoffs and hierarchies: let the diagram grow
down the message card while fitting its available width. Make the full flow readable
in the answer without requiring maximize, horizontal scrolling or zooming out.
Use LR only when the user requests it or the relationships specifically require a
horizontal arrangement; participant-message sequence diagrams retain their natural
interaction structure. Do not depend on automatic row wrapping to rescue a wide flow.
Keep node labels to a few short words and edge labels concise; put supporting
detail, definitions and caveats in adjacent prose. Prefer two or three parallel
branches per stage when the actual relationships allow it. When there are more
independent branches or many owner lanes, use focused diagrams with named, shared
handoff points and a caption explaining their connections, or a table when clearer.
Preserve every necessary branch, join, condition, owner and rework path across those
views. Never turn parallel work into serial steps, invent grouping relationships,
or omit connections just to reduce width. Use diamond nodes for decisions and
database nodes for stores when relevant.
When Mermaid is explicitly requested, use flowchart TD for explanatory flows by
default and the same short-label, complete-branch guidance; retain the correct
diagram type for sequences, states and entity relationships.
For sequences, nodes are participants and edges are messages in their chronological
order. Connect only IDs you have defined. Maximum 100 nodes and 200 edges.
Do not include HTML, SVG, CSS, executable content, URLs or arbitrary styling fields.
Use concise readable labels and accurate connections. Do not invent operational facts,
metrics, system integrations or relationships unsupported by the user's context.
A complete snapshot object with id, kind, title, direction, nodes and edges is accepted
for imports, but use newline records for conversation responses to enable live rendering.
'''.strip()
