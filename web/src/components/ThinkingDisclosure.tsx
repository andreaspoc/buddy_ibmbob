import { Toolbar } from './Toolbar';
import { t } from "../lib/i18n";
import React, { useState } from 'react';
import { CopyButton } from './CopyButton';

interface ThinkingDisclosureProps {
  thoughts?: string;
  planningSteps?: Array<{ text: string; timestamp?: number }>;
  durationMs?: number;
  isStreaming?: boolean;
}

export const ThinkingDisclosure: React.FC<ThinkingDisclosureProps> = ({
  thoughts = '',
  planningSteps = [],
  durationMs,
  isStreaming = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // If there are no thoughts, no planning steps, and not streaming, do not render
  const hasContent = Boolean(thoughts.trim()) || planningSteps.length > 0;
  if (!hasContent && !isStreaming) return null;

  // Format thought duration (e.g. "Thought for 4 seconds")
  let timeLabel = 'Working…';
  if (!isStreaming) {
    if (typeof durationMs === 'number' && durationMs > 0) {
      const secs = Math.max(1, Math.round(durationMs / 1000));
      timeLabel = `Worked for ${secs} second${secs === 1 ? '' : 's'}`;
    } else if (planningSteps.length > 0) {
      timeLabel = `${planningSteps.length} progress step${planningSteps.length === 1 ? '' : 's'}`;
    } else {
      timeLabel = 'Work summary';
    }
  }

  const textToCopy = [
      thoughts.trim(),
      planningSteps.map((s) => `• ${s.text}`).join('\n'),
    ].filter(Boolean).join('\n\n');


  return (
    <div className={`thinking-disclosure ${isOpen ? 'is-open' : ''}`}>
      <button
        type="button"
        className={`thinking-pill ${isStreaming ? 'is-streaming' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        title={t("Show progress and approach")}
      >
        <span className="thinking-spark" aria-hidden="true">✦</span>
        <span className="thinking-label">{timeLabel}</span>
        <span className="thinking-chevron" aria-hidden="true">{isOpen ? '−' : '+'}</span>
      </button>

      {isOpen && (
        <div className="thinking-drawer">
          <Toolbar className="thinking-drawer-header">
            <span className="thinking-drawer-title">
              <span className="thinking-spark-small">✦</span> {t("Progress & approach")}</span>
            {hasContent && (
              <CopyButton
                className="thinking-copy-btn"
                text={textToCopy}
                title={t("Copy progress summary")}
              />
            )}
          </Toolbar>

          <div className="thinking-drawer-body">
            {thoughts.trim() && (
              <div className="progress-summary-cards">
                {thoughts.trim().split(/\n\s*\n/).map((text, index) => <p className="progress-summary-card" key={index}>{text}</p>)}
              </div>
            )}

            {planningSteps.length > 0 && (
              <div className="thinking-planning-steps">
                {planningSteps.map((step, idx) => (
                  <div key={idx} className="thinking-step-item">
                    <span className="thinking-step-arrow">{idx + 1}</span>
                    <span className="thinking-step-text">{t(step.text)}</span>
                  </div>
                ))}
              </div>
            )}

            {!hasContent && isStreaming && (
              <div className="thinking-in-progress">
                <span className="thinking-pulse-dot" />
                <span>{t("Formulating response and verifying requirements…")}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
