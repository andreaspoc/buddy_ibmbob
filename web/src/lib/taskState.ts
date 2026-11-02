import { resolveToolName } from './toolName';
import type { ChatMessage, TaskItem } from '../types';

export type TaskState = { state: string; label: string; detail: string; active: boolean };
const terminalStates: Record<string, TaskState> = {
  completed: { state: 'completed', label: 'Completed', detail: 'The task is complete. Review its results.', active: false },
  failed: { state: 'failed', label: 'Failed', detail: 'The task ended with an error. Review the activity for details.', active: false },
  cancelled: { state: 'stopped', label: 'Stopped', detail: 'The task was stopped. Any partial result remains available.', active: false },
  stopped: { state: 'stopped', label: 'Stopped', detail: 'The task was stopped. Any partial result remains available.', active: false },
};

/** Prefer explicit terminal events over stale tools and unresolved approvals. */
export function answerTaskState(message: ChatMessage): TaskState {
  const state = message.deliveryState;
  if (state && terminalStates[state]) return terminalStates[state];
  if (state === 'saving' && message.answerReadyAt) return { state: 'completed', label: 'Completed', detail: 'The response is complete.', active: false };
  // A saved delta can leave a historical "streaming" state behind. Only the
  // currently attached response reader establishes that work is active now.
  const active = Boolean(message.isStreaming);
  if (!active) return message.content.trim()
    ? { state: 'available', label: 'Response available', detail: 'A completion status was not recorded for this answer.', active: false }
    : { state: 'unknown', label: 'Status unavailable', detail: 'No final task status was recorded.', active: false };
  if (active && message.isStopping) return { state: 'stopping', label: 'Stopping', detail: 'Waiting for the task to confirm it has stopped.', active: true };
  if (active && message.approvals?.some(approval => approval.status === 'pending')) {
    return { state: 'waiting', label: 'Waiting for approval', detail: 'Review the action below to continue.', active: false };
  }
  if (state === 'sending') return { state, label: 'Sending', detail: 'Sending your request.', active: true };
  if (state === 'accepted') return { state, label: 'Accepted', detail: 'Your request has been received.', active: true };
  if (state === 'queued') return { state, label: 'Queued', detail: 'Waiting for a worker to start the task.', active: true };
  if (state === 'saving') return { state, label: 'Saving files', detail: 'Your answer is ready. Files are being saved before the next turn.', active: true };
  const tool = active && message.toolsUsed?.find(item => ['running', 'started'].includes(item.status));
  if (tool) return { state: 'tool', label: 'Running tool', detail: resolveToolName(tool.name).replace(/_/g, ' '), active: true };
  if (state === 'streaming' || (message.isStreaming && message.content.trim())) {
    return { state: 'streaming', label: 'Working', detail: 'The response has started; the task may still be using tools or preparing files.', active: true };
  }
  return { state: 'running', label: 'Working', detail: message.statusText || 'The task is running. You can stop it while it runs.', active: true };
}

export function savedTaskState(task: TaskItem): TaskState {
  if (terminalStates[task.status]) return terminalStates[task.status];
  return task.status === 'queued'
    ? { state: 'queued', label: 'Queued', detail: 'Waiting for a worker to start the task.', active: true }
    : { state: 'running', label: 'Working', detail: task.progress || 'The task is running.', active: true };
}

/** Detail and list polls can arrive independently; never regress a terminal task. */
export function latestTaskSummary(summary: TaskItem, detail?: TaskItem | null): TaskItem {
  if (!detail || detail.id !== summary.id) return summary;
  if (terminalStates[summary.status] && !terminalStates[detail.status]) return summary;
  return Date.parse(detail.updated_at) >= Date.parse(summary.updated_at) ? detail : summary;
}
