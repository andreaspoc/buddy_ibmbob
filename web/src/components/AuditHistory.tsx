import { useEffect, useState, type FormEvent } from 'react';
import { accessRequest, type AuditEvent } from '../accessApi';
import { getLocale, t } from '../lib/i18n';
const actions: Record<string, string> = {
  'create-mcp': 'MCP connection created', 'update-mcp': 'MCP connection updated', 'delete-mcp': 'MCP connection removed', 'classify-mcp': 'MCP connection access changed',
  'review-answer-feedback': 'Feedback status changed',
  'update-user-assignment': 'User groups changed', 'grant-administrator': 'Administrator granted', 'invite-administrator': 'Administrator invited', 'remove-pending-administrator': 'Pending administrator removed',
  'upload-document': 'Document uploaded', 'describe-document': 'Document description changed', 'replace-document': 'Document replaced', 'classify-document': 'Document classification changed', 'remove-document': 'Document removed', 'reindex-document': 'Document reindexed',
};
const fields: Record<string, string> = { name: 'Connection name', transport: 'Transport', disabled: 'Disabled', is_admin: 'Administrator', filename: 'Document', description: 'Description', knowledge_base: 'Knowledge base', audience: 'Applies to', status: 'Status' };
function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return t('Unassigned');
  if (typeof value === 'boolean') return t(value ? 'Yes' : 'No');
  const labels: Record<string,string> = { both: 'Everyone', company: 'Company Knowledge', ready: 'Ready', queued: 'Queued', indexing: 'Indexing', failed: 'Failed', open: 'Open', reviewed: 'Reviewed', resolved: 'Resolved' };
  return t(labels[String(value)] || String(value));
}
function EventDetails({ event }: { event: AuditEvent }) {
  const before = event.details?.before as Record<string, unknown> | undefined;
  const after = event.details?.after as Record<string, unknown> | undefined;
  if (!before && !after) return null;
  const changed = Object.keys(fields).filter(key => (key in (before || {}) || key in (after || {})) && before?.[key] !== after?.[key]);
  if (!changed.length) return null;
  return <details><summary>{t('View changes')}</summary><dl className="audit-changes">{changed.map(key => <div key={key}><dt>{t(fields[key])}</dt><dd>{before ? valueLabel(before[key]) : t('Not previously set')} <span aria-label={t('Changed to')}>→</span> {after ? valueLabel(after[key]) : t('Removed')}</dd></div>)}</dl></details>;
}
export function AuditHistory() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [filters, setFilters] = useState({ action: '', actor: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(before?: number, selected = filters) {
    setBusy(true); setError('');
    const query = new URLSearchParams({ limit: '25' });
    if (before) query.set('before_id', String(before));
    if (selected.action) query.set('action', selected.action);
    if (selected.actor) query.set('actor', selected.actor);
    try { const data = await accessRequest<{ events: AuditEvent[]; next_before_id: number | null }>('/admin/audit?' + query); setEvents(previous => before ? [...previous, ...data.events] : data.events); setNext(data.next_before_id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load audit history.'); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  const filter = (event: FormEvent) => { event.preventDefault(); const selected = { action, actor: actor.trim() }; setFilters(selected); void load(undefined, selected); };
  return <section aria-labelledby="audit-history-title"><h2 id="audit-history-title">{t('Audit history')}</h2><p>{t('Review administrator changes to user groups, administrator access, knowledge documents, and MCP connections.')}</p>
    <form className="administration-invite audit-filter-form" onSubmit={filter}><label>{t('Action')}<select value={action} onChange={event => setAction(event.target.value)}><option value="">{t('All actions')}</option>{Object.entries(actions).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select></label><label>{t('Changed by')}<input value={actor} onChange={event => setActor(event.target.value)} placeholder={t('Name, email, or account ID')} /></label><button type="submit" disabled={busy}>{t('Apply filters')}</button><button type="button" disabled={busy} onClick={() => void load()}>{t('Refresh')}</button></form>
    {error && <p className="administration-error" role="alert">{t(error)}</p>}
    {!events.length ? <p role="status">{t(busy ? 'Loading audit history…' : 'No matching audit events.')}</p> : <ol className="audit-event-list">{events.map(event => <li key={event.id}><div><strong>{t(actions[event.action] || event.action)}</strong><p>{event.actor_name || event.actor} · <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(getLocale())}</time></p><p className="audit-target">{event.target_name || event.target}</p><EventDetails event={event} /></div></li>)}</ol>}
    {next !== null && <button type="button" disabled={busy} onClick={() => void load(next)}>{t(busy ? 'Loading audit history…' : 'Load older events')}</button>}
  </section>;
}
