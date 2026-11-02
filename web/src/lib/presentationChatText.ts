/** Keep presentation source in the artifact viewer, including unfinished streams. */
export function presentationChatText(text: string, presentation: boolean): string {
  let result = text.replace(/(```|~~~)(?=([^\n]*))\2(?:\n|$)([\s\S]*?)(?:\n\1[^\n]*(?=\n|$)|$)/g,
    (block, _fence, language, body) => {
      const lang = language.trim().toLowerCase();
      const source = lang === 'bobdeck' ||
        (presentation && (['', 'json', 'html'].includes(lang) || /^(?:b|bo|bob|bobd|bobde|bobdec|j|js|jso|h|ht|htm)$/.test(lang))) ||
        (lang === 'json' && /"slides"\s*:/.test(body));
      return source ? '' : block;
    });
  // Unfenced deck JSON can arrive a character at a time. Balance braces while
  // respecting quoted strings so any natural-language suffix stays visible.
  const start = result.indexOf('{');
  if (start >= 0 && (presentation || /"slides"\s*:/.test(result.slice(start)))) {
    let depth = 0, quoted = false, escaped = false;
    let end = result.length;
    for (let i = start; i < result.length; i++) {
      const char = result[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = i + 1; break; }
    }
    result = result.slice(0, start) + result.slice(end);
  }
  if (presentation) {
    // Hide the opening backticks before the language tag has finished arriving.
    result = result.replace(/(?:^|\n)[`~]{1,2}$/, '');
    const htmlStart = result.search(/<!doctype\b|<html\b/i);
    if (htmlStart >= 0) {
      const close = result.toLowerCase().indexOf('</html>', htmlStart);
      result = result.slice(0, htmlStart) + (close >= 0 ? result.slice(close + 7) : '');
    }
  }
  return result.trim();
}
