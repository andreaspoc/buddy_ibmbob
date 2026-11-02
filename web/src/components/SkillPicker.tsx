import { useId, useState } from 'react';
import { Analytics, Edit, PresentationFile, Search, Code, Idea, TaskComplete, Security, Settings, Folder, DataBase, Application } from '@carbon/icons-react';
import type { Skill } from '../types';
import { skillDisplayName } from '../lib/skillNames';
import { t } from '../lib/i18n';
import './SkillPicker.scss';

// Decorative task cues; names and descriptions remain the accessible labels.
const skillIcons = [
  {match: /presentation|slide|deck/, icon: PresentationFile, tone: 'purple'},
  {match: /research|search|browse/, icon: Search, tone: 'blue'},
  {match: /analy|chart|excel|spreadsheet/, icon: Analytics, tone: 'teal'},
  {match: /writ|document|note|content|summar/, icon: Edit, tone: 'magenta'},
  {match: /code|develop|debug|software/, icon: Code, tone: 'blue'},
  {match: /secur|audit|privacy/, icon: Security, tone: 'teal'},
  {match: /data|database|sql/, icon: DataBase, tone: 'teal'},
  {match: /project|task|plan|meeting/, icon: TaskComplete, tone: 'purple'},
  {match: /file|folder|office/, icon: Folder, tone: 'blue'},
  {match: /idea|creat|design/, icon: Idea, tone: 'magenta'},
  {match: /config|setting|system/, icon: Settings, tone: 'purple'},
];
function SkillIcon({name}: {name: string}) {
  const {icon: Icon, tone} = skillIcons.find(item => item.match.test(name.toLowerCase())) || {icon: Application, tone: 'purple'};
  return <span className={`skill-picker-icon skill-picker-icon-${tone}`} aria-hidden="true"><Icon size={20} /></span>;
}

/** Select instructions for the next question; selecting never sends a message. */
export function SkillPicker({ skills, selected, disabled = false, onSelect, onManage, onAdd }: {
  skills: Skill[]; selected: string[]; disabled?: boolean; onSelect: (name: string) => void; onManage?: () => void; onAdd?: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const matching = [...skills].sort((a, b) => a.name.localeCompare(b.name)).filter(skill =>
    `${skill.name} ${skillDisplayName(skill.name)} ${t(skill.description)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visible = matching;
  return <section className="skill-picker" aria-labelledby={`${id}-title`}>
    <div className="skill-picker-heading"><div><h3 id={`${id}-title`}>{t('Choose skills')}</h3><p>{t('Select up to 6 skills, then ask your question.')}</p></div>
      <button type="button" className="skill-picker-automatic" disabled={disabled} aria-pressed={selected.length === 0} onClick={() => onSelect('')}>{t('Automatic')}</button>
    </div>
    {(onAdd || onManage) && <div className="skill-picker-management">{onAdd && <button type="button" className="skill-picker-automatic" disabled={disabled} onClick={onAdd}>{t('Add skill')}</button>}{onManage && <button type="button" className="skill-picker-automatic" disabled={disabled} onClick={onManage}>{t('Manage skills')}</button>}</div>}
    <label className="skill-picker-search"><span>{t('Find a skill')}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search skills by name or task…')} /></label>
    {!skills.length ? <p role="status">{t('No skills are available. You can still ask Buddy a question.')}</p> : <>
      <div className="skill-picker-grid" role="group" aria-label={t('Available skills')}>
        {visible.map(skill => <button key={skill.name} type="button" className="skill-picker-card" disabled={disabled || (selected.length >= 6 && !selected.includes(skill.name))} aria-pressed={selected.includes(skill.name)} onClick={() => onSelect(skill.name)}>
          <span className="skill-picker-card-title"><span className="skill-picker-card-name"><SkillIcon name={skill.name} /><span>{skillDisplayName(skill.name)}</span></span>{selected.includes(skill.name) && <span className="skill-picker-selected" aria-hidden="true">✓</span>}</span>
          {skill.description && <span className="skill-picker-card-description">{t(skill.description)}</span>}
        </button>)}
      </div>
      {!matching.length && <p role="status">{t('No matching skills')}</p>}
      <p role="status">{selected.length} / 6 {t('skills selected')}</p>
    </>}
  </section>;
}
