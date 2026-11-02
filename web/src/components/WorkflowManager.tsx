import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t, getLanguage, getLocale } from "../lib/i18n";
import { useEffect, useState } from 'react';
import type { PresentationTemplate, Project, Skill } from '../types';

interface SavedWorkflow {
  id: string; name: string; enabled: boolean; frequency?: string;
  time: string; timezone: string; next_run?: string; last_job_id?: string; last_error?: string;
}

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch('/workflows' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined && method === 'GET' ? undefined : JSON.stringify({ ...(body as Record<string, unknown> | undefined), ui_language: getLanguage() }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not complete workflow request. Check the form and try again.');
  return data;
}

export function WorkflowManager({ projects, skills, templates, onClose, onTask }: {
  projects: Project[]; skills: Skill[]; templates: PresentationTemplate[];
  onClose: () => void; onTask: (id: string) => void;
}) {
  const [items, setItems] = useState<SavedWorkflow[]>([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [roles, setRoles] = useState('');
  const [criteria, setCriteria] = useState('');
  const [iterations, setIterations] = useState(1);
  const [timeout, setTimeoutSeconds] = useState(900);
  const [project, setProject] = useState('');
  const [skill, setSkill] = useState('');
  const [search, setSearch] = useState(false);
  const [searchReady, setSearchReady] = useState(false);
  const [format, setFormat] = useState('');
  const [template, setTemplate] = useState(templates[0]?.id || '');
  const [slides, setSlides] = useState(5);
  const [frequency, setFrequency] = useState('');
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function reload() { setItems(await request('')); }
  useEffect(() => {
    let active = true;
    Promise.all([request(''), request('/capabilities')]).then(([rows, capabilities]) => {
      if (active) { setItems(rows); setSearchReady(capabilities.web_search); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { setBusy(false); }
  }
  async function submit(run: boolean) {
    await action(async () => {
      const spec = { name, prompt, project_id: project || null, skill_name: skill || null,
        roles: roles.split('\n').map(r => r.trim()).filter(Boolean), completion_criteria: criteria,
        max_iterations: iterations, timeout_seconds: timeout, web_search: search,
        presentation_format: format || null, template_id: format ? template : null,
        slide_count: format ? slides : null, frequency: frequency || null, timezone: zone, time, weekday };
      const result = await request(run ? '/run' : '', 'POST', spec);
      if (run) onTask(result.job_id);
      else { await reload(); setNotice(frequency ? 'Scheduled workflow saved.' : 'Reusable workflow saved.'); }
    });
  }
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="workflow-manager buddy-surface" role="dialog" aria-modal="true" aria-labelledby="workflow-title" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <WorkspaceSectionHeader title={t("Automations & agent teams")} titleId="workflow-title" compact actions={<button type="button" onClick={onClose} aria-label={t("Close workflows")}>✕</button>} />
      <p>{t("Create background tasks with optional specialist sub-agents and completion review. Team roles run sequentially in the same workspace. Stop running work from Tasks.")}</p>
      {error && <p role="alert" className="workflow-error">{t(error)}</p>}
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={e => { e.preventDefault(); void submit(false); }}>
        <label>{t("Name")}<input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder={t("Weekly operations report")} /></label>
        <label>{t("Instructions")}<textarea required maxLength={20000} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t("Describe the result Buddy should produce and the sources to use.")} /></label>
        <div className="workflow-grid">
          <label>{t("Workspace")}<select value={project} onChange={e => setProject(e.target.value)}><option value="">{t("New private conversation each run")}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>{t("Skill")}<select value={skill} onChange={e => setSkill(e.target.value)}><option value="">{t("Choose automatically")}</option>{skills.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>
        </div>
        <label>{t("Specialist roles (optional; one per line, maximum 3)")}<textarea rows={3} value={roles} onChange={e => setRoles(e.target.value)} placeholder={t("Researcher: gather sources and facts\nAnalyst: verify calculations\nEditor: check clarity and consistency")} /></label>
 <label>{t("Completion criteria")}<textarea rows={2} maxLength={2000} value={criteria} onChange={e => setCriteria(e.target.value)} required={iterations > 1} placeholder={t("An independent reviewer checks these criteria. Required for multiple iterations.")} /></label>
        <div className="workflow-grid">
          <label>{t("Maximum iterations")}<input type="number" min={1} max={3} required value={iterations} onChange={e => setIterations(Number(e.target.value))} /></label>
          <label>{t("Total time limit (seconds)")}<input type="number" min={60} max={3600} required value={timeout} onChange={e => setTimeoutSeconds(Number(e.target.value))} /></label>
        </div>
        <label className="workflow-checkbox"><input type="checkbox" disabled={!searchReady} checked={search} onChange={e => setSearch(e.target.checked)} />{t("Use live web search")}{searchReady ? '' : t("(configure BRAVE_API_KEY to enable)")}</label>
        <label>{t("Output")}<select value={format} onChange={e => setFormat(e.target.value)}><option value="">{t("General task / report")}</option><option value="pptx">{t("PowerPoint presentation")}</option><option value="html">{t("Interactive HTML presentation")}</option></select></label>
        {format && <div className="workflow-grid">
          <label>{t("Presentation template")}<select required value={template} onChange={e => setTemplate(e.target.value)}>{templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
          <label>{t("Slide count")}<input type="number" min={1} max={50} value={slides} onChange={e => setSlides(Number(e.target.value))} /></label>
        </div>}
        <label>{t("Schedule")}<select value={frequency} onChange={e => setFrequency(e.target.value)}><option value="">{t("Manual only")}</option><option value="daily">{t("Daily")}</option><option value="weekly">{t("Weekly")}</option></select></label>
        {frequency && <div className="workflow-grid">
          <label>{t("Time")}<input type="time" required value={time} onChange={e => setTime(e.target.value)} /></label>
          <label>{t("Timezone")}<input required value={zone} onChange={e => setZone(e.target.value)} placeholder={t("Europe/London")} /></label>
          {frequency === 'weekly' && <label>{t("Weekday")}<select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>{[t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday"), t("Sunday")].map((day, i) => <option key={day} value={i}>{day}</option>)}</select></label>}
        </div>}
        <div className="workflow-actions"><button disabled={busy} type="submit">{frequency ? t("Save schedule") : t("Save workflow")}</button><button disabled={busy || !name.trim() || !prompt.trim()} type="button" onClick={() => void submit(true)}>{t("Run now")}</button></div>
      </form>
      <h3>{t("Saved workflows")}</h3>
      {!items.length && <p>{t("No saved workflows yet.")}</p>}
      {items.map(item => <article className="workflow-item" key={item.id}>
        <strong>{item.name}</strong>
        <p>{item.frequency ? `${item.enabled ? t("Active") : t("Paused")} · ${item.frequency} at ${item.time} (${item.timezone})` : t("Manual workflow")}</p>
        {item.next_run && <p>{t("Next run:")}{new Date(item.next_run).toLocaleString(getLocale())}</p>}
        {item.last_error && <p className="workflow-error">{item.last_error}</p>}
        <div className="workflow-actions">
          <button disabled={busy} onClick={() => void action(async () => { const result = await request(`/${item.id}/run`, 'POST'); onTask(result.job_id); })}>{t("Run now")}</button>
          {item.frequency && <button disabled={busy} onClick={() => void action(async () => { await request(`/${item.id}`, 'PATCH', { enabled: !item.enabled }); await reload(); })}>{item.enabled ? t("Pause") : t("Resume")}</button>}
          {item.last_job_id && <button onClick={() => onTask(item.last_job_id!)}>{t("Last task")}</button>}
          <button disabled={busy} onClick={() => void action(async () => { await request(`/${item.id}`, 'DELETE'); await reload(); })}>{t("Delete workflow")}</button>
        </div>
      </article>)}
    </section>
  </div>;
}
