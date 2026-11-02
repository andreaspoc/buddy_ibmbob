import { isPresentationFile } from './presentationFiles';

/**
 * Deck extraction utilities for BobDeck (.bobdeck) and interactive HTML presentations.
 * Supports both full parsed presentations and real-time partial slide extraction from streaming buffers.
 */

export interface BobdeckParseResult {
  deck?: any;
  rawJson?: string;
  filename?: string;
  cleanText?: string;
  isPartial?: boolean;
}

export interface HtmlDeckParseResult {
  html?: string;
  filename?: string;
  title?: string;
  cleanText?: string;
}

/** Find a complete deck fence without rescanning suffixes for each opening. */
function deckFence(text: string, languages: readonly string[]): [string, string] | null {
  const closing: number[] = [];
  for (let at = text.indexOf('\n```'); at >= 0; at = text.indexOf('\n```', at + 1)) closing.push(at);
  const opening = /```(?:bobdeck|json|html)/gi;
  let nextClosing = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    if (!languages.includes(match[0].slice(3).toLowerCase())) continue;
    const newlines: number[] = [];
    let end = opening.lastIndex;
    while (end < text.length && /\s/.test(text[end])) {
      if (text[end] === '\n') newlines.push(end);
      end++;
    }
    if (!newlines.length) continue;
    // At least one character (the opening newline) precedes the closing newline.
    while (nextClosing < closing.length && closing[nextClosing] <= newlines[0]) nextClosing++;
    if (nextClosing === closing.length) return null;
    const close = closing[nextClosing];
    let boundary = newlines.length - 1;
    while (newlines[boundary] >= close) boundary--;
    const start = newlines[boundary] + 1;
    return [text.slice(match.index, close + 4), text.slice(start, close)];
  }
  return null;
}

/**
 * Extracts Bobdeck JSON from markdown text or filename reference.
 */
export function extractBobdeck(text: string): BobdeckParseResult | null {
  if (!text) return null;

  // 1. Check for code blocks with ```bobdeck or ```json
  const match = deckFence(text, ['bobdeck', 'json']);
  if (match) {
    const inner = match[1].trim();
    if (inner.endsWith('.bobdeck') && !inner.startsWith('{')) {
      return { filename: inner, cleanText: text.replace(match[0], '').trim() };
    }
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.slides && Array.isArray(parsed.slides)) {
        return { deck: parsed, rawJson: match[1], cleanText: text.replace(match[0], '').trim(), isPartial: false };
      }
    } catch {}
  }

  // 2. Check for loose JSON with "slides": [...]
  // Select the same outer span without retrying from every opening brace.
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const rawJson = text.slice(jsonStart, jsonEnd + 1);
    if (/"slides"\s*:\s*\[/.test(rawJson)) {
      try {
        const parsed = JSON.parse(rawJson);
        if (parsed.slides && Array.isArray(parsed.slides)) {
          return { deck: parsed, rawJson, cleanText: (text.slice(0, jsonStart) + text.slice(jsonEnd + 1)).trim(), isPartial: false };
        }
      } catch {}
    }
  }

  // 3. Check for .bobdeck filename references like presentation.bobdeck
  const names = /[a-zA-Z0-9_-]+/g;
  for (let name = names.exec(text); name; name = names.exec(text)) {
    if (text.slice(names.lastIndex, names.lastIndex + 8).toLowerCase() === '.bobdeck') {
      return { filename: name[0] + text.slice(names.lastIndex, names.lastIndex + 8), cleanText: text };
    }
  }

  return null;
}

/**
 * Extracts live / streaming Bobdeck slides from incomplete streaming text.
 * Allows rendering completed slides one-by-one as Buddy streams them in real-time.
 */
export function extractLiveBobdeck(text: string): BobdeckParseResult | null {
  if (!text) return null;

  // If already complete, return full result
  const complete = extractBobdeck(text);
  if (complete && complete.deck) return complete;

  // Look for slides array start
  const slidesIdx = text.search(/"slides"\s*:\s*\[/);
  if (slidesIdx === -1) return null;
  const startArr = text.indexOf('[', slidesIdx);
  if (startArr === -1) return null;

  // Extract theme if present
  let theme: any = undefined;
  const themeMatch = text.match(/"theme"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/);
  if (themeMatch) {
    try {
      theme = JSON.parse(themeMatch[1]);
    } catch {}
  }

  // Scan for completed slide objects inside the array by balancing braces
  const slides: any[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let slideStart = -1;

  for (let i = startArr + 1; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (c === '{') {
      if (depth === 0) slideStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && slideStart !== -1) {
        const slideChunk = text.slice(slideStart, i + 1);
        try {
          const s = JSON.parse(slideChunk);
          if (s && (s.elements || s.layout || s.id)) {
            slides.push(s);
          }
        } catch {}
        slideStart = -1;
      }
    } else if (c === ']' && depth === 0) {
      break;
    }
  }

  if (slides.length > 0) {
    return {
      deck: { theme, slides },
      rawJson: '',
      isPartial: true,
      cleanText: text,
    };
  }

  return null;
}

/**
 * Extracts interactive HTML presentation from markdown or file reference.
 */
export function extractHtmlDeck(text: string, _isStreaming: boolean = false): HtmlDeckParseResult | null {
  if (!text) return null;

  // 1. Check for ```html code blocks containing interactive deck markup
  const match = deckFence(text, ['html']);
  if (match) {
    const code = match[1];
    const isCompleteHtml =
      code.toLowerCase().includes('</html>') &&
      code.toLowerCase().includes('</body>');

    if (
      isCompleteHtml &&
      isPresentationFile({ kind: 'html', content: code })
    ) {
      const titleMatch = code.match(/<title>([^<]+)<\/title>/i);
      return {
        html: code,
        cleanText: text.replace(match[0], '').trim(),
        title: titleMatch ? titleMatch[1] : 'Interactive Presentation',
        filename: 'presentation.html',
      };
    }
  }

  // Workspace metadata routes local files; filenames cannot classify HTML.
  return null;
}
