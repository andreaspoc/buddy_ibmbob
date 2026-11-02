import { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
import { postWithPersonalDataReview } from '../lib/personalDataReview';

export function ComposeEmail({ onClose }: { onClose: () => void }) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function send() {
    if (busy.current || result) return;
    busy.current = true; setSending(true); setError('');
    try {
      const data = await postWithPersonalDataReview('/api/email/send', { to, subject, body }, t('Could not send email.'));
      if (data) setResult(data.message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not send email.'));
    } finally { busy.current = false; setSending(false); }
  }
  return <dialog ref={dialog} className="notes-editor" aria-labelledby="compose-email-title" onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <h2 id="compose-email-title">{t('Send email')}</h2>
      <p>{t('Sent from the shared platform address. You will be asked to confirm if it may contain personal data.')}</p>
      <label className="notes-editor-field">{t('To (comma-separated)')}<input required maxLength={13000} value={to} disabled={sending || Boolean(result)} onChange={event => setTo(event.target.value)} autoFocus /></label>
      <label className="notes-editor-field">{t('Subject')}<input required maxLength={998} value={subject} disabled={sending || Boolean(result)} onChange={event => setSubject(event.target.value)} /></label>
      <label className="notes-editor-field">{t('Message')}<textarea required rows={10} value={body} disabled={sending || Boolean(result)} onChange={event => setBody(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      <div className="notes-revision-actions"><button type="button" disabled={sending} onClick={onClose}>{t(result ? 'Close' : 'Cancel')}</button>{!result && <button type="submit" disabled={sending}>{t(sending ? 'Sending…' : 'Send email')}</button>}</div>
    </form>
  </dialog>;
}
