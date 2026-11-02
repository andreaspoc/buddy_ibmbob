"""Restrained ordinary-chat responses; specialized deliverables retain their policies."""
from __future__ import annotations

import re
from pathlib import PurePosixPath

from app.conversation_context import SPREADSHEET_SUFFIXES
from app.diagram_policy import DIAGRAM_POLICY
from app.skill_routing import _ANALYSIS_REQUEST

# Conservative exclusions supplement explicit runtime modes/skills. Ambiguous follow-ups
# inherit exclusions from user requests, never from assistant-generated content.
_SPECIAL_DELIVERABLE = re.compile(
    r'\b(reports?|presentations?|slides?|decks?|powerpoint|pptx|notes?|bobnotes|'
    r'statistical|analytics|data\s+analysis)\b|SOURCE NOTE \(JSON\):', re.I,
)

INTERACTIVE_RESPONSE_POLICY = '''
[Interactive response timing and tool execution]
When a request needs tools, briefly state the concrete next action in one short sentence
before the first tool call, then start the tools immediately. This must be your own streamed
text describing an intended action, not a generic acknowledgement or a claim that work has
already happened. Do not invent findings, access, results, or completion to fill the wait.
For a question you can answer directly, answer directly without a preliminary announcement.
Explicit output-only formats and artifact protocols take precedence; do not insert commentary
into JSON, code, or another constrained deliverable.

Batch independent read-only lookups in parallel when the tools support it (for example,
independent project records, source pages, or document searches). Inspect every result before
drawing conclusions. Run dependent calls sequentially and keep mutations, approvals, and
operations sharing mutable state in their required order. Do not issue speculative calls or
skip verification to save time. After tools finish, stream useful verified findings as they
become available; avoid repeating the initial action sentence in the final answer.
'''.strip()


def interactive_response_policy(payload: dict) -> str:
    """Apply timing guidance across chat and assistants, preserving voice turn taking."""
    return '' if payload.get('voice_mode') else INTERACTIVE_RESPONSE_POLICY

CHAT_RESPONSE_POLICY = '''
[Ordinary chat answer policy]
Applicability: ordinary conversational answers only. If the task is research/report writing,
presentation creation, data analysis, note creation/enrichment, or another explicitly requested
artifact, keep its existing depth, format, visuals, source requirements and workflow. These
chat defaults must not shorten or restructure those deliverables. Follow explicit requests
for comprehensive detail, length, format, or multiple visuals.

Lead with the answer or key finding. For a routine question, aim for 100–250 words; a technical
follow-up may need 250–450. These are defaults, never hard limits: retain necessary evidence,
uncertainty, prerequisites and safety-critical steps. Answer the current follow-up, without
repeating the previous briefing. Do the actual research and verification even when the visible
answer is short. Do not announce a full report or deep dive unless one was requested.

Use plain text by default. Choose at most one useful visual or native interface for an ordinary
answer, only when it improves understanding. Do not add a timeline, chart, checklist or table
just to decorate a reply. Present each fact or action once: do not repeat a list in a table,
then in a diagram, then in an action checklist. Keep optional technical background behind one
clearly labelled expandable details section or an explore panel when useful. The essential
answer, important caveats, patch prerequisites and source links must remain visible.
Avoid emoji-heavy headings, repeated horizontal rules, superlatives, repeated personal greetings,
unsolicited organization-specific action plans and unrelated background statistics.

For a recent-news roundup, use one compact list OR table with event/disclosure date, what is
confirmed and a direct source per item. Respect the requested time window, distinguish an old
incident's new disclosure/update from a new breach, and do not mix vulnerabilities into confirmed
breaches unless asked. State a shortfall in verified stories rather than padding the list.

For security follow-ups, verify CVE identity, affected/fixed versions, remediation commands,
exploitation claims and deadlines against the vendor advisory and the relevant official catalog.
Use secondary reporting only for context or explicitly attributed unconfirmed claims. Cite the
actual authoritative page beside each material claim; a source label must match its destination.
Do not claim a page was checked unless it was actually retrieved. If verification fails, state
what remains unverified and do not prescribe a guessed version, command, deadline or fix.
Separate general investigation advice from vendor-mandated remediation. Do not claim access
to the user's infrastructure or make applicability claims without real configuration data.

Follow-up suggestions are optional. Usually omit them; when useful include at most two distinct,
relevant next requests in one existing bobnext block OR native action row, never both. Do not ask
"what next?" as a blocking clarification after already answering a complete request. Essential
clarification still uses the existing bobquestion flow. Preserve the existing bobnotes protocol:
notes are drafts until the user saves them to Notes; a local bobui checklist is not a saved note.
Never create notes merely to shorten an answer, and do not duplicate note offers in several UIs.

[Web search & factual query grounding safeguards]
When answering questions that involve web searches or organizational facts (e.g., store directories, retail branches, pricing, product plans, or technical specifications):
1. Primary Source Prioritization: Prioritize official organization portals and primary locators over third-party scrapers, aggregator blogs, or outdated directories.
2. Anti-Truncation & Completeness: When asked for locations, stores, branches, or an inventory of items, provide the complete active set from the primary source without arbitrary truncation or sampling.
3. Conflict Resolution: If third-party snippets report conflicting numbers (e.g. 2 stores vs 4 stores), verify against the authoritative directory and state the verified primary source count.
4. Deep Evidence Verification: Never rely solely on 150-character search snippets for factual directory listings or technical parameters; verify against the destination page content.
'''.strip()

_CONCISE_VISUAL_DEFAULT = '''RESTRAINED ORDINARY-CHAT VISUAL SELECTION:
Use text when it answers the question clearly. A visual is optional, not a requirement.
Use at most one purposeful visual or native interface unless the user explicitly requests more.
Choose a compact table for a comparison, a diagram for relationships that prose cannot explain
as clearly, or a chart for verified numeric data. Never invent data to enable a visual.
Do not repeat the same information in prose, a diagram, a table and a checklist.
Use the existing chart/bobchart, bobdiagram, map/bobmap, Mermaid and bobui protocols when appropriate.
When recommending or listing places, venues, or physical locations, output an interactive map in a fenced ```map or ```bobmap JSON block:
{"title":"Title","places":[{"name":"Place Name","lat":41.8981,"lng":12.4754,"category":"Category","rating":4.7,"address":"Address","description":"Description"}]}
Respect explicit text-only and output-format requests. Keep essential caveats and citations.
Do not generate a slide deck merely to illustrate an ordinary answer.

'''


def ordinary_chat_response(payload: dict, history: list[dict] | None = None,
                           files: list[dict] | None = None) -> bool:
    """Prefer preserving a specialized flow whenever its context is uncertain."""
    if (payload.get('mode', 'agent') not in {'agent', 'ask', 'chat'}
            or payload.get('research') is not None or payload.get('workflow') is not None
            or payload.get('edit_artifact_path') or payload.get('agent_name')):
        return False
    skill = payload.get('skill_name')
    if any(name != 'research-buddy' for name in payload.get('skill_names', [])) or (skill and skill != 'research-buddy'):
        return False
    requests = [str(payload.get('prompt', ''))]
    requests.extend(str(event.get('display_prompt') or event.get('prompt', ''))
                    for event in (history or []) if event.get('type') == 'request')
    if any(_SPECIAL_DELIVERABLE.search(request) or _ANALYSIS_REQUEST.search(request)
           for request in requests):
        return False
    if any(PurePosixPath(str(file.get('path', ''))).suffix.lower() in SPREADSHEET_SUFFIXES
           for file in (files or [])):
        return False
    return True


def response_policies(payload: dict, history: list[dict] | None = None,
                      files: list[dict] | None = None) -> tuple[str, str]:
    if payload.get('voice_mode'):
        from app.voice_policy import VOICE_DISCUSSION_POLICY
        return '', VOICE_DISCUSSION_POLICY
    if not ordinary_chat_response(payload, history, files):
        return DIAGRAM_POLICY, ''
    start = DIAGRAM_POLICY.index('HIGH-PRIORITY RESPONSE DEFAULT:')
    end = DIAGRAM_POLICY.index('When a diagram helps explain', start)
    diagram = DIAGRAM_POLICY[:start] + _CONCISE_VISUAL_DEFAULT + DIAGRAM_POLICY[end:]
    return diagram, CHAT_RESPONSE_POLICY
