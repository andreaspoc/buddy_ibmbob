import { describe, expect, it } from 'vitest';
import { answerActivityLabel, answerStages } from '../../src/lib/answerSteps';
import { answerTaskState } from '../../src/lib/taskState';
import type { ChatMessage } from '../../src/types';

describe('answer progress while analysis continues', () => {
  it('treats the first streamed response as a milestone rather than completion', () => {
    const answer = { isStreaming: true, deliveryState: 'streaming', content: 'Starting analysis', deliveryTimeline: [
      { state: 'running', timestamp: '2026-01-01T00:00:01Z' },
      { state: 'streaming', timestamp: '2026-01-01T00:00:12Z' },
    ] } as ChatMessage;
    expect(answerStages(answer).map(stage => stage.label)).toEqual(['Working', 'Response started']);
    expect(answerTaskState(answer).label).toBe('Working');
    expect(answerTaskState(answer).active).toBe(true);
  });

  it('shows current tool activity after response streaming has started', () => {
    const answer = { isStreaming: true, statusText: 'Streaming…', workLog: [{ id: '1', text: 'Analyzing CSV', state: 'running' }] } as ChatMessage;
    expect(answerActivityLabel(answer, { state: 'streaming', label: 'Working', detail: '' })).toBe('Analyzing CSV');
  });

  it('gives terminal status precedence over stale activity', () => {
    const answer = { isStreaming: false, deliveryState: 'completed', content: 'Done', workLog: [{ id: '1', text: 'Analyzing CSV', state: 'running' }] } as ChatMessage;
    expect(answerTaskState(answer).label).toBe('Completed');
    expect(answerActivityLabel(answer, answerTaskState(answer))).toBe('Completed');
  });
});
