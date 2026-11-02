export interface SourceMetadata { title: string; url: string; kind: 'document' | 'web'; preview?: string; quote?: string }
export function sourceMetadata(link: HTMLAnchorElement, kind: SourceMetadata['kind'], preview?: string): SourceMetadata {
  const url = link.getAttribute('href') || '';
  let fallback = 'Source';
  try { const parsed = new URL(url, window.location.origin); fallback = kind === 'web' ? parsed.hostname : decodeURIComponent(parsed.pathname.split('/').pop() || 'Document source'); } catch { /* Keep a neutral fallback. */ }
  const label = link.textContent?.trim() || '';
  return { title: label && !/^\[?\d+\]?$/.test(label) ? label : fallback, url, kind, preview, quote: link.getAttribute('title') || undefined };
}
export function attachSourceMetadata(link: HTMLAnchorElement, source: SourceMetadata) {
  link.dataset.sourceTitle = source.title;
  link.dataset.sourceUrl = source.url;
  link.dataset.sourceKind = source.kind;
  if (source.quote) link.dataset.sourceQuote = source.quote;
  if (source.preview) link.dataset.citationPreview = source.preview;
}
export function sourcePopupPosition(rect: {left:number; top:number; bottom:number}, viewport: {width:number; height:number}) {
  const width = Math.max(1, Math.min(460, viewport.width - 24));
  const below = viewport.height - rect.bottom;
  const above = below < 260 && rect.top > below;
  return {width, left: Math.max(12, Math.min(rect.left, viewport.width - width - 12)),
    ...(above ? {bottom: Math.max(12, viewport.height - rect.top + 8)} : {top: Math.max(12, rect.bottom + 8)}),
    maxHeight: Math.max(1, Math.min(360, (above ? rect.top : below) - 20))};
}
