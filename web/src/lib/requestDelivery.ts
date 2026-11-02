export const deliveryStates = ['sending', 'accepted', 'queued', 'running', 'streaming', 'saving', 'completed', 'failed', 'cancelled'] as const;
export type DeliveryState = typeof deliveryStates[number];
export type DeliveryStep = { state: DeliveryState; timestamp: string; source: 'server' | 'local' };
export type RequestDelivery = { answerReadyAt?: string; deliveryState?: DeliveryState; deliveryTimeline?: DeliveryStep[] };
const terminal = new Set<DeliveryState>(['completed', 'failed', 'cancelled']);
export function applyDeliveryStep<T extends RequestDelivery>(message: T, step: DeliveryStep): T {
  if (!Number.isFinite(Date.parse(step.timestamp))) return message;
  const timeline = message.deliveryTimeline || [];
  if (timeline.some(previous => previous.state === step.state && previous.timestamp === step.timestamp && previous.source === step.source)) return message;
  const next = [...timeline, step].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  // A replay or delayed transport cannot move a completed request backwards.
  const current = message.deliveryState;
  const advance = !current || (!terminal.has(current) && (terminal.has(step.state) || deliveryStates.indexOf(step.state) >= deliveryStates.indexOf(current)));
  return { ...message, deliveryState: advance ? step.state : current, deliveryTimeline: next };
}
export function applyDeliveryEvent<T extends RequestDelivery>(message: T, event: unknown): T {
  if (!event || typeof event !== 'object') return message;
  const data = event as Record<string, unknown>;
  if (data.type === 'delivery_state') {
    if (!deliveryStates.includes(data.state as DeliveryState) || typeof data.timestamp !== 'string') return message;
    const updated = applyDeliveryStep(message, { state: data.state as DeliveryState, timestamp: data.timestamp, source: 'server' });
    return data.state === 'saving' && updated.deliveryState === 'saving'
      ? { ...updated, answerReadyAt: message.answerReadyAt || data.timestamp } : updated;
  }
  // Old saved requests can show a status without inventing a server timestamp.
  const state: DeliveryState | undefined = data.type === 'done' ? 'completed'
    : data.type === 'error' ? data.cancelled === true ? 'cancelled' : 'failed'
    : data.type === 'delta' && typeof data.text === 'string' && data.text ? 'streaming'
    : undefined;
  if (!state || (message.deliveryState && terminal.has(message.deliveryState))) return message;
  if (state === 'streaming' && message.deliveryState === 'saving') return message;
  return { ...message, deliveryState: state };
}
export function localDeliveryStep<T extends RequestDelivery>(message: T, state: DeliveryState, now = new Date()): T {
  return applyDeliveryStep(message, { state, timestamp: now.toISOString(), source: 'local' });
}
