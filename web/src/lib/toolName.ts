import type { WorkStep } from '../types';

export const UNKNOWN_TOOL = 'Tool name unavailable';
/** ACP updates may omit a name: retain the name recorded for the same call ID. */
export function resolveToolName(name: unknown, id?: unknown, steps: WorkStep[] = []): string {
  if (typeof name === 'string' && name.trim()) return name.trim();
  const previous = typeof id === 'string' && id ? steps.find(step => step.id === id)?.toolName : undefined;
  return typeof previous === 'string' && previous.trim() ? previous.trim() : UNKNOWN_TOOL;
}
