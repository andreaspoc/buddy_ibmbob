"""Structured, optional clarification questions for ordinary conversation turns."""
from __future__ import annotations

import json
import re




CLARIFICATION_PRESETS: dict[str, list[dict]] = {
    'operational-triage': [
        {
            'question': 'What data do you have available to start the health check?',
            'options': [
                "I'll upload a ticket export (CSV / Excel / JSON)",
                "I'll paste log output or CLI diagnostic text",
                'I want a diagnostic methodology & playbook (no real data yet)',
                'I want ready-to-run queries/commands to pull data from our systems',
            ],
            'context': 'Your selection determines the type of analysis I can perform. Uploading real data enables full triage and chart visualisation.',
        },
        {
            'question': 'Which area of the infrastructure should we prioritise?',
            'options': [
                'Broadband & Fiber infrastructure',
                'Core routing & IP backbone',
                'Customer tickets & SLA performance',
                'All areas — give me a full cross-domain triage',
            ],
            'context': 'This helps me focus the diagnostic framework or query templates on the right domain.',
        },
        {
            'question': 'What is the primary goal of this triage?',
            'options': [
                'Identify root cause of an active/recent incident',
                'Spot recurring ticket patterns and reduce repeat faults',
                'Produce a management-ready health report',
                'Build an automated remediation runbook',
            ],
            'context': 'The goal shapes the output format — incident timeline, pattern analysis, executive summary, or automation playbook.',
        },
    ],
    'data-analysis': [
        {
            'question': 'How would you like to analyze this dataset?',
            'options': [
                'Executive KPI overview & summary metrics',
                'Trend, variance & period-over-period breakdown',
                'Outlier & anomaly detection',
                'Detailed category & segment comparison',
            ],
            'context': 'Defines the depth of computational analysis and reporting.',
        },
        {
            'question': 'What visual format should be produced?',
            'options': [
                'Interactive charts & summary cards',
                'Markdown executive briefing table',
                'Slide deck presentation ready for review',
            ],
            'context': 'Determines the visual output deliverable.',
        },
    ],
    'deep-research': [
        {
            'question': 'What is the primary objective of this research?',
            'options': [
                'Market landscape & strategic competitive benchmarks',
                'Technical architecture & technology evaluation',
                'Regulatory, compliance & risk review',
                'Executive strategic briefing & action items',
            ],
            'context': 'Directs the autonomous deep research scope.',
        },
        {
            'question': 'What level of research detail do you need?',
            'options': [
                'Concise executive briefing with key findings',
                'Comprehensive multi-source report with citations',
            ],
            'context': 'Sets the breadth of source synthesis.',
        },
    ],
    'presentation-brief': [
        {
            'question': 'Who is the primary audience for this presentation?',
            'options': [
                'Executive & C-Level Leadership',
                'Technical & Operations Teams',
                'Cross-Functional Business Stakeholders',
                'Clients & External Partners',
            ],
            'context': 'Aligns the presentation tone and level of detail.',
        },
        {
            'question': 'What is the primary objective of the deck?',
            'options': [
                'Strategic project briefing',
                'Quarterly KPI & milestone update',
                'Solution pitch & strategic roadmap',
                'Operational audit & recommendations',
            ],
            'context': 'Shapes the slide layouts and narrative flow.',
        },
    ],
    'presentation-followup': [
        {
            'question': 'How would you like to refine this presentation?',
            'options': [
                'Add interactive animations & slide transitions',
                'Add data charts & KPI summary metrics',
                'Refine slide content, layout & executive narrative',
                'Export presentation to PowerPoint (.pptx) format',
            ],
            'context': 'Choose the next enhancement for your presentation slides.',
        },
    ],
    'next-steps': [
        {
            'question': 'What would you like to do next?',
            'options': [
                'Deep-dive into specific findings and metrics',
                'Generate an executive presentation slide deck',
                'Export summary report and action items',
                'Draft an automated remediation runbook',
            ],
            'context': 'Select a follow-up action or specify your own custom answer.',
        },
    ],
}
CLARIFICATION_PRESETS['health-check'] = CLARIFICATION_PRESETS['operational-triage']
CLARIFICATION_PRESETS['excel-analytics'] = CLARIFICATION_PRESETS['data-analysis']
CLARIFICATION_PRESETS['follow-up'] = CLARIFICATION_PRESETS['next-steps']
CLARIFICATION_PRESETS['presentation-review'] = CLARIFICATION_PRESETS['presentation-followup']


def _structured_values(text: str, language: str):
    """Read complete top-level protocol fences, never examples inside fences."""
    lines = text.splitlines()
    fence = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if fence is None and re.match(r'^ {0,3}```' + language + r'(?:[ \t]+.*)?$', line):
            end = i + 1
            while end < len(lines) and not re.match(r'^ {0,3}(`{3,}|~{3,})', lines[end]):
                end += 1
            if end == len(lines):
                try:
                    yield json.loads('\n'.join(lines[i + 1:]))
                except (ValueError, TypeError):
                    pass
                return
            try:
                yield json.loads('\n'.join(lines[i + 1:end]))
            except (ValueError, TypeError):
                pass
            i = end + 1
            continue
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif re.fullmatch(r' {0,3}' + re.escape(token) + r'[ \t]*', line) and token[0] == fence[0] and len(token) >= len(fence):
                fence = None
        i += 1


def _question(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    question = value.get('question') or value.get('q')
    options = value.get('options') or value.get('opts')
    context = value.get('context', value.get('ctx'))
    if not isinstance(question, str) or not question.strip() or len(question) > 1000:
        return None
    if not isinstance(options, list) or not 2 <= len(options) <= 5:
        return None
    if any(not isinstance(option, str) or not option.strip() or len(option) > 500 for option in options):
        return None
    if len({option.strip().lower() for option in options}) != len(options):
        return None
    if context is not None and (not isinstance(context, str) or len(context) > 2000):
        return None
    item = {'question': question.strip(), 'options': [option.strip() for option in options]}
    if context and context.strip():
        item['context'] = context.strip()
    return item


def _validate_options(value) -> list[str] | None:
    if isinstance(value, list):
        options = value
    elif isinstance(value, dict):
        options = (
            value.get('options')
            or value.get('follow_up_questions')
            or value.get('follow_ups')
            or value.get('suggestions')
            or value.get('next_steps')
        )
    else:
        return None
    if not isinstance(options, list) or not 2 <= len(options) <= 3:
        return None
    if any(not isinstance(option, str) or not option.strip() or len(option) > 500 for option in options):
        return None
    if len({option.strip().lower() for option in options}) != len(options):
        return None
    return [option.strip() for option in options]


def clarification_questions(text: str) -> list[dict]:
    """Recognize complete valid cards only; ordinary code/text cannot pause a run."""
    questions = []
    for value in _structured_values(text, 'bobquestion'):
        preset = value.get('preset') if isinstance(value, dict) else None
        if isinstance(preset, str) and preset.strip().lower() in CLARIFICATION_PRESETS:
            context = value.get('context')
            if context is not None and (not isinstance(context, str) or len(context) > 2000):
                continue
            items = [dict(item) for item in CLARIFICATION_PRESETS[preset.strip().lower()]]
            if context and context.strip():
                items[0]['context'] = context.strip()
        else:
            candidates = value if isinstance(value, list) else [value]
            items = [_question(candidate) for candidate in candidates]
            if not items or any(item is None for item in items):
                continue
        questions.extend(items[:3 - len(questions)])
        if len(questions) == 3:
            break
    return questions


def follow_up_suggestions(text: str) -> list[str]:
    """Return optional next prompts only when no valid clarification is pending."""
    if clarification_questions(text):
        return []
    # Outer 4-backtick markdown blocks are examples/documentation, not live suggestions
    pieces, offset = [], 0
    while True:
        opening = text.find('````', offset)
        if opening == -1:
            pieces.append(text[offset:])
            break
        closing = text.find('````', opening + 4)
        if closing == -1:
            pieces.append(text[offset:])
            break
        pieces.append(text[offset:opening])
        offset = closing + 4
    effective_text = ''.join(pieces)
    for lang in ('bobnext', 'next'):
        for value in _structured_values(effective_text, lang):
            options = _validate_options(value)
            if options:
                return options
    # Check for fenced blocks (```json, ```bobnext, ```next, or generic ```)
    offset = 0
    while True:
        opening = effective_text.find('```', offset)
        if opening == -1:
            break
        closing = effective_text.find('```', opening + 3)
        if closing == -1:
            break
        start = opening + 3
        while start < closing and (effective_text[start].isascii() and (effective_text[start].isalnum() or effective_text[start] in '_-')):
            start += 1
        candidate = effective_text[start:closing].strip()
        offset = closing + 3
        if candidate.startswith('{') and candidate.endswith('}'):
            try:
                parsed = json.loads(candidate)
                options = _validate_options(parsed)
                if options:
                    return options
            except (ValueError, TypeError):
                pass
    # Check for trailing unfenced JSON object
    start_idx = effective_text.rfind('{')
    if start_idx != -1:
        end_idx = effective_text.rfind('}')
        if end_idx > start_idx:
            candidate = effective_text[start_idx:end_idx + 1].strip()
            try:
                parsed = json.loads(candidate)
                options = _validate_options(parsed)
                if options:
                    return options
            except (ValueError, TypeError):
                pass
    return []


def add_clarification_policy(prompt: str, *, supported: bool = True) -> str:
    if not supported:
        return prompt + (
            '\n\n[Clarification policy]: This automated research/workflow cannot pause for interactive '
            'questions. Do not emit bobquestion cards or bobnext suggestions. Use the supplied scope and history; '
            'state material assumptions and unresolved limitations in your result. '
            'Never fabricate fake operational data or simulate real infrastructure metrics.'
        )
    return prompt + '''\n\n[Interactive clarification policy]:
Ask follow-ups only when missing details materially change the result or prevent useful work. Do not ask questions already answered in history.
Before executing an underspecified request, identify the essential subject/source and audience/purpose. If a missing essential would force inventing the task, clarify first. A selected visual template, mode, skill, or assistant preset does not establish the subject or purpose. Prefer one focused question; combine details into at most 3 focused questions.
Clarification forms: All follow-up questions, options, or choices MUST use an interactive ```bobquestion``` card. Never output follow-up choices as plain text or bullets.
```bobquestion
{"question":"Which outcome do you need?","options":["First distinct choice","Second distinct choice"],"context":"Optional short explanation"}
```
Card rules: 1 question (<=1000 chars), 2-5 distinct concise options (<=500 chars each), optional context (<=2000 chars). Up to 3 question objects in an array. The interface adds custom answer, so do not add 'Other'. Never fabricate fake operational data or simulate live telemetry.
After emitting questions, stop this turn and wait for the user's answers.
After a useful completed answer, optionally suggest 2-3 specific next prompts at the very end using ```bobnext```:
```bobnext
{"options":["First contextual next request","Second contextual next request"]}
```
Never emit bobnext while asking clarification.
'''
