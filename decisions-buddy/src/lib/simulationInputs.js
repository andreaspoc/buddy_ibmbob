const MAX_CASES = 100;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

// Strict RFC 4180-style records, including quoted commas, escaped quotes and newlines.
export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('CSV must be at most 1 MB.');
  const records = [];
  let row = [], cell = '', quoted = false, closed = false, recordHasTokens = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (recordHasTokens || row.some(value => value !== '')) records.push(row); row = []; recordHasTokens = false; };
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ',') { recordHasTokens = true; pushCell(); }
    else if (char === '\r' || char === '\n') { pushRow(); if (char === '\r' && source[i + 1] === '\n') i++; }
    else if (char === '"' && cell === '' && !closed) { recordHasTokens = true; quoted = true; }
    else {
      if (closed || char === '"') throw new Error('Unexpected character outside a quoted CSV cell.');
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted cell.');
  if (cell !== '' || row.length || closed || recordHasTokens) pushRow();
  if (records.length < 2) throw new Error('CSV needs a header and at least one data row.');
  const headers = records.shift().map(value => value.trim());
  if (headers.some(value => !value || unsafeKeys.has(value)) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique, nonempty field names.');
  if (records.length > MAX_CASES) throw new Error('Import at most 100 independent scenarios.');
  return records.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${values.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, position) => [header, values[position]]));
  });
}

export function csvScenarios(rows, { path = '', parseValues = false } = {}) {
  const parts = path.trim() ? path.trim().split('.') : [];
  if (parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) || unsafeKeys.has(part))) throw new Error('Use a safe dot-separated object path, or leave it empty for root input.');
  return rows.map(row => {
    let input = Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (!parseValues || value === '') return [key, value];
      try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
    }));
    for (const part of [...parts].reverse()) input = { [part]: input };
    return { input };
  });
}

export function parseScenarios(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Batch input must be at most 1 MB.');
  const cases = JSON.parse(text);
  if (!Array.isArray(cases) || !cases.length || cases.length > MAX_CASES) throw new Error('Provide 1–100 scenarios as a JSON array.');
  for (const scenario of cases) {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario) || !scenario.input || typeof scenario.input !== 'object' || Array.isArray(scenario.input)) throw new Error('Each scenario needs an input object and may include an expected value.');
    if (Object.hasOwn(scenario, 'name') && typeof scenario.name !== 'string') throw new Error('Scenario names must be strings.');
    if (Object.keys(scenario).some(key => !['input', 'expected', 'name'].includes(key))) throw new Error('Scenario fields are input, expected and optional name.');
  }
  return cases;
}

export function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left), other = Object.keys(right);
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export function batchPayload(model, scenarios) {
  const source = model?._dirty || !model?.version ? { graph: model.graph } : { decisionId: model.id, expectedVersion: model.version };
  return { ...source, items: scenarios.map(scenario => scenario.input) };
}
