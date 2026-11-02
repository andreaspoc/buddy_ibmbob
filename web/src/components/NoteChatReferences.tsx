import { useEffect, useId, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
import './WorkspaceIntegration.css';

export type NoteReference = { id: number; title: string };
type ReferenceProps = { selected: NoteReference[]; onChange: (notes: NoteReference[]) => void; disabled: boolean };
export function NoteReferenceChips({ selected, onChange, disabled }: ReferenceProps) {
  useLanguage();
  return <>{selected.map(note => <span className="office-reference-chip note-reference-chip" key={note.id} title={note.title}><span>{note.title}</span><button type="button" disabled={disabled} aria-label={t('Remove reference {0}', [note.title])} onClick={() => onChange(selected.filter(item => item.id !== note.id))}>×</button></span>)}</>;
}

export function NoteChatReferences({ selected, onChange, disabled }: ReferenceProps) {
  useLanguage();
  const pickerId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (returnFocus = false) => { setOpen(false); if (returnFocus) trigger.current?.focus(); };
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => { setPage(null); setRevision(value => value + 1); };
    window.addEventListener('buddy-notes-changed', update);
    return () => window.removeEventListener('buddy-notes-changed', update);
  }, []);
  const [notes, setNotes] = useState<NoteReference[]>([]), [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [page, setPage] = useState<number | null>(null);
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
    void fetch(`/api/notes?limit=100${page ? `&before_id=${page}` : ''}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!controller.signal.aborted) { setNotes(previous => page ? [...previous, ...data.items] : data.items); setBefore(data.next_before_id ?? null); }
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load notes.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, open, page]);
  return <div ref={root} className="office-chat-references note-chat-references">
    <button ref={trigger} type="button" disabled={disabled} aria-label={`${t('Selected notes')} (${selected.length}/5)`} title={t('Select notes')} aria-expanded={open} aria-controls={pickerId} aria-haspopup="dialog" onClick={() => { setPage(null); setOpen(value => !value); }}><span aria-hidden="true">▤</span> {t('Selected notes')}{selected.length > 0 && <span className="reference-count" aria-hidden="true">{selected.length}</span>}</button>
    {open && <section id={pickerId} role="dialog" className="office-reference-picker" aria-label={t('Select notes')}>
      <label>{t('Search saved notes')}<input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label>
      {loading && <p role="status">{t('Loading…')}</p>}{error && <p role="alert">{t(error)}</p>}
      <div className="office-reference-results">{notes.filter(note => note.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(note => <label key={note.id}><input type="checkbox" checked={selected.some(item => item.id === note.id)} disabled={disabled || (selected.length >= 5 && !selected.some(item => item.id === note.id))} onChange={event => onChange(event.target.checked ? [...selected, { id: note.id, title: note.title }] : selected.filter(item => item.id !== note.id))} /><span>{note.title}</span></label>)}</div>
      {before && <button type="button" disabled={loading} onClick={() => setPage(before)}>{t('Load more')}</button>}
      <button type="button" onClick={() => close(true)}>{t('Done')}</button>
    </section>}
  </div>;
}
