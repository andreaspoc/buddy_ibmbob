import { AnswerActionLabel } from './AnswerActionLabel';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../lib/i18n';
import './ShareToPeople.css';

export type PeopleShareItem = { kind: 'note'; note_id: number; title: string } | { kind: 'artifact'; session_id: string; path: string; title: string } | { kind: 'text'; title: string; body: string };
type Room = { id: number; name: string; kind: string; subscribed: boolean; visibility?: string };
type Member = { username: string; display_name: string };
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/community${path}`, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not share this item. Please try again.'); }
  return response.json();
}
export function ShareToPeopleButton({ item, disabled = false, className, title, compact = false }: { item: PeopleShareItem; disabled?: boolean; className?: string; title?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={className} disabled={disabled} title={compact ? undefined : t(title || 'Share only this item with a person or channel')} onClick={() => setOpen(true)}>{compact ? <AnswerActionLabel icon="share" label={t('Share to people')} /> : t('Share to people')}</button>{open && <ShareToPeople item={item} onClose={() => setOpen(false)} />}</>;
}
export function ShareToPeople({ item, onClose }: { item: PeopleShareItem; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState('');
  const [text, setText] = useState(item.kind === 'text' ? item.body : '');
  const [selected, setSelected] = useState<{ room?: Room; member?: Member } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sharedRoom, setSharedRoom] = useState<Room | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => { const prior = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { prior?.focus(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void Promise.all([request<Room[]>('/rooms', { signal: controller.signal }), request<Member[]>('/members', { signal: controller.signal })]).then(([r, m]) => { if (!controller.signal.aborted) { setRooms(r.filter(room => room.subscribed)); setMembers(m); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  async function share() {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      const room = selected.room || await request<Room>('/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'direct', peer: selected.member!.username }) });
      await request(`/rooms/${room.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.kind === 'text' ? { ...item, body: text } : item) });
      setSharedRoom(room); window.dispatchEvent(new Event('community-updated'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not share this item. Please try again.'); } finally { setBusy(false); }
  }
  const destination = selected?.room?.name || selected?.member?.display_name;
  const search = query.trim().toLocaleLowerCase();
  return createPortal(<dialog ref={dialog} className="people-share-dialog" aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="people-share-heading"><div><small>{t('PEOPLE & CHANNELS')}</small><h2 id={heading}>{t(sharedRoom ? 'Item shared' : 'Share to people')}</h2></div><button type="button" aria-label={t('Close share dialog')} disabled={busy} onClick={onClose}>×</button></div>
    <div className="people-share-item"><span aria-hidden="true">{item.kind === 'note' ? '▤' : item.kind === 'artifact' ? '▧' : '❝'}</span><div><strong>{item.title || t('Untitled item')}</strong><small>{t(item.kind === 'text' ? 'Only this text will be shared.' : 'A copy of this item will be shared.')}</small></div></div>
    {sharedRoom ? <><p role="status">{t('Shared with')} <strong>{destination}</strong>.</p><p className="people-share-hint">{t('Your other notes, files, and assistant conversations stay private.')}</p><div className="people-share-footer"><button type="button" onClick={onClose}>{t('Done')}</button></div></> : <>
      <p className="people-share-hint">{t('Choose a recipient, review the destination, then share. Your other workspace content stays private.')}</p>
      {item.kind === 'text' && <label className="people-share-text">{t('Review the text to share')}<textarea aria-label={t('Text to share')} value={text} maxLength={20000} disabled={busy} onChange={event => setText(event.target.value)} /><small>{text.length.toLocaleString()} / 20,000{ text.length > 20000 && ` · ${t('Shorten the text before sharing.')}`}</small></label>}
      <input className="people-share-search" aria-label={t('Search people or joined channels')} placeholder={t('Search people or joined channels…')} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
      <div className="people-share-destinations" aria-label={t('Share destination')}>
        {loading ? <p role="status">{t('Loading recipients…')}</p> : <>{rooms.filter(room => room.name.toLocaleLowerCase().includes(search)).map(room => <button key={`r${room.id}`} type="button" disabled={busy} aria-pressed={selected?.room?.id === room.id} onClick={() => setSelected({ room })}><span aria-hidden="true">{room.kind === 'direct' ? '◉' : '#'}</span><div><strong>{room.name}</strong><small>{t(room.kind === 'direct' ? 'Private conversation' : room.visibility === 'private' ? 'Private group' : 'Open channel · Joined')}</small></div></button>)}{members.filter(member => member.display_name.toLocaleLowerCase().includes(search)).map(member => <button key={`m${member.username}`} type="button" disabled={busy} aria-pressed={selected?.member?.username === member.username} onClick={() => setSelected({ member })}><span aria-hidden="true">{member.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{member.display_name}</strong><small>{t('Private message')}</small></div></button>)}{!rooms.some(room => room.name.toLocaleLowerCase().includes(search)) && !members.some(member => member.display_name.toLocaleLowerCase().includes(search)) && <p>{t('No matching recipients.')}</p>}</>}
      </div>
      {selected && <p className="people-share-confirm">{t('Share with:')} <strong>{destination}</strong>{selected.room?.visibility === 'open' && <small>{t('All current and future channel members can access this copy.')}</small>}</p>}
      {error && <div className="people-share-error" role="alert">{t(error)}{!rooms.length && !members.length && <button type="button" onClick={() => setReload(value => value + 1)}>{t('Retry')}</button>}</div>}
      <div className="people-share-footer"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button type="button" className="people-share-send" disabled={!selected || busy || loading || (item.kind === 'text' && (!text.trim() || text.length > 20000))} onClick={() => void share()}>{t(busy ? 'Sharing…' : 'Share copy')}</button></div>
    </>}
  </dialog>, document.body);
}
