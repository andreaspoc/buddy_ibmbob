/** Route by explicit classification or actual slide markup, never by a preferred filename. */
export interface PresentationFile {
  name?: string;
  path?: string;
  kind?: string;
  is_presentation?: boolean;
  content?: string;
}

export function isPresentationHtml(html: string): boolean {
  if (!html) return false;
  if (/<meta\b[^>]*name\s*=\s*["']bob-(?:artifact-role|artifact-type|document-type)["'][^>]*content\s*=\s*["']presentation["']/i.test(html)) return true;
  if (/\bdata-(?:bob-)?presentation\s*=\s*["'](?:true|presentation)["']/i.test(html)) return true;
  // Slide sections are structural evidence; charts alone are report content.
  const slides = html.match(/<(?:section|article|div)\b[^>]*(?:class\s*=\s*["'][^"']*\bslide\b[^"']*["']|data-slide(?:\s*=|\s|>))/gi);
  if ((slides?.length || 0) >= 1) return true;
  return /class\s*=\s*["'][^"']*\breveal\b[^"']*["']/i.test(html) && /class\s*=\s*["'][^"']*\bslides\b[^"']*["']/i.test(html);
}

export function isPresentationFile(file: PresentationFile): boolean {
  if (file.is_presentation !== undefined) return file.is_presentation;
  if (/\.bobdeck$/i.test(file.path || file.name || '')) return true;
  if (file.kind === 'presentation') return true;
  return Boolean(file.content && isPresentationHtml(file.content));
}

export interface LivePresentationArtifact extends PresentationFile {
  path: string;
  sha256?: string;
  live?: boolean;
}
