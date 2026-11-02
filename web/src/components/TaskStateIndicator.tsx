import type { TaskState } from '../lib/taskState';
import { t } from '../lib/i18n';
import './AiTransparency.css';

export function TaskStateIndicator({ status, compact = false }: { status: TaskState; compact?: boolean }) {
  if (compact) return <span className={`ai-task-badge ai-task-${status.state}`}><span className="ai-task-mark" aria-hidden="true" />{t(status.label)}</span>;
  return <div className={`ai-task-state ai-task-${status.state}`} role="status" aria-live="polite" aria-atomic="true">
    <span className={`ai-task-mark${status.active ? ' is-active' : ''}`} aria-hidden="true" />
    <div><strong>{t(status.label)}</strong><p>{t(status.detail)}</p></div>
  </div>;
}
