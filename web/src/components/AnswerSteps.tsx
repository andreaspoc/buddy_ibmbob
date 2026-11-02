import type { ChatMessage } from '../types';
import { answerActivities, answerStages, elapsedLabel } from '../lib/answerSteps';
import { t } from '../lib/i18n';

export function AnswerSteps({ answer, progressSummary }: { answer: ChatMessage; progressSummary: string }) {
  const stages = answerStages(answer);
  const activities = answerActivities(answer.workLog);
  if (!stages.length && !activities.length && !progressSummary.trim()) return null;
  const terminal = Boolean(answer.answerReadyAt) || ['completed', 'failed', 'cancelled'].includes(answer.deliveryState || '');
  const total = terminal && stages.length > 1 ? stages.at(-1)?.offsetMs : undefined;
  return <section className="answer-journey">
    <div className="answer-journey-heading"><h3>{t('Steps')}</h3>{total !== undefined && <span>{t('Elapsed time')} · {elapsedLabel(total)}</span>}</div>
    {stages.length > 0 && <ol className="answer-stage-track" aria-label={t('Request progress')}>
      {stages.map(stage => <li key={stage.key} data-state={stage.state} aria-current={stage.state === 'active' ? 'step' : undefined}>
        <span className="answer-stage-marker" aria-hidden="true">{stage.state === 'reached' ? '✓' : stage.state === 'failed' ? '!' : stage.state === 'stopped' ? '■' : ''}</span>
        <span className="answer-stage-label">{t(stage.label)}</span>
        {stage.timestamp && <time dateTime={stage.timestamp} title={new Date(stage.timestamp).toLocaleString()}>+{elapsedLabel(stage.offsetMs || 0)}</time>}
      </li>)}
    </ol>}
    {progressSummary.trim() && <p className="answer-progress-summary">{progressSummary}</p>}
    {activities.length > 0 && <div className="answer-activity"><h4>{t('Activity')}</h4><ul className="answer-activity-list">
      {activities.map((step, index) => {
        const failed = ['error', 'failed'].includes(step.state || '');
        const complete = ['completed', 'success'].includes(step.state || '');
        const running = Boolean(answer.isStreaming && ['started', 'running', 'pending'].includes(step.state || ''));
        return <li key={step.id || index} data-state={failed ? 'failed' : running ? 'active' : complete ? 'reached' : 'recorded'}>
          <span className="answer-activity-marker" aria-hidden="true">{failed ? '!' : complete ? '✓' : running ? '◌' : '·'}</span>
          <span>{step.text}</span>
          {(failed || running) && <small>{t(failed ? 'Failed' : 'Running')}</small>}
        </li>;
      })}
    </ul></div>}
  </section>;
}
