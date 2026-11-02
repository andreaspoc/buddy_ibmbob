import { audienceLabel } from '../lib/accessGroups';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { useEffect, useRef, useState } from 'react';
import { accessRequest, type AccessProfile } from '../accessApi';
import { t, useLanguage } from '../lib/i18n';
import './AdministrationPage.css';
export function MyAccessPanel({ onClose }: { onClose: () => void }) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const [profile, setProfile] = useState<AccessProfile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; accessRequest<AccessProfile>('/access/me').then(data => { if (active) setProfile(data); }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, []);
  return <dialog ref={dialog} className="feature-dialog my-access-dialog buddy-surface" aria-label={t('My access')} onCancel={onClose}>
    <WorkspaceSectionHeader title={t('My access')} compact actions={<button type="button" onClick={onClose} aria-label={t('Close')}>×</button>} />
    {error ? <p role="alert" className="form-error">{t(error)}</p> : !profile ? <p role="status">{t('Loading access…')}</p> : <>
      <p>{profile.user.display_name || profile.user.username}{profile.user.email && <span className="access-email">{profile.user.email}</span>}</p>
      <dl className="access-details"><dt>{t('Groups')}</dt><dd>{profile.user.groups?.map(group => group.name).join(', ') || t('No groups')}</dd><dt>{t('Administrator')}</dt><dd>{t(profile.administrator ? 'Yes' : 'No')}</dd></dl>
      <h3>{t('Available knowledge libraries')}</h3><ul className="access-libraries">{profile.libraries.map(library => <li key={library.id}>{t('Company Knowledge')}</li>)}</ul>
      <p>{t('Applicable policies')}: {profile.audiences.map(audience => audienceLabel(audience, profile.user.groups ?? [])).join(', ')}</p>
      <h3>{t('Available MCP connections')}</h3>{profile.mcps?.length ? <ul className="access-libraries">{profile.mcps.map(server => <li key={server.name}>{server.name}</li>)}</ul> : <p>{t('No MCP connections are available for your groups.')}</p>}
      {profile.administrator && <p>{t('Administrators can manage all documents and MCP connections. Your groups determine which policies and connections are available to your chat.')}</p>}
      <p>{t('Contact an administrator if your groups need updating.')}</p>
    </>}
  </dialog>;
}
