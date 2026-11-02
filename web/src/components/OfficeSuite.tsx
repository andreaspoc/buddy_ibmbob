import { Toolbar } from './Toolbar';
import { OfficeToNoteButton } from './NotesOfficeTransfer';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { t, useLanguage, getLanguage, getLocale } from '../lib/i18n';
import { useOfficeBridge } from '../lib/officeBridge';
import { navigateOffice, parseOfficeRoute } from '../lib/officeUrl';
import { officeEditorScriptUrl } from '../lib/officeEditorScript';
import { OfficeHtmlEditor } from './OfficeHtmlEditor';
import { OfficeAssistant } from './OfficeAssistant';
import { WorkspaceBrand } from './WorkspaceSectionHeader';
import { LanguageSelector } from './LanguageSelector';
import { appConfirm } from './AppDialog';
import './OfficeSuite.css';
import './OfficeSuiteTheme.scss';
import { OfficeItemMenu, type OfficeMenuPosition } from './OfficeItemMenu';
import { OfficeFolderBrowser, OfficeFolderDestination, type OfficeFolder } from './OfficeFolderBrowser';

type Kind = 'word' | 'excel' | 'powerpoint' | 'csv' | 'pdf' | 'html' | 'form';
type OfficeFile = { folder_id?: string | null; id: string; name: string; extension: string; size: number; revision: number; save_sequence: number; saved_at: string; save_error?: string | null; save_receipt?: string | null; owner?: string; owner_display?: string; is_owner?: boolean; access?: 'owner' | 'write' | 'read'; share_count?: number };
type ShareEntry = { username: string; display_name: string; email?: string | null; permission: 'read' | 'write'; online?: boolean; created_at?: string };
type ShareUser = { username: string; display_name: string; email?: string | null; online?: boolean };
type EditorInstance = { destroyEditor: () => void };
type EditorApi = { DocEditor: new (id: string, config: Record<string, unknown>) => EditorInstance };
type EditorWindow = Window & { DocsAPI?: EditorApi };
type EditorConfig = { script_url: string; config: Record<string, unknown>; file: OfficeFile };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/office' + path, { cache: 'no-store', ...init });
  if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(t(typeof detail.detail === 'string' ? detail.detail : 'The Office request failed. Please retry.'));
  }
  const result = await response.json();
  if (init?.method && init.method !== 'GET') window.dispatchEvent(new Event('buddy-office-changed'));
  return result;
}
const kindOf = (file: OfficeFile): Kind => file.extension === 'pdf' ? 'pdf' : ['html', 'htm'].includes(file.extension) ? 'html' : file.extension === 'docx' ? 'word' : file.extension === 'pptx' ? 'powerpoint' : 'excel';
const letter = (kind: Kind) => kind === 'html' ? 'H' : kind === 'form' ? 'F' : kind === 'pdf' ? 'PDF' : kind === 'word' ? 'W' : kind === 'powerpoint' ? 'P' : 'X';
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

function OfficeShareModal({ file, onClose, onUpdated }: { file: OfficeFile; onClose: () => void; onUpdated: () => void }) {
  const [users, setUsers] = useState<ShareUser[]>([]);
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [uRes, sRes] = await Promise.all([
          request<{ items: ShareUser[] }>('/users'),
          request<{ items: ShareEntry[] }>(`/files/${file.id}/shares`),
        ]);
        if (cancelled) return;
        setUsers(uRes.items);
        setShares(sRes.items);
        if (uRes.items.length && !selectedUser) setSelectedUser(uRes.items[0].username);
      } catch (failure) {
        if (!cancelled) setError((failure as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [file.id]);

  const grant = async (username: string, perm: 'read' | 'write') => {
    if (!username || busy) return;
    setBusy(true); setError('');
    try {
      const res = await request<{ items: ShareEntry[] }>(`/files/${file.id}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, permission: perm }),
      });
      setShares(res.items);
      onUpdated();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  const revoke = async (username: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const res = await request<{ items: ShareEntry[] }>(`/files/${file.id}/shares/${encodeURIComponent(username)}`, { method: 'DELETE' });
      setShares(res.items);
      onUpdated();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  return <div className="office-upload-shade" onClick={onClose}>
    <section className="office-upload office-share-dialog" role="dialog" aria-modal="true" aria-label={t('Share file access')} onClick={e => e.stopPropagation()}>
      <button disabled={busy} className="office-upload-close" onClick={onClose} aria-label={t('Close share dialog')}>✕</button>
      <span className="office-caption">{t('ACCESS & PERMISSIONS')}</span>
      <h2>{file.name}</h2>
      <p>{t('Grant read-only or read & write access to other users.')}</p>
      <form className="office-share-form" onSubmit={e => { e.preventDefault(); void grant(selectedUser, permission); }}>
        <select aria-label={t('Select user')} value={selectedUser} onChange={e => setSelectedUser(e.target.value)} disabled={busy || !users.length}>
          {!users.length && <option value="">{t('No other users found')}</option>}
          {users.map(u => (
            <option key={u.username} value={u.username}>
              {u.online ? '🟢 ' : ''}{u.display_name}{u.email && u.email !== u.display_name ? ` (${u.email})` : ''}
            </option>
          ))}
        </select>
        <select aria-label={t('Permission level')} value={permission} onChange={e => setPermission(e.target.value as 'read' | 'write')} disabled={busy}>
          <option value="write">{t('Read & Write')}</option>
          <option value="read">{t('Read only')}</option>
        </select>
        <button className="office-primary feature-primary" type="submit" disabled={busy || !selectedUser}>{t('Grant access')}</button>
      </form>
      {error && <div className="office-error" role="alert">{t(error)}</div>}
      <div className="office-share-list">
        <span className="office-caption">{t('PEOPLE WITH ACCESS')}</span>
        {!shares.length ? <p className="office-share-empty">{t('Private to you. No other users have access yet.')}</p> : (
          <ul>
            {shares.map(s => (
              <li key={s.username} className="office-share-item">
                <div>
                  <strong>{s.online ? '🟢 ' : ''}{s.display_name}</strong>
                  {s.email && s.email !== s.display_name && <small> · {s.email}</small>}
                </div>
                <div className="office-share-item-actions">
                  <select aria-label={`${t('Permission for')} ${s.display_name}`} value={s.permission} disabled={busy} onChange={e => void grant(s.username, e.target.value as 'read' | 'write')}>
                    <option value="write">{t('Read & Write')}</option>
                    <option value="read">{t('Read only')}</option>
                  </select>
                  <button type="button" disabled={busy} onClick={() => void revoke(s.username)}>{t('Remove')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button disabled={busy} onClick={onClose}>{t('Done')}</button>
      </div>
    </section>
  </div>;
}

function OfficeEditor({ file, onBack, onClose, onDirty, onUpdated, onRename, onShare, onDelete }: { file: OfficeFile; onBack: () => void; onClose: () => void; onDirty: (dirty: boolean) => void; onUpdated: (file: OfficeFile) => void; onRename?: (file: OfficeFile) => void; onShare?: (file: OfficeFile) => void; onDelete?: (file: OfficeFile) => void }) {
  const language = useLanguage();
  const [editorLanguage, setEditorLanguage] = useState(getLanguage());
  const id = 'office-editor-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const [ready, setReady] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const frameHost = useRef<HTMLDivElement>(null);
  const bridge = useOfficeBridge(frameHost, `${file.id}:${editorLanguage}`, file.extension === 'pdf' ? 'pdf' : undefined);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('Loading document…');
  const [saved, setSaved] = useState(file);

  useEffect(() => {
    setSaved(current => ({ ...current, name: file.name }));
  }, [file.name]);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const unsent = useRef(false);
  const dirty = useRef(false);
  const alive = useRef(true);
  const callbacks = useRef({ onDirty, onUpdated });
  callbacks.current = { onDirty, onUpdated };
  const canEdit = saved.access !== 'read';
  const isOwner = saved.is_owner !== false;

  useEffect(() => {
    if (language !== editorLanguage && !dirty.current && !saving && !assistantBusy) setEditorLanguage(language);
  }, [language, editorLanguage, saving, assistantBusy]);

  useEffect(() => {
    let cancelled = false;
    let editor: EditorInstance | undefined;
    alive.current = true;
    setReady(false); setError(''); setMessage('Loading document…');
    void (async () => {
      try {
        const result = await request<EditorConfig>(`/files/${file.id}/editor?ui_language=${editorLanguage}`, { method: 'POST' });
        if (cancelled) return;
        await loadEditorScript(result.script_url);
        if (cancelled) return;
        const api = (window as EditorWindow).DocsAPI;
        if (!api) throw new Error('The document editor did not initialize.');
        editor = new api.DocEditor(id, { ...result.config, events: {
          onAppReady: () => {
            const iframe = frameHost.current?.querySelector('iframe');
            const doc = iframe?.contentDocument;
            if (doc && !doc.getElementById('buddy-hide-oo-logo')) {
              const style = doc.createElement('style');
              style.id = 'buddy-hide-oo-logo';
              style.textContent = '#header-logo, section.logo, .extra #header-logo, .brand-logo, .loader-logo, #id-about-licensor-logo { display: none !important; width: 0 !important; padding: 0 !important; margin: 0 !important; }';
              (doc.head || doc.documentElement).appendChild(style);
            }
          },
          onDocumentReady: () => {
            const iframe = frameHost.current?.querySelector('iframe');
            const doc = iframe?.contentDocument;
            if (doc && !doc.getElementById('buddy-hide-oo-logo')) {
              const style = doc.createElement('style');
              style.id = 'buddy-hide-oo-logo';
              style.textContent = '#header-logo, section.logo, .extra #header-logo, .brand-logo, .loader-logo, #id-about-licensor-logo { display: none !important; width: 0 !important; padding: 0 !important; margin: 0 !important; }';
              (doc.head || doc.documentElement).appendChild(style);
            }
            if (!cancelled) { setReady(true); setMessage(result.file.access === 'read' ? 'Read-only access' : 'Ready to edit'); }
          },
          onDocumentStateChange: (event: { data: boolean }) => {
            if (result.file.access === 'read') return;
            unsent.current = event.data;
            if (event.data) {
              generation.current += 1; dirty.current = true;
              callbacks.current.onDirty(true);
              if (!cancelled) setMessage('Changes in editor · Save to Office Suite when ready');
            }
          },
          onError: (event: { data?: { errorDescription?: string } }) => {
            if (!cancelled) setError(event.data?.errorDescription || 'The document editor reported an error. Keep the document open and retry saving.');
          },
          onWarning: (event: { data?: { warningDescription?: string } }) => {
            if (!cancelled && event.data?.warningDescription) setMessage(event.data.warningDescription);
          },
        } });
        const hideLogoInIframe = () => {
          const iframe = frameHost.current?.querySelector('iframe');
          if (!iframe) return;
          const inject = () => {
            try {
              const doc = iframe.contentDocument;
              if (doc && (doc.head || doc.documentElement) && !doc.getElementById('buddy-hide-oo-logo')) {
                const style = doc.createElement('style');
                style.id = 'buddy-hide-oo-logo';
                style.textContent = '#header-logo, section.logo, .extra #header-logo, .brand-logo, .loader-logo, #id-about-licensor-logo { display: none !important; width: 0 !important; padding: 0 !important; margin: 0 !important; }';
                (doc.head || doc.documentElement).appendChild(style);
              }
            } catch { /* ignore cross-state timing */ }
          };
          inject();
          iframe.addEventListener('load', inject);
        };
        hideLogoInIframe();
      } catch (failure) { if (!cancelled) setError((failure as Error).message); }
    })();
    return () => { cancelled = true; alive.current = false; editor?.destroyEditor(); };
  }, [file.id, id, retry, editorLanguage]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const current = await request<OfficeFile>(`/files/${file.id}`);
        if (cancelled) return;
        setSaved(current); callbacks.current.onUpdated(current);
        if (current.save_error) setError(current.save_error);
      } catch { /* Explicit saves surface connectivity failures; polling retries. */ }
    };
    const timer = window.setInterval(() => { void poll(); }, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [file.id]);

  const save = async () => {
    if (saving || !canEdit) return;
    setSaving(true); setError(''); setMessage('Saving to Office Suite…');
    const startGeneration = generation.current;
    try {
      // The editor flushes text automatically; an active spreadsheet cell must be committed first.
      for (let attempt = 0; unsent.current && attempt < 20; attempt++) await new Promise(resolve => window.setTimeout(resolve, 250));
      if (unsent.current) throw new Error('Finish editing the current cell or paragraph, then save again. You can also use Save inside the editor.');
      const result = await request<{ pending: boolean; unchanged: boolean; receipt: string }>(`/files/${file.id}/save`, { method: 'POST' });
      if (result.unchanged) {
        if (dirty.current) throw new Error('The editor reports no new changes to save. Use Save inside the editor to finish syncing, then retry Save to Office Suite.');
        setMessage('No new changes to save'); return;
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        if (!alive.current) return;
        const current = await request<OfficeFile>(`/files/${file.id}`);
        if (current.save_error) throw new Error(current.save_error);
        if (current.save_receipt === result.receipt) {
          setSaved(current); callbacks.current.onUpdated(current);
          if (generation.current === startGeneration) {
            dirty.current = false; callbacks.current.onDirty(false);
            setMessage('Saved to Office Suite');
          } else setMessage('Saved · newer edits still need saving');
          return;
        }
      }
      throw new Error('Office Suite has not confirmed the save yet. Keep the document open and retry Save.');
    } catch (failure) { if (alive.current) { setError((failure as Error).message); setMessage('Save needs attention'); } }
    finally { if (alive.current) setSaving(false); }
  };

  return <div className="office-live-editor"><Toolbar className="office-editor-title"><div><WorkspaceBrand className="office-editor-brand" /><button onClick={onBack} aria-label={t('Back to file library')}>←</button><b className={`office-type ${kindOf(file)}`}>{letter(kindOf(file))}</b><strong>{saved.name}</strong>{!isOwner && <span className="office-access-badge">{t(canEdit ? 'Shared · Read & Write' : 'Shared · Read only')}</span>}</div><div><LanguageSelector />{file.extension === 'pptx' && <button disabled={!bridge.ready || saving || assistantBusy} onClick={() => { void bridge.present().catch(failure => setError((failure as Error).message)); }}>{t('Present')}</button>}{isOwner && onRename && <button disabled={saving || assistantBusy} onClick={() => onRename(saved)}>{t('Rename')}</button>}{isOwner && onShare && <button onClick={() => onShare(saved)}>{t('Share')}</button>}{isOwner && onDelete && <button className="office-delete-btn" disabled={saving || assistantBusy} onClick={() => onDelete(saved)}>{t('Delete')}</button>}<button className="office-bob-toggle" aria-expanded={assistantOpen} aria-controls="office-bob-panel" disabled={assistantBusy} onClick={() => setAssistantOpen(value => !value)}>{t('Ask Buddy')}</button><OfficeToNoteButton fileId={file.id} disabled={saving || assistantBusy} /><a className="office-download" href={`/api/office/files/${file.id}/download`}>{t('Download saved file')}</a>{canEdit && <button className="office-primary feature-primary" disabled={!ready || saving} onClick={() => void save()}>{t(saving ? 'Saving…' : 'Save to Office Suite')}</button>}<button onClick={onClose} disabled={saving} aria-label={t('Close Office Suite')}>✕</button></div></Toolbar>
    {(editorLanguage === 'hi' || editorLanguage === 'mt') && <div className="office-csv-options">{t('The editor ribbon uses English for this language.')}</div>}
    {file.extension === 'pdf' && canEdit && <div className="office-csv-options">{t('To create an interactive form, select Edit PDF, then open the Forms tab to add fields. Save to Office Suite before downloading your form.')}</div>}
    {language !== editorLanguage && <div className="office-csv-options">{t('Save your changes to apply the new editor language.')}</div>}
    {error && <div className="office-error" role="alert">{t(error)} {!ready && <button onClick={() => setRetry(value => value + 1)}>{t('Retry editor')}</button>}</div>}
    {!ready && !error && <div className="office-loading" role="status">{t('Opening your document…')}</div>}
    <div className="office-editor-workspace"><div ref={frameHost} className="office-editor-frame"><div id={id} /></div><div id="office-bob-panel" className="office-bob-panel" style={assistantOpen ? undefined : { display: 'none' }}><OfficeAssistant key={file.id} fileId={file.id} extension={file.extension} bridge={bridge} onBusy={setAssistantBusy} onApplied={() => { dirty.current = true; generation.current += 1; callbacks.current.onDirty(true); setMessage('Changes in editor · Save to Office Suite when ready'); }} /></div></div>
    <footer className="office-editor-status" aria-live="polite"><span>{t(message)}</span><span>{t('Last stored in Office Suite: {0}', [new Date(saved.saved_at).toLocaleString(getLocale())])}</span></footer>
  </div>;
}

export function OfficeSuite({ onClose, onAskFile }: { onClose: () => void; onAskFile?: (file: OfficeFile) => void }) {
  useLanguage();
  const [files, setFiles] = useState<OfficeFile[]>([]);
  const [folders, setFolders] = useState<OfficeFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [movingFile, setMovingFile] = useState<OfficeFile | null>(null);
  const [renamingFile, setRenamingFile] = useState<OfficeFile | null>(null);
  const [renameName, setRenameName] = useState('');
  const [fileMenu, setFileMenu] = useState<{ file: OfficeFile; position: OfficeMenuPosition } | null>(null);
  const [moveDestination, setMoveDestination] = useState<string | null>(null);
  const [selected, setSelected] = useState<OfficeFile | null>(null);
  const [sharingFile, setSharingFile] = useState<OfficeFile | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [createKind, setCreateKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [dirty, setDirty] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const routeEpoch = useRef(0);
  const routePath = useRef(window.location.pathname);
  const openFile = (file: OfficeFile) => { selectedRef.current = file; setSelected(file); setDirty(false); navigateOffice(`/office/files/${file.id}`); };
  useEffect(() => {
    let disposed = false;
    const sync = async () => {
      const route = parseOfficeRoute();
      if (!route) return;
      const epoch = ++routeEpoch.current;
      if (route.fileId && route.fileId === selectedRef.current?.id) { routePath.current = window.location.pathname; return; }
      if (dirtyRef.current && !await appConfirm(t('Close this editor? Use Save to Office Suite first to confirm your latest changes are stored. The document server will also attempt a final save after closing.'))) { navigateOffice(routePath.current, true); return; }
      if (disposed || epoch !== routeEpoch.current) return;
      setError(''); setDirty(false); setCreateKind(route.newKind === 'csv' ? 'excel' : (route.newKind ?? null)); setName('');
      routePath.current = window.location.pathname;
      if (!route.fileId) { selectedRef.current = null; setSelected(null); return; }
      try {
        const file = await request<OfficeFile>(`/files/${route.fileId}`);
        if (!disposed && epoch === routeEpoch.current) { selectedRef.current = file; setSelected(file); }
      } catch (failure) { if (!disposed && epoch === routeEpoch.current) { setSelected(null); setError((failure as Error).message); } }
    };
    void sync();
    window.addEventListener('popstate', sync); window.addEventListener('buddy-office-navigation', sync);
    return () => { disposed = true; window.removeEventListener('popstate', sync); window.removeEventListener('buddy-office-navigation', sync); };
  }, []);
  const updated = useCallback((file: OfficeFile) => {
    setFiles(current => current.map(item => item.id === file.id ? file : item));
    window.dispatchEvent(new Event('buddy-office-changed'));
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      let statusError = '';
      try { await request('/status'); setReady(true); } catch (failure) { setReady(false); statusError = (failure as Error).message; }
      const results = await Promise.allSettled([request<{ items: OfficeFile[] }>('/files'), request<{ items: OfficeFolder[] }>('/folders')]);
      if (results[0].status === 'fulfilled') setFiles(results[0].value.items);
      if (results[1].status === 'fulfilled') setFolders(results[1].value.items);
      const failures = results.filter(result => result.status === 'rejected');
      const messages = failures.map(result => result.status === 'rejected' ? String(result.reason?.message ?? result.reason) : '');
      if (statusError) messages.unshift(statusError);
      if (messages.length) setError(messages.join(' · '));
    } catch (failure) { setReady(false); setError((failure as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (selected) return;
    let stopped = false;
    let syncing = false;
    let pending = false;
    const syncLibrary = async () => {
      if (document.visibilityState === 'hidden') return;
      if (syncing) { pending = true; return; }
      syncing = true;
      try {
        const results = await Promise.allSettled([request<{ items: OfficeFile[] }>('/files'), request<{ items: OfficeFolder[] }>('/folders')]);
        if (stopped) return;
        if (results[0].status === 'fulfilled') setFiles(results[0].value.items);
        if (results[1].status === 'fulfilled') setFolders(results[1].value.items);
      } finally {
        syncing = false;
        if (pending && !stopped) { pending = false; void syncLibrary(); }
      }
    };
    void syncLibrary();
    const timer = window.setInterval(() => { void syncLibrary(); }, 15000);
    const resume = () => { void syncLibrary(); };
    window.addEventListener('focus', resume);
    window.addEventListener('buddy-office-changed', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('buddy-office-changed', resume); document.removeEventListener('visibilitychange', resume); };
  }, [selected]);

  const mutateFolder = async (path: string, method: string, body?: unknown) => {
    await request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await request<{ items: OfficeFolder[] }>('/folders'); setFolders(result.items);
  };
  const moveFile = async () => {
    if (!movingFile || busy) return; setBusy(true); setError('');
    try {
      await request(`/files/${movingFile.id}/folder`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_id: moveDestination }) });
      setFiles(current => current.map(file => file.id === movingFile.id ? { ...file, folder_id: moveDestination } : file)); setMovingFile(null);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const openRename = (file: OfficeFile) => {
    setError('');
    setRenamingFile(file);
    setRenameName(file.name);
  };
  const renameFile = async () => {
    if (!renamingFile || !renameName.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const updatedFile = await request<OfficeFile>(`/files/${renamingFile.id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameName.trim() }),
      });
      setFiles(current => current.map(file => file.id === updatedFile.id ? updatedFile : file));
      if (selectedRef.current?.id === updatedFile.id) {
        setSelected(updatedFile);
        selectedRef.current = updatedFile;
      }
      setRenamingFile(null);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const leave = useCallback(async (closeSuite = false) => {
    if (busy) return;
    if (dirty && !await appConfirm(t('Close this editor? Use Save to Office Suite first to confirm your latest changes are stored. The document server will also attempt a final save after closing.'))) return;
    setDirty(false);
    if (closeSuite) onClose(); else { selectedRef.current = null; setSelected(null); navigateOffice('/office'); }
  }, [dirty, busy, onClose]);
  const deleteFile = async (file: OfficeFile) => {
    if (busy) return;
    if (!await appConfirm(t('Delete "{0}" permanently from Office Suite?', [file.name]))) return;
    setBusy(true); setError('');
    try {
      await request(`/files/${file.id}`, { method: 'DELETE' });
      setFiles(current => current.filter(item => item.id !== file.id));
      if (selectedRef.current?.id === file.id) {
        setDirty(false); dirtyRef.current = false;
        selectedRef.current = null; setSelected(null); navigateOffice('/office');
      }
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => prior?.focus();
  }, []);
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { if (busy) return; if (renamingFile) setRenamingFile(null); else if (movingFile) setMovingFile(null); else if (sharingFile) setSharingFile(null); else if (uploadOpen) setUploadOpen(false); else if (createKind) { setCreateKind(null); if (parseOfficeRoute()?.newKind) navigateOffice('/office'); } else void leave(true); }
    if (event.key === 'Tab') {
      const scope = dialog.current?.querySelector('.office-upload') ?? dialog.current;
      const elements = scope?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not([hidden]),select,[tabindex="0"]');
      const visible = Array.from(elements ?? []).filter(element => element.getClientRects().length > 0);
      const first = visible[0], last = visible[visible.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const upload = async (incoming: FileList | null) => {
    if (!incoming || busy) return;
    setBusy(true); setError('');
    let completed = 0;
    try {
      for (const file of Array.from(incoming)) {
        if (!/\.(docx|xlsx|pptx|csv|pdf|html|htm)$/i.test(file.name)) throw new Error(`${file.name}: ${t('Choose DOCX, XLSX, PPTX, CSV, PDF, or HTML.')}`);
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name}: ${t('The maximum file size is 50 MB.')}`);
        setUploadStatus(t('Uploading {0}…', [file.name]));
        const data = new FormData(); data.append('file', file); if (folderId) data.append('folder_id', folderId);
        const saved = await request<OfficeFile>('/files', { method: 'POST', body: data });
        setFiles(current => [saved, ...current]); completed++;
      }
      setUploadStatus(t('{0} file(s) uploaded to Office Suite.', [completed]));
    } catch (failure) { setError((failure as Error).message); setUploadStatus(t('{0} file(s) uploaded. Remaining files were not uploaded.', [completed])); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (!createKind || !name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const file = await request<OfficeFile>('/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), kind: createKind, folder_id: folderId }) });
      setFiles(current => [file, ...current]); setCreateKind(null); openFile(file);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const matchesFilter = (file: OfficeFile, f: string) => (f === 'all' || f === 'mine') || (f === 'shared' ? file.is_owner === false : kindOf(file) === f);
  const visible = files.filter(file => matchesFilter(file, filter) && (filter === 'shared' || (file.is_owner === false ? filter !== 'mine' && folderId === null : (file.folder_id ?? null) === folderId)) && file.name.toLowerCase().includes(search.toLowerCase()));
  return <div className={`office-overlay ${selected && ['html', 'htm'].includes(selected.extension) ? 'office-overlay-html' : ''}`}><section ref={dialog} tabIndex={-1} onKeyDown={keyboard} className="office-suite buddy-surface" role="dialog" aria-modal="true" aria-label={t('Office Suite')}>
    <Toolbar as="header" className="office-top"><div className="office-brand"><div><WorkspaceBrand /><small>{t('Office Suite')} · {t('Your documents, one workspace')}</small></div></div><LanguageSelector /><span className="office-preview-badge">{t(ready ? 'Office Suite storage' : 'Connecting…')}</span><button disabled={busy} onClick={() => void leave(true)} aria-label={t('Close Office Suite')}>✕</button></Toolbar>
    <div className="office-body">{!selected && <aside className="office-sidebar"><span className="office-caption">{t('WORKSPACE')}</span><button className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setFolderId(null); setSearch(''); }}>▦ &nbsp; {t('All files')} <span>{files.length}</span></button><button className={filter === 'mine' ? 'active' : ''} onClick={() => { setFilter('mine'); setFolderId(null); setSearch(''); }}>▦ &nbsp; {t('My files')} <span>{files.filter(file => file.is_owner !== false).length}</span></button><button className={filter === 'shared' ? 'active' : ''} onClick={() => { setFilter('shared'); setFolderId(null); setSearch(''); }}>⇄ &nbsp; {t('Shared with me')} <span>{files.filter(f => f.is_owner === false).length}</span></button><span className="office-caption">{t('FILE TYPES')}</span>{(['word', 'excel', 'powerpoint', 'html', 'pdf'] as Kind[]).map(kind => <button key={kind} className={filter === kind ? 'active' : ''} onClick={() => { setFilter(kind); setFolderId(null); setSearch(''); }}><b className={`office-type ${kind}`}>{letter(kind)}</b>{t(kind === 'html' ? 'HTML presentations' : kind === 'pdf' ? 'PDF documents' : kind === 'word' ? 'Word documents' : kind === 'powerpoint' ? 'PowerPoint presentations' : 'Excel workbooks')}</button>)}<div className="office-storage"><span>☁ &nbsp; {t('Office Suite storage')}</span><strong>{t(ready ? 'Connected' : 'Unavailable')}</strong><p>{t('Private files for your account. Uploaded documents and saved edits are stored in Office Suite.')}</p></div></aside>}
    <section aria-label={t("Office documents")} className={`office-content ${selected ? 'office-content-editing' : ''}`}>
    {selected ? (['html', 'htm'].includes(selected.extension) ? <OfficeHtmlEditor key={selected.id} file={selected} onBack={() => void leave()} onClose={() => void leave(true)} onDirty={setDirty} onUpdated={updated} onRename={f => openRename(f as unknown as OfficeFile)} /> : <OfficeEditor key={selected.id} file={selected} onBack={() => void leave()} onClose={() => void leave(true)} onDirty={setDirty} onUpdated={updated} onRename={f => openRename(f)} onShare={f => setSharingFile(f)} onDelete={f => void deleteFile(f)} />) : <>
      <div className="office-heading"><div><span className="office-caption">{t('YOUR PERSONAL OFFICE')}</span><h1>{t('Room for your next idea.')}</h1><p>{t('Documents, spreadsheets, presentations, and PDFs. All in one place.')}</p></div><button className="office-primary feature-primary" disabled={!ready || busy} onClick={() => { setError(''); setUploadStatus(''); setUploadOpen(true); }}>↑ &nbsp; {t('Upload files')}</button></div>
      {error && !uploadOpen && !createKind && <div className="office-error" role="alert">{t(error)} <button onClick={() => void refresh()}>{t('Retry connection')}</button></div>}
      <div className="office-create">{(['word', 'excel', 'powerpoint', 'pdf', 'form'] as Kind[]).map(kind => <button key={kind} disabled={!ready || busy} onClick={() => { setError(''); setName(''); setCreateKind(kind); navigateOffice(`/office/new/${kind}`); }}><b className={`office-type ${kind}`}>{letter(kind)}</b><strong>{t(kind === 'form' ? 'Fillable form' : kind === 'pdf' ? 'PDF document' : kind === 'word' ? 'Word document' : kind === 'powerpoint' ? 'PowerPoint presentation' : 'Excel workbook')}</strong><small>{t(kind === 'form' ? 'Create interactive PDF forms' : kind === 'pdf' ? 'Edit, annotate, and fill forms' : kind === 'word' ? 'Write, format, and review' : kind === 'powerpoint' ? 'Design slides, decks, and pitches' : 'Calculate, analyze, and visualize')}</small><span>{t('Create new →')}</span></button>)}</div>
      {filter !== 'shared' && <OfficeFolderBrowser folders={folders} current={folderId} onSelect={id => { setFolderId(id); setSearch(''); }} mutate={mutateFolder} />}
      <Toolbar className="office-library-tools"><div role="group" aria-label={t('File type filter')}>{['all', 'word', 'excel', 'powerpoint', 'html', 'pdf', 'shared'].map(kind => <button key={kind} aria-pressed={filter === kind} className={filter === kind ? 'active' : ''} onClick={() => { setFilter(kind); if (kind === 'shared') { setFolderId(null); setSearch(''); } }}>{t(kind === 'html' ? 'HTML presentations' : kind === 'pdf' ? 'PDF documents' : kind === 'all' ? 'All files' : kind === 'word' ? 'Documents' : kind === 'excel' ? 'Spreadsheets' : kind === 'powerpoint' ? 'Presentations' : 'Shared with me')}</button>)}</div><input aria-label={t('Search office files')} placeholder={t('Search your files…')} value={search} onChange={event => setSearch(event.target.value)} /><button disabled={loading} onClick={() => void refresh()} aria-label={t('Refresh office files')}>↻</button></Toolbar>
      <table className="office-file-table"><thead><tr><th>{t('Name')}</th><th>{t('Type')}</th><th>{t('Access')}</th><th>{t('Size')}</th><th>{t('Saved to Office Suite')}</th><th>{t('Actions')}</th></tr></thead><tbody>{visible.map(file => <tr key={file.id} onContextMenu={event => { event.preventDefault(); setFileMenu({ file, position: { x: event.clientX, y: event.clientY, returnFocus: event.currentTarget.querySelector('button') } }); }}><td><b className={`office-type ${kindOf(file)}`}>{letter(kindOf(file))}</b><button className="office-file-name" onClick={() => openFile(file)}>{file.name}</button></td><td>{file.extension.toUpperCase()}</td><td>{file.is_owner === false ? <span className="office-access-badge">{t(file.access === 'write' ? 'Read & Write' : 'Read only')} · {file.owner_display || file.owner}</span> : (file.share_count ? <span className="office-access-badge">{t('Shared ({0})', [file.share_count])}</span> : t('Owner'))}</td><td>{(file.size / 1024).toFixed(1)} KB</td><td>{new Date(file.saved_at).toLocaleString(getLocale())}</td><td className="office-row-actions"><OfficeToNoteButton fileId={file.id} disabled={busy} /><button aria-label={`${t('Actions')}: ${file.name}`} aria-haspopup="menu" aria-expanded={fileMenu?.file.id === file.id} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setFileMenu({ file, position: { x: box.left, y: box.bottom, returnFocus: event.currentTarget } }); }}>⋯</button></td></tr>)}</tbody></table>
      {loading ? <div className="office-empty" role="status">{t('Loading your Office library…')}</div> : !visible.length && (filter === 'shared' || !folders.some(folder => folder.parent_id === folderId)) && <div className="office-empty"><span>▤</span><h2>{t(files.length ? 'No matching files' : 'A fresh workspace')}</h2><p>{t(files.length ? 'Try another search or file type.' : 'Upload your first document or create a new one. Your files are private to your account.')}</p>{!files.length && <button disabled={!ready} onClick={() => { setUploadStatus(''); setUploadOpen(true); }}>{t('Choose your first file')}</button>}</div>}
    </>}
    </section></div>
    {fileMenu && <OfficeItemMenu position={fileMenu.position} onClose={() => setFileMenu(null)} actions={[
      { label: t('Open →'), run: () => openFile(fileMenu.file) },
      ...(onAskFile ? [{ label: t('Use in Buddy chat'), run: () => onAskFile(fileMenu.file), disabled: busy }] : []),
      ...(fileMenu.file.is_owner !== false ? [
        { label: t('Rename'), run: () => openRename(fileMenu.file), disabled: busy },
        { label: t('Share'), run: () => setSharingFile(fileMenu.file), disabled: busy },
        { label: t('Move'), run: () => { setMovingFile(fileMenu.file); setMoveDestination(fileMenu.file.folder_id ?? null); setError(''); }, disabled: busy },
      ] : []),
      { label: t('Download'), run: () => { const link = document.createElement('a'); link.href = `/api/office/files/${fileMenu.file.id}/download`; link.download = fileMenu.file.name; link.click(); } },
      ...(fileMenu.file.is_owner !== false ? [{ label: t('Delete'), danger: true, disabled: busy, run: () => { void deleteFile(fileMenu.file); } }] : []),
    ]} />}
    {movingFile && <div className="office-upload-shade"><form className="office-upload office-folder-dialog" role="dialog" aria-modal="true" aria-label={t('Move file')} onSubmit={event => { event.preventDefault(); void moveFile(); }}><h2>{t('Move file')}</h2><p>{movingFile.name}</p><label>{t('Destination folder')}<OfficeFolderDestination folders={folders} value={moveDestination} onChange={setMoveDestination} /></label>{error && <div className="office-error" role="alert">{error}</div>}<div className="office-folder-dialog-actions"><button disabled={busy} type="button" onClick={() => setMovingFile(null)}>{t('Cancel')}</button><button type="submit" disabled={busy} className="office-primary">{t(busy ? 'Saving…' : 'Move')}</button></div></form></div>}
    {renamingFile && <div className="office-upload-shade"><form className="office-upload office-folder-dialog" role="dialog" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) setRenamingFile(null); } }} aria-modal="true" aria-label={t('Rename file')} onSubmit={event => { event.preventDefault(); void renameFile(); }}><h2>{t('Rename file')}</h2><p>{renamingFile.name}</p><label>{t('New filename')}<input autoFocus required maxLength={190} value={renameName} onChange={event => setRenameName(event.target.value)} /></label>{error && <div className="office-error" role="alert">{error}</div>}<div className="office-folder-dialog-actions"><button disabled={busy} type="button" onClick={() => setRenamingFile(null)}>{t('Cancel')}</button><button type="submit" disabled={busy || !renameName.trim()} className="office-primary">{t(busy ? 'Saving…' : 'Save')}</button></div></form></div>}
    {sharingFile && <OfficeShareModal file={sharingFile} onClose={() => setSharingFile(null)} onUpdated={() => void refresh()} />}
    {(uploadOpen || createKind) && <div className="office-upload-shade"><section className="office-upload" role="dialog" aria-modal="true" aria-label={t(uploadOpen ? 'Upload office files' : 'Create office file')}><button disabled={busy} className="office-upload-close" onClick={() => { setUploadOpen(false); setCreateKind(null); if (parseOfficeRoute()?.newKind) navigateOffice('/office'); }} aria-label={t('Close file dialog')}>✕</button><span className="office-caption">{t('YOUR PRIVATE WORKSPACE')}</span><h2>{t(uploadOpen ? 'Upload to your office' : createKind === 'form' ? 'New fillable form' : createKind === 'pdf' ? 'New PDF' : createKind === 'word' ? 'New document' : createKind === 'powerpoint' ? 'New presentation' : 'New workbook')}</h2>
      {uploadOpen ? <><p>{t('Word documents, Excel workbooks, PowerPoint presentations, CSV files, PDFs, and HTML documents. Up to 50 MB each.')}</p><div className="office-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void upload(event.dataTransfer.files); }}><span>↑</span><strong>{t('Drop files here')}</strong><p>{t('DOCX, XLSX, PPTX, CSV, PDF, HTML')}</p><button autoFocus className="office-primary feature-primary" disabled={busy} onClick={() => input.current?.click()}>{t('Browse files')}</button><input ref={input} hidden type="file" accept=".docx,.xlsx,.pptx,.csv,.pdf,.html,.htm,text/html" multiple onChange={event => { void upload(event.target.files); event.target.value = ''; }} /></div><p role="status">{uploadStatus || t('Files are uploaded directly to your private Office Suite folder through Buddy.')}</p></> : <form onSubmit={event => { event.preventDefault(); void create(); }}><label className="office-new-name">{t('File name')}<input autoFocus required maxLength={190} value={name} onChange={event => setName(event.target.value)} placeholder={t(createKind === 'form' ? 'Untitled form' : createKind === 'pdf' ? 'Untitled PDF' : createKind === 'word' ? 'Untitled document' : createKind === 'powerpoint' ? 'Untitled presentation' : 'Untitled workbook')} /></label><p>{t(createKind === 'form' ? 'Create a PDF, then use the ONLYOFFICE Forms tab to add text fields, checkboxes, dropdowns, and other interactive fields.' : 'The file will be created in Office Suite and opened for editing.')}</p><button className="office-primary feature-primary" disabled={busy || !name.trim()} type="submit">{t(busy ? 'Creating…' : 'Create & open')}</button></form>}
      {error && <div className="office-error" role="alert">{t(error)}</div>}{uploadOpen && <button type="button" disabled={busy} onClick={() => setUploadOpen(false)}>{t('Done')}</button>}
    </section></div>}
  </section></div>;
}
