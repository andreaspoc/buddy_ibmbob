import { useEffect, useRef, useState } from 'react';
import type { ManagedUser } from '../types';
import { t } from '../lib/i18n';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';

export function ManagedUserEditor({ user, currentUsername, lastAdministrator, busy, error, onClose, onSave }: {
  user: ManagedUser; currentUsername: string; lastAdministrator: boolean; busy: boolean; error: string;
  onClose: () => void; onSave: (draft: ManagedUser) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(user);
  const name = user.display_name || user.username;
  const dirty = draft.is_admin !== user.is_admin;
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  return <dialog ref={dialog} className="managed-user-editor buddy-surface" aria-labelledby="managed-user-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <WorkspaceSectionHeader title={t('Edit user')} titleId="managed-user-title" compact actions={<button type="button" disabled={busy} onClick={onClose} aria-label={t('Close user editor')}>×</button>} />
    <div className="managed-user-identity"><span className="directory-avatar" aria-hidden="true">{name.slice(0,1).toUpperCase()}</span><div><strong>{name}</strong><span>{user.email || user.username}</span>{user.username === currentUsername && <small>{t('Your account')}</small>}</div></div>
    <details className="managed-user-account"><summary>{t('User details')}</summary><dl><dt>{t('Account ID')}</dt><dd>{user.username}</dd><dt>{t('Groups')}</dt><dd>{user.groups?.map(group => group.name).join(', ') || t('No groups')}</dd></dl></details>
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    <form onSubmit={async event => { event.preventDefault(); if (dirty && !busy && await onSave(draft)) onClose(); }}>
      <fieldset disabled={busy}>
        <label className="managed-user-switch"><span><strong>{t('Administrator')}</strong><small>{t('Manage user access')}</small></span><input type="checkbox" aria-label={t('Administrator access for {0}', [name])} checked={draft.is_admin} disabled={lastAdministrator} onChange={event => setDraft({...draft,is_admin:event.target.checked})} /></label>
        {lastAdministrator && <p className="managed-user-hint">{t('This is the last administrator. Add another administrator before removing this role.')}</p>}
      </fieldset>
      <p className="managed-user-hint">{t('Changes apply after saving.')}</p>
      <div className="managed-user-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button type="submit" className="directory-primary" disabled={!dirty || busy}>{t(busy ? 'Saving…' : 'Save changes')}</button></div>
    </form>
  </dialog>;
}
