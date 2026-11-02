import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvScenarios, parseScenarios, sameJson, batchPayload } from '../decisions-buddy/src/lib/simulationInputs.js';

test('CSV preserves escaped quotes, commas, multiline fields, BOM and leading zero strings', () => {
  assert.deepEqual(parseCsv('\uFEFFname,id,note\r\n"Doe, Jane",001,"said ""yes""\nand left"\r\n'), [{ name: 'Doe, Jane', id: '001', note: 'said "yes"\nand left' }]);
});
test('CSV preserves empty fields as actual independent rows', () => {
  assert.deepEqual(parseCsv('a,b\n,\n'), [{ a: '', b: '' }]);
  assert.deepEqual(parseCsv('a\n""\n'), [{ a: '' }]);
});
test('CSV rejects malformed structure and unsafe duplicate headers', () => {
  for (const text of ['a,a\n1,2', 'a,b\n1', 'a\n"unfinished', 'a\n"closed"bad', '__proto__\nvalue']) assert.throws(() => parseCsv(text));
});
test('CSV mappings are explicit and values remain strings unless requested', () => {
  const rows = parseCsv('age,enabled\n42,true');
  assert.deepEqual(csvScenarios(rows), [{ input: { age: '42', enabled: 'true' } }]);
  assert.deepEqual(csvScenarios(rows, { path: 'customer', parseValues: true }), [{ input: { customer: { age: 42, enabled: true } } }]);
  assert.throws(() => csvScenarios(rows, { path: '__proto__.x' }));
});
test('batch input has independent objects and optional explicit expected values', () => {
  assert.equal(parseScenarios('[{"input":{},"expected":null}]').length, 1);
  for (const text of ['{}', '[]', '[{"age":3}]', '[{"input":[]}]']) assert.throws(() => parseScenarios(text));
});
test('batch calls bind saved version or exact current draft', () => {
  const graph = { nodes: [] }, cases = [{ input: { a: 1 } }];
  assert.deepEqual(batchPayload({ id: 'm', version: 2, graph }, cases), { decisionId: 'm', expectedVersion: 2, items: [{ a: 1 }] });
  assert.deepEqual(batchPayload({ id: 'm', version: 2, graph, _dirty: true }, cases), { graph, items: [{ a: 1 }] });
});
test('expected outputs compare structurally without depending on object key order', () => {
  assert.equal(sameJson({ a: [1, false], b: null }, { b: null, a: [1, false] }), true);
  assert.equal(sameJson({ a: 0 }, { a: '0' }), false);
  assert.equal(sameJson([1, 2], [2, 1]), false);
});
