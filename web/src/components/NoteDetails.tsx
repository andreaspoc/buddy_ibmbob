import { t, useLanguage, getLocale } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StickyNoteColor } from '../lib/stickyNotes';
import './NoteDetails.css';

type NoteSnapshot = { title: string; body: string; color: StickyNoteColor; collection: string; tags?: string[]; favorite?: boolean; sources?: Array<{ title: string; url: string }> };
type NoteVersion = { id: number; note_id: number; created_at: string; snapshot: NoteSnapshot };
type Attachment = { id: number; filename: string; content_type: string; size: number; created_at: string };
export type RestoredNote = NoteSnapshot & { id: number; [key: string]: unknown };
const formatDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(getLocale()) : t('Saved version');
function formatSize(size: number) { return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`; }
async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.detail === 'string' ? t(detail.detail) : t('This request could not be completed. Please try again.'));
  }
  return response.json();
}

export function NoteDetails({ noteId, onRestored }: { noteId: number; onRestored: (note: RestoredNote) => void }) {
  useLanguage();
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [versionError, setVersionError] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyAttachment, setBusyAttachment] = useState<number | null>(null);
  const [removeId, setRemoveId] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState('');
  const [reload, setReload] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/notes/${noteId}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setVersionError(''); setAttachmentError(''); setSelectedVersion(null); setConfirmRestore(null);
    const load = async () => {
      await Promise.allSettled([
        requestJson<{ items: NoteVersion[] }>(`${base}/versions`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setVersions(data.items); }).catch(e => { if (!controller.signal.aborted) setVersionError(e instanceof Error ? e.message : t('Could not load versions.')); }),
        requestJson<{ items: Attachment[] }>(`${base}/attachments`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setAttachments(data.items); }).catch(e => { if (!controller.signal.aborted) setAttachmentError(e instanceof Error ? e.message : t('Could not load attachments.')); }),
      ]);
      if (!controller.signal.aborted) setLoading(false);
    };
    void load();
    return () => controller.abort();
  }, [base, reload]);
  async function upload(file: File | undefined) {
    if (!file || uploading) return;
    setAttachmentError(''); setStatus('');
    if (file.size > 10 * 1024 * 1024) { setAttachmentError(t('Choose a file no larger than 10 MB.')); return; }
    if (attachments.length >= 20) { setAttachmentError(t('A note can hold up to 20 attachments. Remove one before adding another.')); return; }
    const body = new FormData(); body.append('file', file);
    setUploading(true);
    try {
      const attachment = await requestJson<Attachment>(`${base}/attachments`, { method: 'POST', body });
      if (mounted.current) { setAttachments(previous => [...previous, attachment]); setStatus(t('{0} attached.', [attachment.filename])); }
    } catch (e) { if (mounted.current) setAttachmentError(e instanceof Error ? e.message : t('Could not upload file.')); }
    finally { if (mounted.current) setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function removeAttachment(id: number) {
    if (busyAttachment !== null) return;
    setBusyAttachment(id); setAttachmentError(''); setStatus('');
    try {
      const response = await fetch(`${base}/attachments/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(t('The attachment could not be removed. Please try again.'));
      if (mounted.current) { setAttachments(previous => previous.filter(item => item.id !== id)); setRemoveId(null); setStatus(t('Attachment removed.')); }
    } catch (e) { if (mounted.current) setAttachmentError(e instanceof Error ? e.message : t('Could not remove attachment.')); }
    finally { if (mounted.current) setBusyAttachment(null); }
  }
  async function restore(versionId: number) {
    if (restoring) return;
    setRestoring(true); setVersionError(''); setStatus('');
    try {
      const note = await requestJson<RestoredNote>(`${base}/versions/${versionId}/restore`, { method: 'POST' });
      if (mounted.current) { onRestored(note); setConfirmRestore(null); setStatus(t('Previous version restored.')); setReload(value => value + 1); }
      window.dispatchEvent(new Event('buddy-notes-changed'));
    } catch (e) { if (mounted.current) setVersionError(e instanceof Error ? e.message : t('Could not restore version.')); }
    finally { if (mounted.current) setRestoring(false); }
  }
  const preview = versions.find(version => version.id === selectedVersion);
  return <div className="note-details" data-note-details>
    <section className="note-details-section" aria-label={t("Note attachments")}><div className="note-details-heading"><div><h3>{t("Attachments")}</h3><p>{t("Keep supporting files alongside this thought.")}</p></div><button type="button" className="note-details-add" onClick={() => fileInput.current?.click()} disabled={uploading || loading || attachments.length >= 20}>{uploading ? t('Uploading…') : t('＋ Attach file')}</button><input ref={fileInput} type="file" aria-label={t("Attach a file")} className="note-details-file" disabled={uploading} onChange={event => void upload(event.target.files?.[0])} /></div>
      <span className="note-details-hint">{t('Up to 10 MB per file · {0} / 20 files', [attachments.length])}</span>
      {attachmentError && <div className="note-details-error" role="alert">{attachmentError}<button type="button" onClick={() => setReload(value => value + 1)}>{t("Retry loading")}</button></div>}
      {loading ? <p className="note-details-empty">{t("Loading attachments…")}</p> : attachments.length === 0 ? <p className="note-details-empty">{t("No attachments yet. Add images, documents, or other reference files.")}</p> : <ul className="note-attachment-list">{attachments.map(attachment => <li key={attachment.id} data-attachment-id={attachment.id}><span className="note-attachment-icon" aria-hidden="true">{attachment.content_type.startsWith('image/') ? '▧' : '▤'}</span><div className="note-attachment-info"><a href={Number.isSafeInteger(noteId) && noteId > 0 && Number.isSafeInteger(attachment.id) && attachment.id > 0 ? `${base}/attachments/${attachment.id}` : undefined} download={attachment.filename}>{attachment.filename}</a><span>{formatSize(attachment.size)} · {attachment.content_type || t('File')}</span></div>{removeId === attachment.id ? <div className="note-attachment-confirm"><span>{t("Remove file?")}</span><button type="button" onClick={() => setRemoveId(null)} disabled={busyAttachment !== null}>{t("Keep")}</button><button type="button" onClick={() => void removeAttachment(attachment.id)} disabled={busyAttachment !== null}>{busyAttachment === attachment.id ? t('Removing…') : t('Remove')}</button></div> : <button type="button" className="note-attachment-remove" aria-label={t('Remove attachment: {0}', [attachment.filename])} onClick={() => setRemoveId(attachment.id)}>×</button>}</li>)}</ul>}
    </section>
    <details className="note-details-section note-history" data-note-history><summary><span>{t("Version history")}</span><small>{t(versions.length === 1 ? '{0} saved version' : '{0} saved versions', [versions.length])}</small></summary><p className="note-details-hint">{t("Review an earlier version before restoring it. Your current saved note is kept in history.")}</p>
      {versionError && <div className="note-details-error" role="alert">{versionError}<button type="button" onClick={() => setReload(value => value + 1)}>{t("Retry loading")}</button></div>}
      {loading ? <p className="note-details-empty">{t("Loading version history…")}</p> : versions.length === 0 ? <p className="note-details-empty">{t("Earlier versions will appear here when you save changes.")}</p> : <div className="note-version-layout"><div className="note-version-list">{versions.map(version => <button type="button" key={version.id} aria-pressed={selectedVersion === version.id} onClick={() => { setSelectedVersion(version.id); setConfirmRestore(null); }}><strong>{version.snapshot.title}</strong><time dateTime={version.created_at}>{formatDate(version.created_at)}</time></button>)}</div>{preview ? <div className="note-version-preview" data-note-version-preview><span className="note-details-hint">{t('SAVED {0}', [formatDate(preview.created_at)])}</span><h4>{preview.snapshot.title}</h4><div className="sticky-note-copy" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(preview.snapshot.body, { async: false, breaks: true }) as string) }} /><p className="note-version-meta">{t('Collection: {0} · Paper: {1}', [preview.snapshot.collection || t('Inbox'), t(preview.snapshot.color)])}</p>{confirmRestore === preview.id ? <div className="note-version-confirm"><strong>{t("Restore this version?")}</strong><p>{t("This replaces the saved note and any unsaved changes in the editor. Your current saved version stays in history.")}</p><div><button type="button" disabled={restoring} onClick={() => setConfirmRestore(null)}>{t("Cancel restore")}</button><button type="button" className="note-details-add" disabled={restoring} onClick={() => void restore(preview.id)}>{restoring ? t('Restoring…') : t('Confirm restore')}</button></div></div> : <button type="button" className="note-details-add" onClick={() => setConfirmRestore(preview.id)}>{t("Restore this version")}</button>}</div> : <p className="note-details-empty">{t("Choose a version to review its contents.")}</p>}</div>}
    </details><p className="note-details-status" role="status" aria-live="polite">{status}</p>
  </div>;
}
