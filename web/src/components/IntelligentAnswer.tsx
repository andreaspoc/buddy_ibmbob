import { useId, useState } from 'react';
import { useInteractiveState } from '../lib/interactiveState';
import { InteractiveAction } from './InteractiveAction';
import { AnalysisWorkspace } from './AnalysisWorkspace';
import type { IntelligentSpec } from '../lib/intelligentUi';
import { splitAmount } from '../lib/intelligentUi';
import { t } from '../lib/i18n';
import './IntelligentAnswer.css';
import './IntelligentAnswerFinishes.scss';

export function IntelligentAnswer({
  spec,
  source,
  pending,
  onPrompt,
  disabled = false,
  sessionId,
  identity = 'widget',
  readOnly = false,
}: {
  spec?: IntelligentSpec;
  source: string;
  pending: boolean;
  onPrompt?: (prompt: string) => void;
  disabled?: boolean;
  sessionId?: string;
  identity?: string;
  readOnly?: boolean;
}) {
  const id = useId();
  const { state, setState, status } = useInteractiveState(
    source,
    identity,
    pending || !spec || spec.kind === 'action' ? undefined : sessionId,
    readOnly
  );

  const selected = state.selected ?? 0;
  const done = (state.done ?? []).filter(index => spec && 'items' in spec && index < spec.items.length);
  const values = state.values;
  const locked = status === 'loading';

  const items = spec && 'items' in spec ? spec.items : [];
  const [filterText, setFilterText] = useState('');

  const setSelected = (value: number) => setState({ ...state, selected: value });
  const setDone = (value: number[]) => setState({ ...state, done: value });
  const setValues = (value: { total: string; people: string; tip: string } | null) =>
    setState({ ...state, values: value ?? undefined });

  if (pending) {
    return (
      <div className="intelligent-answer ia-pending" role="status">
        <div className="ia-spinner" aria-hidden="true" />
        <div className="ia-pending-content">
          <strong>{t("Generating interactive answer…")}</strong>
          <small>{t("Composing Carbon interactive components")}</small>
        </div>
      </div>
    );
  }

  if (!spec) {
    return (
      <details className="intelligent-answer ia-fallback">
        <summary>
          <span className="ia-fallback-icon" aria-hidden="true">💡</span>
          <span>{t("Interactive answer source · Click to inspect")}</span>
        </summary>
        <pre className="ia-source-pre">{source}</pre>
      </details>
    );
  }

  const savedIndex = Math.min(selected, Math.max(0, items.length - 1));

  const filteredItems = filterText.trim()
    ? items.filter(
        it =>
          it.title.toLowerCase().includes(filterText.toLowerCase()) ||
          it.body.toLowerCase().includes(filterText.toLowerCase()) ||
          it.facts?.some(
            f =>
              f.label.toLowerCase().includes(filterText.toLowerCase()) ||
              f.value.toLowerCase().includes(filterText.toLowerCase())
          )
      )
    : items;

  // Keep a visible tab focusable when filtering hides the saved selection.
  const index = spec.kind === 'explore' && filteredItems.length && !filteredItems.includes(items[savedIndex])
    ? items.indexOf(filteredItems[0])
    : savedIndex;
  const active = items[index];

  const fields =
    spec.kind === 'split'
      ? {
          total: values?.total ?? String(spec.total),
          people: values?.people ?? String(spec.people),
          tip: values?.tip ?? String(spec.tip),
        }
      : null;

  const valid =
    fields &&
    fields.total.trim() !== '' &&
    fields.people.trim() !== '' &&
    fields.tip.trim() !== '' &&
    Number.isFinite(Number(fields.total)) &&
    Number(fields.total) >= 0 &&
    Number(fields.total) <= 1e9 &&
    Number.isInteger(Number(fields.people)) &&
    Number(fields.people) >= 1 &&
    Number(fields.people) <= 1000 &&
    Number.isFinite(Number(fields.tip)) &&
    Number(fields.tip) >= 0 &&
    Number(fields.tip) <= 100;

  const modeBadge =
    spec.kind === 'explore'
      ? t('Topic Explorer')
      : spec.kind === 'comparison'
        ? t('Comparison Matrix')
        : spec.kind === 'steps'
          ? t('Interactive Plan')
          : spec.kind === 'split'
            ? t('Smart Calculator')
            : spec.kind === 'analysis'
              ? t('Data Workspace')
              : t('Action Card');

  const renderFacts = (facts?: { label: string; value: string }[]) => {
    if (!facts || facts.length === 0) return null;
    return (
      <div className="ia-facts-grid" role="list" aria-label={t("Key details")}>
        {facts.map((fact, i) => (
          <div key={i} className="ia-fact-card" role="listitem">
            <span className="ia-fact-label">{fact.label}</span>
            <strong className="ia-fact-value">{fact.value}</strong>
          </div>
        ))}
      </div>
    );
  };

  const itemBody = (item: typeof active) => {
    if (!item) return null;
    return (
      <div className="ia-item-content">
        <p className="ia-item-body">{item.body}</p>
        {renderFacts(item.facts)}
      </div>
    );
  };

  const stepsDoneCount = done.length;
  const stepsTotalCount = items.length;
  const stepsPercent = stepsTotalCount > 0 ? Math.round((stepsDoneCount / stepsTotalCount) * 100) : 0;

  return (
    <section className={`intelligent-answer ia-mode-${spec.kind}`} aria-labelledby={`${id}-title`}>
      <header className="ia-header">
        <div className="ia-header-top">
          <div className="ia-header-badges">
            <span className="cds--tag cds--tag--cool-gray ia-badge-mode">{modeBadge}</span>
            {items.length > 0 && (
              <span className="ia-badge-count">
                {items.length} {t("items")}
              </span>
            )}
          </div>
          {(status === 'loading' || status === 'saving' || status === 'error') && (
            <div className="ia-header-status" role="status">
              <small>{t(status === 'loading' ? 'Restoring…' : status === 'saving' ? 'Saving…' : 'Could not save changes.')}</small>
            </div>
          )}
        </div>
        <h3 id={`${id}-title`} className="ia-title">{spec.title}</h3>
        {spec.description && <p className="ia-description">{spec.description}</p>}
      </header>

      {/* Explore Mode */}
      {spec.kind === 'explore' && items.length > 0 && (
        <div className="ia-explore-container">
          {items.length > 3 && (
            <div className="ia-explore-toolbar">
              <div className="ia-search-wrap">
                <svg className="ia-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg>
                <input
                  type="search"
                  className="ia-search-input"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t("Filter {0} items…", [items.length])}
                  aria-label={t("Filter items")}
                />
                {filterText && (
                  <button
                    type="button"
                    className="ia-search-clear"
                    onClick={() => setFilterText('')}
                    aria-label={t("Clear filter")}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}

          {filteredItems.length === 0 ? (
            <div className="ia-no-results">
              <p>{t("No items match “{0}”", [filterText])}</p>
              <button type="button" className="ia-reset-filter-btn" onClick={() => setFilterText('')}>
                {t("Show all {0} items", [items.length])}
              </button>
            </div>
          ) : (
            <div className="ia-grid-catalog">
              {filteredItems.map((item) => {
                const origIndex = items.indexOf(item);
                const isSelected = index === origIndex;
                return (
                  <article
                    key={origIndex}
                    className={`ia-grid-card ${isSelected ? 'is-selected' : ''}`}
                  >
                    <div className="ia-grid-card-head">
                      <span className="ia-grid-card-index">0{origIndex + 1}</span>
                      <h4 className="ia-grid-card-title">
                        <button
                          type="button"
                          className="ia-topic-title"
                          disabled={locked}
                          aria-pressed={isSelected}
                          onClick={() => setSelected(origIndex)}
                        >
                          {item.title}
                        </button>
                      </h4>
                    </div>
                    <p className="ia-grid-card-body">{item.body}</p>
                    {renderFacts(item.facts)}
                  </article>
                );
              })}
            </div>
          )}
          {filteredItems.length > 0 && active && onPrompt && !readOnly && (
            <div className="ia-actions-bar">
              <button type="button" className="ia-action-btn" disabled={disabled || locked}
                onClick={() => onPrompt(`Please elaborate on ${active.title} in the context of ${spec.title}.`)}>
                {t("Elaborate on selected topic")}: {active.title}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Comparison Mode */}
      {spec.kind === 'comparison' && items.length > 0 && (
        <div className="ia-comparison-grid">
          {items.map((item, i) => {
            const isSelected = index === i;
            return (
              <article
                key={i}
                className={`ia-comparison-card ${isSelected ? 'is-selected' : ''}`}
              >
                <div className="ia-card-top">
                  <span className="ia-card-index">0{i + 1}</span>
                  <h4 className="ia-card-title">{item.title}</h4>
                  {isSelected && (
                    <span className="ia-selected-pill" aria-label={t("Selected option")}>
                      ✓ {t("Selected")}
                    </span>
                  )}
                </div>
                <div className="ia-card-body-wrap">{itemBody(item)}</div>
                <button
                  type="button"
                  className={`ia-comparison-select-btn ${isSelected ? 'is-selected' : ''}`}
                  aria-pressed={isSelected}
                  disabled={locked}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(i);
                  }}
                >
                  {t(isSelected ? "✓ Selected Option" : "Select Option")}
                </button>
              </article>
            );
          })}
        </div>
      )}

      {/* Steps Mode */}
      {spec.kind === 'steps' && (
        <div className="ia-steps-container">
          <div className="ia-section-header">
            <h4 className="ia-section-title">{t("Action Plan & Implementation Checklist")}</h4>
            <p className="ia-section-description">{t("Follow the sequence below and check off items as they are finished.")}</p>
          </div>
          <div className="ia-progress-header">
            <div className="ia-progress-meta">
              <span className="ia-progress-title">{t("Checklist Progress")}</span>
              <span className="ia-progress-count">
                {stepsDoneCount} / {stepsTotalCount} {t("completed")} ({stepsPercent}%)
              </span>
            </div>
            <div className="ia-progress-bar-wrap" aria-label={t("Checklist Progress")} role="progressbar" aria-valuenow={stepsDoneCount} aria-valuemin={0} aria-valuemax={stepsTotalCount}>
              <div className="ia-progress-bar-fill" style={{ width: `${stepsPercent}%` }} />
            </div>
            {stepsDoneCount > 0 && (
              <button
                type="button"
                className="ia-reset-link"
                onClick={() => setDone([])}
                disabled={locked}
              >
                ↺ {t("Reset checklist")}
              </button>
            )}
          </div>

          <ol className="ia-steps-list">
            {items.map((item, i) => {
              const isChecked = done.includes(i);
              return (
                <li key={i} className={`ia-step-row ${isChecked ? 'is-done' : ''}`}>
                  <label className="ia-step-label">
                    <input
                      type="checkbox"
                      className="ia-step-checkbox"
                      disabled={locked}
                      checked={isChecked}
                      onChange={() =>
                        setDone(isChecked ? done.filter((n) => n !== i) : [...done, i])
                      }
                    />
                    <span className="ia-step-custom-box" aria-hidden="true">
                      {isChecked ? '✓' : ''}
                    </span>
                    <span className="ia-step-num-badge">0{i + 1}</span>
                    <strong className="ia-step-name">{item.title}</strong>
                    {isChecked && <span className="ia-done-badge">{t("Done")}</span>}
                  </label>
                  <div className="ia-step-details">{itemBody(item)}</div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Split Calculator Mode */}
      {spec.kind === 'split' && fields && (
        <div className="ia-calculator-container">
          <div className="ia-section-header">
            <h4 className="ia-section-title">{t("Interactive Calculator & Parameters")}</h4>
            <p className="ia-section-description">{t("Adjust values below to compute breakdowns in real time.")}</p>
          </div>
          <div className="ia-split-kpi-card">
            <span className="ia-split-kpi-label">{t("Amount Per Person")}</span>
            <div className="ia-split-hero-value">
              <span className="ia-split-currency">{spec.unit || '€'}</span>
              <span className="ia-split-number">
                {valid
                  ? splitAmount(Number(fields.total), Number(fields.people), Number(fields.tip)).toLocaleString(
                      undefined,
                      { minimumFractionDigits: 2, maximumFractionDigits: 2 }
                    )
                  : '0.00'}
              </span>
            </div>
            <small className="ia-split-formula">
              {valid
                ? `${spec.unit || '€'}${fields.total} ${t("total")} + ${fields.tip}% ${t("tip")} ÷ ${fields.people} ${t("people")}`
                : t("Enter valid bill amounts and people")}
            </small>
          </div>

          <div className="ia-fields-grid">
            {(['total', 'people', 'tip'] as const).map((key) => (
              <label key={key} className="ia-input-group">
                <span className="ia-input-label">
                  {t(key === 'total' ? 'Bill Total' : key === 'people' ? 'People' : 'Tip (%)')}
                </span>
                <input
                  disabled={locked}
                  type="number"
                  min={key === 'people' ? 1 : 0}
                  max={key === 'total' ? 1e9 : key === 'people' ? 1000 : 100}
                  step={key === 'people' ? 1 : 'any'}
                  value={fields[key]}
                  className="ia-number-input"
                  onChange={(e) => setValues({ ...fields, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>

          {/* Quick Tip Presets */}
          <div className="ia-tip-presets">
            <span className="ia-presets-label">{t("Quick Tip:")}</span>
            {[0, 5, 10, 15, 20].map((tipVal) => (
              <button
                key={tipVal}
                type="button"
                className={`ia-preset-btn ${fields.tip === String(tipVal) ? 'is-active' : ''}`}
                aria-pressed={fields.tip === String(tipVal)}
                disabled={locked}
                onClick={() => setValues({ ...fields, tip: String(tipVal) })}
              >
                {tipVal}%
              </button>
            ))}
            <button
              type="button"
              className="ia-preset-reset-btn"
              disabled={locked}
              onClick={() => setValues(null)}
            >
              ↺ {t("Reset")}
            </button>
          </div>
        </div>
      )}

      {/* Action Mode */}
      {spec.kind === 'action' && !readOnly && (
        <InteractiveAction
          title={spec.title}
          body={spec.body}
          operation={spec.operation}
          sessionId={sessionId}
          disabled={disabled}
        />
      )}
      {spec.kind === 'action' && readOnly && (
        <div className="ia-detail">
          <p className="ia-item-body">{spec.body}</p>
        </div>
      )}

      {/* Analysis Mode */}
      {spec.kind === 'analysis' && (
        <AnalysisWorkspace
          ready={status !== 'loading'}
          filters={state.filters}
          onFiltersChange={(filters) => setState({ ...state, filters })}
          title={spec.title}
          headers={spec.headers}
          rows={spec.rows}
          source={spec.source}
          onPrompt={disabled || readOnly ? undefined : onPrompt}
        />
      )}

      {/* Follow-up Prompts / Actions */}
      {spec.actions && spec.actions.length > 0 && onPrompt && (
        <div className="ia-actions-bar" aria-label={t("Explore further")}>
          <span className="ia-actions-title">{t("Suggested actions:")}</span>
          <div className="ia-actions-list">
            {spec.actions.map((action, i) => (
              <button
                type="button"
                key={i}
                className="ia-action-btn"
                disabled={disabled}
                title={action.prompt}
                onClick={() => {
                  const context =
                    spec.kind === 'explore' || spec.kind === 'comparison'
                      ? { selected: items[index]?.title }
                      : spec.kind === 'steps'
                        ? { checkedSteps: done.map((idx) => items[idx]?.title) }
                        : spec.kind === 'split'
                          ? { inputs: fields }
                          : {};
                  onPrompt(
                    action.prompt +
                      (Object.keys(state).length
                        ? '\n\nCurrent interactive selections: ' + JSON.stringify(context)
                        : '')
                  );
                }}
              >
                <span>{action.label}</span>
                <span className="ia-action-arrow" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <details className="ia-source-disclosure">
        <summary>{t("View raw JSON specification")}</summary>
        <pre className="ia-source-pre">{source}</pre>
      </details>
    </section>
  );
}
