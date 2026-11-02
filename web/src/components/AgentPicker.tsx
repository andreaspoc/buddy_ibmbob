import { useId, useState } from 'react';
import { Bot } from '@carbon/icons-react';
import type { A2AAgent } from '../types';
import { t } from '../lib/i18n';
import './SkillPicker.scss';

export function AgentPicker({
  agents,
  selected,
  disabled = false,
  onChange,
  onManage,
}: {
  agents: A2AAgent[];
  selected: string[];
  disabled?: boolean;
  onChange: (slugs: string[]) => void;
  onManage?: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const matching = [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(agent =>
      `${agent.name} ${agent.slug} ${agent.description || ''} ${agent.endpoint || ''}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
    );

  return (
    <section className="skill-picker" aria-labelledby={`${id}-title`}>
      <div className="skill-picker-heading">
        <div>
          <h3 id={`${id}-title`}>{t('Choose agents')}</h3>
          <p>
            {t('Select agents to collaborate in this conversation, then ask your question. Nothing is sent until you press Send.')}
          </p>
        </div>
        <button
          type="button"
          className="skill-picker-automatic"
          disabled={disabled}
          aria-pressed={!selected.length}
          onClick={() => onChange([])}
        >
          {t('Automatic')}
        </button>
      </div>

      {onManage && (
        <div className="skill-picker-management">
          <button
            type="button"
            className="skill-picker-automatic"
            disabled={disabled}
            onClick={onManage}
          >
            {t('Manage agents')}
          </button>
        </div>
      )}

      <label className="skill-picker-search">
        <span>{t('Find an agent')}</span>
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('Search agents by name or task…')}
        />
      </label>

      {!agents.length ? (
        <p role="status">{t('No agents are available. Add or activate an agent in Manage agents.')}</p>
      ) : (
        <>
          <div className="skill-picker-grid" role="group" aria-label={t('Available agents')}>
            {matching.map(agent => (
              <button
                key={agent.slug}
                type="button"
                className="skill-picker-card"
                disabled={disabled}
                aria-pressed={selected.includes(agent.slug)}
                onClick={() =>
                  onChange(
                    selected.includes(agent.slug)
                      ? selected.filter(slug => slug !== agent.slug)
                      : [...selected, agent.slug]
                  )
                }
              >
                <span className="skill-picker-card-title">
                  <span className="skill-picker-card-name">
                    <span className="skill-picker-icon skill-picker-icon-teal" aria-hidden="true">
                      <Bot size={20} />
                    </span>
                    <span>{agent.name}</span>
                  </span>
                  {selected.includes(agent.slug) && (
                    <span className="skill-picker-selected" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </span>
                {agent.description && (
                  <span className="skill-picker-card-description">{agent.description}</span>
                )}
              </button>
            ))}
          </div>
          {!matching.length && <p role="status">{t('No matching agents')}</p>}
        </>
      )}
    </section>
  );
}
