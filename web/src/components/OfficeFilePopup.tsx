import { Toolbar } from './Toolbar';
import { WorkspaceBrand } from './WorkspaceSectionHeader';
import { useEffect, useId, useRef, useState } from 'react';
import { getLanguage, t, useLanguage } from '../lib/i18n';
import { navigateOffice } from '../lib/officeUrl';
import { officeEditorScriptUrl } from '../lib/officeEditorScript';
import './OfficeFilePopup.css';

type EditorInstance = { destroyEditor: () => void };
type EditorWindow = Window & { DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => EditorInstance } };
const scriptLoads = new Map<string, Promise<void>>();
function loadEditorScript(url: string) {
  url = officeEditorScriptUrl(url, window.location.origin);
  if ((window as EditorWindow).DocsAPI) return Promise.resolve();
  const existing = scriptLoads.get(url);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => { scriptLoads.delete(url); script.remove(); reject(new Error('The Office editor could not load. Retry when the editor service is available.')); };
    document.head.appendChild(script);
  });
  scriptLoads.set(url, promise);
  return promise;
}

/** Preview the actual stored file without leaving the conversation. */
export function OfficeFilePopup({ file, onClose }: { file: { id: string; name: string }; onClose: () => void }) {
  useLanguage();
  const language = getLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const id = `office-popup-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const html = /\.html?$/i.test(file.name);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = dialog.current;
    modal?.show(); closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) closeRef.current(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); modal?.close(); if (modal?.contains(document.activeElement)) opener?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let editor: EditorInstance | undefined;
    setReady(false); setError('');
    if (!html) void (async () => {
      try {
        const response = await fetch(`/api/office/files/${encodeURIComponent(file.id)}/editor?ui_language=${language}&view_only=true`, { method: 'POST', signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'The Office request failed. Please retry.');
        if (cancelled) return;
        await loadEditorScript(result.script_url);
        if (cancelled) return;
        const api = (window as EditorWindow).DocsAPI;
        if (!api) throw new Error('The document editor did not initialize.');
        const config = result.config;
        editor = new api.DocEditor(id, { ...config, width: '100%', height: '100%', editorConfig: { ...config.editorConfig, mode: 'view' }, events: {
          onDocumentReady: () => { if (!cancelled) setReady(true); },
          onError: () => { if (!cancelled) setError('The Office preview could not load. Open the saved file in Office Suite or download it.'); },
        } });
      } catch (failure) { if (!cancelled) setError((failure as Error).message); }
    })();
    return () => { cancelled = true; controller.abort(); editor?.destroyEditor(); };
  }, [file.id, html, id, language]);
  return <dialog ref={dialog} className={`office-file-popup${minimized ? ' is-minimized' : ''}`} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <Toolbar as="header"><div><WorkspaceBrand className="answer-frame-brand" /><strong id={`${id}-title`}>{file.name}</strong><small>{t('Saved file preview')}</small></div><nav aria-label={t('File actions')}><a href={`/office/files/${encodeURIComponent(file.id)}`} onClick={event => { event.preventDefault(); onClose(); navigateOffice(`/office/files/${file.id}`); }}>{t('Open in Office Suite')}</a><a href={`/api/office/files/${encodeURIComponent(file.id)}/download`}>{t('Download saved file')}</a><button type="button" aria-expanded={!minimized} aria-controls={`${id}-body`} onClick={() => setMinimized(value => !value)}>{t(minimized ? 'Expand preview' : 'Minimize preview')}</button><button ref={closeButton} type="button" onClick={onClose} aria-label={t('Close')}>✕</button></nav></Toolbar>
    <div id={`${id}-body`} className="office-file-popup-body" hidden={minimized}>
      {html ? <p>{t('Open this HTML file in Office Suite to preview it.')}</p> : <>
        {!ready && !error && <p className="office-file-popup-status" role="status">{t('Loading document…')}</p>}
        {error && <p className="office-file-popup-status" role="alert">{t(error)}</p>}
        <div className="office-file-popup-editor"><div id={id} /></div>
      </>}
    </div>
  </dialog>;
}
