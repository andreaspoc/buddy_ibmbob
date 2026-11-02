export interface NoteLink {
  raw: string; target: string; label: string; start: number; end: number;
  id?: string; title?: string;
}
export interface LinkableNote { id: number | string; title: string }

/** Plain data only; callers render labels as React text, never as HTML. */
export function extractNoteLinks(body: string): NoteLink[] {
  const links: NoteLink[] = [];
  const excluded: [number, number][] = [];
  let offset = 0;
  let fence: { marker: string; start: number } | undefined;
  for (const line of body.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && marker) fence = {marker: marker[1], start: offset};
    else if (fence && marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length &&
             /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
      excluded.push([fence.start, offset + line.length]); fence = undefined;
    }
    offset += line.length + 1;
  }
  if (fence) excluded.push([fence.start, body.length]);
  for (const match of body.matchAll(/(`+)([\s\S]*?)\1/g)) {
    excluded.push([match.index, match.index + match[0].length]);
  }
  const pattern = /\[\[([^\]\n]{1,400})\]\]/g;
  for (const match of body.matchAll(pattern)) {
    if (excluded.some(([start, end]) => match.index >= start && match.index < end)) continue;
    if (match.index > 0 && body[match.index - 1] === '\\') continue;
    const [targetPart, ...labelParts] = match[1].split('|');
    const target = targetPart.trim();
    const label = labelParts.join('|').trim() || target;
    if (!target) continue;
    const idMatch = target.match(/^note:([1-9]\d*)$/);
    if (target.startsWith('note:') && !idMatch) continue;
    links.push({ raw: match[0], target, label, start: match.index, end: match.index + match[0].length,
      ...(idMatch ? {id: idMatch[1]} : {title: target}) });
  }
  return links;
}

export function resolveNoteLinks<T extends LinkableNote>(body: string, notes: T[]): (NoteLink & {note?: T; ambiguous: boolean})[] {
  return extractNoteLinks(body).map(link => {
    const candidates = notes.filter(note => link.id ? String(note.id) === link.id :
      note.title.trim().toLocaleLowerCase() === link.title?.toLocaleLowerCase());
    return {...link, note: candidates.length === 1 ? candidates[0] : undefined, ambiguous: candidates.length > 1};
  });
}

export function insertNoteLink(note: LinkableNote, label = note.title): string {
  if (!/^[1-9]\d*$/.test(String(note.id))) throw new Error('Invalid note ID');
  const text = label.replace(/[\[\]\r\n|]/g, ' ').trim().slice(0, 160) || 'Linked note';
  return `[[note:${note.id}|${text}]]`;
}
