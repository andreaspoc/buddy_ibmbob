// Keep unfinished Markdown links out of the visible response. Once a document
// URL is available, render a temporary marker until its supporting quote arrives.
export function streamMarkdown(content: string): string {
  content = streamKnowledgeReferences(content);
  let fence = '';
  let inlineTicks = '';
  let linkStart = -1;
  let destinationStart = -1;
  let depth = 0;
  let quote = '';
  const brackets: number[] = [];

  for (let i = 0; i < content.length; i++) {
    if (i === 0 || content[i - 1] === '\n') {
      const match = content.slice(i).match(/^ {0,3}(?=(`{3,}|~{3,}))\1[^\n]*(?:\n|$)/);
      if (match && !inlineTicks && destinationStart < 0) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length
          && /^ {0,3}(?:`+|~+)\s*$/.test(match[0])) fence = '';
        i += match[0].length - 1;
        continue;
      }
    }
    if (fence) continue;
    if (content[i] === '\\') { i++; continue; }
    if (destinationStart >= 0) {
      const char = content[i];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth++;
      else if (char === ')' && --depth === 0) {
        destinationStart = -1;
        linkStart = -1;
      }
      continue;
    }
    if (content[i] === '`') {
      const ticks = content.slice(i).match(/^`+/)![0];
      if (!inlineTicks) inlineTicks = ticks;
      else if (ticks === inlineTicks) inlineTicks = '';
      i += ticks.length - 1;
      continue;
    }
    if (inlineTicks) continue;
    if (content[i] === '[') brackets.push(i);
    else if (content[i] === ']' && brackets.length) {
      const start = brackets.pop()!;
      if (content[i + 1] === '(') {
        linkStart = start;
        destinationStart = i + 2;
        depth = 1;
        i++;
      } else if (i === content.length - 1 && !/^\d+$/.test(content.slice(start + 1, i))) {
        return content.slice(0, start);
      }
    }
  }

  if (destinationStart >= 0) {
    const destination = content.slice(destinationStart);
    const path = destination.match(/^\s*<?(\/(?:sessions\/(?:legacy|[a-f0-9]{32})\/)?knowledge\/[a-f0-9-]{36}\/file)(?=[?\s>#]|$)/)?.[1];
    // Web link labels can stay visible while their URL/title arrives. Never
    // expose an unfinished URL as a clickable link or raw Markdown syntax.
    const webLabel = /^\s*<?https?:\/\//i.test(destination)
      ? content.slice(linkStart + 1, destinationStart - 2) : '';
    const marker = path ? `[Source](${path}#stream-pending)` : webLabel;
    return content.slice(0, linkStart) + marker;
  }
  // A source label arrives before its URL. Hold it until it can be recognized.
  return brackets.length ? content.slice(0, brackets[0]) : content;
}

// Reference definitions arrive after the answer. Hide incomplete definitions
// and show short, non-clickable markers until marked can resolve the full link.
function streamKnowledgeReferences(content: string): string {
  let fence = '';
  const complete = new Set<string>();
  const lines = content.split('\n');
  const visible = lines.map((line, index) => {
    const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length
        && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = '';
      return line;
    }
    if (fence || /^ {4}|^\t/.test(line)) return line;
    const definition = line.match(/^ {0,3}\[(kb\d+)\]:/i);
    if (definition) {
      // A newline closes the URL and supporting quote. Never parse partial
      // URLs as final links while the model is still emitting the definition.
      if (index === lines.length - 1) return '';
      complete.add(definition[1].toLowerCase());
    } else if (/^ {0,3}\[kb\d*\]?:?$/i.test(line)) return '';
    return line;
  });
  fence = '';
  return visible.map(line => {
    const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length
        && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = '';
      return line;
    }
    if (fence || /^ {4}|^\t/.test(line)) return line;
    return line.replace(/(`+)[\s\S]*?\1|\\.|\[Source (\d+)\]\[(kb\d+)\]/gi,
      (match, _ticks, number, id) => number && !complete.has(id.toLowerCase()) ? `[${number}]` : match);
  }).join('\n');
}
