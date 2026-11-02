import { WorkspaceBrand } from './WorkspaceSectionHeader';
import { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
import { useOfficeIntegrationAvailable } from '../lib/officeIntegration';
import { useDesktopWorkspace } from '../lib/workspaceDevice';
import { navigateOffice } from '../lib/officeUrl';
import { OfficeFolderDestination, type OfficeFolder } from './OfficeFolderBrowser';
import './WorkspaceIntegration.css';
import { useTransferFeedback } from '../lib/useTransferFeedback';

export function NotesToOfficeButton({ ids }: { ids: number[] }) {
  useLanguage();
  const available = useOfficeIntegrationAvailable(useDesktopWorkspace());
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<OfficeFolder[] | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [error, setError] = useState(''), [savedId, setSavedId] = useState('');
  const [snapshot, setSnapshot] = useState<number[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const transfer = useTransferFeedback();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFolders(null);
    void fetch('/api/office/folders', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load Office folders.');
      const result = await response.json(); setFolders(result.items ?? []);
    }).catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => controller.abort();
  }, [open]);
  if (!available) return null;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const save = async () => {
    if (busy || !folders || !snapshot.length) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/notes/office', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: snapshot, folder_id: destination }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not save to Office Suite.');
      setSavedId(result.id);
      window.dispatchEvent(new Event('buddy-office-changed'));
      transfer(trigger.current, t('{0} notes selected', [snapshot.length]), 'office');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <span className="save-office-control"><button ref={trigger} type="button" disabled={!ids.length} onClick={() => { setSnapshot([...ids]); setSavedId(''); setError(''); setDestination(null); setOpen(true); }}>{t('Copy selected notes to Office')}</button>
    {open && <span className="save-office-dialog" role="dialog" aria-label={t('Copy selected notes to Office')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); } }}>
      <span className="save-office-header"><WorkspaceBrand className="answer-frame-brand" /><strong>{t('{0} notes selected', [snapshot.length])}</strong><small>{t('Creates a Word document from the saved notes.')}</small></span>
      {!savedId && <label>{t('Destination folder')}<OfficeFolderDestination folders={folders ?? []} value={destination} onChange={setDestination} /></label>}
      {error && <span role="alert">{t(error)}</span>}
      {savedId ? <><span role="status">{t('Copy saved to Office Suite.')}</span><button type="button" onClick={() => { close(); navigateOffice(`/office/files/${savedId}`); }}>{t('Open in Office Suite')}</button></> : <button type="button" disabled={busy || !folders} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save copy')}</button>}
      <button autoFocus type="button" disabled={busy} onClick={close}>{t('Close')}</button>
    </span>}
  </span>;
}

export function OfficeToNoteButton({ fileId, disabled = false }: { fileId: string; disabled?: boolean }) {
  useLanguage();
  const trigger = useRef<HTMLButtonElement>(null);
  const transfer = useTransferFeedback();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [savedId, setSavedId] = useState<number | null>(null);
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(''); setSavedId(null);
    try {
      const response = await fetch('/api/notes/from-office', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not save note.');
      setSavedId(result.id); window.dispatchEvent(new Event('buddy-notes-changed'));
      transfer(trigger.current, result.title || t('Note saved.'), 'notes');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <span className="save-office-control"><button ref={trigger} type="button" disabled={disabled || busy} title={t('Copies text from the last saved Office version.')} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save text snapshot to Notes')}</button>{error && <span role="alert">{t(error)}</span>}{savedId && <span role="status">{t('Note saved.')} <a href={`/notes?note=${savedId}`}>{t('Open note')}</a></span>}</span>;
}
