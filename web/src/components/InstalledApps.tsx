import { Toolbar } from './Toolbar';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, useLanguage } from '../lib/i18n';
import { workspaceAppGroup, workspaceAppGroups, type WorkspaceApp } from '../lib/appRegistry';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { safeHref } from '../lib/safeHref';
import './InstalledApps.css';

export function InstalledApps({ apps, loaded, error, desktop, onOpen, onRefresh, onClose }: {
  apps: WorkspaceApp[]; loaded: boolean; error: boolean; desktop: boolean;
  onOpen: (app: WorkspaceApp) => void; onRefresh: () => void; onClose: () => void;
}) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const panel = dialog.current!;
    const previous = document.activeElement;
    panel.showModal();
    return () => { panel.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const close = onClose;
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = apps.filter(app => {
    if (app.desktop_only && !desktop) return false;
    const group = workspaceAppGroups.find(group => group.id === workspaceAppGroup(app))!;
    const searchable = `${t(app.id === 'connections' ? 'Connected services' : app.name)} ${t(app.name)} ${app.name} ${t(app.description)} ${app.description} ${t(group.label)} ${group.label}`.toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const groups = workspaceAppGroups.map(group => ({ ...group, apps: visible.filter(app => workspaceAppGroup(app) === group.id) })).filter(group => group.apps.length);
  return createPortal(<dialog ref={dialog} className="installed-apps buddy-surface" data-apps-motion="none" aria-labelledby="installed-apps-title"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) { const bounds = dialog.current.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } }}>
    <WorkspaceSectionHeader title={t('Apps')} titleId="installed-apps-title" description={t('Your available workspace apps')} compact
      actions={<button type="button" onClick={close}>{t('Close')}</button>} />
    <Toolbar className="installed-apps-controls"><input type="search" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search apps or categories')} aria-label={t('Search apps')} /><button type="button" onClick={onRefresh}>{t('Refresh')}</button></Toolbar>
    {error && <p role="alert">{t('Apps could not be refreshed. Try again.')}</p>}
    {!loaded && <p role="status">{t('Loading…')}</p>}
    {groups.map(group => <section key={group.id} aria-labelledby={`apps-group-${group.id}`}>
      <h3 id={`apps-group-${group.id}`}>{t(group.label)}</h3>
      <div className="installed-apps-grid">{group.apps.map(app => {
        const destination = app.launch.kind === 'office' ? 'office' : app.launch.kind === 'notes' ? 'notes' : undefined;
        const name = app.id === 'connections' ? 'Connected services' : app.name;
        const content = <><span className="installed-app-icon" aria-hidden="true">{({ projects: '◫', office: '▦', people: '☏', docmost: '▤', chat: '✦', notes: '▤', tasks: '✓', knowledge: '▧', research: '⌕', workflows: '⇄', search: '⌕', connections: '⌘', zen: '⚡', decisions: '⚡' } as Record<string, string>)[app.id] || app.name.slice(0, 1).toUpperCase()}</span><span><strong>{t(name)}</strong><small>{t(app.description)}</small></span><span className="installed-app-arrow" aria-hidden="true">{app.launch.kind === 'link' && app.launch.target !== '_self' ? '↗' : '→'}</span></>;
        return app.launch.kind === 'link' && app.launch.url && safeHref(app.launch.url) ? <a key={app.id} href={safeHref(app.launch.url)} target={app.launch.target || "_blank"} rel="noopener noreferrer" data-workspace-destination={destination} className="installed-app-card" aria-label={app.launch.target === '_self' ? t(name) : `${t(name)} · ${t('Open in new tab')}`}>{content}</a> : <button type="button" key={app.id} data-workspace-destination={destination} className="installed-app-card" disabled={app.disabled} onClick={() => { onClose(); onOpen(app); }}>{content}</button>;
      })}</div>
    </section>)}
    {loaded && !visible.length && <p className="installed-apps-empty" role="status">{t(query.trim() ? 'No apps match this search. Try an app name or category.' : 'No apps are available for this account and device.')}</p>}
  </dialog>, document.body);
}
