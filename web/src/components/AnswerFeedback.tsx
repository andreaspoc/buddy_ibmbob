import { AnswerActionLabel } from './AnswerActionLabel';
import { Toolbar } from './Toolbar';
import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import './AnswerFeedback.css';

interface Source { id: string; filename: string; url: string }
export async function feedbackRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not load feedback.');
  }
  return response.json();
}

export function AnswerFeedback({ sessionId, answerIndex, compact = false }: { sessionId: string; answerIndex: number; compact?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState('incorrect_answer');
  const [source, setSource] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError('');
    feedbackRequest<{ sources: Source[]; submitted?: {id:number;status:string} | null }>(`/feedback/answer?session_id=${encodeURIComponent(sessionId)}&answer_index=${answerIndex}`)
      .then(data => { if (active) { setSources(data.sources); setSubmitted(Boolean(data.submitted)); } })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, sessionId, answerIndex]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await feedbackRequest('/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, answer_index: answerIndex, category, comment, source_document_id: source || null }) });
      setSubmitted(true); setOpen(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send feedback.'); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className={compact ? 'answer-feedback-trigger answer-icon-action' : 'answer-feedback-trigger'} onClick={() => setOpen(true)} disabled={submitted}>{compact ? <AnswerActionLabel icon="report" label={t(submitted ? 'Feedback sent' : 'Report an issue')} /> : t(submitted ? 'Feedback sent' : 'Report an issue')}</button>
    <dialog ref={dialog} className="answer-feedback-dialog" aria-labelledby={`feedback-title-${answerIndex}`} onCancel={() => setOpen(false)}>
      <form onSubmit={event => void submit(event)}>
        <Toolbar as="header"><h2 id={`feedback-title-${answerIndex}`}>{t('Answer feedback')}</h2><button type="button" onClick={() => setOpen(false)}>{t('Close')}</button></Toolbar>
        <p>{t('Flag an incorrect answer or an outdated policy. Administrators will receive this answer and your feedback.')}</p>
        <label>{t('Issue type')}<select value={category} onChange={event => setCategory(event.target.value)}><option value="incorrect_answer">{t('Incorrect answer')}</option><option value="outdated_policy">{t('Outdated policy')}</option><option value="other">{t('Other issue')}</option></select></label>
        <label>{t('Related source')}<select disabled={loading || busy} value={source} onChange={event => setSource(event.target.value)}><option value="">{t('The answer as a whole')}</option>{sources.map(item => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label>
        <label>{t('What needs correcting?')}<textarea maxLength={4000} value={comment} onChange={event => setComment(event.target.value)} rows={4} placeholder={t('Explain the issue or describe the correct policy…')} /></label>
        {submitted && <p role="status">{t('Feedback sent')}</p>}
        {loading && <p role="status">{t('Loading sources…')}</p>}
        {error && <p role="alert" className="feedback-error">{t(error)}</p>}
        <footer><button type="button" disabled={busy} onClick={() => setOpen(false)}>{t('Cancel')}</button><button type="submit" disabled={busy || loading || submitted}>{t(busy ? 'Sending…' : 'Send feedback')}</button></footer>
      </form>
    </dialog>
  </>;
}
