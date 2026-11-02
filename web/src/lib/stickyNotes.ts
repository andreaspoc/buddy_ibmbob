export type StickyNoteColor = 'butter' | 'rose' | 'lavender' | 'mint' | 'sky';
export interface StickyNoteDraft { title: string; body: string; color: StickyNoteColor }

const colors = new Set<StickyNoteColor>(['butter', 'rose', 'lavender', 'mint', 'sky']);

function validNotes(value: unknown): StickyNoteDraft[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'notes')) return null;
  const notes = (value as { notes?: unknown }).notes;
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > 12) return null;
  const result: StickyNoteDraft[] = [];
  for (const note of notes) {
    if (!note || typeof note !== 'object' || Array.isArray(note) ||
        Object.keys(note).some(key => !['title', 'body', 'color'].includes(key)) ||
        typeof note.title !== 'string' || !note.title.trim() || note.title.length > 160 ||
        typeof note.body !== 'string' || !note.body.trim() || note.body.length > 6000 ||
        !colors.has(note.color)) return null;
    result.push({ title: note.title.trim(), body: note.body.trim(), color: note.color });
  }
  return result;
}

/** Extract only top-level protocol fences; examples inside code stay ordinary Markdown. */
export function parseStickyNotes(text: string, streaming = false): { text: string; notes: StickyNoteDraft[] } {
  const lines = text.split('\n');
  const output: string[] = [];
  const notes: StickyNoteDraft[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (streaming && !fence && i === lines.length - 1 &&
        /^ {0,3}`/.test(line) && '```bobnotes'.startsWith(line.trimStart())) break;
    if (!fence && /^ {0,3}```bobnotes[ \t]*\r?$/.test(line)) {
      let end = i + 1;
      while (end < lines.length && !/^ {0,3}```[ \t]*\r?$/.test(lines[end])) end++;
      // Never expose partial JSON while tokens are arriving.
      if (end === lines.length) {
        if (!streaming) output.push(...lines.slice(i));
        break;
      }
      const raw = lines.slice(i + 1, end).join('\n');
      let parsed: StickyNoteDraft[] | null = null;
      try { if (raw.length <= 80000) parsed = validNotes(JSON.parse(raw)); } catch { /* ordinary code on invalid input */ }
      if (parsed && notes.length + parsed.length <= 12) notes.push(...parsed);
      else output.push(...lines.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (/^ {0,3}(?:`{3,}|~{3,})[ \t]*\r?$/.test(line) &&
               marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    output.push(line);
    i++;
  }
  return { text: output.join('\n').trim(), notes };
}
