import { brandText } from '../lib/brand';
import { useEffect, useRef, useState } from 'react';
import { Add, Close, Edit, TrashCan } from '@carbon/icons-react';
import type { Skill, SkillDetail } from '../types';
import { buddySkillName, skillDisplayName } from '../lib/skillNames';
import { t } from '../lib/i18n';
import * as api from '../api';
import './SkillsManager.scss';

export function SkillsManager({ skills, onClose, onChanged, startCreate = false }: {
  skills: Skill[]; onClose: () => void; onChanged: () => Promise<void>; startCreate?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const [view, setView] = useState<'list' | 'create' | 'edit' | 'delete'>(startCreate ? 'create' : 'list');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<SkillDetail>({name:'',description:'',instructions:''});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog.current;
    modal?.showModal();
    return () => { request.current?.abort(); modal?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('[data-skill-heading]')?.focus(); }, [view]);
  const back = () => { request.current?.abort(); setError(''); setBusy(false); setView('list'); };
  const create = () => { request.current?.abort(); setDraft({name:'',description:'',instructions:''}); setError(''); setNotice(''); setView('create'); };
  const edit = async (skill: Skill) => {
    if (lock.current) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setDraft({...skill,instructions:''}); setError(''); setNotice(''); setView('edit'); setBusy(true);
    try { const result = await api.fetchSkill(skill.name, controller.signal); if (!controller.signal.aborted) setDraft(result); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load skill'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const mutate = async (action: () => Promise<unknown>, message: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); await onChanged(); setView('list'); setNotice(message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save skill'); }
    finally { lock.current = false; setBusy(false); }
  };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !draft.instructions.trim()) return;
    const stem = draft.name.trim().toLowerCase().replace(/[\s_]+/g,'-');
    if (view === 'create' && !/^[a-z][a-z0-9-]{0,63}$/.test(stem)) { setError('Use a name starting with a letter, using letters A–Z, numbers, spaces or hyphens.'); return; }
    const updates = {description:draft.description.trim(),instructions:draft.instructions.trim()};
    void mutate(() => view === 'create' ? api.createSkill({name:buddySkillName(stem),...updates}) : api.updateSkill(draft.name,updates), t('Skill saved.'));
  };
  const title = view === 'create' ? 'Add a skill' : view === 'edit' ? 'Edit skill' : view === 'delete' ? 'Delete skill?' : 'Manage skills';
  const matching = skills.filter(skill => `${skillDisplayName(skill.name)} ${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <dialog ref={dialog} className="skills-manager" aria-labelledby="skills-manager-title" aria-busy={busy} onCancel={event => { event.preventDefault(); if (!lock.current) onClose(); }}>
    <header><div><h2 id="skills-manager-title" data-skill-heading tabIndex={-1}>{t(title)}</h2><p>{t('Create and manage the skills saved to your account.')}</p></div><button type="button" className="skills-manager-icon" disabled={busy} aria-label={t('Close skills manager')} onClick={onClose}><Close size={20} /></button></header>
    {notice && <p className="skills-manager-notice" role="status">{notice}</p>}
    {error && <p className="skills-manager-error" role="alert">{t(error)}</p>}
    {view === 'list' ? <>
      <div className="skills-manager-tools"><label>{t('Find a skill')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="skills-manager-primary" onClick={create}><Add size={16} />{t('Add skill')}</button></div>
      {!skills.length && <p>{t('No skills are available. Add a skill to get started.')}</p>}
      {!!skills.length && !matching.length && <p role="status">{t('No matching skills')}</p>}
      <ul className="skills-manager-list">{matching.map(skill => <li key={skill.name}><div><h3>{skillDisplayName(skill.name)}</h3><p>{t(skill.description)}</p></div><div className="skills-manager-row-actions"><button type="button" aria-label={t('Edit skill {0}',[skillDisplayName(skill.name)])} onClick={() => void edit(skill)}><Edit size={16} />{t('Edit')}</button><button type="button" className="skills-manager-delete-link" aria-label={t('Delete skill {0}',[skillDisplayName(skill.name)])} onClick={() => { setDraft({...skill,instructions:''}); setError(''); setNotice(''); setView('delete'); }}><TrashCan size={16} />{t('Delete')}</button></div></li>)}</ul>
    </> : view === 'delete' ? <section className="skills-manager-confirm">
      <h3>{skillDisplayName(draft.name)}</h3><p>{t('Delete this skill, its instructions and supporting files from your account? Saved skill selections will be cleared, and workflows using it will be disabled. Deleted skills will stay removed.')}</p>
      <div className="skills-manager-footer"><button type="button" disabled={busy} onClick={back}>{t('Keep skill')}</button><button type="button" className="skills-manager-danger" disabled={busy} onClick={() => void mutate(() => api.deleteSkill(draft.name),t('Skill deleted.'))}>{t(busy ? 'Deleting…' : 'Delete skill')}</button></div>
    </section> : <form onSubmit={save}>
      <fieldset disabled={busy}><label>{t('Skill name')}<input required maxLength={64} readOnly={view==='edit'} value={view==='edit' ? skillDisplayName(draft.name) : draft.name} placeholder={brandText("Support Buddy")} onChange={event => setDraft({...draft,name:event.target.value})} /></label>
      <label>{t('Description')}<textarea required={view === 'create'} minLength={view === 'create' ? 5 : undefined} rows={2} maxLength={400} value={draft.description} placeholder={t('When should Buddy use this skill?')} onChange={event => setDraft({...draft,description:event.target.value})} /></label>
      <label>{t('Instructions')}<textarea required rows={10} maxLength={10000} value={draft.instructions} placeholder={t('Describe what the skill should do, the context it needs, and the result it should produce.')} onChange={event => setDraft({...draft,instructions:event.target.value})} /></label></fieldset>
      {busy && <p role="status">{t('Working…')}</p>}
      <div className="skills-manager-footer"><button type="button" disabled={busy} onClick={back}>{t('Back to skills')}</button><button type="submit" className="skills-manager-primary" disabled={busy || !draft.name.trim() || !draft.instructions.trim() || (view === 'create' && draft.description.trim().length < 5)}>{t(busy ? 'Saving…' : 'Save skill')}</button></div>
    </form>}
  </dialog>;
}
