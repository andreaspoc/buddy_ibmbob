import { postWithPersonalDataReview } from '../lib/personalDataReview';
import { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';

export function EmailNote({ note, onClose }: { note: { id: number; title: string }; onClose: () => void }) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function send() {
    if (busy.current || result) return;
    busy.current = true; setSending(true); setError('');
    try {
      const data = await postWithPersonalDataReview(`/api/notes/${note.id}/email`, { to }, t('Could not send note.'));
      if (data) setResult(data.message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not send note.'));
    } finally { busy.current = false; setSending(false); }
  }
  return <dialog ref={dialog} className="notes-editor" aria-labelledby="email-note-title" onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <h2 id="email-note-title">{t('Send note as email')}</h2>
      <p>{note.title}</p>
      <p>{t('Sends a Markdown attachment. On your iPhone, hold the attachment → Share → Notes → Save (iOS 26 or later).')}</p>
      <label className="notes-editor-field">{t('Recipient email')}<input type="email" required maxLength={254} value={to} disabled={sending || Boolean(result)} onChange={event => setTo(event.target.value)} autoFocus /></label>
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      <div className="notes-revision-actions"><button type="button" disabled={sending} onClick={onClose}>{t(result ? 'Close' : 'Cancel')}</button>{!result && <button type="submit" disabled={sending}>{t(sending ? 'Sending…' : 'Send email')}</button>}</div>
    </form>
  </dialog>;
}
