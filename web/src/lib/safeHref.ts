/**
 * Validates a URL before use in an href attribute.
 * Returns the URL unchanged if it is a safe http/https/relative URL,
 * or undefined if the scheme could execute script (e.g. javascript:, data:).
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return undefined;
  if (url.startsWith('//')) return undefined;
  // Relative paths and same-origin API paths are always safe.
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function knowledgeDocumentHref(id: string, action: 'file' | 'prepared'): string | undefined {
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? `/knowledge/${id}/${action}` : undefined;
}
