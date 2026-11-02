import { Toolbar } from './Toolbar';
import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { feedbackRequest } from './AnswerFeedback';
import './ArtifactReviewComments.css';

interface ReviewComment { id: number; anchor: string; comment: string; status: 'open' | 'resolved'; outdated: boolean; created_at: string }
export function ArtifactReviewComments({ sessionId, path, disabled = false, onRequestChanges }: { sessionId: string; path: string; disabled?: boolean; onRequestChanges?: (prompt: string, path: string) => void | Promise<void> }) {
  const [items, setItems] = useState<ReviewComment[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [anchor, setAnchor] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    if (disabled) return;
    let active = true;
    setItems([]); setSelected([]); setAnchor(''); setComment(''); setLoading(true); setError('');
    feedbackRequest<{items: ReviewComment[]; has_more: boolean}>(`/artifact-comments?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}&limit=500`)
      .then(data => { if (active) { setItems(data.items); setHasMore(data.has_more); } })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, path, disabled]);
  async function run(action: () => Promise<void>) {
    if (disabled) return;
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not update comments.'); }
    finally { setBusy(false); }
  }
  async function add() {
    const item = await feedbackRequest<ReviewComment>('/artifact-comments', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ session_id: sessionId, path, anchor, comment }) });
    setItems(previous => [item, ...previous]); setComment('');
  }
  async function changeStatus(item: ReviewComment) {
    const updated = await feedbackRequest<ReviewComment>(`/artifact-comments/${item.id}`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status: item.status === 'open' ? 'resolved' : 'open'}) });
    setItems(previous => previous.map(row => row.id === item.id ? updated : row));
    setSelected(previous => previous.filter(id => id !== item.id));
  }
  async function requestChanges() {
    const data = await feedbackRequest<{prompt: string}>('/artifact-comments/revision-request', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ session_id: sessionId, path, ids: selected }) });
    await onRequestChanges?.(data.prompt, path);
  }
  return <section className="artifact-review" aria-label={t("Artifact review comments")}>
    <Toolbar as="header"><h3>{t("Review comments")}</h3><span>{t("{0} open", [items.filter(item => item.status === 'open').length])}</span></Toolbar>
    <p>{t("Attach feedback to a slide, paragraph, or chart. Select comments to ask Buddy for changes.")}</p>
    <form onSubmit={event => { event.preventDefault(); void run(add); }}>
      <label>{t("Location")}<input value={anchor} maxLength={200} required placeholder={t("Slide 3, paragraph 2, or Revenue chart")} disabled={busy || disabled || loading} onChange={event => setAnchor(event.target.value)} /></label>
      <label>{t("Comment")}<textarea value={comment} maxLength={4000} required rows={3} disabled={busy || disabled || loading} onChange={event => setComment(event.target.value)} /></label>
      <button type="submit" disabled={busy || disabled || loading || !anchor.trim() || !comment.trim()}>{t("Add comment")}</button>
    </form>
    {loading && <p role="status">{t("Loading comments…")}</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && !items.length && <p>{t("No review comments yet.")}</p>}
    {hasMore && <p>{t("Showing the latest 500 comments.")}</p>}
    <ul>{items.map(item => <li key={item.id} className={item.status === 'resolved' ? 'resolved' : ''}>
      <div className="artifact-review-row"><label><input type="checkbox" aria-label={t("Select comment at {0}", [item.anchor])} disabled={busy || disabled || item.status === 'resolved' || (!selected.includes(item.id) && selected.length >= 50)} checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} /><strong>{item.anchor}</strong></label><button type="button" disabled={busy || disabled} onClick={() => void run(() => changeStatus(item))}>{t(item.status === 'open' ? 'Resolve' : 'Reopen')}</button></div>
      <p>{item.comment}</p><small>{item.status === 'resolved' ? t('Resolved') + ' · ' : ''}{new Date(item.created_at).toLocaleString()}{item.outdated ? ' · ' + t('Earlier artifact revision') : ''}</small>
    </li>)}</ul>
    {onRequestChanges && <button type="button" disabled={busy || disabled || !selected.length} onClick={() => void run(requestChanges)}>{t("Ask Buddy to address {0} comments", [selected.length])}</button>}
  </section>;
}

export function SavedArtifactReview({ sessionId, path, disabled = false }: { sessionId: string; path: string; disabled?: boolean }) {
  return <details><summary>{t('Review comments')}</summary><ArtifactReviewComments key={`${sessionId}:${path}`} sessionId={sessionId} path={path} disabled={disabled} onRequestChanges={comments => { if (!disabled) window.dispatchEvent(new CustomEvent('buddy-request-artifact-edit', { detail: { sessionId, path, comments } })); }} /></details>;
}
