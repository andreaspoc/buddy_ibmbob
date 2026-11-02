import './ClarificationHeader.css';
import { t } from "../lib/i18n";
import { useState, useId, useRef } from 'react';
import type { ClarificationQuestion } from '../lib/clarification';
import { clarificationReply, clarificationCancelReply } from '../lib/clarification';

export function ClarificationCard({
  questions,
  disabled,
  answered,
  cancelled = false,
  onReply,
}: {
  questions: ClarificationQuestion[];
  disabled: boolean;
  answered: boolean;
  cancelled?: boolean;
  onReply: (prompt: string) => void;
}) {
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  const formId = useId();
  const submitted = useRef(false);

  const answers = questions.map((_, i) =>
    choices[i] === 'custom' ? (custom[i] || '').trim() : choices[i]?.slice(7) || ''
  );

  const answeredCount = answers.filter(Boolean).length;
  const isComplete = !disabled && !answered && !cancelled && questions.length > 0 && answers.every(Boolean);

  const handleCancel = () => {
    if (!disabled && !answered && !cancelled && !submitted.current) {
      submitted.current = true;
      onReply(clarificationCancelReply());
    }
  };

  return (
    <form
      aria-labelledby={`${formId}-title`}
      className={`clarification-card ${cancelled ? 'is-cancelled' : answered ? 'is-answered' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (isComplete && !submitted.current) {
          submitted.current = true;
          onReply(clarificationReply(questions, answers));
        }
      }}
    >
      <header className="clarification-header-row">
        <h3 id={`${formId}-title`} className="clarification-title">{t('Follow-up questions')}</h3>
        <span className={`clarification-status ${answered ? 'is-answered' : ''}`} aria-live="polite">
          {cancelled ? t('Form cancelled') : answered ? t('Reply sent') : t("{0} of {1} answered", [answeredCount, questions.length])}
        </span>
      </header>

      <div className="clarification-questions-list">
        {questions.map((q, i) => {
          const isQuestionAnswered = Boolean(answers[i]);
          return (
            <fieldset
              key={i}
              disabled={disabled || answered || cancelled}
              aria-describedby={q.context ? `${formId}-context-${i}` : undefined}
            >
              <legend className="clarification-legend">
                <span className="clarification-step-num">{i + 1}</span>
                <span className="clarification-question-text">{q.question}</span>
              </legend>

              <div className={`clarification-fieldset-wrap ${isQuestionAnswered ? 'is-answered' : ''}`}>
              {q.context && (
                <div id={`${formId}-context-${i}`} className="clarification-context-pill">
                  <span>{q.context}</span>
                </div>
              )}

              <div className="clarification-options-grid">
                {q.options.map((option, j) => {
                  const isSelected = choices[i] === `option:${option}`;
                  return (
                    <label
                      key={j}
                      className={`clarification-option-tile ${isSelected ? 'is-selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name={`${formId}-question-${i}`}
                        className="clarification-native-radio"
                        checked={isSelected}
                        onChange={() => setChoices((prev) => ({ ...prev, [i]: `option:${option}` }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && isComplete && !submitted.current) {
                            e.preventDefault();
                            submitted.current = true;
                            onReply(clarificationReply(questions, answers));
                          }
                        }}
                      />
                      <span className="clarification-custom-radio" aria-hidden="true">
                        <span className="clarification-radio-inner" />
                      </span>
                      <span className="clarification-option-text">{option}</span>
                      {isSelected ? (
                        <span className="clarification-selection-badge" aria-hidden="true">
                          ✓ {t("Selected")}
                        </span>
                      ) : (
                        <span className="clarification-option-hint" aria-hidden="true">
                          {t("Select")}
                        </span>
                      )}
                    </label>
                  );
                })}

                <label
                  className={`clarification-option-tile clarification-custom-tile ${choices[i] === 'custom' ? 'is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name={`${formId}-question-${i}`}
                    className="clarification-native-radio"
                    checked={choices[i] === 'custom'}
                    onChange={() => setChoices((prev) => ({ ...prev, [i]: 'custom' }))}
                  />
                  <span className="clarification-custom-radio" aria-hidden="true">
                    <span className="clarification-radio-inner" />
                  </span>
                  <span className="clarification-option-text">{t("Write my own answer")}</span>
                  <svg className="clarification-write-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" /><path d="m13 6 5 5" /></svg>
                </label>
              </div>

              {choices[i] === 'custom' && (
                <div className="clarification-textarea-wrap">
                  <textarea
                    aria-label={t("Your answer to: {0}", [q.question])}
                    maxLength={4000}
                    value={custom[i] || ''}
                    onChange={(event) => setCustom((prev) => ({ ...prev, [i]: event.target.value }))}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                        event.preventDefault();
                        if (isComplete && !submitted.current) {
                          submitted.current = true;
                          onReply(clarificationReply(questions, answers));
                        }
                      }
                    }}
                    placeholder={t("Tell Buddy what you need…")}
                    className="clarification-custom-textarea"
                  />
                </div>
              )}
              </div>
            </fieldset>
          );
        })}
      </div>

      {!answered && !cancelled && (
        <div className="clarification-actions-bar">
          <div className="clarification-completion"><span>{t(isComplete ? "Ready to continue" : "Choose an option or write your own answer.")}</span><progress className="clarification-completion-track" aria-hidden="true" value={answeredCount} max={Math.max(1, questions.length)} /></div>
          <button
            type="button"
            className="clarification-cancel-btn"
            disabled={disabled}
            onClick={handleCancel}
          >
            {t("Cancel Form")}</button>
          <button
            type="submit"
            className="clarification-submit-btn"
            disabled={!isComplete}
          >
            <span>{t("Continue")}</span>
            <span className="clarification-btn-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      )}
    </form>
  );
}
