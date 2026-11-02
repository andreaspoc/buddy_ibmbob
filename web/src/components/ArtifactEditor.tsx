import { Toolbar } from './Toolbar';
import { SaveToOfficeButton } from './SaveToOfficeButton';
import { ShareToPeopleButton } from './ShareToPeople';
import { ArtifactVersionCompare } from './ArtifactVersionCompare';
import { ArtifactProvenance, type Provenance } from './ArtifactProvenance';
import { SavedArtifactReview } from './ArtifactReviewComments';
import { StructuredDiagram } from './StructuredDiagram';
import { ArtifactPreview } from './ArtifactPreview';
import { parseDiagramSource } from '../lib/structuredDiagram';
import { t, getLocale } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import { appConfirm } from './AppDialog';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import mermaid from 'mermaid';
import { ArtifactChangeRequest } from './ArtifactChangeRequest';
import { isPresentationFile } from '../lib/presentationFiles';
import { prepareReactPreview } from '../lib/reactPreview';

export type Artifact = { path: string; content: string; sha256: string; kind: string; live?: boolean; is_presentation?: boolean; role?: 'presentation' | 'artifact'; provenance?: Provenance | null; correlation_id?: string; job_id?: string; chat_id?: string; workspace_id?: string; user_message_id?: string; assistant_message_id?: string; tool_call_id?: string; timestamp?: string; created_at?: string };
type Revision = { id: string; created: string; provenance?: Provenance | null };
const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || 'Artifact request failed'); }
  return response.json();
}

export function ArtifactEditor({ sessionId, initialPath, liveArtifact: incomingArtifact, liveArtifacts, isStreaming = false, onClose }: { sessionId: string; initialPath?: string; liveArtifact?: Artifact; liveArtifacts?: Record<string, Artifact>; isStreaming?: boolean; onClose?: () => void }) {
  const base = `/sessions/${encodeURIComponent(sessionId)}/artifacts`;
  const [files, setFiles] = useState<{ path: string; kind: string; is_presentation?: boolean }[]>([]);
  const [path, setPath] = useState(initialPath || '');
  const liveArtifact = liveArtifacts?.[path] || (incomingArtifact?.path === path ? incomingArtifact : undefined);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [source, setSource] = useState('');
  const [versions, setVersions] = useState<Revision[]>([]);
  const [compareRevision, setCompareRevision] = useState<Revision | null>(null);
  const [view, setView] = useState<'code' | 'visual'>('visual');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const diagram = path.endsWith('.diagram.json') ? parseDiagramSource(source, !isStreaming && !artifact?.live) : null;
  const previewRequest = useRef({source, kind: artifact?.kind});
  previewRequest.current = {source, kind: artifact?.kind};
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewVersion = useRef(0);
  const previewMounted = useRef(true);
  useEffect(() => { previewMounted.current = true; return () => { previewMounted.current = false; previewVersion.current++; if (previewTimer.current) clearTimeout(previewTimer.current); }; }, []);
  const latestLiveArtifact = useRef(liveArtifact);
  latestLiveArtifact.current = liveArtifact;
  useEffect(() => {
    let active = true;
    setArtifact(null); setError(''); setFiles([]);
    void request<{ path: string; kind: string; is_presentation?: boolean }[]>(base).then(rows => { if (active) { setFiles(rows.filter(row => !isPresentationFile(row))); setPath(current => initialPath || current || rows.filter(row => !isPresentationFile(row))[0]?.path || ''); } }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [base, initialPath]);
  useEffect(() => {
    let active = true;
    setVersions([]); setCompareRevision(null);
    const currentLive = latestLiveArtifact.current;
    if (currentLive?.path === path) { setArtifact(currentLive); setSource(currentLive.content); }
    else { setArtifact(null); setSource(''); setPreview(''); }
    if (path) void Promise.all([request<Artifact>(`${base}/source?path=${encodeURIComponent(path)}`), request<Revision[]>(`${base}/history?path=${encodeURIComponent(path)}`)]).then(([a, v]) => { if (active) { const current = latestLiveArtifact.current; const next = current?.path === path ? current : a; setArtifact(next); setSource(next.content || ''); setVersions(v); setError(''); } }).catch(err => { if (active && !isStreaming && latestLiveArtifact.current?.path !== path) setError(err.message); });
    return () => { active = false; };
  }, [base, path]);
  useEffect(() => {
    if (!liveArtifact || liveArtifact.path !== path) return;
    if (artifact && !artifact.live && source !== artifact.content) return;
    setFiles(rows => rows.some(row => row.path === liveArtifact.path) ? rows : [...rows, liveArtifact]);
    setArtifact(liveArtifact);
    setSource(liveArtifact.content);
    setError('');
  }, [liveArtifact, path, isStreaming]);
  useEffect(() => {
    previewVersion.current++;
    // Throttle instead of debouncing: continuous snapshots must never starve
    // the visible preview. Each tick renders the newest available content.
    if (previewTimer.current) return;
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      const version = previewVersion.current;
      const {source, kind} = previewRequest.current;
      if (!kind) return;
      async function render() {
        let html = '';
        if (kind === 'html') html = source;
        else if (kind === 'markdown') html = DOMPurify.sanitize(await marked.parse(source));
        else if (kind === 'mermaid') {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
          const result = await mermaid.render(`artifact-${Date.now()}`, source);
          html = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        } else if (kind === 'react') {
          const code = prepareReactPreview(source);
          html = `<div id="root"></div><script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.development.js"></script><script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.development.js"></script><script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script><script type="text/babel" data-presets="react,typescript" data-filename="artifact.tsx">const {useState,useEffect,useRef,useMemo,useCallback}=React; ${code}\nReactDOM.createRoot(document.getElementById('root')).render(<ArtifactComponent/>);</script>`;
        } else html = `<pre>${source.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
        if (previewMounted.current && previewVersion.current === version) setPreview(policy + html);
      }
      void render().catch(err => { if (previewMounted.current && previewVersion.current === version) setPreview(policy + `<p>Preview unavailable: ${DOMPurify.sanitize(String(err))}</p>`); });
    }, 120);
  }, [source, artifact?.kind]);
  useEffect(() => {
    if (isStreaming || !path || (artifact && !artifact.live)) return;
    let active = true;
    void Promise.all([request<Artifact>(`${base}/source?path=${encodeURIComponent(path)}`), request<Revision[]>(`${base}/history?path=${encodeURIComponent(path)}`)]).then(([next, revisions]) => {
      if (active && (!artifact || source === artifact.content)) { setArtifact(next); setSource(next.content); setVersions(revisions); setError(''); }
    }).catch(err => { if (active && !artifact) setError(err.message); });
    return () => { active = false; };
  }, [isStreaming, base, path]);
  async function save(revision?: string) {
    if (!artifact) return;
    setBusy(true); setError('');
    try {
      const a = await request<Artifact>(`${base}/${revision ? 'restore' : 'source'}`, { method: revision ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content: source, expected_sha256: artifact.sha256, ...(revision ? { revision } : {}) }) });
      setArtifact(a); setSource(a.content || ''); setCompareRevision(null); setVersions(await request<Revision[]>(`${base}/history?path=${encodeURIComponent(path)}`));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  async function create() {
    if (dirty && !await appConfirm('Discard unsaved changes and create a new artifact?')) return;
    setBusy(true); setError('');
    try {
      const a = await request<Artifact>(`${base}/source`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: newName, content: '' }) });
      setFiles(rows => [...rows, { path: a.path, kind: a.kind }]); setPath(a.path); setNewName('');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  function download() {
    if (!artifact) return;
    const types: Record<string,string> = {html:'text/html',markdown:'text/markdown',mermaid:'text/plain',react:'text/plain',text:'text/plain'};
    const blob = new Blob([source], {type:(types[artifact.kind] || 'text/plain') + ';charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = path.split('/').pop() || 'artifact.txt';
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  const dirty = !!artifact && source !== artifact.content;
  if (artifact && isPresentationFile(artifact)) return <section aria-label={t("Presentation redirect")} style={{ padding: 16 }}>
    <p>{t("Presentations open in Presentation Studio.")}</p>
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('buddy-open-artifact', { detail: { sessionId, path } }))}>{t("Open Presentation Studio")}</button>
    {onClose && <button type="button" onClick={onClose}>{t("Close")}</button>}
  </section>;
  return <section aria-label={t("Artifact editor")} className="artifact-editor">
    <Toolbar className="artifact-editor-toolbar">
      <strong>{t("Artifacts")}</strong>
      <select aria-label={t("Artifact")} value={path} disabled={busy} onChange={async e => { const next = e.target.value; if (!dirty || await appConfirm('Discard unsaved changes?')) setPath(next); }}><option value="">{t("Choose artifact")}</option>{files.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select>
      <button disabled={busy || isStreaming || !!artifact?.live || !dirty} onClick={() => void save()}>{busy ? t("Saving…") : t("Save")}</button>
      <button type="button" disabled={!artifact} onClick={download} title={t("Download the current source, including unsaved changes")}>{artifact?.live ? t("Download draft") : t("Download")}</button>
      <SaveToOfficeButton key={path} sessionId={sessionId} path={path} disabled={!artifact || busy || dirty || isStreaming || !!artifact.live} />
      <ShareToPeopleButton item={{ kind: 'artifact', session_id: sessionId, path, title: path.split('/').pop() || 'Artifact' }} disabled={!artifact || busy || dirty || isStreaming || !!artifact.live} title={dirty ? 'Save your changes before sharing' : 'Share a copy of this saved artifact'} />
      {onClose && <button onClick={async () => { if (!dirty || await appConfirm('Discard unsaved changes?')) onClose(); }}>{t("Close")}</button>}
    </Toolbar>
    <div className="artifact-editor-create"><input aria-label={t("New artifact filename")} placeholder={t("notes.md, page.html, component.tsx")} value={newName} onChange={e => setNewName(e.target.value)} /><button disabled={busy || isStreaming || !!artifact?.live || !newName.trim()} onClick={() => void create()}>{t("Create")}</button></div>
    {(isStreaming || artifact?.live) && <p role="status">{t("Live preview · Buddy is writing. Editing becomes available when the task finishes.")}</p>}
    {artifact?.kind === 'html' && <ArtifactChangeRequest sessionId={sessionId} path={path} disabled={busy || isStreaming || !!artifact.live || dirty} />}
    {!artifact && !error && <p role="status">{t("Preparing your artifact… Content will appear here as Buddy writes it.")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {artifact && <>
      <ArtifactProvenance provenance={artifact.provenance || (artifact.live && artifact.job_id ? {...artifact, origin: 'generated'} : null)} live={artifact.live} dirty={dirty} />
      <div className="artifact-view-tabs" role="tablist" aria-label={t("Artifact view")}>
        <button type="button" role="tab" id="artifact-code-tab" aria-selected={view === 'code'} aria-controls="artifact-code-panel" onClick={() => setView('code')}>{t("Code")}</button>
        <button type="button" role="tab" id="artifact-visual-tab" aria-selected={view === 'visual'} aria-controls="artifact-visual-panel" onClick={() => setView('visual')}>{t("Visual viewer")}</button>
      </div>
      <div id="artifact-code-panel" role="tabpanel" aria-labelledby="artifact-code-tab" hidden={view !== 'code'}>
        <textarea aria-label={t("Artifact source")} spellCheck={false} readOnly={isStreaming || !!artifact?.live} value={source} onChange={e => setSource(e.target.value)} className="artifact-source" />
      </div>
      <div id="artifact-visual-panel" role="tabpanel" aria-labelledby="artifact-visual-tab" hidden={view !== 'visual'}>
        {diagram ? <StructuredDiagram spec={diagram.spec} source={source} streaming={Boolean(isStreaming || artifact.live)} error={diagram.error} /> : <ArtifactPreview key={path} html={preview} live={Boolean(isStreaming || artifact.live)} />}
      </div>
      {artifact.kind === 'react' && <p>{t("React previews support a default exported component and React hooks. Preview libraries load from jsDelivr; other imports require a build.")}</p>}
      <SavedArtifactReview sessionId={sessionId} path={path} disabled={busy || isStreaming || !!artifact.live || dirty} />
      <details><summary>{t("Version history (")}{versions.length})</summary>{versions.length === 0 && <p>{t("Saved versions will appear here after the artifact changes.")}</p>}{versions.map((v, index) => <div key={`${v.id}-${index}`} className="artifact-history-row"><div><ArtifactProvenance provenance={v.provenance} /><time>{new Date(v.created).toLocaleString(getLocale())}</time></div><button type="button" disabled={busy || isStreaming || !!artifact.live} onClick={() => setCompareRevision(v)}>{t("Compare")}{v.id === artifact.sha256 ? ` · ${t("Current")}` : ''}</button></div>)}</details>
      {compareRevision && <ArtifactVersionCompare key={`${path}-${compareRevision.id}`} base={base} path={path} revision={compareRevision} current={source} dirty={dirty} disabled={busy || isStreaming || !!artifact.live} onClose={() => setCompareRevision(null)} onRestore={async () => { if (!dirty || await appConfirm('Discard unsaved changes and restore this version?')) void save(compareRevision.id); }} />}
    </>}
  </section>;
}
