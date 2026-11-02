import { t } from "../lib/i18n";
import { useState } from 'react';

export function ArtifactChangeRequest({ sessionId, path, disabled = false }: { sessionId?: string; path: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState('');
  return <div className="artifact-change-request">
    <button type="button" className="artifact-change-trigger" aria-expanded={open} disabled={disabled || !sessionId} title={disabled ? t("Save manual edits and wait for the current task to finish before requesting changes") : t("Ask Buddy to edit this existing file")} onClick={() => setOpen(value => !value)}>{t("Request changes")}</button>
    {open && <form className="artifact-change-form" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }} onSubmit={event => {
      event.preventDefault();
      if (disabled || !sessionId || !comments.trim()) return;
      window.dispatchEvent(new CustomEvent('buddy-request-artifact-edit', { detail: { sessionId, path, comments: comments.trim() } }));
      setOpen(false);
    }}>
      <label>{t("What should Buddy change?")}<textarea value={comments} maxLength={16000} onChange={event => setComments(event.target.value)} placeholder={t("Describe the heading, chart, layout, or content you want changed.")} required />
      </label>
      <p>{t("Buddy will edit this saved file and preserve the content you haven't asked to change. Save any manual edits first.")}</p>
      <div className="artifact-change-actions">
      <button type="submit" disabled={disabled || !comments.trim()}>{t("Apply changes with Buddy")}</button>
      <button type="button" onClick={() => setOpen(false)}>{t("Cancel")}</button>
      </div>
    </form>}
  </div>;
}
