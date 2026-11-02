import { NoteGrid } from './NoteGrid';
import { Toolbar } from './Toolbar';
import { flyNoteToNotes } from '../lib/noteFlight';
import { NotesToOfficeButton } from './NotesOfficeTransfer';
import { EmailNote } from './EmailNote';
import { ShareToPeople } from './ShareToPeople';
import { NoteOptions } from './NoteOptions';
import { appConfirm } from './AppDialog';
import { useLanguage, getLanguage, getLocale, t } from '../lib/i18n';
import { NoteDetails } from './NoteDetails';
import { resolveNoteLinks, insertNoteLink } from '../lib/noteLinks';
import { enrichNote } from '../lib/noteEnrichment';
import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StickyNoteDraft } from '../lib/stickyNotes';
import './StickyNotes.css';
import './NoteWriting.css';
import { editNoteMarkdown, localNoteDate, noteHeadings, type NoteFormat } from '../lib/noteWriting';

type NoteSource = { title: string; url: string };
type SavedNote = StickyNoteDraft & { tags?: string[]; favorite?: boolean; sources?: NoteSource[]; id: number; created_at?: string; updated_at?: string; source_session_id?: string | null; source_message_id?: string | null; collection?: string; source_note_index?: number | null };
type EditorNote = StickyNoteDraft & { id?: number; collection: string; tags: string[]; favorite: boolean; sources: NoteSource[] };
type NotePage = { items: SavedNote[]; next_before_id?: number | null; default_collection?: string };
const colors = ['butter', 'rose', 'lavender', 'mint', 'sky'] as const;
const noteKey = (note: StickyNoteDraft) => JSON.stringify([note.title, note.body, note.color]);
async function getNotes(before?: number, signal?: AbortSignal): Promise<NotePage> {
  const response = await fetch(`/api/notes${before ? `?before_id=${before}` : ''}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(t("Your notes could not be loaded. Please try again."));
  return response.json();
}
function NoteText({ body, notes = [], onNavigate }: { body: string; notes?: SavedNote[]; onNavigate?: (note: SavedNote) => void }) {
  let content = body;
  for (const link of resolveNoteLinks(body, notes).reverse()) {
    if (!link.note) continue;
    const label = link.label.replace(/([\\`*_[\]<>])/g, '\\$1');
    content = content.slice(0, link.start) + `[${label}](#note-${link.note.id})` + content.slice(link.end);
  }
  return <div className="sticky-note-copy" onClick={event => {
    const anchor = (event.target as HTMLElement).closest('a');
    const match = anchor?.getAttribute('href')?.match(/^#note-(\d+)$/);
    if (match && onNavigate) { event.preventDefault(); const note = notes.find(item => item.id === Number(match[1])); if (note) onNavigate(note); }
  }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content, { async: false, breaks: true }) as string) }} />;
}
function NoteIcon({ kind = 'note' }: { kind?: 'note' | 'check' | 'save' | 'trash' | 'search' }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'check' ? <path d="m5 12 4 4L19 6" /> : kind === 'save' ? <><path d="M5 3h12l4 4v14H3V3h2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></> : kind === 'trash' ? <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></> : kind === 'search' ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></> : <><path d="M4 3h16v12l-6 6H4V3Z" /><path d="M14 21v-6h6M8 8h8M8 12h5" /></>}</svg>;
}

export function StickyNotes({ notes, sessionId, messageId, readOnly = false }: { notes: StickyNoteDraft[]; sessionId?: string; messageId?: string; readOnly?: boolean }) {
  useLanguage();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const draftNotes = useRef(notes);
  draftNotes.current = notes;
  const busy = useRef(new Set<string>());
  const flights = useRef(new Map<HTMLElement, Animation>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const active = flights.current;
    return () => { mounted.current = false; for (const [ghost, animation] of active) { animation.cancel(); ghost.remove(); } active.clear(); };
  }, []);
  useEffect(() => {
    if (readOnly) return;
    let currentRequest: AbortController | undefined;
    const refresh = async () => {
      // A late lookup from before a bulk save must not restore moved cards.
      currentRequest?.abort();
      const controller = new AbortController();
      currentRequest = controller;
      try {
        const found = new Set<string>();
        let before: number | undefined;
        do {
          const page = await getNotes(before, controller.signal);
          for (const note of page.items) if ((note.source_session_id || undefined) === sessionId) {
            if ((note.source_message_id || undefined) === messageId) {
              const original = note.source_note_index != null ? draftNotes.current[note.source_note_index] : undefined;
              found.add(original ? noteKey(original) : noteKey(note));
            } else {
              // A later conversational save uses that turn's provenance.
              for (const draft of draftNotes.current) if (draft.title.trim() === note.title.trim() && draft.body.trim() === note.body.trim()) found.add(noteKey(draft));
            }
          }
          before = page.next_before_id || undefined;
        } while (before && !controller.signal.aborted);
        if (!controller.signal.aborted) setSaved(previous => new Set([...previous, ...found].filter(key => {
          const card = [...document.querySelectorAll<HTMLElement>('[data-sticky-notes] [data-note-key]')].find(card => card.dataset.noteKey === key && card.dataset.noteMessage === messageId);
          return previous.has(key) || !card?.hasAttribute('data-note-flight-queued');
        })));
      } catch { /* Saving retries lookup and reports an actionable error. */ }
    };
    void refresh();
    window.addEventListener('buddy-notes-changed', refresh);
    return () => { currentRequest?.abort(); window.removeEventListener('buddy-notes-changed', refresh); };
  }, [sessionId, messageId, readOnly]);
  useEffect(() => {
    const moved = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId === sessionId && detail?.messageId === messageId && typeof detail?.key === 'string') {
        setSaved(previous => new Set([...previous, detail.key]));
      }
    };
    window.addEventListener('buddy-note-moved', moved);
    return () => window.removeEventListener('buddy-note-moved', moved);
  }, [sessionId, messageId]);
  async function save(note: StickyNoteDraft, card: HTMLElement | null) {
    const key = noteKey(note);
    if (busy.current.has(key) || saved.has(key)) return;
    busy.current.add(key); setPending(new Set(busy.current)); setErrors(previous => ({ ...previous, [key]: '' }));
    card?.setAttribute('data-note-flight-queued', '');
    try {
      // Resolve existing copies before saving, including after a component remount.
      let before: number | undefined;
      let exists = false;
      do {
        const page = await getNotes(before);
        exists = page.items.some(item => (item.source_session_id || undefined) === sessionId && item.title === note.title && item.body === note.body) || page.items.some(item => (item.source_note_index != null ? item.source_note_index === notes.indexOf(note) : noteKey(item) === key) && (item.source_session_id || undefined) === sessionId && (item.source_message_id || undefined) === messageId);
        before = page.next_before_id || undefined;
      } while (before && !exists);
      if (!exists) {
        const response = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...note, source_session_id: sessionId, source_message_id: messageId, source_note_index: notes.indexOf(note) }) });
        if (!response.ok) throw new Error(t("This note could not be saved. Please try again."));
      }
      try { await flyNoteToNotes(card, flights.current); } catch { /* A saved note stays saved if decorative feedback fails. */ }
      if (!mounted.current) return;
      setSaved(previous => new Set([...previous, key]));
      window.dispatchEvent(new Event('buddy-notes-changed'));
    } catch (error) { setErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : t("Could not save note.") })); }
    finally { card?.removeAttribute('data-note-flight-queued'); busy.current.delete(key); if (mounted.current) setPending(new Set(busy.current)); }
  }
  const remaining = readOnly ? notes : notes.filter(note => !saved.has(noteKey(note)));
  if (!readOnly && notes.length > 0 && remaining.length === 0) return <div className="sticky-notes-moved" role="status" data-notes-moved><span className="sticky-notes-moved-icon"><NoteIcon kind="check" /></span><div><strong>{t("All notes moved to My Notes.")}</strong><span>{t("You can find and organize them in the Notes tab.")}</span></div></div>;
  return <section className="sticky-notes" data-sticky-notes aria-label={t("Sticky notes")}>
    <div className="sticky-notes-heading"><span><NoteIcon /> {t("Notes to keep")}</span><small>{readOnly ? t("From this conversation") : t("Tell Buddy which notes to save and where.")}</small></div>
    <NoteGrid>{remaining.map((note, index) => { const key = noteKey(note); return <article className="sticky-note" data-note-color={note.color} data-note-title={note.title} data-note-key={key} data-note-session={sessionId} data-note-message={messageId} key={key} style={{ animationDelay: `${Math.min(index, 8) * 65}ms` }}>
      <span className="sticky-note-pin" aria-hidden="true" /><div className="sticky-note-topline"><span className="sticky-note-number">{t("NOTE")} {String(index + 1).padStart(2, '0')}</span><NoteIcon /></div>
      <h3>{note.title}</h3><NoteText body={note.body} />
      {!readOnly && <div className="sticky-note-footer"><button type="button" className={`sticky-note-save ${saved.has(key) ? 'is-saved' : ''}`} onClick={event => void save(note, event.currentTarget.closest<HTMLElement>('.sticky-note'))} disabled={pending.has(key) || saved.has(key)} data-note-save><NoteIcon kind={saved.has(key) ? 'check' : 'save'} />{saved.has(key) ? t("Saved to Notes") : pending.has(key) ? t("Saving…") : t("Save to Notes")}</button>{errors[key] && <p className="sticky-note-error" role="alert">{errors[key]}</p>}</div>}
    </article>; })}</NoteGrid>
  </section>;
}

export function NotesWorkspace({ onBack }: { onBack: () => void }) {
  useLanguage();
  const [notes, setNotes] = useState<SavedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('favorites');
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [color, setColor] = useState('all');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [sharingNote, setSharingNote] = useState<SavedNote | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const refresh = () => setRetry(value => value + 1);
    window.addEventListener('buddy-notes-changed', refresh);
    return () => window.removeEventListener('buddy-notes-changed', refresh);
  }, []);
  const [collection, setCollection] = useState<string | null>(null);
  const [defaultCollection, setDefaultCollection] = useState('');
  const [editing, setEditing] = useState<EditorNote | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [metadataBusy, setMetadataBusy] = useState<Set<number>>(new Set());
  const [emailNote, setEmailNote] = useState<SavedNote | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const bulkRequest = useRef<AbortController | null>(null);
  useEffect(() => () => bulkRequest.current?.abort(), []);
  const [editorTab, setEditorTab] = useState<'write' | 'preview'>('write');
  const [slashPosition, setSlashPosition] = useState<number | null>(null);
  const [editorError, setEditorError] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichInstruction, setEnrichInstruction] = useState("Add useful detail and clarify the key points while preserving the original meaning.");
  const [enrichStatus, setEnrichStatus] = useState('');
  const [enrichError, setEnrichError] = useState('');
  const [proposal, setProposal] = useState<{title: string; body: string} | null>(null);
  const [revisionApplied, setRevisionApplied] = useState(false);
  const enrichment = useRef<AbortController | null>(null);
  useEffect(() => () => enrichment.current?.abort(), []);
  function stopEnrichment() { enrichment.current?.abort(); enrichment.current = null; setEnrichStatus(''); }
  const editorBaseline = useRef('');
  const editorBody = useRef<HTMLTextAreaElement>(null);
  const draftKey = (note: EditorNote, tags: string) => JSON.stringify([note.title, note.body, note.color, note.collection, tags, note.favorite, note.sources]);
  const hasUnsavedChanges = () => !!editing && draftKey(editing, tagsText) !== editorBaseline.current;
  async function closeEditor() {
    if (editorSaving) return;
    if ((hasUnsavedChanges() || proposal) && !await appConfirm(t('Discard unsaved changes?'))) return;
    stopEnrichment(); setEditing(null);
    const url = new URL(window.location.href); url.pathname='/notes'; url.searchParams.delete('note'); window.history.pushState({...window.history.state}, '', url);
  }
  function formatNote(format: NoteFormat) {
    if (!editing || editorSaving || enrichStatus) return;
    const field = editorBody.current;
    const body = slashPosition === null ? editing.body : editing.body.slice(0,slashPosition) + editing.body.slice(slashPosition+1);
    const result = editNoteMarkdown(body, slashPosition ?? field?.selectionStart ?? body.length, slashPosition ?? field?.selectionEnd ?? body.length, format, t('Text'));
    if (result.body.length > 6000) { setEditorError(t('Formatting would exceed the 6,000 character limit.')); return; }
    setEditing({...editing, body: result.body}); setEditorTab('write'); setSlashPosition(null);
    requestAnimationFrame(() => { editorBody.current?.focus(); editorBody.current?.setSelectionRange(result.start,result.end); });
  }
  async function applyTemplate(template: string) {
    if (!editing || editorSaving || enrichStatus) return;
    if ((editing.title || editing.body) && !await appConfirm(t('Replace this draft with a template?'))) return;
    const sections = template === 'meeting' ? [t('Agenda'), t('Discussion'), t('Decisions'), t('Next steps')] : [t('Goals'), t('Plan'), t('Progress'), t('Open questions')];
    setEditing({...editing, title: t(template === 'meeting' ? 'Meeting notes' : 'Project notes'), body: sections.map(title => `## ${title}\n\n`).join('\n')}); setEditorTab('write'); setSlashPosition(null);
  }
  function openDailyNote() {
    const date = localNoteDate();
    const existing = notes.find(note => note.tags?.includes(`daily:${date}`) || (note.tags?.includes('daily') && note.title.endsWith(date)));
    if (existing) { openEditor(existing); return; }
    openEditor();
    setEditing({title: `${t('Daily note')} · ${date}`, body: [t('Priorities'), t('Notes'), t('Reflection')].map(title => `## ${title}\n\n`).join('\n'), color:'butter', collection:t('Daily notes'), tags:['daily',`daily:${date}`], favorite:false, sources:[]});
    setTagsText(`daily, daily:${date}`);
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (hasUnsavedChanges() || proposal) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing, tagsText, proposal]);
  useEffect(() => { if (slashPosition !== null && editing?.body[slashPosition] !== '/') setSlashPosition(null); }, [editing?.body, slashPosition]);
  async function requestEnrichment() {
    if (!editing || enrichment.current) return;
    if (!editing.title.trim() || !editing.body.trim() || !enrichInstruction.trim()) { setEnrichError(t("Add note content and tell Bob how to improve it.")); return; }
    const controller = new AbortController(); enrichment.current = controller;
    setEnrichError(''); setProposal(null); setRevisionApplied(false); setEnrichStatus(t("Asking Bob…"));
    try {
      const revision = await enrichNote(editing, t(enrichInstruction), { signal: controller.signal, onStatus: status => { if (!controller.signal.aborted) setEnrichStatus(status); } });
      if (!controller.signal.aborted) setProposal(revision);
    } catch (error) { if (!controller.signal.aborted) setEnrichError(error instanceof Error ? error.message : t("Bob could not revise this note. Please try again.")); }
    finally { if (enrichment.current === controller) { enrichment.current = null; setEnrichStatus(''); } }
  }
  const openedLinkedNote = useRef(false);
  useEffect(() => {
    if (loading || openedLinkedNote.current) return;
    const id = /^\/notes\/([1-9]\d*)\/?$/.exec(window.location.pathname)?.[1] || new URLSearchParams(window.location.search).get('note');
    if (window.location.pathname === '/notes/new') { openedLinkedNote.current = true; openEditor(); return; }
    if (!id || !/^[1-9]\d*$/.test(id)) return;
    openedLinkedNote.current = true;
    const note = notes.find(item => item.id === Number(id));
    if (note) openEditor(note);
    else setError(t('Note not found'));
  }, [loading, notes]);
  useEffect(() => {
    const sync = () => {
      if (hasUnsavedChanges()) return;
      const match = /^\/notes\/([1-9]\d*)\/?$/.exec(window.location.pathname);
      if (match) { const note=notes.find(item=>item.id===Number(match[1])); if (note) openEditor(note); }
      else if (window.location.pathname === '/notes/new') openEditor();
      else if (window.location.pathname === '/notes') { stopEnrichment(); setEditing(null); }
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [notes, editing, tagsText, proposal]);
  const editorDialog = useRef<HTMLDialogElement>(null);
  const editorTitle = useRef<HTMLInputElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const collections = [...new Set(notes.map(note => note.collection || '').filter(Boolean))].sort((a, b) => { const dateA = /^\d{4}-\d{2}-\d{2}$/.test(a); const dateB = /^\d{4}-\d{2}-\d{2}$/.test(b); return dateA && dateB ? b.localeCompare(a) : dateA !== dateB ? (dateA ? 1 : -1) : a.localeCompare(b); });
  useEffect(() => {
    if (editing) { if (!editorDialog.current?.open) editorDialog.current?.showModal(); editorTitle.current?.focus(); }
    else { editorDialog.current?.close(); editorOpener.current?.focus(); }
  }, [Boolean(editing)]);
  function openEditor(note?: SavedNote, withBob = false) {
    const url = new URL(window.location.href);
    if (url.pathname.startsWith('/notes')) {
      url.pathname = note ? `/notes/${note.id}` : '/notes/new'; url.searchParams.delete('note');
      if (url.href !== window.location.href) window.history.pushState({...window.history.state}, '', url);
    }
    if (!editorDialog.current?.open) editorOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stopEnrichment(); setEnrichOpen(withBob); setProposal(null); setEnrichError(''); setRevisionApplied(false);
    setEditorError(''); setEditorTab('write'); setSlashPosition(null);
    setEditing(note ? { id: note.id, title: note.title, body: note.body, color: note.color, collection: note.collection || '', tags: note.tags || [], favorite: Boolean(note.favorite), sources: note.sources || [] } : { title: '', body: '', color: 'butter', collection: collection ?? defaultCollection, tags: [], favorite: false, sources: [] });
    setTagsText((note?.tags || []).join(', '));
    const draft: EditorNote = note ? {id:note.id,title:note.title,body:note.body,color:note.color,collection:note.collection || '',tags:note.tags || [],favorite:Boolean(note.favorite),sources:note.sources || []} : {title:'',body:'',color:'butter',collection:collection ?? defaultCollection,tags:[],favorite:false,sources:[]};
    editorBaseline.current = draftKey(draft, (note?.tags || []).join(', '));
  }
  async function saveEditor() {
    if (!editing || editorSaving || enrichStatus || proposal) return;
    if (!editing.title.trim() || !editing.body.trim()) { setEditorError(t("Add a title and some note content before saving.")); return; }
    const tags = [...new Set(tagsText.split(',').map(tag => tag.trim()).filter(Boolean))];
    if (tags.length > 20 || tags.some(tag => tag.length > 40)) { setEditorError(t('Use up to 20 tags, each at most 40 characters.')); return; }
    const sources = editing.sources.filter(source => source.url.trim()).map(source => ({ title: source.title.trim() || source.url.trim(), url: source.url.trim() }));
    setEditorSaving(true); setEditorError('');
    try {
      const response = await fetch(editing.id ? `/api/notes/${editing.id}` : '/api/notes', { method: editing.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: editing.title.trim(), body: editing.body.trim(), color: editing.color, collection: editing.collection.trim(), tags, favorite: editing.favorite, sources }) });
      if (!response.ok) throw new Error(t("Your changes could not be saved. Please try again."));
      const savedNote = await response.json() as SavedNote;
      setNotes(previous => editing.id ? previous.map(note => note.id === savedNote.id ? savedNote : note) : [savedNote, ...previous]);
      setCollection(savedNote.collection || ''); setEditing(null);
      const url = new URL(window.location.href); url.pathname='/notes'; url.searchParams.delete('note'); window.history.pushState({...window.history.state}, '', url);
      window.dispatchEvent(new Event('buddy-notes-changed'));
    } catch (e) { setEditorError(e instanceof Error ? e.message : t("Could not save note.")); }
    finally { setEditorSaving(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void (async () => {
      try {
        const all: SavedNote[] = []; let before: number | undefined;
        do { const page = await getNotes(before, controller.signal); all.push(...page.items); if (page.default_collection && !controller.signal.aborted) setDefaultCollection(page.default_collection); before = page.next_before_id || undefined; } while (before && !controller.signal.aborted);
        if (!controller.signal.aborted) setNotes(all);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t("Could not load notes.")); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [retry]);
  async function deleteNote(id: number) {
    if (deleting !== null) return;
    setDeleting(id); setError('');
    try {
      const response = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(t("This note could not be deleted. Please try again."));
      setRemoving(id);
      setTimeout(() => { setNotes(previous => previous.filter(note => note.id !== id)); setSelected(previous=>{const next=new Set(previous);next.delete(id);return next;}); setRemoving(null); setDeleting(null); setConfirming(null); }, 220);
      window.dispatchEvent(new Event('buddy-notes-changed'));
    } catch (e) { setError(e instanceof Error ? e.message : t("Could not delete note.")); setDeleting(null); }
  }
  const allTags = [...new Set(notes.flatMap(note => note.tags || []))].sort((a, b) => a.localeCompare(b));
  async function toggleFavorite(note: SavedNote) {
    if (metadataBusy.has(note.id)) return;
    setMetadataBusy(previous => new Set([...previous, note.id]));
    try {
      const response = await fetch(`/api/notes/${note.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({favorite: !note.favorite}) });
      if (!response.ok) throw new Error(t('Could not update favorite. Please try again.'));
      const updated = await response.json() as SavedNote;
      setNotes(previous => previous.map(item => item.id === note.id ? updated : item));
      window.dispatchEvent(new Event('buddy-notes-changed'));
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not update favorite. Please try again.')); }
    finally { setMetadataBusy(previous => { const next = new Set(previous); next.delete(note.id); return next; }); }
  }
  async function navigateNote(note: SavedNote) {
    if ((hasUnsavedChanges() || proposal) && !await appConfirm(t('Discard unsaved changes and open the linked note?'))) return;
    openEditor(note);
  }
  async function exportNotes(format: 'markdown' | 'pdf') {
    const ids = selected.size ? [...selected] : visible.map(note => note.id);
    if (!ids.length || exporting) return;
    if (ids.length > 100) { setError(t('Export up to 100 notes at a time. Narrow your search or select fewer notes.')); return; }
    setExporting(true); setError('');
    try {
      const response = await fetch(`/api/notes/export?format=${format}&language=${getLanguage()}&ids=${ids.join(',')}`);
      if (!response.ok) { const failure = await response.json().catch(() => null); throw new Error(typeof failure?.detail === 'string' ? t(failure.detail) : t('Could not export notes. Please try again.')); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `notes.${format === 'pdf' ? 'pdf' : 'md'}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not export notes. Please try again.')); }
    finally { setExporting(false); }
  }
  async function askAboutSelection(action: 'summarize' | 'compare' | 'actions') {
    const chosen = notes.filter(note => selected.has(note.id));
    if (!chosen.length || bulkRequest.current) return;
    const body = chosen.map(note => `${insertNoteLink(note)}\n${note.body}\n${(note.sources || []).map(source => `[${source.title}](${source.url})`).join('\n')}`).join('\n\n---\n\n');
    if (JSON.stringify(body).length > 14000) { setError(t('Select fewer or shorter notes for Bob.')); return; }
    const controller = new AbortController(); bulkRequest.current = controller; setBulkStatus(t('Asking Bob…')); setError('');
    const instruction = action === 'summarize' ? t("Synthesize these selected notes into one concise useful summary. Preserve the stable note links so the reader can return to the originals.") : action === 'compare' ? t("Compare the selected notes: agreements, differences, tradeoffs and uncertainties. Preserve stable note links and real source links.") : t("Build an actionable plan from the selected notes. Distinguish agreed decisions from proposed steps. Do not invent owners, dates or completion. Preserve stable note links.");
    try {
      const revision = await enrichNote({title:t("Selected notes"), body}, instruction, {signal:controller.signal,onStatus:status=>{if(!controller.signal.aborted)setBulkStatus(status);}});
      if (!controller.signal.aborted) { openEditor(); setEditing({ ...revision, color:'lavender', collection:collection ?? defaultCollection, tags:[], favorite:false, sources:[] }); setTagsText(''); setEditorTab('preview'); setRevisionApplied(true); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t('Could not revise selected notes.')); }
    finally { if (bulkRequest.current === controller) { bulkRequest.current = null; setBulkStatus(''); } }
  }
  const searchTerms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searching = searchTerms.length > 0;
  const visible = notes.filter(note => {
    if (!searching) return (collection === null || (note.collection || '') === collection) && (color === 'all' || note.color === color) && (!favoriteOnly || note.favorite) && (!tagFilter || note.tags?.includes(tagFilter));
    const date = note.created_at ? new Date(note.created_at) : null;
    const dateText = date && Number.isFinite(date.getTime()) ? `${date.toLocaleDateString(getLocale())} ${date.toLocaleDateString(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}` : '';
    const text = `${note.title} ${note.body} ${note.collection || t("Inbox")} ${note.created_at || ''} ${dateText} ${(note.tags || []).join(' ')} ${(note.sources || []).map(source => source.title + ' ' + source.url).join(' ')}`.toLocaleLowerCase();
    return searchTerms.every(term => text.includes(term));
  }).sort((a,b) => sort === 'title' ? a.title.localeCompare(b.title, getLocale()) : sort === 'oldest' ? a.id - b.id : sort === 'updated' ? (Date.parse(b.updated_at || b.created_at || '') || 0) - (Date.parse(a.updated_at || a.created_at || '') || 0) : sort === 'newest' ? b.id - a.id : Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.id - a.id);
  return <section className="notes-workspace" data-notes-workspace aria-label={t("Saved notes")}>
    <Toolbar as="header" className="notes-workspace-hero"><div className="notes-hero-copy"><button className="notes-back" type="button" onClick={onBack}>{t("← Back to chat")}</button><div className="notes-eyebrow">{t("BUDDY · PRIVATE NOTES")}</div><h1>{t("Small notes.")}<br /><span>{t("Ideas worth keeping.")}</span></h1><p>{t("A little space for the useful things you find along the way.")}</p><span className="notes-count">{loading ? t("Opening your collection…") : t(notes.length === 1 ? '{0} saved note' : '{0} saved notes', [notes.length])}</span></div><div className="notes-hero-art" aria-hidden="true"><div className="notes-art-back" /><div className="notes-art-front"><NoteIcon /><i /><i /><i /><span>{t("Keep the good stuff.")}</span></div></div></Toolbar>
    <div className="notes-library-layout"><nav className="notes-library-filters" aria-label={t("Note collections")}>
      <div className="notes-filter-group">
        <span className="notes-filter-label">{t("LIBRARY")}</span>
        <div className="notes-filter-buttons">
          <button type="button" aria-pressed={collection === null && !favoriteOnly && !tagFilter} onClick={() => { setCollection(null); setQuery(''); setFavoriteOnly(false); setTagFilter(null); }}><span>{t("All notes")}</span><small>{notes.length}</small></button>
          <button type="button" aria-pressed={collection === '' && !favoriteOnly && !tagFilter} onClick={() => { setCollection(''); setQuery(''); setFavoriteOnly(false); setTagFilter(null); }}><span>{t("Inbox")}</span><small>{notes.filter(note => !note.collection).length}</small></button>
          <button type="button" aria-pressed={favoriteOnly} onClick={() => { setFavoriteOnly(!favoriteOnly); setTagFilter(null); setQuery(''); setCollection(null); }}><span>{t("★ Favorites")}</span><small>{notes.filter(note => note.favorite).length}</small></button>
        </div>
      </div>
      {allTags.length > 0 && <div className="notes-filter-group"><span className="notes-filter-label">{t("TAGS")}</span><div className="notes-filter-buttons">{allTags.map(tag => <button key={tag} type="button" aria-pressed={tagFilter === tag} onClick={() => { setTagFilter(tagFilter === tag ? null : tag); setFavoriteOnly(false); setCollection(null); setQuery(''); }}><span>#{tag}</span></button>)}</div></div>}
      {collections.length > 0 && <div className="notes-filter-group"><span className="notes-filter-label">{t("COLLECTIONS")}</span><div className="notes-filter-buttons">{collections.map(name => <button key={name} type="button" aria-pressed={collection === name && !favoriteOnly && !tagFilter} onClick={() => { setCollection(name); setQuery(''); setFavoriteOnly(false); setTagFilter(null); }} title={name}><span>▱ {name}</span><small>{notes.filter(note => note.collection === name).length}</small></button>)}</div></div>}
    </nav><div className="notes-library-main"><Toolbar className="notes-library-title"><h2>{searching ? t("Search all notes") : favoriteOnly ? t("Favorites") : tagFilter ? '#' + tagFilter : collection === null ? t("All notes") : collection || t("Inbox")}</h2><button type="button" className="notes-daily" disabled={loading} onClick={openDailyNote}>{t("Daily note")}</button><button type="button" className="notes-new" onClick={() => openEditor()} data-note-new>{t("＋ New note")}</button></Toolbar><Toolbar className="notes-toolbar"><label className="notes-search"><NoteIcon kind="search" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("Search all notes, collections, or dates…")} aria-label={t("Search saved notes")} /></label><div className="notes-color-filters" aria-label={t("Filter notes by color")}><button type="button" aria-pressed={color === 'all'} onClick={() => setColor('all')}>{t("All notes")}</button>{colors.map(value => <button key={value} type="button" className="notes-color-dot" data-note-color={value} aria-label={t('{0} notes', [t(value)])} title={t('{0} notes', [t(value)])} aria-pressed={color === value} onClick={() => setColor(value)}>{color === value && <NoteIcon kind="check" />}</button>)}</div></Toolbar>
    <Toolbar className="notes-view-tools"><label>{t('Sort notes')}<select value={sort} onChange={event => setSort(event.target.value)}><option value="favorites">{t('Favorites first')}</option><option value="updated">{t('Recently edited')}</option><option value="newest">{t('Newest first')}</option><option value="oldest">{t('Oldest first')}</option><option value="title">{t('Title A–Z')}</option></select></label><div role="group" aria-label={t('Notes view')}><button type="button" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>{t('Cards')}</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('List')}</button></div></Toolbar>
    <Toolbar className="notes-actions-toolbar"><label><input type="checkbox" aria-label={t("Select all visible notes")} checked={visible.length > 0 && visible.every(note => selected.has(note.id))} onChange={event => setSelected(previous => { const next = new Set(previous); visible.forEach(note => event.target.checked ? next.add(note.id) : next.delete(note.id)); return next; })} /> {t("Select notes")}</label><div className="notes-export-actions"><NotesToOfficeButton ids={[...selected]} /><button type="button" disabled={exporting || !visible.length && !selected.size} onClick={() => void exportNotes('markdown')}>{t("Export Markdown")}</button><button type="button" disabled={exporting || !visible.length && !selected.size} onClick={() => void exportNotes('pdf')}>{exporting ? t("Downloading…") : t("Export PDF")}</button></div></Toolbar>
    {selected.size > 0 && <div className="notes-selection-bar" data-notes-selection><span>{t('{0} notes selected', [selected.size])}</span><button type="button" onClick={() => {bulkRequest.current?.abort();bulkRequest.current=null;setBulkStatus('');setSelected(new Set());}}>{t("Clear selection")}</button>{bulkStatus ? <><span role="status">{t(bulkStatus)}</span><button type="button" onClick={() => {bulkRequest.current?.abort();bulkRequest.current=null;setBulkStatus('');}}>{t("Stop")}</button></> : <><button type="button" onClick={() => void askAboutSelection('summarize')}>{t("✦ Summarize")}</button><button type="button" onClick={() => void askAboutSelection('compare')}>{t("Compare")}</button><button type="button" onClick={() => void askAboutSelection('actions')}>{t("Make action plan")}</button></>}</div>}
    {searching && <p className="notes-search-summary" role="status">{visible.length} {visible.length === 1 ? 'note' : 'notes'} {t("found across all collections ·")}<button type="button" onClick={() => setQuery('')}>{t("Clear search")}</button></p>}
    {error && <div className="notes-workspace-error" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>{t("Retry loading")}</button></div>}
    {loading ? <div className="notes-loading" role="status"><span /><span /><span /><p>{t("Gathering your notes…")}</p></div> : !visible.length ? <div className="notes-empty"><div><NoteIcon /></div><h2>{notes.length ? t("No matching notes") : t("Your next good idea belongs here")}</h2><p>{notes.length ? t("Try another search or choose a different color.") : t("Ask Buddy to make notes from a response or research. Save the sticky notes here to keep them close.")}</p>{notes.length ? <button type="button" onClick={() => { setQuery(''); setColor('all'); setCollection(null); setFavoriteOnly(false); setTagFilter(null); }}>{t("Clear filters")}</button> : <button type="button" onClick={onBack}>{t("Make your first notes →")}</button>}</div> : <NoteGrid className={`notes-saved-grid ${view === 'list' ? 'notes-list-view' : ''}`}>{visible.map((note, index) => <article key={note.id} data-note-id={note.id} data-note-color={note.color} className={`sticky-note notes-saved-card ${expanded === note.id ? 'is-expanded' : ''} ${removing === note.id ? 'is-removing' : ''}`} style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
      <span className="sticky-note-pin" aria-hidden="true" /><div className="sticky-note-topline"><input type="checkbox" aria-label={t('Select note: {0}', [note.title])} checked={selected.has(note.id)} onChange={event => setSelected(previous => {const next = new Set(previous); event.target.checked ? next.add(note.id) : next.delete(note.id); return next;})} /><span className="sticky-note-number">{note.created_at && Number.isFinite(Date.parse(note.created_at)) ? new Date(note.created_at).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', year: 'numeric' }) : t('SAVED NOTE')}</span><button type="button" className="notes-favorite" aria-label={t(note.favorite ? t("Unfavorite note: {0}") : t("Favorite note: {0}"), [note.title])} aria-pressed={Boolean(note.favorite)} disabled={metadataBusy.has(note.id)} onClick={() => void toggleFavorite(note)}>{note.favorite ? '★' : '☆'}</button></div><h2><button type="button" className="notes-title-open" onClick={() => openEditor(note)}>{note.title}</button></h2><span className="notes-card-collection">▱ {note.collection || t("Inbox")}</span><div className="notes-saved-body"><NoteText body={note.body} notes={notes} onNavigate={navigateNote} /></div><div className="notes-card-tags">{note.tags?.map(tag => <button key={tag} type="button" onClick={() => {setTagFilter(tag);setFavoriteOnly(false);setCollection(null);setQuery('');}}>#{tag}</button>)}</div>{Boolean(note.sources?.length) && <details className="notes-card-sources"><summary>{t("Sources")}</summary>{note.sources?.map((source,index) => <a key={index} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>)}</details>}
      <div className="sticky-note-footer">{confirming === note.id ? <div className="notes-delete-confirm"><strong>{t("Delete this note?")}</strong><span>{t("This removes it from your collection.")}</span><div><button type="button" onClick={() => setConfirming(null)} disabled={deleting === note.id}>{t("Keep note")}</button><button type="button" className="notes-delete-action" onClick={() => void deleteNote(note.id)} disabled={deleting !== null}>{deleting === note.id ? t("Deleting…") : t("Delete")}</button></div></div> : <div className="notes-card-actions"><button type="button" className="notes-card-edit" onClick={() => openEditor(note)} aria-label={t('Edit note: {0}', [note.title])} data-note-edit>{t("Edit")}</button><button type="button" className="notes-card-improve" onClick={() => openEditor(note, true)} aria-label={t('Enrich note: {0}', [note.title])} data-note-enrich>{t("✦ Bob")}</button><NoteOptions title={note.title} actions={[
        {label: t(expanded === note.id ? 'Show less ↑' : 'View full note ↗'), run: () => setExpanded(expanded === note.id ? null : note.id)},
        {label: t(note.favorite ? 'Unfavorite note' : 'Favorite note'), disabled: metadataBusy.has(note.id), run: () => { void toggleFavorite(note); }},
        {label: t('Send note as email'), run: () => setEmailNote(note)},
        {label: t('Share to people'), run: () => setSharingNote(note)},
        {label: t('Delete note'), danger: true, disabled: deleting !== null, run: () => setConfirming(note.id)},
      ]} /></div>}</div>
    </article>)}</NoteGrid>}</div></div>
    {emailNote && <EmailNote note={emailNote} onClose={() => setEmailNote(null)} />}
    {sharingNote && <ShareToPeople item={{kind:'note',note_id:sharingNote.id,title:sharingNote.title}} onClose={() => setSharingNote(null)} />}
    <dialog ref={editorDialog} className="notes-editor notes-editor-organized" aria-labelledby="notes-editor-title" data-note-editor onCancel={event => { event.preventDefault(); if (!editorSaving) void closeEditor(); }}>
      {editing && <form onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveEditor(); } }} onSubmit={event => { event.preventDefault(); void saveEditor(); }}>
        <fieldset className="notes-editor-fields" disabled={editorSaving}>
        <Toolbar className="notes-editor-heading"><div><div className="notes-eyebrow">{t("A LITTLE SPACE TO THINK")}</div><h2 id="notes-editor-title">{editing.id ? t("Edit your note") : t("A new thought")}</h2></div><button type="button" aria-label={t("Close note editor")} disabled={editorSaving} onClick={closeEditor}>×</button></Toolbar>
        <label className="notes-editor-field">{t("Title")}<input ref={editorTitle} disabled={Boolean(enrichStatus)} value={editing.title} maxLength={160} required onChange={event => setEditing({ ...editing, title: event.target.value })} placeholder={t("Give this thought a title")} /></label>
        <div className="notes-template-tools"><label>{t('Note template')}<select value="" disabled={editorSaving || Boolean(enrichStatus)} onChange={event => applyTemplate(event.target.value)}><option value="">{t('Choose a template…')}</option><option value="meeting">{t('Meeting notes')}</option><option value="project">{t('Project notes')}</option></select></label><small>{t('Ctrl / ⌘ + S to save')}</small></div>
        <Toolbar className="notes-editor-tabs" onKeyDown={event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'write' : event.key === 'End' ? 'preview' : editorTab === 'write' ? 'preview' : 'write'; setEditorTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#note-${next}-tab`)?.focus(); }} role="tablist" aria-label={t("Note content mode")}><button type="button" role="tab" tabIndex={editorTab === 'write' ? 0 : -1} aria-selected={editorTab === 'write'} aria-controls="note-write-panel" id="note-write-tab" onClick={() => setEditorTab('write')}>{t("Write")}</button><button type="button" role="tab" tabIndex={editorTab === 'preview' ? 0 : -1} aria-selected={editorTab === 'preview'} aria-controls="note-preview-panel" id="note-preview-tab" onClick={() => setEditorTab('preview')}>{t("Preview")}</button><span>{t("Markdown supported")}</span></Toolbar>
        {editorTab === 'write' && <Toolbar className="notes-format-toolbar" role="group" aria-label={t('Format note')}>{([['heading', 'Heading'],['bold','Bold'],['italic','Italic'],['bullet','Bullet list'],['checklist','Checklist'],['quote','Quote'],['code','Code block'],['divider','Divider']] as const).map(([format,label]) => <button type="button" disabled={editorSaving || Boolean(enrichStatus)} key={format} onMouseDown={event => event.preventDefault()} onClick={() => formatNote(format)}>{t(label)}</button>)}</Toolbar>}
        {editorTab === 'write' ? <div role="tabpanel" id="note-write-panel" aria-labelledby="note-write-tab"><textarea ref={editorBody} onSelect={event => { if (slashPosition !== null && event.currentTarget.selectionStart !== slashPosition + 1) setSlashPosition(null); }} onKeyDown={event => { if (slashPosition !== null && event.key === 'ArrowDown') { event.preventDefault(); editorDialog.current?.querySelector<HTMLButtonElement>('.notes-slash-menu button')?.focus(); } else if (slashPosition !== null && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSlashPosition(null); } if ((event.ctrlKey || event.metaKey) && ['b','i'].includes(event.key.toLowerCase())) { event.preventDefault(); formatNote(event.key.toLowerCase() === 'b' ? 'bold' : 'italic'); } }} aria-label={t("Note content")} disabled={Boolean(enrichStatus)} required maxLength={6000} value={editing.body} onChange={event => { const body = event.target.value; const position = event.currentTarget.selectionStart; const before = body.slice(0,position); setSlashPosition(before.slice(before.lastIndexOf('\n')+1) === '/' ? position-1 : null); setEditing({ ...editing, body }); }} placeholder={t("Capture an idea, a checklist, or something worth remembering…")} /></div> : <div role="tabpanel" id="note-preview-panel" aria-labelledby="note-preview-tab" className="notes-editor-preview" tabIndex={0}>{editing.body ? <NoteText body={editing.body} notes={notes} onNavigate={navigateNote} /> : <p>{t("Your note preview will appear here.")}</p>}</div>}
        {editorTab === 'write' && slashPosition !== null && <div className="notes-slash-menu" role="menu" tabIndex={-1} aria-label={t('Insert block')} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSlashPosition(null); editorBody.current?.focus(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll('button')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
        }}>{([['heading','Heading'],['bullet','Bullet list'],['checklist','Checklist'],['quote','Quote'],['code','Code block'],['divider','Divider']] as const).map(([format,label]) => <button type="button" role="menuitem" key={format} onClick={() => formatNote(format)}>{t(label)}</button>)}</div>}
        <small className="notes-writing-hint">{t('Type / on a new line to insert a block.')}</small>
        {!!noteHeadings(editing.body).length && <details className="notes-outline"><summary>{t('On this page')}</summary>{noteHeadings(editing.body).map(heading => <button type="button" key={heading.offset} data-heading-level={heading.level} onClick={() => { setEditorTab('write'); requestAnimationFrame(() => { editorBody.current?.focus(); editorBody.current?.setSelectionRange(heading.offset,heading.offset); }); }}>{heading.text}</button>)}</details>}
        <div className="notes-link-insert"><label>{t("Link a note")}<select aria-label={t("Link a note")} value="" onChange={event => {const linked = notes.find(note => note.id === Number(event.target.value));if(linked)setEditing({...editing,body:editing.body + '\n' + insertNoteLink(linked)});}}><option value="">{t("Insert a link…")}</option>{notes.filter(note => note.id !== editing.id).map(note => <option key={note.id} value={note.id}>{note.title}</option>)}</select></label><small>{t("Use [[note title]] or insert a stable link that survives renaming.")}</small></div>
        <div className="notes-links-panel"><div><strong>{t("Links")}</strong>{resolveNoteLinks(editing.body,notes).length ? resolveNoteLinks(editing.body,notes).map((link,index) => link.note ? <button key={index} type="button" onClick={() => navigateNote(link.note!)}>{link.label} ↗</button> : <span key={index}>{link.label} · {t(link.ambiguous ? 'Choose a unique note link' : 'Note not found')}</span>) : <span>{t("No linked notes yet.")}</span>}</div><div><strong>{t("Backlinks")}</strong>{notes.filter(note => note.id !== editing.id && resolveNoteLinks(note.body,notes).some(link => link.note?.id === editing.id)).map(note => <button key={note.id} type="button" onClick={() => navigateNote(note)}>{note.title} ↗</button>)}</div></div>
        <details className="notes-properties"><summary><span>{t('Note properties')}</span><small>{t('Collection, tags, color and sources')}</small></summary><div className="notes-properties-content">        <div className="notes-editor-options"><label className="notes-editor-field">{t("Collection")}<input aria-label={t("Collection")} value={editing.collection} maxLength={80} list="note-collections" onChange={event => setEditing({ ...editing, collection: event.target.value })} placeholder={t("Inbox — or create a collection")} /><datalist id="note-collections">{collections.map(name => <option key={name} value={name} />)}</datalist><small>{t("Defaults to the save date. Type a name to choose another collection, or clear for Inbox.")}</small></label><fieldset><legend>{t("Paper color")}</legend><div className="notes-color-filters">{colors.map(value => <button key={value} type="button" className="notes-color-dot" data-note-color={value} aria-label={t('{0} paper', [t(value)])} aria-pressed={editing.color === value} onClick={() => setEditing({ ...editing, color: value })}>{editing.color === value && <NoteIcon kind="check" />}</button>)}</div></fieldset></div>
        <label className="notes-editor-field notes-tags-field">{t("Tags")}<input aria-label={t("Note tags")} value={tagsText} maxLength={900} onChange={event => setTagsText(event.target.value)} placeholder={t("research, ideas, follow-up")} /><small>{t("Separate tags with commas. Up to 20 tags.")}</small></label><label className="notes-editor-favorite"><input type="checkbox" checked={editing.favorite} onChange={event => setEditing({...editing,favorite:event.target.checked})} /> {t("Favorite this note")}</label>
        <details className="notes-source-editor"><summary>{t("Sources")}</summary>{editing.sources.map((source,index) => <div key={index}><input aria-label={t('Source title {0}', [index+1])} placeholder={t("Source title")} maxLength={200} value={source.title} onChange={event => setEditing({...editing,sources:editing.sources.map((item,i)=>i===index?{...item,title:event.target.value}:item)})} /><input type="url" aria-label={t('Source URL {0}', [index+1])} placeholder={t("https://…")} maxLength={2048} value={source.url} onChange={event => setEditing({...editing,sources:editing.sources.map((item,i)=>i===index?{...item,url:event.target.value}:item)})} /><button type="button" onClick={() => setEditing({...editing,sources:editing.sources.filter((_,i)=>i!==index)})}>{t("Remove source")}</button></div>)}<button type="button" disabled={editing.sources.length>=20} onClick={() => setEditing({...editing,sources:[...editing.sources,{title:'',url:''}]})}>{t("＋ Add source")}</button></details>
        </div></details>
        <section className="notes-enrichment" aria-label={t("Improve this note with Bob")}>
          <button type="button" className="notes-enrichment-toggle" aria-expanded={enrichOpen} onClick={() => setEnrichOpen(!enrichOpen)}><span>{t("✦ Enrich with Bob")}</span><span>{enrichOpen ? '−' : '+'}</span></button>
          {enrichOpen && <div className="notes-enrichment-content"><p>{t("Expand an idea, add examples, or ask Bob to research it. Review the suggestion before changing your note.")}</p>
            <div className="notes-enrichment-presets">{[[t("Add detail"),"Add useful detail and clarify the key points while preserving the original meaning."],[t("Add examples"),"Add concrete examples that help explain this note. Clearly label hypothetical examples."],[t("Make actionable"),"Turn this note into clear actionable steps. Preserve caveats and source links."],[t("Research & cite"),"Research the topic of this note using available search tools, verify claims, and enrich it with real source links. Explain any uncertainty or source access limitations."]].map(([label, instruction]) => <button key={label} type="button" disabled={Boolean(enrichStatus)} aria-pressed={enrichInstruction === instruction} onClick={() => setEnrichInstruction(instruction)}>{label}</button>)}</div>
            <label className="notes-editor-field">{t("How should Bob improve it?")}<textarea aria-label={t("Instructions for Bob")} value={t(enrichInstruction)} maxLength={1500} disabled={Boolean(enrichStatus)} onChange={event => setEnrichInstruction(event.target.value)} /></label>
            {enrichStatus ? <div className="notes-enrichment-progress"><span role="status">✦ {enrichStatus}</span><button type="button" onClick={stopEnrichment}>{t("Stop")}</button></div> : <button type="button" className="notes-new" disabled={editorSaving || !editing.body.trim()} onClick={() => void requestEnrichment()}>{t("✦ Ask Bob for a revision")}</button>}
            {enrichError && <p role="alert" className="sticky-note-error">{enrichError}</p>}
            {proposal && <div className="notes-revision" data-note-revision><div className="notes-revision-heading">{t("BOB’S SUGGESTED REVISION · NOT SAVED")}</div><h3>{proposal.title}</h3><NoteText body={proposal.body} /><div className="notes-revision-actions"><button type="button" className="notes-new" onClick={() => { setEditing({ ...editing, title: proposal.title, body: proposal.body }); setProposal(null); setRevisionApplied(true); setEditorTab('preview'); }}>{t("Use this revision")}</button><button type="button" onClick={() => setProposal(null)}>{t("Discard suggestion")}</button></div></div>}
            {revisionApplied && <p className="notes-revision-applied" role="status">{t("Revision added to your draft. Select Save note to keep your changes.")}</p>}
          </div>}
        </section>

        {editing.id && <NoteDetails key={editing.id} noteId={editing.id} onRestored={restored => {const note = restored as SavedNote;setNotes(previous=>previous.map(item=>item.id===note.id?note:item));openEditor(note);setEditorError('');window.dispatchEvent(new Event('buddy-notes-changed'));}} />}
        {editorError && <p className="sticky-note-error" role="alert">{editorError}</p>}
        <div className="notes-editor-footer"><button type="button" disabled={editorSaving} onClick={closeEditor}>{t("Cancel")}</button><button type="submit" className="notes-new" disabled={editorSaving || Boolean(enrichStatus) || Boolean(proposal)}>{editorSaving ? t("Saving…") : t("Save note")}</button></div>
        </fieldset>
      </form>}
    </dialog>
  </section>;
}
