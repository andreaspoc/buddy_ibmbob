import { skillDisplayName } from '../lib/skillNames';
import { Toolbar } from './Toolbar';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { TutorialPreference } from './SkillsGuide';
import type { TutorialPreferenceProps } from './SkillsGuide';
import { useEffect, useState } from 'react';
import type { Mode, Skill } from '../types';
export interface AssistantPreset { id: string; name: string; instructions: string; mode: string; skill_name: string | null; web_search: boolean }
interface Memory { id: string; content: string; enabled: boolean }
import { personalRequest } from '../lib/personalRequest';
export { personalRequest } from '../lib/personalRequest';
export function PersonalizationManager({ modes, skills, onClose, onPresetsChanged, onShowTutorials, ...tutorialProps }: { modes: Mode[]; skills: Skill[]; onClose: () => void; onPresetsChanged: () => void; onShowTutorials: () => void } & TutorialPreferenceProps) {
  const [tab, setTab] = useState<'memories' | 'presets'>('memories');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [presets, setPresets] = useState<AssistantPreset[]>([]);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState<Omit<AssistantPreset, 'id'>>({ name: '', instructions: '', mode: 'agent', skill_name: null, web_search: false });
  const [editing, setEditing] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const hasWebSearchSkill = skills.some(skill => skill.name === 'research-buddy');
  const draftSkill = skills.some(skill => skill.name === draft.skill_name) ? draft.skill_name : null;
  const load = async () => { const [m, p] = await Promise.all([personalRequest('memories'), personalRequest('presets')]); setMemories(m); setPresets(p); };
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await load(); onPresetsChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="feature-overlay"><section className="feature-dialog personalization-dialog buddy-surface" role="dialog" aria-modal="true" aria-label={t("Memory and assistant presets")}>
    <WorkspaceSectionHeader title={t("Memory & assistant presets")} eyebrow={t("YOUR BUDDY WORKSPACE")} compact actions={<button className="feature-close" type="button" onClick={onClose}>{t("Close")}</button>} />
    <TutorialPreference {...tutorialProps} /><button type="button" onClick={() => { onClose(); onShowTutorials(); }}>{t("Replay welcome tutorial")}</button>
    <Toolbar as="nav" aria-label={t("Personalization settings")}><button type="button" aria-pressed={tab === 'memories'} onClick={() => { setTab('memories'); setEditing(''); }}>{t("Personal memory")}</button><button type="button" aria-pressed={tab === 'presets'} onClick={() => { setTab('presets'); setEditing(''); }}>{t("Assistant presets")}</button></Toolbar>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {tab === 'memories' ? <><p>{t("Buddy uses your signed-in name and enabled preferences across your conversations. Save your role, preferred language, answer style, or reporting format here. Memories are private to your account.")}</p>
      {memories.map(m => <div className="feature-row" key={m.id}><label><input type="checkbox" checked={m.enabled} disabled={busy} onChange={() => { void run(() => personalRequest('memories/' + m.id, 'PUT', { content: m.content, enabled: !m.enabled })); }} />{m.content}</label><button type="button" onClick={() => { setEditing(m.id); setContent(m.content); }}>{t("Edit")}</button><button type="button" disabled={busy} onClick={() => { void run(() => personalRequest('memories/' + m.id, 'DELETE')); }}>{t("Delete")}</button></div>)}
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await personalRequest('memories' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', { content, enabled: true }); setContent(''); setEditing(''); }); }}><label>{t("Preference")}<textarea required maxLength={1000} value={content} onChange={e => setContent(e.target.value)} placeholder={t("Use British English, concise answers, and executive-ready summaries.")} /></label><button type="submit" className="feature-primary" disabled={busy}>{editing ? t("Update memory") : t("Save memory")}</button>{editing && <button type="button" onClick={() => { setEditing(''); setContent(''); }}>{t("Cancel edit")}</button>}</form>
    </> : <><p>{t("Save instructions, a mode, an optional skill, and web search settings. Select a preset above the chat before sending.")}</p>
      {presets.map(p => <div className="feature-row" key={p.id}><strong>{p.name}</strong><span>{p.mode}</span><button type="button" onClick={() => { setEditing(p.id); setDraft(p); }}>{t("Edit")}</button><button type="button" disabled={busy} onClick={() => { void run(() => personalRequest('presets/' + p.id, 'DELETE')); }}>{t("Delete")}</button></div>)}
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await personalRequest('presets' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', { ...draft, skill_name: draftSkill, web_search: draft.web_search && hasWebSearchSkill }); setEditing(''); setDraft({ name: '', instructions: '', mode: 'agent', skill_name: null, web_search: false }); }); }}>
      <label>{t("Name")}<input required maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>{t("Instructions")}<textarea maxLength={6000} value={draft.instructions} onChange={e => setDraft({ ...draft, instructions: e.target.value })} /></label>
      <label>{t("Mode")}<select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value })}>{modes.filter(m => m.slug !== 'presentation').map(m => <option key={m.slug} value={m.slug}>{t(m.name)}</option>)}</select></label>
      <label>{t("Skill")}<select value={draftSkill || ''} onChange={e => setDraft({ ...draft, skill_name: e.target.value || null })}><option value="">{t("Automatic")}</option>{skills.map(s => <option key={s.name} value={s.name}>{skillDisplayName(s.name)}</option>)}</select></label>
      <label className="feature-checkbox"><input type="checkbox" checked={draft.web_search && hasWebSearchSkill} disabled={!hasWebSearchSkill} onChange={e => setDraft({ ...draft, web_search: e.target.checked })} />{t("Enable web search")}</label><button type="submit" className="feature-primary" disabled={busy}>{editing ? t("Update preset") : t("Save preset")}</button>{editing && <button type="button" onClick={() => setEditing('')}>{t("Cancel edit")}</button>}</form>
    </>}
  </section></div>;
}
