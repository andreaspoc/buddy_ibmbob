import { useEffect, useId, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
import { navigateOffice } from '../lib/officeUrl';
import './WorkspaceIntegration.css';

export type OfficeReference = { id: string; name: string; extension: string; folder_id?: string | null; is_owner?: boolean };
type ReferenceProps = { selected: OfficeReference[]; onChange: (files: OfficeReference[]) => void; disabled: boolean };
export function OfficeReferenceChips({ selected, onChange, disabled }: ReferenceProps) {
  useLanguage();
  return <>{selected.map(file => <span className="office-reference-chip office-desktop-reference" key={file.id} title={file.name}><button type="button" disabled={disabled} title={`${file.name} · ${t('Open in Office Suite')}`} onClick={() => navigateOffice(`/office/files/${file.id}`)}>{file.name}</button><button type="button" disabled={disabled} aria-label={t('Remove reference {0}', [file.name])} onClick={() => onChange(selected.filter(item => item.id !== file.id))}>×</button></span>)}</>;
}

export function OfficeChatReferences({ selected, onChange, disabled }: ReferenceProps) {
  useLanguage();
  const pickerId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (returnFocus = false) => { setOpen(false); if (returnFocus) trigger.current?.focus(); };
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => { setRevision(value => value + 1); };
    window.addEventListener('buddy-office-changed', update);
    return () => window.removeEventListener('buddy-office-changed', update);
  }, []);
  const [files, setFiles] = useState<OfficeReference[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    const picker = root.current?.querySelector<HTMLElement>('.office-reference-picker');
    if (picker) {
      const box = picker.getBoundingClientRect();
      const shift = box.right > window.innerWidth - 12 ? window.innerWidth - 12 - box.right : box.left < 12 ? 12 - box.left : 0;
      picker.style.marginLeft = `${shift}px`;
    }
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void fetch('/api/office/files', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load Office files.');
      const data = await response.json();
      if (!controller.signal.aborted) setFiles(data.items ?? []);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load Office files.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, open]);
  return <div ref={root} className="office-chat-references office-desktop-reference">
    <button ref={trigger} type="button" disabled={disabled} aria-label={t('Use Office files')} title={t('Use Office files')} aria-expanded={open} aria-controls={pickerId} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><span aria-hidden="true">▦</span> {t('Office files')}{selected.length > 0 && <span className="reference-count" aria-hidden="true">{selected.length}</span>}</button>
    {open && <section id={pickerId} role="dialog" className="office-reference-picker" aria-label={t('Office files for this conversation')}>
      <label>{t('Search Office files')}<input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label>
      <p>{t('Choose up to 3 files. Buddy reads their saved content; edits stay in Office Suite.')}</p>
      {loading && <p role="status">{t('Loading…')}</p>}{error && <p role="alert">{t(error)}</p>}
      <div className="office-reference-results">{files.filter(file => file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(file => <label key={file.id}><input type="checkbox" checked={selected.some(item => item.id === file.id)} disabled={disabled || (selected.length >= 3 && !selected.some(item => item.id === file.id))} onChange={event => onChange(event.target.checked ? [...selected, file] : selected.filter(item => item.id !== file.id))} /><span>{file.name}<small>{file.extension.toUpperCase()} · {t(file.is_owner === false ? 'Shared with me' : 'My files')}</small></span></label>)}</div>
      {!loading && !error && !files.length && <p>{t('No Office files yet.')}</p>}
      <button type="button" onClick={() => close(true)}>{t('Done')}</button>
    </section>}
  </div>;
}
