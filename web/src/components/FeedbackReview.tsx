import { useEffect, useState } from 'react';
import { t, getLocale } from '../lib/i18n';
import { feedbackRequest } from './AnswerFeedback';
import { AnswerQuality } from './AnswerQuality';
import { safeHref } from '../lib/safeHref';

interface Report {
  id: number; username: string; user_name: string; category: string; comment: string;
  answer_text: string; source_filename: string | null; source_url: string | null;
  status: string; created_at: string;
}
interface Page { items: Report[]; next_before_id: number | null }
const statusNames: Record<string, string> = { open: 'Open', reviewed: 'Reviewed', resolved: 'Resolved' };
const categoryNames: Record<string, string> = { incorrect_answer: 'Incorrect answer', outdated_policy: 'Outdated policy', other: 'Other issue' };

export function FeedbackReview() {
  const [qualityRevision, setQualityRevision] = useState(0);
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState<Report[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setItems([]); setNext(null);
    feedbackRequest<Page>(`/admin/feedback?limit=25${status ? `&status=${status}` : ''}`)
      .then(data => { if (active) { setItems(data.items); setNext(data.next_before_id); } })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [status]);
  async function loadMore() {
    if (next === null) return;
    setBusy(true); setError('');
    try {
      const data = await feedbackRequest<Page>(`/admin/feedback?limit=25&before_id=${next}${status ? `&status=${status}` : ''}`);
      setItems(previous => [...previous, ...data.items]); setNext(data.next_before_id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load feedback.'); }
    finally { setBusy(false); }
  }
  async function update(item: Report, value: string) {
    setBusy(true); setError('');
    try {
      await feedbackRequest(`/admin/feedback/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: value }) });
      setQualityRevision(previous => previous + 1);
      setItems(previous => previous.flatMap(entry => entry.id !== item.id ? [entry] : status && status !== value ? [] : [{ ...entry, status: value }]));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update feedback.'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="feedback-review-title">
    <h2 id="feedback-review-title">{t('Answer feedback')}</h2>
    <p>{t('Review reported answers and outdated policies. Status changes are recorded in audit history.')}</p>
    <AnswerQuality revision={qualityRevision} />
    <label className="administration-search">{t('Feedback status')}<select value={status} onChange={event => setStatus(event.target.value)} disabled={busy}><option value="">{t('All statuses')}</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    {items.map(item => <article className="feedback-review" key={item.id}>
      <header><strong>{t(categoryNames[item.category] || 'Other issue')}</strong><label>{t('Feedback status')}<select aria-label={t('Status for feedback {0}', [item.id])} value={item.status} disabled={busy} onChange={event => void update(item, event.target.value)}>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label></header>
      <small>{item.user_name || item.username} · {new Date(item.created_at).toLocaleString(getLocale())}</small>
      {item.source_filename && <p>{t('Related source')}: {item.source_url && safeHref(item.source_url) ? <a href={safeHref(item.source_url)}>{item.source_filename}</a> : item.source_filename}</p>}
      <p>{item.comment || t('No additional comment.')}</p>
      <details><summary>{t('Reported answer')}</summary><div className="feedback-review-answer">{item.answer_text}</div></details>
    </article>)}
    {busy && <p role="status">{t('Loading feedback…')}</p>}
    {!busy && !items.length && !error && <p>{t('No feedback in this view.')}</p>}
    {next !== null && <button type="button" disabled={busy} onClick={() => void loadMore()}>{t('Load more')}</button>}
  </section>;
}
