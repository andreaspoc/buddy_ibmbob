import { WorkspaceBrand } from './WorkspaceSectionHeader';
import { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
import { useOfficeIntegrationAvailable } from '../lib/officeIntegration';
import { useDesktopWorkspace } from '../lib/workspaceDevice';
import { navigateOffice } from '../lib/officeUrl';
import { OfficeFolderDestination, type OfficeFolder } from './OfficeFolderBrowser';
import './WorkspaceIntegration.css';
import { useTransferFeedback } from '../lib/useTransferFeedback';
export function SaveToOfficeButton({ sessionId, path, disabled = false }: { sessionId: string; path: string; disabled?: boolean }) {
  useLanguage();
  const desktop = useDesktopWorkspace();
  const supported = /\.(docx|xlsx|pptx|csv|pdf|html|htm)$/i.test(path);
  const available = useOfficeIntegrationAvailable(desktop && supported);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [folderReady, setFolderReady] = useState(false);
  const [folders, setFolders] = useState<OfficeFolder[]>([]), [destination, setDestination] = useState<string | null>(null), [savedId, setSavedId] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const transfer = useTransferFeedback();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setLoading(true); setFolderReady(false); setError('');
    void fetch('/api/office/folders', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load Office folders.');
      const data = await response.json();
      if (!controller.signal.aborted) { setFolders(data.items ?? []); setFolderReady(true); }
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load Office folders.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);
  if (!available) return null;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const save = async () => {
    if (busy || loading || disabled || !folderReady || savedId) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/office/import-conversation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, path, folder_id: destination }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not save to Office Suite.');
      setSavedId(result.id);
      window.dispatchEvent(new Event('buddy-office-changed'));
      transfer(trigger.current, path.split('/').pop() || path, 'office');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <span className="save-office-control"><button ref={trigger} type="button" disabled={disabled} onClick={() => { setSavedId(''); setDestination(null); setOpen(true); }}>{t('Save a copy to Office Suite')}</button>
    {open && <span className="save-office-dialog" role="dialog" aria-label={t('Save a copy to Office Suite')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); } }}>
      <span className="save-office-header"><WorkspaceBrand className="answer-frame-brand" /><strong>{path.split('/').pop()}</strong><small>{t('Copy the saved version into your Office library.')}</small></span>
      {!savedId && <label>{t('Destination folder')}<OfficeFolderDestination folders={folders} value={destination} onChange={setDestination} /></label>}
      {error && <span role="alert">{t(error)}</span>}
      {savedId ? <><span role="status">{t('Copy saved to Office Suite.')}</span><button type="button" onClick={() => { close(); navigateOffice(`/office/files/${savedId}`); }}>{t('Open in Office Suite')}</button></> : <button type="button" disabled={busy || loading || disabled || !folderReady} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save copy')}</button>}
      <button autoFocus type="button" disabled={busy} onClick={close}>{t('Close')}</button>
    </span>}
  </span>;
}
