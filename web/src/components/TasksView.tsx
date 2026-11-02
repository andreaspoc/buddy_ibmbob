import { Toolbar } from './Toolbar';
import { PeopleAssignedTasks } from './PeopleChatTools';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t, getLocale } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import type { TaskItem, TaskDetail } from '../types';
import { fetchTask } from '../api';
import { MarkdownView } from './MarkdownView';
import { RuntimeApprovalSettings } from './ApprovalControls';
import { formatBobcoins } from './Topbar';
import { TaskStateIndicator } from './TaskStateIndicator';
import { latestTaskSummary, savedTaskState } from '../lib/taskState';

export function TasksView({ tasks, error, selectedId, onSelect, onOpenConversation, onStop, onEnableNotifications }: {
  tasks: TaskItem[]; error: string; selectedId: string; onSelect: (id: string) => void;
  onOpenConversation: (sessionId: string) => void; onStop: (id: string) => Promise<void>;
  onEnableNotifications: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [stopping, setStopping] = useState(false);
  const selected = tasks.find(task => task.id === selectedId);
  const previousStates = useRef(new Map<string, string>());
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  useEffect(() => {
    const fresh = tasks.filter(task => task.status === 'completed' && ['queued', 'running'].includes(previousStates.current.get(task.id) || '')).map(task => task.id);
    previousStates.current = new Map(tasks.map(task => [task.id, task.status]));
    if (fresh.length) setCompleted(previous => new Set([...previous, ...fresh]));
  }, [tasks]);
  useEffect(() => {
    if (!completed.size) return;
    const timer = setTimeout(() => setCompleted(new Set()), 6000);
    return () => clearTimeout(timer);
  }, [completed]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const next = await fetchTask(selectedId, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next); setDetailError('');
        if (next.status === 'queued' || next.status === 'running') timer = setTimeout(update, 2000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setDetailError(e instanceof Error ? e.message : 'Could not load results.');
          timer = setTimeout(update, 3000);
        }
      }
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selectedId, selected?.status]);
  const visible = tasks.map(task => latestTaskSummary(task, detail)).filter(task => filter === 'all' || (filter === 'active' ? ['queued', 'running'].includes(task.status) : task.status === filter));
  const current = detail?.id === selectedId ? { ...detail, ...latestTaskSummary(selected || detail, detail) } : null;
  return <section className="tasks-view buddy-surface" aria-label={t("Tasks")}>
    <WorkspaceSectionHeader level="h1" title={t("Tasks")} description={t("Follow work and review results across your conversations.")} actions={<button type="button" onClick={onEnableNotifications}>{t("Enable desktop notifications")}</button>} />
    <PeopleAssignedTasks/>
    <Toolbar className="task-filters" aria-label={t("Filter tasks")}>
      {['all', 'active', 'completed', 'failed', 'stopped'].map(value => <button key={value} type="button"
        aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value[0].toUpperCase() + value.slice(1))}</button>)}
    </Toolbar>
    {error && <p role="alert">{t(error)}</p>}
    <div className="tasks-layout"><div className="task-list">
      {!visible.length && <p className="task-empty">{t("No")}{filter === 'all' ? '' : t(filter) + ' '}{t("tasks yet. Send a message to Buddy to start work.")}</p>}
      {visible.map(task => <button key={task.id} type="button" className={`task-card ${selectedId === task.id ? 'selected' : ''}`}
        data-just-completed={completed.has(task.id) ? 'true' : undefined}
        onClick={() => onSelect(task.id)} aria-pressed={selectedId === task.id}>
        <TaskStateIndicator status={savedTaskState(task)} compact /><strong>{task.title}</strong>
        <span className="task-progress">{t(task.progress)}</span><time dateTime={task.created_at}>{new Date(task.created_at).toLocaleString(getLocale())}</time>
        {task.status === 'completed' && <span className="task-open-result">{t('Open result')} →</span>}
      </button>)}
    </div><div className="task-detail">
      {!selectedId ? <p className="task-empty">{t("Select a task to see its progress and results.")}</p> : <>
        {detailError && <p role="alert">{t(detailError)}</p>}
        {!current && !detailError && <p role="status">{t("Loading task…")}</p>}
        {current && <><h2>{current.title}</h2><div className="task-actions">
          <button type="button" onClick={() => onOpenConversation(current.session_id)}>{t(current.status === 'completed' ? 'Open result' : 'Open conversation & files')}</button>
          {['queued', 'running'].includes(current.status) && <RuntimeApprovalSettings key={current.id} jobId={current.id} />}
          {['queued', 'running'].includes(current.status) && <button type="button" disabled={stopping} onClick={async () => {
            setStopping(true);
            try { await onStop(current.id); } catch (e) { setDetailError(e instanceof Error ? e.message : "Could not stop task."); }
            finally { setStopping(false); }
          }}>{stopping ? t("Stopping…") : t("Stop task")}</button>}
        </div>
        <TaskStateIndicator status={savedTaskState(current)} />
        <p className="task-last-updated">{t('Last updated')} <time dateTime={current.updated_at}>{new Date(current.updated_at).toLocaleString(getLocale())}</time></p>
        <p aria-label={t("Task spending")}>{current.cost == null ? t("Bobcoins not reported yet") : formatBobcoins(current.cost)}</p>
        {current.result ? <MarkdownView content={current.result} isStreaming={current.status === 'running'} sessionId={current.session_id} />
          : <p className="task-empty">{['queued', 'running'].includes(current.status) ? t("The result will appear as Buddy works.") : t("This task did not produce a text result.")}</p>}
        <details className="task-timeline" open><summary>{t("Activity")}</summary><ol>{current.steps.map(step => <li key={step.id}>
          <time dateTime={step.timestamp}>{new Date(step.timestamp).toLocaleTimeString(getLocale())}</time> {t(step.message)}
        </li>)}</ol></details></>}
      </>}
    </div></div>
  </section>;
}
