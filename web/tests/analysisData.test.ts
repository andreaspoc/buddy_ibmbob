import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeAnalysisData } from '../src/lib/analysisData.ts';

test('analysis keeps supplied numbers and explicit missing cells without filling them', () => {
  const input = { title: 'Measured results', source: 'Uploaded CSV', headers: ['Region', 'Value'], rows: [['East', 0], ['West', null], ['North', -4.5]] };
  assert.deepEqual(normalizeAnalysisData(input), input);
  const normalized = normalizeAnalysisData(input)!;
  normalized.rows[0][1] = 8;
  assert.equal(input.rows[0][1], 0);
});
test('analysis rejects incomplete rows and nonfinite or structured cells', () => {
  for (const rows of [[['East']], [['East', Infinity]], [['East', NaN]], [['East', {}]], [['East', true]]]) {
    assert.equal(normalizeAnalysisData({ headers: ['Region', 'Value'], rows }), null);
  }
});
test('analysis requires usable columns and at least one supplied row', () => {
  for (const data of [null, {}, { headers: [''], rows: [[1]] }, { headers: ['A', 'B'], rows: [] }]) {
    assert.equal(normalizeAnalysisData(data), null);
  }
});
