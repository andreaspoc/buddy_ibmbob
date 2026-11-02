import { skillDisplayName } from '../lib/skillNames';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { useEffect, useState } from 'react';
import * as api from '../api';
import type { SkillDetail } from '../types';

export function SkillEditModal({ name, onClose, onSaved, onDeleted, startDelete = false }: {
  name: string; onClose: () => void; onSaved: () => Promise<void>; onDeleted: (name: string) => Promise<void>; startDelete?: boolean;
}) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(startDelete);
  useEffect(() => {
    const controller = new AbortController();
    api.fetchSkill(name, controller.signal).then(setSkill).catch(err => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load skill');
    });
    return () => controller.abort();
  }, [name]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!skill || saving || confirmDelete) return;
    setSaving(true); setError('');
    try {
      await api.updateSkill(name, { description: skill.description.trim(), instructions: skill.instructions.trim() });
      await onSaved();
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save skill'); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try { await api.deleteSkill(name); await onDeleted(name); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not delete skill'); }
    finally { setSaving(false); }
  };

  return <div className="modal-backdrop" onClick={() => { if (!saving) onClose(); }}>
    <div className="create-dialog skill-edit-dialog buddy-surface" role="dialog" aria-modal="true" aria-labelledby="skill-edit-title"
      onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape" && !saving) onClose(); }}>
      <form onSubmit={save}>
        <WorkspaceSectionHeader compact title={confirmDelete ? t("Delete skill?") : t("Edit skill")} eyebrow={t("SKILL SETTINGS")} titleId="skill-edit-title" actions={<button type="button" className="dialog-close" aria-label={t("Close skill editor")} disabled={saving} onClick={onClose}>×</button>} />
        <p className="dialog-intro">{confirmDelete
          ? t("This removes the skill, its instructions and supporting files from your account and clears saved skill selections. Workflows using this skill will be disabled. Deleted skills will stay removed.")
          : t("Update how this skill works for your account.")}</p>
        <label>{t("Skill name")}<input value={skillDisplayName(name)} readOnly /></label>
        {!skill && !error && <p role="status">{t("Loading skill…")}</p>}
        {skill && !confirmDelete && <>
          <label>{t("Description")}<input autoFocus value={skill.description} disabled={saving} maxLength={400}
            onChange={event => setSkill({ ...skill, description: event.target.value })} /></label>
          <label>{t("Instructions")}<textarea value={skill.instructions} rows={12} maxLength={10000} required disabled={saving}
            onChange={event => setSkill({ ...skill, instructions: event.target.value })} /></label>
        </>}
        {error && <p className="skill-edit-error" role="alert">{t(error)}</p>}
        <div className="skill-edit-actions">
          {confirmDelete ? <>
            <button type="button" className="cancel-button" disabled={saving} onClick={() => setConfirmDelete(false)}>{t("Keep skill")}</button>
            <button type="button" className="save-button skill-delete-confirm" disabled={saving || !skill} onClick={() => void remove()}>{saving ? t("Deleting…") : t("Delete skill")}</button>
          </> : <>
          <button type="button" className="cancel-button skill-delete-link" disabled={saving || !skill} onClick={() => setConfirmDelete(true)}>{t("Delete skill")}</button>
          <button type="button" className="cancel-button" disabled={saving} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="save-button" disabled={saving || !skill?.instructions.trim()}>{saving ? t("Saving…") : t("Save changes")}</button>
          </>}
        </div>
      </form>
    </div>
  </div>;
}
