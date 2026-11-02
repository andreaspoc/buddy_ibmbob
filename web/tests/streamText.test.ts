import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createTextStream } from '../src/lib/streamText.ts';

function fixture(hidden = false) {
  let next = 0;
  let clock = 0;
  const frames = new Map<number, () => void>();
  const paints: string[] = [];
  const stream = createTextStream(text => paints.push(text), callback => {
    frames.set(++next, callback); return next;
  }, id => { frames.delete(id); }, () => hidden, () => clock);
  return { stream, frames, paints, paint() { clock += 16; const callback = frames.values().next().value; frames.clear(); callback?.(); } };
}

test('a large incoming burst paints progressively within 240ms without a backlog', () => {
  const f = fixture();
  const burst = 'A long response 🟣\n'.repeat(1000);
  f.stream.push('First. '); f.stream.push(burst);
  assert.equal(f.frames.size, 1);
  f.paint();
  assert.ok(f.paints[0].length < burst.length);
  for (let i = 0; i < 14; i++) f.paint();
  assert.equal(f.paints.join(''), 'First. ' + burst);
  assert.equal(f.frames.size, 0);
});
test('completion and cancellation flush text exactly once before the next frame', () => {
  const f = fixture(); f.stream.push('Last words');
  f.stream.flush(); f.stream.flush();
  assert.deepEqual(f.paints, ['Last words']);
  assert.equal(f.frames.size, 0);
});
test('replacement discards obsolete queued content and allows later deltas', () => {
  const f = fixture(); f.stream.push('Obsolete'); f.stream.clear();
  f.stream.push('After replacement'); for (let i = 0; i < 5; i++) f.paint();
  assert.equal(f.paints.join(''), 'After replacement');
});
test('background tabs never wait for a suspended animation frame', () => {
  const f = fixture(true); f.stream.push('Background response');
  assert.deepEqual(f.paints, ['Background response']);
  assert.equal(f.frames.size, 0);
});
test('unicode split across transport chunks remains intact', () => {
  const f = fixture(); f.stream.push('\ud83d'); f.stream.push('\udfe3'); f.paint();
  assert.deepEqual(f.paints, ['🟣']);
});

test('continuous arrivals cannot extend smoothing beyond 240ms', async () => {
  const f = fixture(); f.stream.push('A'.repeat(100)); f.paint();
  f.stream.push('B'.repeat(10000)); const done = f.stream.drain();
  for (let i = 0; i < 14; i++) f.paint();
  await done;
  assert.equal(f.paints.join(''), 'A'.repeat(100) + 'B'.repeat(10000));
  assert.equal(f.frames.size, 0);
});

test('completion still resolves when frames stop after draining begins', async () => {
  const f = fixture(); f.stream.push('Final text');
  await f.stream.drain();
  assert.equal(f.paints.join(''), 'Final text');
  assert.equal(f.frames.size, 0);
});

test('switching to immediate delivery preserves queued text before new deltas', () => {
  let immediate = false;
  let callback: (() => void) | undefined;
  const paints: string[] = [];
  const stream = createTextStream(text => paints.push(text), next => { callback = next; return 1; }, () => { callback = undefined; }, () => immediate);
  stream.push('Earlier ');
  immediate = true;
  stream.push('later');
  assert.deepEqual(paints, ['Earlier later']);
  assert.equal(callback, undefined);
});

test('a trailing Unicode surrogate waits across animation frames for its pair', () => {
  const f = fixture();
  f.stream.push('\ud83d'); f.paint();
  assert.deepEqual(f.paints, []);
  f.stream.push('\udfe3'); f.paint();
  assert.deepEqual(f.paints, ['🟣']);
});

test('multiple completion callers resolve and paint only once', async () => {
  const f = fixture();
  f.stream.push('One completion');
  const first = f.stream.drain(), second = f.stream.drain();
  f.paint();
  await Promise.all([first, second]);
  assert.deepEqual(f.paints, ['One completion']);
});
