import LearningPeopleAdmin from './LearningPeopleAdmin';
import { useAccessGroups } from '../lib/accessGroups';
import { brandText } from '../lib/brand';
import { Toolbar } from './Toolbar';
import { BulkUserEditor, type UserAssignmentChanges } from './BulkUserEditor';
import { ManagedUserEditor } from './ManagedUserEditor';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { useEffect, useState, type FormEvent } from 'react';
import { addAdministrator, fetchAdministrationUsers, removePendingAdministrator, updateManagedUser, updateManagedUsers } from '../api';
import type { ManagedUser, User } from '../types';
import { t, getLocale, useLanguage } from '../lib/i18n';
import './AdministrationPage.css';
import { AccessPreview } from './AccessPreview';
import { AuditHistory } from './AuditHistory';
import { FeedbackReview } from './FeedbackReview';
import { SmtpSettings } from './SmtpSettings';
import { BobKeySettings } from './BobKeySettings';
import { BrandingSettings } from './BrandingFields';
import { BuddyProfiles } from './BuddyProfiles';
import { DataProtectionSettings } from './DataProtectionSettings';

interface Props {
  currentUser: User;
  onBack: () => void;
  onCurrentUserUpdated?: (user: User) => void;
}

export function AdministrationPage({ currentUser, onBack, onCurrentUserUpdated }: Props) {
  useLanguage();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('users');
  const [groupFilter, setGroupFilter] = useState('all');
  const groupOptions = useAccessGroups();
  const [roleFilter, setRoleFilter] = useState('all');
  const [sort, setSort] = useState('asc');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  useEffect(() => { setPage(1); setSelection([]); }, [search, groupFilter, roleFilter, sort]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeValues, setNoticeValues] = useState<(string | number)[]>([]);
  const load = async () => {
    const data = await fetchAdministrationUsers();
    setUsers(data.users); setPending(data.pending_admins); setLoaded(true);
  };
  useEffect(() => {
    let active = true;
    fetchAdministrationUsers().then(data => { if (active) { setUsers(data.users); setPending(data.pending_admins); setLoaded(true); } }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const save = async (draft: ManagedUser) => {
    setBusy(draft.username); setError(''); setNotice('');
    try {
      const updated = await updateManagedUser(draft.username, { is_admin: draft.is_admin });
      setUsers(previous => previous.map(user => user.username === draft.username ? updated : user));
      setNotice('User groups saved.');
      if (updated.username === currentUser.username) onCurrentUserUpdated?.(updated);
      return true;
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update user groups.'); return false; }
    finally { setBusy(null); }
  };
  const invite = async (event: FormEvent) => {
    event.preventDefault(); setBusy('invite'); setError(''); setNotice('');
    try { await addAdministrator(email.trim()); await load(); setEmail(''); setNotice('Administrator access configured. Pending access activates after a verified company sign-in.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update user groups.'); }
    finally { setBusy(null); }
  };
  const removePending = async (address: string) => {
    setBusy(address); setError(''); setNotice('');
    try { await removePendingAdministrator(address); await load(); setNotice('Pending administrator access removed.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update user groups.'); }
    finally { setBusy(null); }
  };
  const saveBulk = async (changes: UserAssignmentChanges) => {
    setBusy('bulk'); setError(''); setNotice('');
    try {
      const result = await updateManagedUsers(selection, changes);
      setUsers(previous => previous.map(user => result.users.find(updated => updated.username === user.username) || user));
      setNotice('User access updated for {0} users.'); setNoticeValues([result.updated]);
      const current = result.users.find(user => user.username === currentUser.username);
      if (current) onCurrentUserUpdated?.(current);
      setSelection([]);
      return true;
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update user groups.'); return false; }
    finally { setBusy(null); }
  };
  const query = search.trim().toLocaleLowerCase(getLocale());
  const administrators = users.filter(user => user.is_admin).length;
  const clearFilters = () => { setSearch(''); setGroupFilter('all'); setRoleFilter('all'); setPage(1); };
  const filtered = users.filter(user =>
    [user.username, user.display_name, user.email].some(value => value?.toLocaleLowerCase(getLocale()).includes(query)) &&
    (groupFilter === 'all' || (groupFilter === 'none' ? !user.groups?.length : user.groups?.some(group => group.id === groupFilter))) &&
    (roleFilter === 'all' || user.is_admin === (roleFilter === 'admin'))
  ).sort((a,b) => (a.display_name || a.username).localeCompare(b.display_name || b.username, getLocale(), {sensitivity:'base'}) * (sort === 'asc' ? 1 : -1));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const selectedUsers = users.filter(user => selection.includes(user.username));
  const toggleUser = (username: string) => setSelection(previous => previous.includes(username) ? previous.filter(id => id !== username) : previous.length < 100 ? [...previous, username] : previous);
  const tabs = [['users','Users'],['groups','Groups'],['administrators','Administrators'],['access','Access preview'],['activity','Activity'],['feedback','Answer feedback'],['email','Email settings'],['branding','Name & logo'],['bob-key','Bob API key'],['buddy-profiles',brandText('Buddy profiles')],['data-protection','Data protection']];
  const refresh = async () => { setLoading(true); setError(''); try { await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not update user groups.'); } finally { setLoading(false); } };
  return <section className="administration-page buddy-surface user-management-page" aria-label={t("User groups & administrators")}>
    <WorkspaceSectionHeader level="h1" title={t('User groups & administrators')} description={t('Create groups, add people to them, and manage administrator access.')} actions={<button type="button" onClick={onBack}>{t('Back to chat')}</button>} />
    <Toolbar as="nav" className="administration-tabs" role="tablist" aria-label={t('Administration sections')}>{tabs.map(([value,label],index) => <button key={value} type="button" role="tab" id={`administration-tab-${value}`} aria-controls={`administration-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
      if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; setTab(tabs[next][0]); document.getElementById(`administration-tab-${tabs[next][0]}`)?.focus(); }
    }}>{t(label)}{value === 'administrators' && pending.length > 0 && <span className="directory-tab-count">{pending.length}</span>}</button>)}</Toolbar>
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    {notice && <p role="status" className="administration-notice">{t(notice, noticeValues)}</p>}
    <div id="administration-panel-users" role="tabpanel" aria-labelledby="administration-tab-users" hidden={tab !== 'users'}>
      <div className="directory-summary">{[['Total users', users.length, 'all'], ['Administrators', administrators, 'admin'], ['Users without a group', users.filter(user => !user.groups?.length).length, 'none']].map(([label,count,filter]) => <button type="button" key={label} disabled={!loaded || loading} onClick={() => { clearFilters(); if(filter === 'admin') setRoleFilter('admin'); if(filter === 'none') setGroupFilter('none'); }}><span>{t(String(label))}</span><strong>{loaded ? count : '—'}</strong></button>)}</div>
      <section className="directory-section" aria-labelledby="administration-users-title">
        <div className="directory-section-heading"><div><h2 id="administration-users-title">{t('User directory')}</h2><p>{t('Changes apply after saving.')}</p></div><div><button type="button" disabled={loading || busy !== null} onClick={() => void refresh()}>{t('Refresh users')}</button><button type="button" className="directory-primary" onClick={() => {setTab('administrators'); requestAnimationFrame(() => document.getElementById('administrator-grant-email')?.focus());}}>{t('Add an administrator')}</button></div></div>
        <div className="directory-filters" role="group" aria-label={t('Directory filters')}>
          <label className="directory-search">{t('Search users')}<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('Name, email, or account ID')} /></label>
          <label>{t('Group')}<select value={groupFilter} onChange={event => setGroupFilter(event.target.value)}><option value="all">{t('All groups')}</option>{groupOptions.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}<option value="none">{t('No group')}</option></select></label>
          <label>{t('Role')}<select value={roleFilter} onChange={event => setRoleFilter(event.target.value)}><option value="all">{t('All roles')}</option><option value="admin">{t('Administrator only')}</option><option value="member">{t('Members only')}</option></select></label>
          <label>{t('Sort users')}<select value={sort} onChange={event => setSort(event.target.value)}><option value="asc">{t('Name A–Z')}</option><option value="desc">{t('Name Z–A')}</option></select></label>
        </div>
        <div className="directory-results-bar"><label className="directory-select-page"><input type="checkbox" aria-label={t('Select displayed users')} checked={visible.length > 0 && visible.every(user => selection.includes(user.username))} disabled={loading || busy !== null || !visible.length} onChange={event => setSelection(previous => event.target.checked ? Array.from(new Set([...previous,...visible.map(user => user.username)])).slice(0,100) : previous.filter(id => !visible.some(user => user.username === id)))} />{t('Select displayed users')}</label><span role="status">{loading ? t('Loading users…') : !loaded ? '—' : t('Showing {0}–{1} of {2} users',[filtered.length ? (currentPage - 1) * 20 + 1 : 0, Math.min(currentPage * 20,filtered.length),filtered.length])}</span>{(search || groupFilter !== 'all' || roleFilter !== 'all') && <button type="button" onClick={clearFilters}>{t('Clear filters')}</button>}</div>
        {selectedUsers.length > 0 && <div className="directory-bulk-bar"><strong>{t('{0} users selected',[selectedUsers.length])}</strong><span>{t('Select up to 100 users.')}</span><div><button type="button" onClick={() => setSelection([])}>{t('Clear selection')}</button><button type="button" className="directory-primary" onClick={() => {setError('');setBulkOpen(true);}}>{t('Manage selected users')}</button></div></div>}
        <div className="administration-table directory-table"><table><thead><tr><th scope="col" className="directory-selection"><span className="sr-only">{t('Select displayed users')}</span></th><th scope="col">{t('Employee')}</th><th scope="col">{t('Groups')}</th><th scope="col">{t('Role')}</th><th scope="col">{t('Actions')}</th></tr></thead><tbody>{visible.map(user => {const name = user.display_name || user.username; return <tr key={user.username}><td className="directory-selection"><input type="checkbox" aria-label={t('Select {0}',[name])} checked={selection.includes(user.username)} disabled={busy !== null || (!selection.includes(user.username) && selection.length >= 100)} onChange={() => toggleUser(user.username)} /></td><th scope="row"><div className="directory-person"><span className="directory-avatar" aria-hidden="true">{name.slice(0,1).toUpperCase()}</span><div><strong>{name}</strong><small>{user.email || user.username}</small>{user.username === currentUser.username && <span className="directory-you">{t('Your account')}</span>}</div></div></th><td data-label={t('Groups')}>{user.groups?.map(group => group.name).join(', ') || t('No group')}</td><td data-label={t('Role')}><span className={`directory-badge ${user.is_admin ? 'is-admin' : ''}`}>{t(user.is_admin ? 'Administrator' : 'Workspace member')}</span></td><td><button type="button" disabled={busy !== null} aria-label={t('Edit {0}',[name])} onClick={() => {setError('');setEditing(user);}}>{t('Edit user')}</button></td></tr>;})}</tbody></table></div>
        {!loading && loaded && !filtered.length && <div className="directory-empty"><strong>{t(users.length ? 'No users match these filters.' : 'No users yet.')}</strong><p>{t('Try another search or clear the filters.')}</p>{users.length > 0 && <button type="button" onClick={clearFilters}>{t('Clear filters')}</button>}</div>}
        {filtered.length > 20 && <div className="directory-pagination"><span>{t('Page {0} of {1}',[currentPage,pages])}</span><div><button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t('Previous')}</button><button type="button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>{t('Next')}</button></div></div>}
        <details className="directory-access-note"><summary>{t('Manage user access')}</summary><p>{t('Groups decide which restricted documents and connections a person can use. Content for everyone stays available to all users. Group membership is independent of email domain and chat language.')}</p></details>
      </section>
    </div>
    <div id="administration-panel-groups" role="tabpanel" aria-labelledby="administration-tab-groups" hidden={tab !== 'groups'}>{currentUser.is_admin && tab === 'groups' && <LearningPeopleAdmin onChanged={() => void refresh()} />}</div>
    <div id="administration-panel-administrators" role="tabpanel" aria-labelledby="administration-tab-administrators" hidden={tab !== 'administrators'}><section aria-labelledby="administration-grants-title"><h2 id="administration-grants-title">{t('Add an administrator')}</h2><p>{t('Grant access to an existing account or reserve it for a verified email at the next company sign-in. At least one administrator must remain.')}</p>
      <form className="administration-invite" onSubmit={event => void invite(event)}><label>{t('Administrator email')}<input id="administrator-grant-email" type="email" required value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" /></label><button type="submit" disabled={busy !== null || !email.trim()}>{t(busy === 'invite' ? 'Saving…' : 'Add administrator')}</button></form>
      {pending.length > 0 && <div><h3>{t('Pending administrator access')}</h3><ul>{pending.map(address => <li key={address}><span>{address}</span><button type="button" disabled={busy !== null} onClick={() => void removePending(address)} aria-label={t('Remove pending administrator {0}', [address])}>{t('Remove')}</button></li>)}</ul></div>}
    </section></div>
    <div id="administration-panel-access" role="tabpanel" aria-labelledby="administration-tab-access" hidden={tab !== 'access'}><AccessPreview /></div>
    <div id="administration-panel-activity" role="tabpanel" aria-labelledby="administration-tab-activity" hidden={tab !== 'activity'}><AuditHistory /></div>
    <div id="administration-panel-feedback" role="tabpanel" aria-labelledby="administration-tab-feedback" hidden={tab !== 'feedback'}><FeedbackReview /></div>
    <div id="administration-panel-email" role="tabpanel" aria-labelledby="administration-tab-email" hidden={tab !== 'email'}>{currentUser.is_admin && <SmtpSettings />}</div>
    <div id="administration-panel-branding" role="tabpanel" aria-labelledby="administration-tab-branding" hidden={tab !== 'branding'}>{currentUser.is_admin && tab === 'branding' && <BrandingSettings />}</div>
    <div id="administration-panel-bob-key" role="tabpanel" aria-labelledby="administration-tab-bob-key" hidden={tab !== 'bob-key'}>{currentUser.is_admin && tab === 'bob-key' && <BobKeySettings />}</div>
    <div id="administration-panel-buddy-profiles" role="tabpanel" aria-labelledby="administration-tab-buddy-profiles" hidden={tab !== 'buddy-profiles'}>{currentUser.is_admin && tab === 'buddy-profiles' && <BuddyProfiles />}</div>
    <div id="administration-panel-data-protection" role="tabpanel" aria-labelledby="administration-tab-data-protection" hidden={tab !== 'data-protection'}>{currentUser.is_admin && tab === 'data-protection' && <DataProtectionSettings />}</div>
    {bulkOpen && <BulkUserEditor users={selectedUsers} administrators={administrators} busy={busy !== null} error={error} onClose={() => setBulkOpen(false)} onSave={saveBulk} />}
    {editing && <ManagedUserEditor key={editing.username} user={editing} currentUsername={currentUser.username} lastAdministrator={editing.is_admin && administrators === 1} busy={busy !== null} error={error} onClose={() => setEditing(null)} onSave={save} />}
  </section>;
}
