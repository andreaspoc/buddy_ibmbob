/** A bounded, data-only response format. Never executes model-generated code. */
export interface ExploreItem { title: string; body: string; facts?: { label: string; value: string }[] }
export type IntelligentSpec = { title: string; description?: string; actions?: { label: string; prompt: string }[] } & (
  { kind: 'explore' | 'comparison' | 'steps'; items: ExploreItem[] } |
  { kind: 'split'; total: number; people: number; tip: number; unit?: string } |
  { kind: 'action'; operation: 'save_note' | 'email_note'; body: string } |
  { kind: 'analysis'; headers: string[]; rows: (string | number | null)[][]; source?: string }
);
export type IntelligentPart = { type: 'text'; text: string } | { type: 'ui'; key: string; source: string; spec?: IntelligentSpec; pending: boolean };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stripComments(source: string): string {
  let output = '', quoted = false, escaped = false;
  let i = 0;
  while (i < source.length) {
    const char = source[i], next = source[i + 1];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) { output += source.slice(i); break; }
      i = end + 2;
      continue;
    } else if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) break;
      i = end;
      continue;
    } else output += char;
    i++;
  }
  return output;
}

function cleanJsonSource(raw: string): string {
  let s = raw.trim();
  // Strip inner markdown code fences if model wrapped json inside another fence
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-z0-9_-]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }
  // Extract text within outer braces if preamble or commentary was output
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  // Strip line and block comments
  s = stripComments(s);
  // Strip trailing commas before closing braces/brackets
  s = s.replace(/,\s*([\]}])/g, '$1');
  return s;
}

function parseEmergencySpec(source: string): IntelligentSpec {
  // Graceful fallback to guarantee interactive answer always renders even if JSON syntax was damaged
  const lines = source.split('\n').map(l => l.trim()).filter(Boolean);
  const items: ExploreItem[] = [];
  let currentTitle = 'Overview';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('**') && line.endsWith('**') && line.length < 80) {
      if (currentBody.length > 0) {
        items.push({ title: currentTitle, body: currentBody.join('\n') });
        currentBody = [];
      }
      let start = 0, end = line.length;
      while (start < end && /[#*\s]/.test(line[start])) start++;
      while (end > start && /[#*\s]/.test(line[end - 1])) end--;
      currentTitle = line.slice(start, end) || 'Topic';
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    items.push({ title: currentTitle, body: currentBody.join('\n') });
  }
  if (items.length === 0) {
    items.push({ title: 'Interactive Overview', body: source.slice(0, 2000) });
  }

  return {
    kind: 'explore',
    title: 'Interactive Answer',
    items: items.slice(0, 10),
  };
}

export function parseIntelligentSpec(source: string): IntelligentSpec | undefined {
  if (!source || source.trim().length === 0) return;
  if (source.length > 150000) return;

  const cleaned = cleanJsonSource(source);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try relaxed parsing for single-quoted keys or values
    try {
      const relaxed = cleaned
        .replace(/([{,]\s*)([A-Za-z0-9_$]+)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"');
      parsed = JSON.parse(relaxed);
    } catch {
      // Return a resilient parsed fallback so it always renders!
      return parseEmergencySpec(source);
    }
  }

  if (!record(parsed)) {
    return parseEmergencySpec(source);
  }

  const title = typeof parsed.title === 'string' && parsed.title.trim()
    ? parsed.title.slice(0, 180)
    : typeof parsed.name === 'string' && parsed.name.trim()
      ? parsed.name.slice(0, 180)
      : typeof parsed.heading === 'string' && parsed.heading.trim()
        ? parsed.heading.slice(0, 180)
        : 'Interactive Answer';

  const description = typeof parsed.description === 'string' && parsed.description.trim()
    ? parsed.description.slice(0, 4000)
    : undefined;

  // Normalize actions
  let actions: { label: string; prompt: string }[] | undefined;
  if (Array.isArray(parsed.actions)) {
    actions = parsed.actions
      .map(a => {
        if (typeof a === 'string' && a.trim()) {
          return { label: a.slice(0, 80), prompt: a.slice(0, 1000) };
        }
        if (record(a) && typeof a.label === 'string' && typeof a.prompt === 'string') {
          return { label: a.label.slice(0, 80), prompt: a.prompt.slice(0, 1000) };
        }
        return null;
      })
      .filter((a): a is { label: string; prompt: string } => a !== null)
      .slice(0, 6);
  }

  // Normalize kind
  let rawKind = String(parsed.kind || '').toLowerCase().trim();
  if (rawKind === 'tabs' || rawKind === 'topics' || rawKind === 'sections') rawKind = 'explore';
  if (rawKind === 'options' || rawKind === 'vs' || rawKind === 'alternatives') rawKind = 'comparison';
  if (rawKind === 'checklist' || rawKind === 'tasks' || rawKind === 'todo' || rawKind === 'plan') rawKind = 'steps';
  if (rawKind === 'calculator' || rawKind === 'bill') rawKind = 'split';

  if (rawKind === 'action') {
    const op = parsed.operation === 'email_note' ? 'email_note' : 'save_note';
    const body = typeof parsed.body === 'string' ? parsed.body.slice(0, 20000) : '';
    return { kind: 'action', title, description, actions, operation: op, body };
  }

  if (rawKind === 'analysis' && Array.isArray(parsed.headers) && Array.isArray(parsed.rows)) {
    const headers = parsed.headers.map(h => String(h || '')).slice(0, 30);
    const rows = parsed.rows
      .filter(Array.isArray)
      .slice(0, 500)
      .map(r => headers.map((_, idx) => {
        const cell = r[idx];
        if (cell === null || cell === undefined) return null;
        if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
        return String(cell).slice(0, 2000);
      }));
    const src = typeof parsed.source === 'string' ? parsed.source.slice(0, 2000) : undefined;
    return { kind: 'analysis', title, description, actions, headers, rows, source: src };
  }

  if (rawKind === 'split') {
    const total = Number(parsed.total) || 0;
    const people = Math.max(1, Math.round(Number(parsed.people) || 1));
    const tip = Math.max(0, Number(parsed.tip) || 0);
    const unit = typeof parsed.unit === 'string' ? parsed.unit.slice(0, 16) : '€';
    return { kind: 'split', title, description, actions, total, people, tip, unit };
  }

  // Normalize explore / comparison / steps items
  let rawItems: unknown[] = [];
  if (Array.isArray(parsed.items)) {
    rawItems = parsed.items;
  } else if (record(parsed.items)) {
    rawItems = Object.entries(parsed.items).map(([key, val]) => {
      if (record(val)) return { title: key, ...val };
      return { title: key, body: String(val) };
    });
  }

  const items: ExploreItem[] = rawItems
    .map(item => {
      if (!record(item)) {
        if (typeof item === 'string') return { title: 'Item', body: item };
        return null;
      }
      const itTitle = String(item.title || item.name || item.heading || item.label || 'Detail').slice(0, 160);
      const itBody = String(item.body || item.content || item.description || item.text || item.summary || '').slice(0, 8000);

      let facts: { label: string; value: string }[] | undefined;
      if (Array.isArray(item.facts)) {
        facts = item.facts
          .map(f => {
            if (record(f) && typeof f.label === 'string' && typeof f.value === 'string') {
              return { label: f.label.slice(0, 160), value: f.value.slice(0, 500) };
            }
            return null;
          })
          .filter((f): f is { label: string; value: string } => f !== null)
          .slice(0, 12);
      } else if (record(item.facts)) {
        facts = Object.entries(item.facts)
          .map(([k, v]) => ({ label: String(k).slice(0, 160), value: String(v).slice(0, 500) }))
          .slice(0, 12);
      }

      return { title: itTitle, body: itBody, facts };
    })
    .filter((item): item is ExploreItem => item !== null)
    .slice(0, 200);

  if (items.length === 0) {
    items.push({ title: 'Overview', body: description || title });
  }

  const finalKind: 'explore' | 'comparison' | 'steps' =
    rawKind === 'comparison' ? 'comparison' : rawKind === 'steps' ? 'steps' : 'explore';

  return {
    kind: finalKind,
    title,
    description,
    actions,
    items,
  };
}

export function splitIntelligentMarkdown(content: string, streaming = false): IntelligentPart[] {
  const parts: IntelligentPart[] = [];
  const fence = /^([ \t]{0,3})(?=(`{3,}|~{3,}))\2([^\n]*)\n/gm;
  let cursor = 0, match: RegExpExecArray | null;

  while ((match = fence.exec(content))) {
    const close = new RegExp(`^[ \\t]{0,3}${match[2][0]}{${match[2].length},}[ \\t]*(?:\\n|$)`, 'gm');
    close.lastIndex = fence.lastIndex;
    const end = close.exec(content);
    const source = content.slice(fence.lastIndex, end?.index ?? content.length).trim();
    const next = end ? close.lastIndex : content.length;
    const tag = match[3].trim().toLowerCase();

    // Check if tag is explicitly an interactive answer format
    const isExplicitTag = /^(?:bobui|interactive(?:-answer)?|intelligent-ui|bob-ui)(?:[:\s]+json)?$/i.test(tag) ||
      /^(?:json[:\s]+(?:bobui|interactive|intelligent-ui|bob-ui))$/i.test(tag);

    // Or if tagged as json / generic but contains an interactive spec payload
    const isImplicitInteractiveJson = (tag === 'json' || tag === '' || tag === 'ui') &&
      source.includes('"kind"') &&
      /"kind"\s*:\s*"(?:explore|comparison|steps|split|action|analysis)"/i.test(source);

    if (isExplicitTag || isImplicitInteractiveJson) {
      parts.push({ type: 'text', text: content.slice(cursor, match.index) });
      parts.push({
        type: 'ui',
        key: `ui${match.index}`,
        source,
        spec: end ? parseIntelligentSpec(source) : undefined,
        pending: !end && streaming,
      });
      cursor = next;
    }
    fence.lastIndex = next;
  }
  parts.push({ type: 'text', text: content.slice(cursor) });
  return parts;
}

export function splitAmount(total: number, people: number, tip: number) {
  return total * (1 + tip / 100) / people;
}
