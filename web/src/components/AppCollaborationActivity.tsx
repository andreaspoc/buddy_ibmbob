import { t } from '../lib/i18n';
import './AppCollaborationActivity.css';

export interface AppCollaboration {
  version: 1;
  call_id: string;
  agent_id: string;
  agent_name: string;
  stage: 'started' | 'completed' | 'failed' | 'cancelled';
  message: string;
  task?: string;
}

export function readAppCollaboration(event: unknown): AppCollaboration | undefined {
  if (!event || typeof event !== 'object' || !('collaboration' in event)) return;
  const value = event.collaboration as Partial<AppCollaboration> | null;
  if (value?.version === 1 && typeof value.call_id === 'string' && typeof value.agent_id === 'string' && typeof value.agent_name === 'string' && typeof value.message === 'string' && (value.task === undefined || typeof value.task === 'string') && ['started', 'completed', 'failed', 'cancelled'].includes(value.stage || '')) return value as AppCollaboration;
}

export function AppCollaborationActivity({ activities }: { activities: AppCollaboration[] }) {
  if (!activities.length) return null;
  return <ul className="app-collaboration-activity" aria-label={t('App collaboration')} aria-live="polite">{activities.map(activity => <li key={activity.call_id} data-stage={activity.stage}><span aria-hidden="true">{activity.stage === 'completed' ? '✓' : activity.stage === 'started' ? '◌' : '!'}</span><span>{t(activity.message)}{activity.task && <small>{activity.task}</small>}</span></li>)}</ul>;
}

export function collaborationFromWorkLog(steps: Array<{ collaboration?: unknown }> = []): AppCollaboration[] {
  const activities = new Map<string, AppCollaboration>();
  for (const step of steps) {
    const value = readAppCollaboration(step);
    if (value) activities.set(value.call_id, value);
  }
  return [...activities.values()];
}
