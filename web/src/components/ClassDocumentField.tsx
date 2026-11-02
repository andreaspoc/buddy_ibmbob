import { brandText } from '../lib/brand';
import { CLASS_DOCUMENT_TYPES } from '../lib/classDocumentDraft';

export function ClassDocumentField({ file, brief, busy, onFile, onBrief }: {
  file: File | null;
  brief: string;
  busy: boolean;
  onFile: (file: File | null) => void;
  onBrief: (brief: string) => void;
}) {
  return <>
    <label>Reference document for {brandText("Buddy")} (optional)
      <input aria-label={brandText("Reference document for Buddy")} type="file" accept={CLASS_DOCUMENT_TYPES} disabled={busy} onChange={event => onFile(event.target.files?.[0] ?? null)} />
    </label>
    {file && <label>What should {brandText("Buddy")} focus on? (optional)
      <textarea aria-label={brandText("What should Buddy focus on?")} maxLength={6000} rows={3} disabled={busy} value={brief} onChange={event => onBrief(event.target.value)} />
    </label>}
    {file && <p className="learning-muted" role={busy ? 'status' : undefined}>
      {busy
        ? brandText('Buddy is reading your document and drafting a lesson. This can take several minutes; keep this page open.')
        : brandText('Buddy will draft a private lesson from this document for you to review. Learners cannot see the draft or the document, and the file is not kept.')}
    </p>}
  </>;
}
