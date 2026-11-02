import { useEffect, useRef, useState } from 'react';
import type { ManagedUser } from '../types';
import { t } from '../lib/i18n';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';

export type UserAssignmentChanges = Partial<Pick<ManagedUser, 'is_admin'>>;
export function BulkUserEditor({ users, administrators, busy, error, onClose, onSave }: {
  users: ManagedUser[]; administrators: number; busy: boolean; error: string;
  onClose: () => void; onSave: (changes: UserAssignmentChanges) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [role,setRole] = useState('keep');
  const removesEveryAdmin = administrators > 0 && users.filter(user => user.is_admin).length === administrators;
  const changes: UserAssignmentChanges = {};
  if (role !== 'keep') changes.is_admin = role === 'admin';
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLSelectElement>('select')?.focus(); }, []);
  return <dialog ref={dialog} className="managed-user-editor bulk-user-editor buddy-surface" aria-label={t('Bulk user settings')} onCancel={event => {event.preventDefault();if(!busy) onClose();}}>
    <WorkspaceSectionHeader compact title={t('Configure {0} users',[users.length])} actions={<button type="button" disabled={busy} onClick={onClose} aria-label={t('Close user editor')}>×</button>} />
    <p className="managed-user-hint">{t('Apply only the fields you change. All other settings stay as they are.')}</p>
    <details className="managed-user-account"><summary>{t('Selected users')} · {users.length}</summary><ul>{users.map(user => <li key={user.username}>{user.display_name || user.username}<small>{user.email || user.username}</small></li>)}</ul></details>
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    <form onSubmit={async event => {event.preventDefault();if(Object.keys(changes).length && !busy && await onSave(changes)) onClose();}}><fieldset disabled={busy}>
      <label>{t('Role')}<select value={role} onChange={event => setRole(event.target.value)}><option value="keep">{t('Keep unchanged')}</option><option value="admin">{t('Make administrators')}</option><option value="member" disabled={removesEveryAdmin}>{t('Make workspace members')}</option></select></label>
      {removesEveryAdmin && <p className="managed-user-hint">{t('At least one administrator must remain.')}</p>}
    </fieldset><div className="managed-user-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button type="submit" className="directory-primary" disabled={busy || !Object.keys(changes).length}>{t(busy ? 'Saving…' : 'Apply changes')}</button></div></form>
  </dialog>;
}
