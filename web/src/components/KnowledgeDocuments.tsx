import { audienceLabel, useAccessGroups } from '../lib/accessGroups';
import { Toolbar } from './Toolbar';
import { t, getLocale } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import { appConfirm } from './AppDialog';
import { knowledgeDocumentHref } from '../lib/safeHref';

interface KnowledgeDocument {
  id: string;
  owner?: string;
  review_due?: string | null;
  review_overdue?: boolean;
  reviewed_at?: string | null;
  filename: string;
  description: string;
  status: 'queued' | 'indexing' | 'ready' | 'failed';
  error: string | null;
  chunk_count: number;
  uploaded_by: string;
  created_at: string;
  size: number;
  can_manage: boolean;
  knowledge_base: "company";
  audience: string;
}
interface SearchPassage { id: string; filename: string; location: string; text: string; citation_id: string; }
const base = '/knowledge';
const supported = /\.(pdf|docx|txt|md|csv|tsv|xlsx|xlsm|xltx)$/i;
async function checkedFetch(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || 'Could not update the knowledge base');
  }
  return response;
}
const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function KnowledgeDocuments({ isStreaming, hasExternalAgent, compact = false, isAdmin = false }: {
  isAdmin?: boolean; compact?: boolean; sessionId?: string; isStreaming: boolean; hasExternalAgent: boolean;
}) {
  const library = 'company';
  const groups = useAccessGroups();
  const [audience, setAudience] = useState('both');
  const editLibrary = 'company';
  const [editAudience, setEditAudience] = useState('both');
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [expanded, setExpanded] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingDescriptions, setPendingDescriptions] = useState<Record<string,string>>({});
  const [description, setDescription] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editOwner, setEditOwner] = useState('');
  const [editReviewDue, setEditReviewDue] = useState('');
  const [replacing, setReplacing] = useState<KnowledgeDocument | null>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('recent');
  const [results, setResults] = useState<SearchPassage[] | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const searchRequest = useRef(0);

  async function refresh() {
    const response = await checkedFetch(base);
    const data = await response.json();
    if (mounted.current) { setDocuments(data); setLoadError(''); }
  }
  useEffect(() => {
    mounted.current = true;
    async function poll() {
      try { await refresh(); }
      catch (e) { if (mounted.current) setLoadError(e instanceof Error ? e.message : 'Could not load sources'); }
    }
    void poll();
    const timer = window.setInterval(() => { if (!document.hidden) void poll(); }, 4000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);

  async function upload(files: FileList | File[] | null) {
    if (!files?.length || busy) return;
    setBusy(true); setExpanded(true); setError('');
    const selected = Array.from(files);
    try {
      for (let i = 0; i < selected.length; i++) {
        const file = selected[i];
        if (!supported.test(file.name)) throw new Error(`${file.name}: choose PDF, Word, text, CSV, or Excel files.`);
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} exceeds the 20 MB limit.`);
        setUploadStatus(`Uploading ${i + 1} of ${selected.length}: ${file.name}`);
        const body = new FormData(); body.append('file', file); body.append('description', pendingDescriptions[file.name] ?? description); body.append('knowledge_base', library); body.append('audience', audience);
        await checkedFetch(base, { method: 'POST', body });
      }
      setPendingFiles([]); setPendingDescriptions({});
      setUploadStatus(`${selected.length} ${selected.length === 1 ? 'source added' : 'sources added'} to the selected knowledge library.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed'); }
    finally {
      try { await refresh(); } catch { /* Polling reports connection errors. */ }
      if (mounted.current) { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
    }
  }

  async function action(document: KnowledgeDocument, retry: boolean) {
    if (!retry && !await appConfirm(`Remove “${document.filename}” from this knowledge library?\nUsers with access to this source will lose its passages and citations.`)) return;
    setBusy(true); setError('');
    try {
      await checkedFetch(`${base}/${document.id}${retry ? '/retry' : ''}`, { method: retry ? 'POST' : 'DELETE' });
      setResults(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update source'); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function removeSelected() {
    if (!selectedIds.length || !await appConfirm(`Delete ${selectedIds.length} selected documents from this library? Their passages and citations will be removed.`)) return;
    setBusy(true); setError('');
    try { for (const id of selectedIds) await checkedFetch(`${base}/${id}`,{method:'DELETE'}); }
    catch(e) { setError((e as Error).message); }
    finally { setSelectedIds([]); setResults(null); await refresh().catch(() => {}); setBusy(false); }
  }
  async function saveDescription(d: KnowledgeDocument) {
    setBusy(true); setError('');
    try { await checkedFetch(`${base}/${d.id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({description:editDescription, ...(isAdmin ? {knowledge_base:editLibrary,audience:editAudience} : {})})}); await checkedFetch(`${base}/${d.id}/freshness`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:editOwner,review_due:editReviewDue || null})}); setEditing(''); await refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function markReviewed(d: KnowledgeDocument) {
    setBusy(true); setError('');
    try { await checkedFetch(`${base}/${d.id}/freshness`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:d.owner || '',review_due:d.review_due || null,reviewed:true})}); await refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function replaceFile(file?: File) {
    if (!file || !replacing) return;
    if (!supported.test(file.name) || file.size > 20 * 1024 * 1024) { setError('Choose a supported file no larger than 20 MB.'); return; }
    if (!await appConfirm(`Replace “${replacing.filename}” with “${file.name}”? Old passages and citations will be removed from this library.`)) return;
    setBusy(true); setError('');
    try { const body=new FormData(); body.append('file',file); await checkedFetch(`${base}/${replacing.id}`,{method:'PUT',body}); setResults(null); await refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); setReplacing(null); if(replacementInput.current) replacementInput.current.value=''; }
  }

  async function search() {
    if (!query.trim() || searching) return;
    const request = ++searchRequest.current;
    setSearching(true); setError('');
    try {
      const response = await checkedFetch(`${base}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, knowledge_base: library }) });
      const data = await response.json();
      if (mounted.current && request === searchRequest.current) setResults(data);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Search unavailable'); }
    finally { if (mounted.current) setSearching(false); }
  }

  const libraryDocuments = documents.filter(d => (d.knowledge_base || 'company') === library);
  const ready = libraryDocuments.filter(d => d.status === 'ready').length;
  const preparing = documents.filter(d => d.status === 'queued' || d.status === 'indexing').length;
  const failed = documents.filter(d => d.status === 'failed').length;
  const visible = libraryDocuments.filter(d => (filter === 'all' || (filter === 'overdue' ? d.review_overdue : filter === 'preparing' ? ['queued', 'indexing'].includes(d.status) : d.status === filter))
    && (!query || d.filename.toLowerCase().includes(query.toLowerCase()) || (d.description || '').toLowerCase().includes(query.toLowerCase()) || d.uploaded_by.toLowerCase().includes(query.toLowerCase())))
    .sort((a, b) => sort === 'name' ? a.filename.localeCompare(b.filename) : b.created_at.localeCompare(a.created_at));

  if (compact) return <button type="button" className="knowledge-chat-indicator" onClick={() => window.dispatchEvent(new Event('buddy-open-knowledge'))}><span aria-hidden="true">▤</span><strong>{t("Knowledge base")}</strong><span>{ready} {t("ready sources")}{preparing ? ` · ${preparing} preparing` : ''}</span><span>{t("Manage ↗")}</span></button>;

  return <section className={`knowledge-panel shared-knowledge ${expanded ? 'expanded' : ''}`} aria-label={t("Knowledge libraries")}>
    <div className="knowledge-heading">
      <button className="knowledge-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="knowledge-brand-icon" aria-hidden="true">▤</span>
        <span><strong>{t("Knowledge base")}</strong><small>{t("Access follows the groups an administrator assigns to you.")}</small></span>
        <span className="knowledge-shared-badge">{t("Access controlled")}</span>
        <span className="knowledge-count">{ready} {t("ready")}{preparing ? ` · ${preparing} preparing` : ''}</span>
        <span className="knowledge-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {isAdmin && <button type="button" className="knowledge-upload" disabled={busy} onClick={() => { setExpanded(true); fileInput.current?.click(); }}>{busy ? t("Uploading…") : t("+ Add sources")}</button>}
      <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md,.csv,.tsv,.xlsx,.xlsm,.xltx" multiple hidden aria-label={t("Upload knowledge sources")} onChange={e => setPendingFiles(Array.from(e.target.files || []))} />
    </div>
    <input ref={replacementInput} type="file" hidden accept=".pdf,.docx,.txt,.md,.csv,.tsv,.xlsx,.xlsm,.xltx" onChange={e => void replaceFile(e.target.files?.[0])} />
    {expanded && <div className="knowledge-body">
      <p>{t("Sources for everyone apply to all users. Group sources apply only to members of that group.")}</p>
      {isAdmin && <label className="knowledge-description-field">{t("Policy audience")}<select value={audience} onChange={e => setAudience(e.target.value)}><option value="both">{t("Everyone")}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
      {isAdmin && <label className="knowledge-description-field">{t("Default description for new uploads")}<textarea maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} placeholder={t("What these documents cover, their purpose, and relevant dates…")} /></label>}
      {isAdmin && pendingFiles.length > 0 && <section className="knowledge-upload-review" aria-label={t("Review uploads")}><h3>{t("Prepare your documents")}</h3>{pendingFiles.map((file,i) => <label className="knowledge-description-field" key={`${file.name}-${i}`}><strong>{file.name} · {sizeLabel(file.size)}</strong><textarea aria-label={t("Description for upload {0}", [file.name])} maxLength={2000} value={pendingDescriptions[file.name] ?? description} onChange={e => setPendingDescriptions({...pendingDescriptions,[file.name]:e.target.value})} placeholder={t("Describe this document…")} /></label>)}<div className="knowledge-review-actions"><button type="button" className="knowledge-upload" disabled={busy} onClick={() => void upload(pendingFiles)}>{t(pendingFiles.length === 1 ? "Upload {0} document" : "Upload {0} documents", [pendingFiles.length])}</button><button type="button" className="knowledge-review-cancel" disabled={busy} onClick={() => {setPendingFiles([]);if(fileInput.current)fileInput.current.value='';}}>{t("Cancel")}</button></div></section>}
      <div className="knowledge-summary"><span><b>{documents.length}</b> {t("sources")}</span><span className="ready"><b>{ready}</b> {t("ready to search")}</span><span><b>{preparing}</b> {t("preparing")}</span>{failed > 0 && <span className="failed"><b>{failed}</b> {t("need attention")}</span>}</div>
      <form className="knowledge-search" onSubmit={e => { e.preventDefault(); void search(); }}>
        <span aria-hidden="true">⌕</span><input aria-label={t("Search available knowledge")} placeholder={t("Find a source or ask a question about its contents…")} value={query} maxLength={2000} onChange={e => { ++searchRequest.current; setQuery(e.target.value); setResults(null); }} />
        {query && <button type="button" onClick={() => { ++searchRequest.current; setQuery(''); setResults(null); }} aria-label={t("Clear search")}>×</button>}
        <button type="submit" disabled={searching || !query.trim() || !ready}>{searching ? t("Searching…") : t("Search contents")}</button>
      </form>
      {results !== null && <div className="knowledge-results" aria-live="polite"><div className="knowledge-results-heading"><strong>{results.length} {t("matching passages")}</strong><button type="button" onClick={() => setResults(null)}>{t("Back to sources")}</button></div>
        {results.length === 0 && <p>{t("No relevant passages found in ready sources. Try a more specific question.")}</p>}
        {results.map((result, index) => <article key={`${result.citation_id}-${index}`}><a href={knowledgeDocumentHref(result.id, 'file')}>{result.filename}</a><small>{result.location}</small><p>{result.text}</p></article>)}
      </div>}
      {results === null && <>
        <Toolbar className="knowledge-toolbar"><button disabled={busy || !visible.some(d => d.can_manage)} onClick={() => setSelectedIds(visible.filter(d => d.can_manage).map(d => d.id))}>{t("Select manageable sources")}</button>{selectedIds.length > 0 && <><button disabled={busy || isStreaming} onClick={() => void removeSelected()}>{t("Delete selected (")}{selectedIds.length})</button><button onClick={() => setSelectedIds([])}>{t("Clear selection")}</button></>}<Toolbar className="knowledge-filters" aria-label={t("Filter source status")}>{[['all',t("All sources")],['ready',t("Ready")],['preparing',t("Preparing")],['failed',t("Needs attention")],['overdue',t("Review overdue")]].map(([value,label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</Toolbar><select aria-label={t("Sort knowledge sources")} value={sort} onChange={e => setSort(e.target.value)}><option value="recent">{t("Newest first")}</option><option value="name">{t("Name A–Z")}</option></select></Toolbar>
        {isAdmin && <div className={`knowledge-dropzone ${dragging ? 'dragging' : ''} ${busy ? 'is-busy' : ''}`}
          onDragEnter={e => { if (!busy && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); dragDepth.current++; setDragging(true); } }}
          onDragOver={e => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } }}
          onDragLeave={e => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
          onDrop={e => { e.preventDefault(); dragDepth.current = 0; setDragging(false); if (!busy && e.dataTransfer.files.length) setPendingFiles(Array.from(e.dataTransfer.files)); }}>
          <button className="knowledge-dropzone-trigger" type="button" disabled={busy} aria-label={t("Browse knowledge documents")} onClick={() => fileInput.current?.click()}>
            <span className="knowledge-dropzone-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4" /></svg></span>
            <span className="knowledge-dropzone-copy"><strong>{dragging ? t("Drop your documents here") : t("Add documents to your knowledge base")}</strong><span>{t("Drag and drop files, or choose from your device")}</span><small>{t("PDF, Word, Markdown, text, CSV & Excel")}<span className="knowledge-dropzone-limit">{t("20 MB per file")}</span></small></span>
            <span className="knowledge-dropzone-action">{busy ? t("Uploading…") : t("Browse files")}</span>
          </button>
        </div>}
        <ul className="knowledge-list">{visible.map(d => <li key={d.id}>{d.can_manage && <input type="checkbox" aria-label={t("Select {0}", [d.filename])} disabled={busy} checked={selectedIds.includes(d.id)} onChange={e => setSelectedIds(e.target.checked ? [...selectedIds,d.id] : selectedIds.filter(id => id !== d.id))} />}
          <span className={`knowledge-file-icon ${d.filename.split('.').pop()?.toLowerCase()}`} aria-hidden="true">{d.filename.split('.').pop()?.toUpperCase()}</span>
          <div className="knowledge-document"><a href={knowledgeDocumentHref(d.id, 'file')}>{d.filename}</a><span className="knowledge-meta">{t("Company Knowledge")} · {audienceLabel(d.audience, groups)}</span>{(d.owner || d.review_due) && <span className={`knowledge-meta ${d.review_overdue ? 'knowledge-error' : ''}`}>{t('Owner')}: {d.owner || '—'} · {t('Review due')}: {d.review_due || '—'}{d.review_overdue ? ` · ${t('Review overdue')}` : ''}{d.reviewed_at ? ` · ${t('Last reviewed')}: ${new Date(d.reviewed_at).toLocaleDateString(getLocale())}` : ''}</span>}{d.description && <p className="knowledge-description">{d.description}</p>}{editing === d.id && <div className="knowledge-description-field">{isAdmin && <><label>{t("Policy audience")}<select value={editAudience} onChange={e => setEditAudience(e.target.value)}><option value="both">{t("Everyone")}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label></>}<label>{t('Document owner')}<input maxLength={200} value={editOwner} onChange={e => setEditOwner(e.target.value)} /></label><label>{t('Review due')}<input type="date" value={editReviewDue} onChange={e => setEditReviewDue(e.target.value)} /></label><textarea aria-label={t("Description for {0}", [d.filename])} maxLength={2000} value={editDescription} onChange={e => setEditDescription(e.target.value)} /><button disabled={busy} onClick={() => void saveDescription(d)}>{t("Save")}</button><button onClick={() => setEditing('')}>{t("Cancel")}</button></div>}<span className="knowledge-meta">{sizeLabel(d.size)} {t("· Added by")}{d.uploaded_by} · {new Date(d.created_at).toLocaleDateString(getLocale())}</span><span className={`knowledge-status ${d.status}`}>{d.status === 'ready' ? t("Ready · {0} passages", [d.chunk_count]) : d.status === 'queued' ? t("Waiting to prepare") : d.status === 'indexing' ? t("Preparing source…") : t("Needs attention")}</span>{d.error && <span className="knowledge-error">{d.error}</span>}</div>
          <div className="knowledge-actions"><a href={knowledgeDocumentHref(d.id, 'file')} title={t("Download {0}", [d.filename])}>{t("Download")}</a>{d.status === 'ready' && <a href={knowledgeDocumentHref(d.id, 'prepared')} target="_blank" rel="noreferrer">{t("Read text")}</a>}{d.can_manage && <><button disabled={busy} onClick={() => void markReviewed(d)}>{t('Mark reviewed')}</button><button disabled={busy} onClick={() => {setEditing(d.id);setEditDescription(d.description || '');setEditOwner(d.owner || '');setEditReviewDue(d.review_due || '');setEditAudience(d.audience || 'both');}}>{isAdmin ? t("Edit classification & description") : t("Edit description")}</button><button disabled={busy || isStreaming} onClick={() => {setReplacing(d);replacementInput.current?.click();}}>{t("Replace file")}</button>{(d.status === 'failed' || d.status === 'ready') && <button type="button" disabled={busy || isStreaming} onClick={() => void action(d,true)}>{d.status === 'failed' ? t("Retry") : t("Reindex")}</button>}<button type="button" className="knowledge-remove" disabled={busy || isStreaming} aria-label={t("Remove {0} from the library", [d.filename])} onClick={() => void action(d,false)}>{t("Remove")}</button></>}</div>
        </li>)}</ul>
        {!visible.length && <div className="knowledge-empty"><strong>{documents.length ? t("No sources match your filters.") : t("Build a library for the appropriate employee groups.")}</strong><span>{documents.length ? t("Clear the search or choose another status.") : t("Add policies, reports, reference documents or spreadsheets. Buddy uses sources available to your employee groups.")}</span></div>}
      </>}
      {hasExternalAgent && <p className="knowledge-notice">{t("Select Buddy to answer from this library. External agents do not receive its sources.")}</p>}
      <p className="knowledge-footnote">{t("Sources stay available when a chat is deleted. Administrators manage documents and their access classification.")}</p>
    </div>}
    {uploadStatus && <div className="knowledge-upload-status" role="status">{t(uploadStatus)}</div>}
    {(error || loadError) && <div className="knowledge-error" role="alert">{error || loadError}</div>}
  </section>;
}
