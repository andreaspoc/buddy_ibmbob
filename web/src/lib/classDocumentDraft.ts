import { brandText } from './brand';
import { getLearningLanguage } from '../learningLanguage';

export const CLASS_DOCUMENT_TYPES = '.epub,.pdf,.docx,.pptx,.xlsx,.csv,.html,.htm,.txt,.md';

type DraftResult = { title: string; source_truncated: boolean; untranslated?: string[] };
export type DraftOutcome = { ok: boolean; message: string };

/** The class already exists when this runs, so a failed draft is reported rather than thrown. */
export async function draftLessonFromDocument(folderId: string, file: File, brief: string): Promise<DraftOutcome> {
  const body = new FormData();
  body.append('file', file);
  body.append('brief', brief);
  body.append('language', getLearningLanguage());
  try {
    const response = await fetch(`/api/learning/folders/${encodeURIComponent(folderId)}/lesson-document-draft`, { method: 'POST', credentials: 'same-origin', body });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `Request failed (${response.status}).`);
    return { ok: true, message: draftMessage(result) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Request failed.';
    return { ok: false, message: brandText(`Your class was created, but Buddy could not draft a lesson from the document. ${reason}`) };
  }
}

function draftMessage(result: DraftResult) {
  const parts = [brandText(`Class created. Buddy drafted the private lesson “${result.title}”. Review it under Lessons before publishing.`)];
  if (result.source_truncated) parts.push(brandText('The document was long, so Buddy used only its first part. Check that nothing important is missing.'));
  if (result.untranslated?.length) parts.push(`Translation failed for: ${result.untranslated.join(', ')}. Those languages show the original text.`);
  return parts.join(' ');
}
