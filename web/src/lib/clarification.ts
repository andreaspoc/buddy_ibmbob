export interface ClarificationQuestion { question: string; options: string[]; context?: string }

export const CLARIFICATION_PRESETS: Record<string, ClarificationQuestion[]> = {
  'operational-triage': [
    {
      question: 'What data do you have available to start the health check?',
      options: [
        "I'll upload a ticket export (CSV / Excel / JSON)",
        "I'll paste log output or CLI diagnostic text",
        'I want a diagnostic methodology & playbook (no real data yet)',
        'I want ready-to-run queries/commands to pull data from our systems',
      ],
      context: 'Your selection determines the type of analysis I can perform. Uploading real data enables full triage and chart visualisation.',
    },
    {
      question: 'Which area of the infrastructure should we prioritise?',
      options: [
        'Broadband & Fiber infrastructure',
        'Core routing & IP backbone',
        'Customer tickets & SLA performance',
        'All areas — give me a full cross-domain triage',
      ],
      context: 'This helps me focus the diagnostic framework or query templates on the right domain.',
    },
    {
      question: 'What is the primary goal of this triage?',
      options: [
        'Identify root cause of an active/recent incident',
        'Spot recurring ticket patterns and reduce repeat faults',
        'Produce a management-ready health report',
        'Build an automated remediation runbook',
      ],
      context: 'The goal shapes the output format — incident timeline, pattern analysis, executive summary, or automation playbook.',
    },
  ],
  'data-analysis': [
    {
      question: 'How would you like to analyze this dataset?',
      options: [
        'Executive KPI overview & summary metrics',
        'Trend, variance & period-over-period breakdown',
        'Outlier & anomaly detection',
        'Detailed category & segment comparison',
      ],
      context: 'Defines the depth of computational analysis and reporting.',
    },
    {
      question: 'What visual format should be produced?',
      options: [
        'Interactive charts & summary cards',
        'Markdown executive briefing table',
        'Slide deck presentation ready for review',
      ],
      context: 'Determines the visual output deliverable.',
    },
  ],
  'deep-research': [
    {
      question: 'What is the primary objective of this research?',
      options: [
        'Market landscape & strategic competitive benchmarks',
        'Technical architecture & technology evaluation',
        'Regulatory, compliance & risk review',
        'Executive strategic briefing & action items',
      ],
      context: 'Directs the autonomous deep research scope.',
    },
    {
      question: 'What level of research detail do you need?',
      options: [
        'Concise executive briefing with key findings',
        'Comprehensive multi-source report with citations',
      ],
      context: 'Sets the breadth of source synthesis.',
    },
  ],
  'presentation-brief': [
    {
      question: 'Who is the primary audience for this presentation?',
      options: [
        'Executive & C-Level Leadership',
        'Technical & Operations Teams',
        'Cross-Functional Business Stakeholders',
        'Clients & External Partners',
      ],
      context: 'Aligns the presentation tone and level of detail.',
    },
    {
      question: 'What is the primary objective of the deck?',
      options: [
        'Strategic project briefing',
        'Quarterly KPI & milestone update',
        'Solution pitch & strategic roadmap',
        'Operational audit & recommendations',
      ],
      context: 'Shapes the slide layouts and narrative flow.',
    },
  ],
  'presentation-followup': [
    {
      question: 'How would you like to refine this presentation?',
      options: [
        'Add interactive animations & slide transitions',
        'Add data charts & KPI summary metrics',
        'Refine slide content, layout & executive narrative',
        'Export presentation to PowerPoint (.pptx) format',
      ],
      context: 'Choose the next enhancement for your presentation slides.',
    },
  ],
  'next-steps': [
    {
      question: 'What would you like to do next?',
      options: [
        'Deep-dive into specific findings and metrics',
        'Generate an executive presentation slide deck',
        'Export summary report and action items',
        'Draft an automated remediation runbook',
      ],
      context: 'Select a follow-up action or specify your own custom answer.',
    },
  ],
};
CLARIFICATION_PRESETS['health-check'] = CLARIFICATION_PRESETS['operational-triage'];
CLARIFICATION_PRESETS['excel-analytics'] = CLARIFICATION_PRESETS['data-analysis'];
CLARIFICATION_PRESETS['follow-up'] = CLARIFICATION_PRESETS['next-steps'];
CLARIFICATION_PRESETS['presentation-review'] = CLARIFICATION_PRESETS['presentation-followup'];

function isValidQuestion(val: any): boolean {
  if (!val || typeof val !== 'object') return false;
  const q = val.question || val.q;
  const opts = val.options || val.opts;
  const ctx = val.context ?? val.ctx;
  if (typeof q !== 'string' || !q.trim() || q.length > 1000) return false;
  if (!Array.isArray(opts) || opts.length < 2 || opts.length > 5) return false;
  if (opts.some((opt: unknown) => typeof opt !== 'string' || !opt.trim() || opt.length > 500)) return false;
  if (new Set(opts.map((opt: string) => opt.trim().toLowerCase())).size !== opts.length) return false;
  if (ctx !== undefined && (typeof ctx !== 'string' || ctx.length > 2000)) return false;
  return true;
}

function normalizeQuestion(val: any): ClarificationQuestion {
  return {
    question: (val.question || val.q).trim(),
    options: (val.options || val.opts).map((o: string) => o.trim()),
    context: val.context ?? val.ctx,
  };
}

function isLineInCodeFence(lines: string[], targetIdx: number): boolean {
  let fence: string | null = null;
  for (let i = 0; i < targetIdx; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(lines[i]) && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
  }
  return fence !== null;
}

function parseMarkdownFollowUps(lines: string[]): { remainingLines: string[]; questions: ClarificationQuestion[] } | null {
  let endIdx = lines.length - 1;
  while (endIdx >= 0 && !lines[endIdx].trim()) endIdx--;
  if (endIdx < 0) return null;

  const HEADER_RE = /^ {0,3}(?:#{1,4}\s+|\*\*)?(?:Follow-up questions?|Follow up questions?|Next steps?|Suggested next steps?|Next questions?|Questions to consider|How would you like to proceed\??):?(?:\*\*)?:?\s*$/i;

  let headerIdx = -1;
  for (let i = endIdx; i >= 0; i--) {
    if (HEADER_RE.test(lines[i])) {
      if (!isLineInCodeFence(lines, i)) {
        headerIdx = i;
        break;
      }
    }
    if (endIdx - i > 25) break;
  }
  if (headerIdx === -1 || headerIdx >= endIdx) return null;

  const sectionLines = lines.slice(headerIdx + 1, endIdx + 1);
  const nonEmpty = sectionLines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 2) return null;

  const SUB_Q_RE = /^ {0,3}(?:\d+[.)]\*{0,2}|\*{1,2}\d+[.)]\*{1,2})\s+(\S.*\S|\S)$/;
  const OPTION_RE = /^ {2,8}[-*•]\s+(\S.*\S|\S)$/;

  const structuredQuestions: ClarificationQuestion[] = [];
  let currentQ: { question: string; options: string[] } | null = null;
  let isPatternA = true;

  for (const line of sectionLines) {
    if (!line.trim()) continue;
    const qMatch = line.match(SUB_Q_RE);
    if (qMatch) {
      if (currentQ) {
        if (currentQ.options.length < 2 || currentQ.options.length > 5) {
          isPatternA = false;
          break;
        }
        structuredQuestions.push(currentQ);
      }
      currentQ = { question: qMatch[1].replace(/\*{1,2}/g, '').trim(), options: [] };
      continue;
    }
    const optMatch = line.match(OPTION_RE);
    if (optMatch && currentQ) {
      currentQ.options.push(optMatch[1].replace(/\*{1,2}/g, '').trim());
      continue;
    }
    isPatternA = false;
    break;
  }

  if (isPatternA && currentQ) {
    if (currentQ.options.length >= 2 && currentQ.options.length <= 5) {
      structuredQuestions.push(currentQ);
    } else {
      isPatternA = false;
    }
  }

  if (isPatternA && structuredQuestions.length > 0 && structuredQuestions.length <= 3) {
    if (structuredQuestions.every(q => isValidQuestion(q))) {
      return {
        remainingLines: lines.slice(0, headerIdx),
        questions: structuredQuestions.map(normalizeQuestion),
      };
    }
  }

  const FLAT_ITEM_RE = /^ {0,4}(?:[-*•]|\d+[.)])\s+(\S.*\S|\S)$/;
  const flatItems: string[] = [];
  for (const line of sectionLines) {
    if (!line.trim()) continue;
    const match = line.match(FLAT_ITEM_RE);
    if (!match) return null;
    flatItems.push(match[1].replace(/\*{1,2}/g, '').trim());
  }

  if (flatItems.length >= 2 && flatItems.length <= 5) {
    if (new Set(flatItems.map(s => s.toLowerCase())).size !== flatItems.length) return null;
    if (flatItems.some(s => s.length > 500)) return null;

    let headerText = lines[headerIdx].trim().replace(/^#{1,4}\s+/, '').replace(/^\*\*|\*\*$/g, '').replace(/^:?|:?$/g, '').trim();
    if (/^follow-?up questions?$/i.test(headerText)) {
      headerText = 'What would you like to do next?';
    } else if (/^next steps?$/i.test(headerText) || /^suggested next steps?$/i.test(headerText)) {
      headerText = 'How would you like to proceed?';
    } else if (!headerText.endsWith('?')) {
      headerText = `${headerText}?`;
    }

    const questionObj: ClarificationQuestion = {
      question: headerText,
      options: flatItems,
    };
    if (isValidQuestion(questionObj)) {
      return {
        remainingLines: lines.slice(0, headerIdx),
        questions: [normalizeQuestion(questionObj)],
      };
    }
  }

  return null;
}

export function parseClarifications(text: string, streaming = false): { text: string; questions: ClarificationQuestion[] } {
  const lines = text.split('\n');
  const output: string[] = [];
  const questions: ClarificationQuestion[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A fence's language arrives character by character. Hide a possible
    // question opener until we know whether it is prose or a question block.
    if (streaming && !fence && i === lines.length - 1 && line.trimStart().startsWith('`') &&
        '```bobquestion'.startsWith(line.trimStart())) break;
    if (!fence && /^ {0,3}```bobquestion\s*$/.test(line) && questions.length < 3) {
      let end = i + 1;
      let trailing = '';
      while (end < lines.length) {
        const closeMatch = lines[end].match(/^ {0,3}(?=(`{3,}|~{3,}))\1(.*)$/);
        if (closeMatch) {
          trailing = closeMatch[2].trim();
          break;
        }
        end++;
      }
      if (end === lines.length) {
        if (!streaming) {
          try {
            const raw = lines.slice(i + 1).join('\n').trim();
            const value = JSON.parse(raw);
            if (isValidQuestion(value)) {
              questions.push(normalizeQuestion(value));
              break;
            }
          } catch {}
          output.push(...lines.slice(i));
        }
        break;
      }
      try {
        const value = JSON.parse(lines.slice(i + 1, end).join('\n'));
        const presetName = value && typeof value === 'object' && typeof value.preset === 'string'
          ? value.preset.toLowerCase().trim()
          : null;
        if (presetName && CLARIFICATION_PRESETS[presetName]) {
          if (value.context !== undefined && (typeof value.context !== 'string' || value.context.length > 2000)) throw new Error('Invalid context');
          const items = CLARIFICATION_PRESETS[presetName].map(item => ({ ...item }));
          if (typeof value.context === 'string' && value.context.trim()) {
            items[0].context = value.context.trim();
          }
          questions.push(...items.slice(0, 3 - questions.length));
          if (trailing) output.push(trailing);
          i = end + 1;
          continue;
        }
        if (Array.isArray(value)) {
          if (!value.length || value.some(item => !isValidQuestion(item))) throw new Error('Invalid questions');
          for (const item of value) {
            if (isValidQuestion(item) && questions.length < 3) {
              questions.push(normalizeQuestion(item));
            }
          }
          if (trailing) output.push(trailing);
          i = end + 1;
          continue;
        }
        if (isValidQuestion(value)) {
          questions.push(normalizeQuestion(value));
          if (trailing) output.push(trailing);
        } else {
          throw new Error('Invalid question');
        }
      } catch { output.push(...lines.slice(i, end + 1)); }
      i = end + 1;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line) && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    output.push(line);
    i++;
  }
  if (!streaming && questions.length === 0) {
    const fallback = parseMarkdownFollowUps(output);
    if (fallback) {
      return { text: fallback.remainingLines.join('\n').trim(), questions: fallback.questions };
    }
  }
  return { text: output.join('\n').trim(), questions };
}

export function clarificationReply(questions: ClarificationQuestion[], answers: string[]): string {
  if (questions.length === 1) return (answers[0] || '').trim();
  return questions.map((q, i) => `${q.question}\n${(answers[i] || '').trim()}`).join('\n\n');
}

export function clarificationCancelReply(): string {
  return 'I have cancelled this clarification form and dismissed the follow-up questions. Please acknowledge that I cancelled the questionnaire, disregard these follow-up options, and ask how you can help me or what we should do next instead.';
}



function isValidOptionList(items: unknown): items is string[] {
  return Array.isArray(items) &&
    items.length >= 1 &&
    items.length <= 6 &&
    items.every((item: unknown) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500) &&
    new Set(items.map((item: string) => item.trim().toLowerCase())).size === items.length;
}

function extractOptionsFromValue(val: unknown): string[] | null {
  if (!val) return null;
  if (Array.isArray(val) && isValidOptionList(val)) {
    return val.map((s: string) => s.trim());
  }
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    const candidate = obj.options || obj.follow_up_questions || obj.follow_ups || obj.suggestions || obj.next_steps;
    if (isValidOptionList(candidate)) {
      return candidate.map((s: string) => s.trim());
    }
  }
  return null;
}

function readFenceMarker(line: string): { value: string; end: number } | null {
  let cursor = 0;
  while (line[cursor] === ' ') {
    if (cursor === 3) return null;
    cursor++;
  }
  const character = line[cursor];
  if (character !== '`' && character !== '~') return null;
  const start = cursor;
  while (line[cursor] === character) cursor++;
  if (cursor - start < 3) return null;
  return { value: line.slice(start, cursor), end: cursor };
}

function isClosingFence(line: string, marker: string): boolean {
  const candidate = readFenceMarker(line);
  if (!candidate || candidate.value[0] !== marker[0] || candidate.value.length < marker.length) return false;
  const last = line.charAt(line.length - 1);
  const end = last === '\r' || last === '\u2028' || last === '\u2029' ? line.length - 1 : line.length;
  let cursor = candidate.end;
  while (cursor < end && (line[cursor] === ' ' || line[cursor] === '\t')) cursor++;
  return cursor === end;
}

function extractFallbackOptions(lines: string[]): { options: string[]; remainingLines: string[] } | null {
  // Only JSON/unlabelled fences are fallback data. Other code blocks are
  // examples: skip their entire span, including any nested suggestion syntax.
  const unfenced = [...lines];
  let cursor = 0;
  while (cursor < lines.length) {
    const marker = readFenceMarker(lines[cursor]);
    if (!marker) { cursor++; continue; }
    let end = cursor + 1;
    while (end < lines.length && !isClosingFence(lines[end], marker.value)) end++;
    const language = lines[cursor].slice(marker.end).trim().toLowerCase();
    if (end < lines.length && (language === '' || language === 'json')) {
      try {
        const parsed = JSON.parse(lines.slice(cursor + 1, end).join('\n').trim());
        const options = extractOptionsFromValue(parsed);
        if (options) {
          return { options, remainingLines: [...lines.slice(0, cursor), ...lines.slice(end + 1)] };
        }
      } catch {}
    }
    // Preserve offsets so an unfenced JSON span can be removed from the
    // original response without changing any surrounding code examples.
    for (let line = cursor; line < Math.min(end + 1, lines.length); line++) {
      unfenced[line] = ' '.repeat(lines[line].length);
    }
    cursor = end + 1;
  }

  const fullText = lines.join('\n');
  const visibleText = unfenced.join('\n');
  const startIdx = visibleText.lastIndexOf('{');
  const endIdx = visibleText.lastIndexOf('}');
  if (startIdx !== -1 && endIdx > startIdx) {
    const rawJson = fullText.slice(startIdx, endIdx + 1).trim();
    try {
      const parsed = JSON.parse(rawJson);
      const opts = extractOptionsFromValue(parsed);
      if (opts) {
        const prefix = fullText.slice(0, startIdx).trimEnd();
        const suffix = fullText.slice(endIdx + 1).trimStart();
        const remainingText = (prefix + (suffix ? '\n' + suffix : '')).trim();
        return { options: opts, remainingLines: remainingText.split('\n') };
      }
    } catch {}
  }

  return null;
}

export function parseNextQuestions(text: string, streaming = false): { text: string; options: string[] } {
  const lines = text.split('\n');
  const output: string[] = [];
  let options: string[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (streaming && !fence && i === lines.length - 1 && line.trimStart().startsWith('`') &&
        ('```bobnext'.startsWith(line.trimStart()) || '```next'.startsWith(line.trimStart()))) break;
    if (!fence && /^ {0,3}```(?:bobnext|next)\s*$/.test(line)) {
      let end = i + 1;
      let trailing = '';
      while (end < lines.length) {
        const closeMatch = lines[end].match(/^ {0,3}(?=(`{3,}|~{3,}))\1(.*)$/);
        if (closeMatch) {
          trailing = closeMatch[2].trim();
          break;
        }
        end++;
      }
      if (end === lines.length) {
        if (!streaming) {
          try {
            const raw = lines.slice(i + 1).join('\n').trim();
            const items = JSON.parse(raw).options;
            if (isValidOptionList(items)) {
              if (!options.length) options = items.map((item: string) => item.trim());
              break;
            }
          } catch {}
          output.push(...lines.slice(i));
        }
        break;
      }
      try {
        const items = JSON.parse(lines.slice(i + 1, end).join('\n')).options;
        if (!isValidOptionList(items)) throw new Error('Invalid suggestions');
        if (!options.length) options = items.map((item: string) => item.trim());
        if (trailing) output.push(trailing);
      } catch { output.push(...lines.slice(i, end + 1)); }
      i = end + 1;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line) && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    output.push(line);
    i++;
  }
  if (!streaming && options.length === 0) {
    const fallback = extractFallbackOptions(output);
    if (fallback) {
      return { text: fallback.remainingLines.join('\n').trim(), options: fallback.options };
    }
  }
  return { text: output.join('\n').trim(), options };
}
