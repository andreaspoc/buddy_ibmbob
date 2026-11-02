import { Toolbar } from './Toolbar';
import { OfficeToNoteButton } from './NotesOfficeTransfer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HtmlDeckViewer } from './HtmlDeckViewer';
import { OfficeAssistant } from './OfficeAssistant';
import { useOfficeHtmlBridge } from '../lib/officeHtmlBridge';
import { useOfficeHtmlRuntime } from '../lib/officeHtmlRuntime';
import { t } from '../lib/i18n';
import { repairHtmlForRender } from '../lib/htmlRenderRepair';

type HTMLFile = { id: string; name: string; extension: string; size: number; revision: number; save_sequence: number; saved_at: string; access?: 'owner' | 'write' | 'read' };
export type OfficeHtmlEditorProps = {
  file: HTMLFile; onBack: () => void; onClose: () => void;
  onDirty: (dirty: boolean) => void; onUpdated: (file: HTMLFile) => void;
  onRename?: (file: HTMLFile) => void;
};
export function OfficeHtmlEditor({ file, onBack, onClose, onDirty, onUpdated, onRename }: OfficeHtmlEditorProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [frameSource, setFrameSource] = useState('');
  const [revision, setRevision] = useState(file.revision);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [layoutMode, setLayoutMode] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const liveFrame = useRef<HTMLIFrameElement>(null);
  const presentFrame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const readOnly = file.access === 'read';
  const markDirty = useCallback((value: boolean) => { setDirty(value); onDirty(value); }, [onDirty]);
  const runtimeChanged = useCallback(() => markDirty(true), [markDirty]);
  const runtime = useOfficeHtmlRuntime(liveFrame, file.id, frameSource, runtimeChanged);
  const staticBridge = useOfficeHtmlBridge(host, file.id, readOnly);
  const bridge = layoutMode ? staticBridge : runtime;
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/office/files/${file.id}/content`, { signal: abort.signal }).then(async response => {
      if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not load this presentation.');
      if (!abort.signal.aborted) { setHtml(data.html); setFrameSource(data.html); setRevision(data.revision); }
    }).catch(reason => { if (!abort.signal.aborted) setError(String(reason.message || reason)); });
    return () => abort.abort();
  }, [file.id]);
  useEffect(() => {
    if (!presenting) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPresenting(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [presenting]);
  const save = async (source: string, refreshRuntime = false) => {
    setSaving(true); setError('');
    try {
      const response = await fetch(`/api/office/files/${file.id}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: source, revision }) });
      if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save this presentation.');
      setRevision(data.revision); setHtml(source); markDirty(false); onUpdated(data);
      if (refreshRuntime) { setFrameSource(source); setEditingText(false); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally { setSaving(false); }
  };
  const saveRuntime = async () => {
    setSaving(true); setError('');
    try { await save(await runtime.saveSource()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const toggleTextEditing = async () => {
    try { await runtime.setEditing(!editingText); setEditingText(value => !value); }
    catch (reason) { setError((reason as Error).message); }
  };
  return <div ref={container} className="office-live-editor office-html-editor">
    <Toolbar className="office-editor-title office-html-toolbar"><div><button disabled={saving || busy} onClick={onBack} aria-label={t('Back to file library')}>←</button><strong>{file.name}</strong>{readOnly && <span>{t('Read only')}</span>}</div><div>
      {!readOnly && <>
        {onRename && <button disabled={saving || busy} onClick={() => onRename(file)}>{t('Rename')}</button>}
        <button disabled={busy} aria-expanded={assistantOpen} onClick={() => setAssistantOpen(value => !value)}>{t('Ask Buddy')}</button>
        {!layoutMode && <button disabled={!runtime.ready || busy || saving} aria-pressed={editingText} onClick={() => void toggleTextEditing()}>{t(editingText ? 'Finish text editing' : 'Edit text')}</button>}
        <button disabled={dirty || busy || saving} aria-pressed={layoutMode} title={dirty ? t('Save changes before switching views') : undefined} onClick={() => { setLayoutMode(value => !value); setEditingText(false); void runtime.setEditing(false).catch(() => {}); }}>{t(layoutMode ? 'Live presentation' : 'Layout editor')}</button>
        {!layoutMode && <button className="office-primary" disabled={!dirty || saving || busy || !runtime.ready} onClick={() => void saveRuntime()}>{t(saving ? 'Saving…' : 'Save to Office Suite')}</button>}
      </>}
      <button disabled={html === null || dirty || saving || busy} title={dirty ? t('Save changes before presenting') : undefined} onClick={() => setPresenting(true)}>{t('Present')}</button>
      <button onClick={() => { void container.current?.requestFullscreen?.().catch(() => {}); }}>{t('Full screen')}</button>
      <OfficeToNoteButton fileId={file.id} disabled={saving || busy} /><a href={`/api/office/files/${file.id}/download`}>{t('Download saved file')}</a><button disabled={saving || busy} onClick={onClose} aria-label={t('Close Office Suite')}>✕</button>
    </div></Toolbar>
    {(error || runtime.runtimeError) && <div className="office-error" role="alert">{error || runtime.runtimeError}</div>}
    {html === null ? <div className="office-loading">{t('Opening your document…')}</div> : <div className="office-editor-workspace">
      <div className="office-html-stage">
        <iframe ref={liveFrame} title={file.name} sandbox="allow-scripts" srcDoc={runtime.runtimeSource} className="office-html-live-frame" style={layoutMode ? { display: 'none' } : undefined} />
        {layoutMode && !readOnly && <div ref={host} className="office-editor-frame" style={{ overflow: 'auto', height: '100%' }}><HtmlDeckViewer htmlContent={html} filename={file.name} officeFileId={file.id} restrictedScripts onSaveHtml={source => save(source, true)} onDirtyChange={markDirty} isWorking={saving || busy} /></div>}
      </div>
      {!readOnly && assistantOpen && <div className="office-bob-panel"><OfficeAssistant key={`${file.id}:${layoutMode}`} fileId={file.id} extension="html" bridge={bridge} onBusy={setBusy} onApplied={() => markDirty(true)} /></div>}
    </div>}
    <footer className="office-editor-status"><span>{dirty ? t('Changes in editor · Save to Office Suite when ready') : t('Saved to Office Suite')}</span>{dirty && <span>{t('Save changes before presenting')}</span>}</footer>
    {presenting && html !== null && <div role="dialog" aria-label={t('Presentation')} className="office-html-presentation">
      <Toolbar role="toolbar" className="office-html-present-toolbar"><strong>{file.name}</strong><button onClick={() => setPresenting(false)}>{t('Close presentation')}</button></Toolbar>
      <iframe ref={presentFrame} title={file.name} sandbox="allow-scripts" srcDoc={repairHtmlForRender(html)} onLoad={() => presentFrame.current?.focus()} className="office-html-live-frame" />
    </div>}
  </div>;
}
