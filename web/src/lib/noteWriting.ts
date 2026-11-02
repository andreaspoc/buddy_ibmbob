export type NoteFormat = 'heading' | 'bold' | 'italic' | 'bullet' | 'checklist' | 'quote' | 'code' | 'divider';
export function editNoteMarkdown(body: string, start: number, end: number, format: NoteFormat, placeholder: string) {
  start = Math.max(0, Math.min(start, body.length)); end = Math.max(start, Math.min(end, body.length));
  const selected = body.slice(start, end) || placeholder;
  let text: string; let caretStart: number; let caretEnd: number;
  if (format === 'bold' || format === 'italic') {
    const marker = format === 'bold' ? '**' : '*';
    text = marker + selected + marker; caretStart = start + marker.length; caretEnd = caretStart + selected.length;
  } else {
    const lead = start > 0 && body[start - 1] !== '\n' ? '\n' : '';
    const tail = end < body.length && body[end] !== '\n' ? '\n' : '';
    const prefix = {heading: '## ', bullet: '- ', checklist: '- [ ] ', quote: '> '}[format as 'heading' | 'bullet' | 'checklist' | 'quote'];
    text = lead + (format === 'code' ? '```\n' + selected + '\n```' : format === 'divider' ? '---' : selected.split('\n').map(line => prefix + line).join('\n')) + tail;
    caretStart = start + lead.length + (format === 'code' ? 4 : format === 'divider' ? 3 : prefix.length);
    caretEnd = format === 'divider' ? caretStart : start + text.length - tail.length - (format === 'code' ? 4 : 0);
  }
  return { body: body.slice(0, start) + text + body.slice(end), start: caretStart, end: caretEnd };
}
export function noteHeadings(body: string) {
  const headings: Array<{text: string; level: number; offset: number}> = [];
  let offset = 0; let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
    } else if (!fence) {
      const match = /^(#{1,6})[ \t]+/.exec(line);
      if (match) {
        const raw = line.slice(match[0].length).trimEnd();
        let end = raw.length;
        while (end > 1 && raw[end - 1] === '#') end--;
        const text = raw.slice(0, end).trimEnd();
        if (text) headings.push({ text, level: match[1].length, offset });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}
export function localNoteDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
