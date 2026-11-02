import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAwayFromResponse, ResponseNotifications } from '../src/lib/responseNotifications.ts';
import type { TaskItem } from '../src/types.ts';

function task(status: TaskItem['status'], eventId?: number, kind: TaskItem['kind'] = 'chat'): TaskItem {
  return { id: 'job', session_id: 'conversation', title: 'Question', mode: 'agent', kind,
    status, progress: '', created_at: '', updated_at: '', terminal_event_id: eventId };
}
const away = () => true;

test('historical completions stay silent on first load and later polls', () => {
  const tracker = new ResponseNotifications(null);
  assert.deepEqual(tracker.update([task('completed', 10)], away), []);
  assert.deepEqual(tracker.update([task('completed', 10)], away), []);
});
test('observed ongoing chat notifies once when completed away', () => {
  const tracker = new ResponseNotifications(null);
  tracker.update([task('running')], away);
  assert.equal(tracker.update([task('completed', 10)], away).length, 1);
  assert.equal(tracker.update([task('completed', 10)], away).length, 0);
});
test('explicitly watched fast response can finish before first poll', () => {
  const tracker = new ResponseNotifications(null);
  tracker.watch('job', 'conversation');
  assert.equal(tracker.update([task('completed', 10)], away).length, 1);
});
test('visible completion does not notify later when user leaves', () => {
  const tracker = new ResponseNotifications(1);
  tracker.watch('job', 'conversation');
  assert.equal(tracker.update([task('completed', 10)], () => false).length, 0);
  assert.equal(tracker.update([task('completed', 10)], away).length, 0);
});
test('failures, cancellation and non-chat jobs never notify', () => {
  for (const status of ['failed', 'stopped'] as const) {
    const tracker = new ResponseNotifications(null);
    tracker.watch('job', 'conversation');
    assert.equal(tracker.update([task(status, 10)], away).length, 0);
  }
  const tracker = new ResponseNotifications(null);
  tracker.watch('job', 'conversation');
  tracker.update([task('running', undefined, 'workflow')], away);
  assert.equal(tracker.update([task('completed', 10, 'workflow')], away).length, 0);
});
test('research finishing while every tab was closed notifies once on return', () => {
  const tracker = new ResponseNotifications(5);
  assert.equal(tracker.update([task('completed', 10, 'research')], () => false).length, 1);
  assert.equal(tracker.update([task('completed', 10, 'research')], () => false).length, 0);
  assert.equal(new ResponseNotifications(10).update([task('completed', 10, 'research')], away).length, 0);
});
test('research failure notifies but an explicit stop does not', () => {
  assert.equal(new ResponseNotifications(5).update([task('failed', 10, 'research')], away).length, 1);
  assert.equal(new ResponseNotifications(5).update([task('stopped', 10, 'research')], away).length, 0);
});
test('first use without a cursor notifies only for research seen running', () => {
  assert.equal(new ResponseNotifications(null).update([task('completed', 10, 'research')], away).length, 0);
  const tracker = new ResponseNotifications(null);
  tracker.update([task('running', undefined, 'research')], away);
  assert.equal(tracker.update([task('completed', 10, 'research')], () => false).length, 1);
});
test('persisted cursor prevents replay after reload', () => {
  const tracker = new ResponseNotifications(10);
  tracker.watch('job', 'conversation');
  assert.equal(tracker.update([task('completed', 10)], away).length, 0);
});
test('away means hidden, unfocused, another view, or another conversation', () => {
  const screen = { activeView: 'chat' as const, sessionId: 'conversation' };
  assert.equal(isAwayFromResponse(screen, false, true, 'conversation'), false);
  assert.equal(isAwayFromResponse(screen, true, true, 'conversation'), true);
  assert.equal(isAwayFromResponse(screen, false, false, 'conversation'), true);
  assert.equal(isAwayFromResponse({ ...screen, activeView: 'tasks' }, false, true, 'conversation'), true);
  assert.equal(isAwayFromResponse(screen, false, true, 'different'), true);
});
