import type { TaskItem } from '../types.ts';

export interface CurrentScreen {
  sessionId?: string;
  activeView?: 'chat' | 'tasks' | 'knowledge' | 'administration' | 'notes';
  taskId?: string;
}

export function isAwayFromResponse(screen: CurrentScreen | undefined, hidden: boolean, focused: boolean, sessionId: string) {
  return hidden || !focused || screen?.activeView !== 'chat' || screen.sessionId !== sessionId;
}

/**
 * Chat responses notify only when witnessed in flight. A research report runs
 * on after the tab closes, so one that ended past the saved cursor still notifies
 * when Buddy is next open. A report the user stopped never notifies.
 */
export class ResponseNotifications {
  private watched = new Map<string, string>();
  cursor: number | null;

  constructor(cursor: number | null) { this.cursor = cursor; }

  watch(jobId: string, sessionId: string) { this.watched.set(jobId, sessionId); }

  update(tasks: TaskItem[], away: (sessionId: string) => boolean): TaskItem[] {
    const notices: TaskItem[] = [];
    for (const task of tasks) {
      if (task.kind === 'workflow') {
        this.watched.delete(task.id);
        continue;
      }
      if (task.status === 'queued' || task.status === 'running') {
        this.watch(task.id, task.session_id);
        continue;
      }
      const witnessed = this.watched.get(task.id) === task.session_id;
      this.watched.delete(task.id);
      const eventId = task.terminal_event_id;
      if (task.kind === 'research') {
        const unseen = this.cursor === null ? witnessed : Boolean(eventId && eventId > this.cursor);
        if (unseen && (task.status === 'completed' || task.status === 'failed')) notices.push(task);
        continue;
      }
      if (witnessed && task.status === 'completed' && eventId &&
          (this.cursor === null || eventId > this.cursor) && away(task.session_id)) {
        notices.push(task);
      }
    }
    this.cursor = Math.max(this.cursor || 0, ...tasks.map(task => task.terminal_event_id || 0));
    return notices;
  }
}
