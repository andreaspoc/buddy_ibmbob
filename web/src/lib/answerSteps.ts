import type { ChatMessage, WorkStep } from '../types';

export type AnswerStage = { key: string; label: string; timestamp?: string; offsetMs?: number; state: 'reached' | 'active' | 'failed' | 'stopped' | 'recorded' };
const group: Record<string, string> = { sending: 'received', accepted: 'received', queued: 'received', running: 'working', streaming: 'writing', saving: 'completed', completed: 'completed', failed: 'failed', cancelled: 'stopped' };
const labels: Record<string, string> = { received: 'Request received', working: 'Working', writing: 'Response started', saving: 'Saving files', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };

/** Collapse transport chatter, retaining only milestones actually recorded. */
export function answerStages(answer: ChatMessage): AnswerStage[] {
  const events = (answer.deliveryTimeline || []).filter(event => Number.isFinite(Date.parse(event.timestamp))).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const stages = new Map<string, AnswerStage>();
  const start = events[0] ? Date.parse(events[0].timestamp) : undefined;
  for (const event of events) {
    const key = group[event.state];
    if (!key || stages.has(key)) continue;
    stages.set(key, { key, label: labels[key], timestamp: event.timestamp, offsetMs: start === undefined ? undefined : Date.parse(event.timestamp) - start, state: 'recorded' });
  }
  const result = [...stages.values()];
  return result.map((stage, index) => ({ ...stage,
    label: stage.key === 'received' && index === result.length - 1 && answer.isStreaming
      ? answer.deliveryState === 'sending' ? 'Sending' : answer.deliveryState === 'queued' ? 'Queued' : 'Accepted' : stage.label,
    state: stage.key === 'failed' ? 'failed' : stage.key === 'stopped' ? 'stopped'
      : stage.key === 'completed' || index < result.length - 1 ? 'reached'
      : answer.isStreaming ? 'active' : 'recorded',
  }));
}

/** Terminal transport messages add no activity information. */
export function answerActivities(steps: WorkStep[] = []): WorkStep[] {
  const unique = new Map<string, WorkStep>();
  for (const step of steps) {
    const text = step.text.trim();
    if (!text || /^(?:done[.!]?|completed(?: in .*)?|request started|response started|stopped by you)$/i.test(text)) continue;
    unique.set(step.id || text, { ...step, text });
  }
  return [...unique.values()];
}

export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A compact activity label from recorded events, never inferred work or thoughts. */
export function answerActivityLabel(answer: ChatMessage, status: { state: string; label: string; detail: string }): string {
  if (!answer.isStreaming || ['sending','accepted','queued','waiting','stopping','saving','completed','failed','stopped'].includes(status.state)) return status.label;
  const generic = /^(?:working|running|streaming|request started|response started|done|completed)(?:[.!…]|\s)*$/i;
  const reported = answer.statusText?.trim();
  if (reported && !generic.test(reported)) return reported;
  const activity = answerActivities(answer.workLog).filter(step => ['started','running','pending'].includes(step.state || '')).at(-1);
  if (activity?.toolName) return `Using ${activity.toolName.replace(/_/g,' ')}…`;
  if (activity) {
    const text = activity.text;
    if (text.slice(0, 6).toLowerCase() === 'skill:') {
      const name = text.slice(6).trimStart();
      if (name && !/[\r\n]/.test(name)) return `Using skill ${name}…`;
    }
    return text;
  }
  if (status.state === 'tool') return `Using ${status.detail}…`;
  return status.label;
}
