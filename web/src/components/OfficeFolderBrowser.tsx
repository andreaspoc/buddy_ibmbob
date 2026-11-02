import { Toolbar } from './Toolbar';
import { useState } from 'react';
import { t } from '../lib/i18n';
import { appConfirm } from './AppDialog';
import './OfficeFolderBrowser.css';
import { OfficeItemMenu, type OfficeMenuPosition } from './OfficeItemMenu';

export type OfficeFolder = { id: string; name: string; parent_id: string | null };
export function folderPath(folders: OfficeFolder[], id: string | null): OfficeFolder[] {
  const path: OfficeFolder[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) { seen.add(id); const folder = folders.find(item => item.id === id); if (!folder) break; path.unshift(folder); id = folder.parent_id; }
  return path;
}
export function folderDestinations(folders: OfficeFolder[], exclude?: string): OfficeFolder[] {
  return folders.filter(folder => !exclude || !folderPath(folders, folder.id).some(item => item.id === exclude))
    .sort((a, b) => folderPath(folders, a.id).map(item => item.name).join('/').localeCompare(folderPath(folders, b.id).map(item => item.name).join('/')));
}
export function OfficeFolderDestination({ folders, value, onChange, exclude }: { folders: OfficeFolder[]; value: string | null; onChange: (id: string | null) => void; exclude?: string }) {
  return <select aria-label={t('Destination folder')} value={value ?? ''} onChange={event => onChange(event.target.value || null)}><option value="">{t('My files')}</option>{folderDestinations(folders, exclude).map(folder => <option key={folder.id} value={folder.id}>{folderPath(folders, folder.id).map(item => item.name).join(' / ')}</option>)}</select>;
}
export function OfficeFolderBrowser({ folders, current, onSelect, mutate }: { folders: OfficeFolder[]; current: string | null; onSelect: (id: string | null) => void; mutate: (path: string, method: string, body?: unknown) => Promise<void> }) {
  const [editing, setEditing] = useState<OfficeFolder | 'new' | null>(null), [name, setName] = useState(''), [parent, setParent] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [menu, setMenu] = useState<{ position: OfficeMenuPosition; folder: OfficeFolder } | null>(null);
  const open = (folder: OfficeFolder | 'new', destination = current) => { setEditing(folder); setName(folder === 'new' ? '' : folder.name); setParent(folder === 'new' ? destination : folder.parent_id); setError(''); };
  const save = async () => { if (!editing || !name.trim() || busy) return; setBusy(true); setError(''); try { await mutate(editing === 'new' ? '/folders' : `/folders/${editing.id}`, editing === 'new' ? 'POST' : 'PATCH', { name: name.trim(), parent_id: parent }); setEditing(null); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } };
  const remove = async (folder: OfficeFolder) => { if (!await appConfirm(t('Delete empty folder "{0}"?', [folder.name]))) return; setBusy(true); setError(''); try { await mutate(`/folders/${folder.id}`, 'DELETE'); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } };
  return <section className="office-folders" aria-label={t('Folders')}>
    <Toolbar className="office-folder-heading"><nav aria-label={t('Folder location')}><button onClick={() => onSelect(null)}>{t('My files')}</button>{folderPath(folders, current).map(folder => <span key={folder.id}><span aria-hidden="true"> / </span><button title={folder.name} aria-current={folder.id === current ? 'location' : undefined} onClick={() => onSelect(folder.id)}>{folder.name}</button></span>)}</nav><button disabled={busy} onClick={() => open('new')}>＋ {t('New folder')}</button></Toolbar>
    <p className="office-folder-search-note">{t('Search and file types apply to this folder.')}</p>
    <div className="office-folder-grid">{folders.filter(folder => folder.parent_id === current).sort((a, b) => a.name.localeCompare(b.name)).map(folder => <div className="office-folder-card" key={folder.id} onContextMenu={event => { event.preventDefault(); setMenu({ folder, position: { x: event.clientX, y: event.clientY, returnFocus: event.currentTarget.querySelector('button') } }); }}><button className="office-folder-open" title={folder.name} onClick={() => onSelect(folder.id)}><svg aria-hidden="true" width="34" height="28" viewBox="0 0 34 28"><path d="M2 6a3 3 0 0 1 3-3h9l4 4h11a3 3 0 0 1 3 3v14H2Z" fill="#f4c86b"/><path d="M2 11h30v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3Z" fill="#f9d98a"/></svg><span className="office-folder-name">{folder.name}</span></button><button disabled={busy} aria-label={t('Rename or move folder "{0}"', [folder.name])} aria-haspopup="menu" aria-expanded={menu?.folder.id === folder.id} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ folder, position: { x: box.left, y: box.bottom, returnFocus: event.currentTarget } }); }}>⋯</button></div>)}</div>
    {menu && <OfficeItemMenu position={menu.position} onClose={() => setMenu(null)} actions={[
      { label: t('Open →'), run: () => onSelect(menu.folder.id) },
      { label: t('New folder'), disabled: busy, run: () => open('new', menu.folder.id) },
      { label: t('Rename / move'), disabled: busy, run: () => open(menu.folder) },
      { label: t('Delete'), danger: true, disabled: busy, run: () => { void remove(menu.folder); } },
    ]} />}

    {error && !editing && <div className="office-error" role="alert">{error}</div>}
    {editing && <div className="office-upload-shade"><form className="office-upload office-folder-dialog" role="dialog" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) setEditing(null); } }} aria-modal="true" aria-label={t(editing === 'new' ? 'New folder' : 'Rename / move folder')} onSubmit={event => { event.preventDefault(); void save(); }}><h2>{t(editing === 'new' ? 'New folder' : 'Rename / move folder')}</h2><label>{t('Folder name')}<input autoFocus required maxLength={190} value={name} onChange={event => setName(event.target.value)} /></label><label>{t('Destination folder')}<OfficeFolderDestination folders={folders} value={parent} onChange={setParent} exclude={editing === 'new' ? undefined : editing.id} /></label>{error && <div className="office-error" role="alert">{error}</div>}<div className="office-folder-dialog-actions"><button disabled={busy} type="button" onClick={() => setEditing(null)}>{t('Cancel')}</button><button type="submit" className="office-primary" disabled={busy || !name.trim()}>{t(busy ? 'Saving…' : 'Save')}</button></div></form></div>}
  </section>;
}
