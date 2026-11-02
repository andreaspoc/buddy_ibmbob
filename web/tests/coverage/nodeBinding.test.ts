import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
const require = createRequire(import.meta.url);
test('Node binding decision graphs and expression security', async () => {
  await expect(require('../../../bindings/nodejs/test.js').runTests()).resolves.toBeUndefined();
});

test('loads and caches decision graphs and validates output and cycles', async () => {
  const { ZenEngine, ZenDecisionContent, evaluateUnary } = require('../../../bindings/nodejs');
  const graph = { nodes: [
    { id: 'in', type: 'inputNode' },
    { id: 'expr', type: 'expressionNode', content: { expressions: [{ key: 'result.value', value: 'score + 1' }] } },
    { id: 'out', type: 'outputNode', content: { schema: ['result.value'] } },
  ], edges: [{ sourceId: 'in', targetId: 'expr' }, { sourceId: 'expr', targetId: 'out' }] };
  let loads = 0;
  const engine = new ZenEngine({ loader: async (key: string) => { loads++; return key === 'known' ? { graph } : null; } });
  const first = await engine.getDecision('known');
  const second = await engine.getDecision('known');
  const assert = require('node:assert/strict');
  expect(first).toBe(second); expect(loads).toBe(1);
  const result = await engine.evaluate('known', { score: 9 }, { trace: true });
  assert.deepEqual(result.result, { 'result.value': 10 }); assert.equal(result.trace.length, 3);
  assert.equal(evaluateUnary('(1..3]', 1).passed, false);
  assert.equal(evaluateUnary('(1..3]', 3).passed, true);
  assert.equal(evaluateUnary('not in [1, 2]', 2).passed, false);
  await assert.rejects(() => engine.evaluate('missing', {}, {}), /not found/);
  assert.throws(() => new ZenDecisionContent(null), /Invalid decision content/);
  const cycle = engine.createDecision({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ sourceId: 'a', targetId: 'b' }, { sourceId: 'b', targetId: 'a' }] });
  assert.throws(() => cycle.evaluateSync({}), /cycle/i);
  engine.dispose();
});

test('expression builtins handle collections, strings, and invalid input', () => {
  const { safeEvalExpression } = require('../../../bindings/nodejs');
  const context = { values: [1, 2, 2], name: 'hello', empty: [], invalid: null };
  const cases: Array<[string, unknown]> = [
    ['sum(values)', 5], ['avg(values)', 5 / 3], ['avg(empty)', 0],
    ['min(values)', 1], ['max(values)', 2], ['min(empty)', 0], ['max(empty)', 0],
    ['count(values)', 3], ['count(invalid)', 0], ['len(name)', 5], ['len(invalid)', 0],
    ['contains(name, "ell")', true], ['contains(values, 3)', false],
    ['startsWith(name, "he")', true], ['endsWith(name, "lo")', true],
    ['matches(name, "[")', false], ['unique(values)', [1, 2]],
    ['join(values, "-")', '1-2-2'], ['split(name, "l")', ['he', '', 'o']],
    ['replace(name, "l", "x")', 'hexxo'], ['slice(name, 1, 4)', 'ell'],
    ['flatten(invalid)', []], ['join(invalid)', ''], ['split(invalid)', []],
  ];
  for (const [expression, expected] of cases) {
    expect(safeEvalExpression(expression, context), expression).toEqual(expected);
  }
});
