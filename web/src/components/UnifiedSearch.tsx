import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import './UnifiedSearch.css';

export type SearchResult = { kind: 'conversations' | 'files' | 'knowledge'; id: string; title: string; snippet: string; session_id?: string; project_id?: string; path?: string; url?: string };
type SearchResponse = { results: SearchResult[]; has_more: boolean; coverage?: string };

export function UnifiedSearch({ onClose, onOpen }: { onClose: () => void; onOpen: (result: SearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(''); setBusy(false);
    if (query.trim().length < 2) return;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void fetch(`/search?q=${encodeURIComponent(query.trim())}&kind=${kind}`, { signal: controller.signal }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Search failed.');
        if (!controller.signal.aborted) setResult(data);
      }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, kind]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <div className="feature-overlay"><section className="feature-dialog unified-search buddy-surface" role="dialog" aria-modal="true" aria-label={t('Unified search')}>
    <WorkspaceSectionHeader title={t('Search saved work')} compact actions={<button type="button" onClick={onClose}>{t('Close')}</button>} />
    <div className="unified-search-controls"><label>{t('Search')}<input ref={input} type="search" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search answers, files, reports, and knowledge…')} /></label>
      <label>{t('Search in')}<select value={kind} onChange={event => setKind(event.target.value)}><option value="all">{t('Everything')}</option><option value="conversations">{t('Conversations')}</option><option value="files">{t('Files & artifacts')}</option><option value="knowledge">{t('Knowledge')}</option></select></label></div>
    <p className="unified-search-help">{t('Searches your saved work and knowledge sources you can access. Text search uses exact phrases, regardless of letter case.')}</p>
    {busy && <p role="status">{t('Searching…')}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {result && <><p role="status">{result.results.length ? `${result.results.length} ${t('results')}` : t('No matching saved work.')}{result.has_more && ` · ${t('More matches available. Refine your search.')}`}</p>
      <ul className="unified-search-results">{result.results.map(item => <li key={`${item.kind}:${item.id}`}>
        <span className="unified-search-kind">{t(item.kind === 'conversations' ? 'Conversation' : item.kind === 'knowledge' ? 'Knowledge source' : 'File / artifact')}</span>
        {item.kind === 'knowledge' ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a> : <button type="button" onClick={() => onOpen(item)}>{item.title}</button>}
        {item.snippet && <p>{item.snippet}</p>}
      </li>)}</ul>
      <p className="unified-search-help">{t('Workspace text indexing covers the first 1 MB of supported text files. Binary originals use prepared document text when available.')}</p>
    </>}
  </section></div>;
}
