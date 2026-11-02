import { brandText } from './brand';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TaskItem } from '../types';
import { fetchTasks } from '../api';
import { isAwayFromResponse, ResponseNotifications } from './responseNotifications';
import type { CurrentScreen } from './responseNotifications';
export type { CurrentScreen } from './responseNotifications';

export function useTasks(username?: string, screen?: CurrentScreen) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<TaskItem[]>([]);
  const screenRef = useRef(screen);
  useLayoutEffect(() => { screenRef.current = screen; }, [screen]);
  const trackerRef = useRef<ResponseNotifications | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => refreshRef.current?.(), []);
  const watchResponse = useCallback((jobId: string, sessionId: string) => {
    trackerRef.current?.watch(jobId, sessionId);
  }, []);

  useEffect(() => {
    if (!username) return;
    const key = `buddy-task-notifications:${username}`;
    let cursor: number | null = null;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null && Number.isFinite(Number(stored))) cursor = Number(stored);
    } catch { /* In-memory tracking remains available. */ }
    const tracker = new ResponseNotifications(cursor);
    trackerRef.current = tracker;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let updating = false;
    let refreshPending = false;
    async function update() {
      if (updating) { refreshPending = true; return; }
      clearTimeout(timer);
      updating = true;
      try {
        const next = await fetchTasks(controller.signal);
        if (controller.signal.aborted) return;
        setTasks(next); setError('');
        // Another tab may already have notified about this completion.
        try {
          const stored = localStorage.getItem(key);
          if (stored !== null && Number.isFinite(Number(stored))) {
            tracker.cursor = Math.max(tracker.cursor || 0, Number(stored));
          }
        } catch { /* Storage may be unavailable. */ }
        const fresh = tracker.update(next, sessionId =>
          isAwayFromResponse(screenRef.current, document.hidden, document.hasFocus(), sessionId));
        try { localStorage.setItem(key, String(tracker.cursor)); } catch { /* Storage may be unavailable. */ }
        for (const task of fresh) {
          setNotices(previous => [task, ...previous.filter(t => t.id !== task.id)].slice(0, 5));
          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              const research = task.kind === 'research';
              const heading = !research ? brandText('Buddy response ready') : task.status === 'failed' ? 'Research report needs attention' : 'Research report ready';
              const notification = new Notification(brandText(heading), {
                body: task.title || 'Your response is ready', tag: task.id, icon: '/favicon.svg',
              });
              notification.onclick = () => {
                window.focus();
                setNotices(previous => previous.filter(item => item.id !== task.id));
                window.dispatchEvent(new CustomEvent(research ? 'buddy-open-research' : 'buddy-open-conversation', { detail: task.session_id }));
                notification.close();
              };
            } catch { /* In-app notices still work. */ }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load tasks.');
      }
      updating = false;
      if (!controller.signal.aborted) {
        if (refreshPending) { refreshPending = false; void update(); }
        else timer = setTimeout(update, 3000);
      }
    }
    refreshRef.current = () => { void update(); };
    void update();
    return () => {
      controller.abort(); clearTimeout(timer);
      trackerRef.current = null;
      refreshRef.current = null;
      setTasks([]); setNotices([]);
    };
  }, [username]);
  return { tasks, error, notices, watchResponse, refresh, dismiss: (id: string) => setNotices(previous => previous.filter(task => task.id !== id)) };
}
