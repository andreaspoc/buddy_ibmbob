import assert from 'node:assert/strict';

function parseNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[$€£¥%,]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function detectNumericColumns(headers, rows) {
  const numericColumns = [];
  headers.forEach((_, colIdx) => {
    let numericCount = 0;
    let populatedCount = 0;
    rows.forEach((row) => {
      const val = row[colIdx];
      if (val !== undefined && val !== '') {
        populatedCount++;
        if (parseNumber(val) !== null) {
          numericCount++;
        }
      }
    });
    if (populatedCount > 0 && numericCount / populatedCount >= 0.6) {
      numericColumns.push(colIdx);
    }
  });
  return numericColumns;
}

// Test 1: Number parsing with currencies and percentages
assert.equal(parseNumber('$1,250.50'), 1250.5);
assert.equal(parseNumber('99.9%'), 99.9);
assert.equal(parseNumber('€450'), 450);
assert.equal(parseNumber('-15'), -15);
assert.equal(parseNumber('London'), null);

// Test 2: Detect numeric columns in typical Company A dataset
const headers = ['Region', 'Subscribers', 'Revenue', 'Status'];
const rows = [
  ['London', '12,450', '€249,000', 'Active'],
  ['Manchester', '9,800', '€196,000', 'Active'],
  ['Leeds', '4,200', '€84,000', 'Active'],
  ['Paphos', '3,100', '€62,000', 'Pending'],
];

const numCols = detectNumericColumns(headers, rows);
assert.deepEqual(numCols, [1, 2], 'Columns 1 (Subscribers) and 2 (Revenue) should be detected as numeric');

console.log('Interactive Table Data parsing checks passed');
