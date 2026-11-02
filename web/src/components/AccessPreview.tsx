import { audienceLabel, useAccessGroups } from '../lib/accessGroups';
import type { MCPServer } from '../types';
import { useState, type FormEvent } from 'react';
import { accessRequest, type PreviewDocument } from '../accessApi';
import { t } from '../lib/i18n';
export function AccessPreview() {
  const groups = useAccessGroups();
  const [selected, setSelected] = useState<string[]>([]);
  const [documents, setDocuments] = useState<PreviewDocument[] | null>(null);
  const [mcps, setMcps] = useState<MCPServer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preview = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setDocuments(null); setMcps(null);
    try { const result = await accessRequest<{ documents: PreviewDocument[]; mcps?: MCPServer[] }>('/admin/access-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: selected }) }); setDocuments(result.documents); setMcps((result.mcps || []).filter(server => server.allowed !== false)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load access information.'); } finally { setBusy(false); }
  };
  return <section aria-labelledby="access-preview-title"><h2 id="access-preview-title">{t('Access preview')}</h2><p>{t('See which documents and MCP connections an employee can access. This preview does not change any user assignments.')}</p>
    <form className="administration-invite access-preview-form" onSubmit={event => void preview(event)}>{groups.length ? groups.map(group => <label key={group.id} className="access-inline-checkbox"><input type="checkbox" disabled={busy} checked={selected.includes(group.id)} onChange={event => { setSelected(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id)); setDocuments(null); setMcps(null); }} />{group.name}</label>) : <p>{t('No groups yet. This preview shows what everyone can access.')}</p>}<button type="submit" disabled={busy}>{t(busy ? 'Loading access…' : 'Preview access')}</button></form>
    {error && <p className="administration-error" role="alert">{t(error)}</p>}
    {documents && <><p role="status">{t('Accessible documents: {0}', [documents.length])}</p>{documents.length ? <div className="administration-table"><table><thead><tr><th>{t('Document')}</th><th>{t('Knowledge base')}</th><th>{t('Applies to')}</th><th>{t('Status')}</th></tr></thead><tbody>{documents.map(document => <tr key={document.id}><th scope="row">{document.filename}</th><td>{t('Company Knowledge')}</td><td>{audienceLabel(document.audience, groups)}</td><td>{t(({ ready: 'Ready', queued: 'Queued', indexing: 'Indexing', failed: 'Failed' } as Record<string, string>)[document.status] || document.status)}</td></tr>)}</tbody></table></div> : <p>{t('No documents are available for this group.')}</p>}</>}
    {mcps && <><h3>{t('Available MCP connections')}</h3><p role="status">{t('Accessible MCP connections: {0}', [mcps.length])}</p>{mcps.length ? <ul className="access-libraries">{mcps.map(server => <li key={server.name}>{server.name}</li>)}</ul> : <p>{t('No MCP connections are available for this group.')}</p>}</>}
  </section>;
}
