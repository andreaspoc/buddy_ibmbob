import { parseClarifications, parseNextQuestions } from './clarification';

/** Speak the public prose, leaving reasoning, code and structured payloads out. */
export function speechText(content: string): string {
  const prose = parseNextQuestions(parseClarifications(content, true).text, true).text;
  const lines = prose.split('\n').map(line => {
    const text = line.trim();
    if (text.startsWith('|') && text.endsWith('|') && text.length > 1) return '';
    let start = 0;
    while (start < line.length && /[ \t\r]/.test(line[start])) start++;
    let end = start;
    while (end < line.length && '#>*+-'.includes(line[end])) end++;
    if (end === start) return line;
    while (end < line.length && /[ \t\r]/.test(line[end])) end++;
    return line.slice(end);
  }).join('\n');
  return lines
    .replace(/<think(?:ing)?>[^]*?(?:<\/think(?:ing)?>|$)/gi, '')
    .replace(/```[^]*?(?:```|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\[\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^<>]+>/g, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ').trim();
}
export function speechChunks(text: string, limit = 900): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit);
    const sentence = [...prefix.matchAll(/[.!?](?:\s|$)/g)].at(-1);
    const split = sentence && sentence.index > limit / 3 ? sentence.index + 1 : (prefix.lastIndexOf(' ') > 0 ? prefix.lastIndexOf(' ') : limit);
    chunks.push(remaining.slice(0, split)); remaining = remaining.slice(split).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
