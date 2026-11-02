import { afterEach, describe, expect, test, vi } from 'vitest';
// @ts-expect-error plain JS modules outside the typed project
import { batchPayload, csvScenarios, parseCsv, parseScenarios, sameJson } from '../../../decisions-buddy/src/lib/simulationInputs.js';
// @ts-expect-error plain JS modules outside the typed project
import { ACTION_TYPES, AGENDA_TYPES, MODERN_TYPES, modernNodeDefaults, modernNodeDraft, normalizeModernDraft } from '../../../decisions-buddy/src/lib/modernNodes.js';
// @ts-expect-error plain JS modules outside the typed project
import { applySavedModel, canEdit, mergeProviderSettings, mergeSavedModels, newDraft, savedModelsChanged, savePayload } from '../../../decisions-buddy/src/decision-state.js';
// @ts-expect-error plain JS modules outside the typed project
import { API_BASE, DECISIONS_API, apiRequest } from '../../../decisions-buddy/src/config.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('parseCsv', () => {
  test('maps rows to header names', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  test('handles quoted commas, escaped quotes, embedded newlines, BOM and CRLF', () => {
    const text = '\uFEFFname,note\r\n"Smith, Jo","said ""hi"""\r\n"multi\nline",plain\r\n';
    expect(parseCsv(text)).toEqual([
      { name: 'Smith, Jo', note: 'said "hi"' },
      { name: 'multi\nline', note: 'plain' },
    ]);
  });

  test('trims header names but keeps cell whitespace', () => {
    expect(parseCsv(' a , b \n 1 , 2 ')).toEqual([{ a: ' 1 ', b: ' 2 ' }]);
  });

  test('skips blank lines between records', () => {
    expect(parseCsv('a\n1\n\n2\n')).toEqual([{ a: '1' }, { a: '2' }]);
  });

  test.each([
    ['non-string input', 42, 'CSV must be at most 1 MB.'],
    ['oversized input', 'x'.repeat(1024 * 1024 + 1), 'CSV must be at most 1 MB.'],
    ['unterminated quote', 'a\n"open', 'unterminated quoted cell'],
    ['text after a closing quote', 'a\n"x"y', 'Unexpected character outside a quoted CSV cell.'],
    ['quote inside an unquoted cell', 'a\nab"c', 'Unexpected character outside a quoted CSV cell.'],
    ['header only', 'a,b', 'needs a header and at least one data row'],
    ['empty input', '', 'needs a header and at least one data row'],
    ['duplicate headers', 'a,a\n1,2', 'unique, nonempty field names'],
    ['empty header', 'a,\n1,2', 'unique, nonempty field names'],
    ['prototype-polluting header', '__proto__,b\n1,2', 'unique, nonempty field names'],
    ['constructor header', 'constructor\n1', 'unique, nonempty field names'],
    ['short row', 'a,b\n1', 'CSV row 2 has 1 cells; expected 2.'],
    ['long row', 'a,b\n1,2\n1,2,3', 'CSV row 3 has 3 cells; expected 2.'],
  ])('rejects %s', (_name, input, message) => {
    expect(() => parseCsv(input)).toThrow(message);
  });

  test('allows exactly 100 data rows and rejects 101', () => {
    const rows = (count: number) => 'a\n' + Array.from({ length: count }, (_, i) => String(i)).join('\n');
    expect(parseCsv(rows(100))).toHaveLength(100);
    expect(() => parseCsv(rows(101))).toThrow('Import at most 100 independent scenarios.');
  });

  test('parsed rows are plain data without prototype pollution', () => {
    const [row] = parseCsv('a\n1');
    expect(Object.keys(row)).toEqual(['a']);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });
});

describe('csvScenarios', () => {
  const rows = [{ amount: '5', flag: 'true', label: 'abc', blank: '' }];

  test('keeps strings by default and wraps the input in the requested path', () => {
    expect(csvScenarios(rows, { path: ' customer.profile ' })).toEqual([
      { input: { customer: { profile: { amount: '5', flag: 'true', label: 'abc', blank: '' } } } },
    ]);
  });

  test('parses JSON values when asked, leaving invalid and empty cells alone', () => {
    expect(csvScenarios(rows, { parseValues: true })).toEqual([
      { input: { amount: 5, flag: true, label: 'abc', blank: '' } },
    ]);
  });

  test('uses the root input when no path is given', () => {
    expect(csvScenarios([{ x: '1' }])).toEqual([{ input: { x: '1' } }]);
  });

  test.each(['a.b-c', '1a', 'a..b', '__proto__', 'x.constructor', 'prototype'])('rejects unsafe path %s', path => {
    expect(() => csvScenarios(rows, { path })).toThrow('safe dot-separated object path');
  });
});

describe('parseScenarios', () => {
  test('accepts named scenarios with expected values', () => {
    const cases = [{ input: { a: 1 }, expected: 2, name: 'first' }, { input: {} }];
    expect(parseScenarios(JSON.stringify(cases))).toEqual(cases);
  });

  test.each([
    ['non-string', 7, 'at most 1 MB'],
    ['oversized', ' '.repeat(1024 * 1024 + 1), 'at most 1 MB'],
    ['not an array', '{}', '1–100 scenarios'],
    ['empty array', '[]', '1–100 scenarios'],
    ['too many', JSON.stringify(Array.from({ length: 101 }, () => ({ input: {} }))), '1–100 scenarios'],
    ['null scenario', '[null]', 'needs an input object'],
    ['array scenario', '[[]]', 'needs an input object'],
    ['missing input', '[{"expected":1}]', 'needs an input object'],
    ['array input', '[{"input":[]}]', 'needs an input object'],
    ['non-string name', '[{"input":{},"name":3}]', 'names must be strings'],
    ['unknown field', '[{"input":{},"extra":1}]', 'Scenario fields are input, expected and optional name.'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseScenarios(text)).toThrow(message);
  });

  test('propagates JSON syntax errors', () => {
    expect(() => parseScenarios('{oops')).toThrow(SyntaxError);
  });
});

describe('sameJson', () => {
  test.each([
    [1, 1, true], ['a', 'a', true], [NaN, NaN, true], [null, null, true],
    [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, true],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [1, 2, false], [null, {}, false], [{}, [], false], [[1], { 0: 1 }, false],
    [{ a: 1 }, { a: 1, b: 2 }, false], [{ a: 1 }, { b: 1 }, false],
    [{ a: undefined }, { b: undefined }, false], [[1, 2], [1, 3], false],
  ])('%j vs %j is %s', (left, right, expected) => {
    expect(sameJson(left, right)).toBe(expected);
  });
});

describe('batchPayload', () => {
  const scenarios = [{ input: { a: 1 } }, { input: { a: 2 } }];

  test('uses the saved version for clean, versioned models', () => {
    expect(batchPayload({ id: 'd1', version: 3, graph: {} }, scenarios)).toEqual({
      decisionId: 'd1', expectedVersion: 3, items: [{ a: 1 }, { a: 2 }],
    });
  });

  test.each([{ id: 'd1', version: 3, _dirty: true, graph: { nodes: [] } }, { id: 'd2', graph: { nodes: [] } }])(
    'sends the draft graph for unsaved models', model => {
      expect(batchPayload(model, scenarios)).toEqual({ graph: { nodes: [] }, items: [{ a: 1 }, { a: 2 }] });
    });
});

describe('modernNodeDefaults', () => {
  test.each(ACTION_TYPES)('%s starts with a vocabulary-backed business rule', (type: string) => {
    const defaults = modernNodeDefaults(type);
    expect(defaults.name).toBe('Business Action Rule');
    expect(defaults.content.vocabulary[0]).toMatchObject({ term: 'decision approved', type: 'boolean' });
  });

  test.each(AGENDA_TYPES)('%s starts with one prioritized rule', (type: string) => {
    expect(modernNodeDefaults(type).content).toMatchObject({ maxCycles: 50, conflictResolution: 'priority' });
  });

  test('fork, join and unknown types', () => {
    expect(modernNodeDefaults('forkNode').content).toEqual({ maxWorkers: 4 });
    expect(modernNodeDefaults('joinNode').content).toEqual({ mergePolicy: 'error' });
    expect(modernNodeDefaults('decisionTableNode')).toBeNull();
    expect(MODERN_TYPES).toHaveLength(7);
  });

  test('defaults are fresh objects each time', () => {
    modernNodeDefaults('forkNode').content.maxWorkers = 99;
    expect(modernNodeDefaults('forkNode').content.maxWorkers).toBe(4);
  });
});

describe('modernNodeDraft', () => {
  test('action nodes fall back from source to legacy rule text and inherit vocabulary', () => {
    const inherited = [{ term: 'score', path: 'score', type: 'number' }];
    const draft = modernNodeDraft('businessRuleNode', { rule: 'if true then set x to 1;' }, inherited);
    expect(draft.source).toBe('if true then set x to 1;');
    expect(draft.vocabulary).toEqual(inherited);
    expect(draft.vocabulary).not.toBe(inherited);
  });

  test('own vocabulary wins over inherited, and empty source stays empty', () => {
    const draft = modernNodeDraft('actionRuleNode', { vocabulary: [] }, [{ term: 'x', path: 'x' }]);
    expect(draft.vocabulary).toEqual([]);
    expect(draft.source).toBe('');
  });

  test('agenda rules expose editable text for actions and patterns', () => {
    const draft = modernNodeDraft('inferenceNode', { rules: [
      { actions: ['set a to 1', 'set b to 2'] },
      { id: 'named', priority: 5, actions: 'set c to 3', patterns: [{ fact: 'x' }] },
      { _id: 'legacy', actions: [{ op: 'set' }] },
      {},
    ] });
    expect(draft.rules.map((rule: { id: string }) => rule.id)).toEqual(['rule_1', 'named', 'legacy', 'rule_4']);
    expect(draft.rules[0]).toMatchObject({ priority: 0, actionsText: 'set a to 1;\nset b to 2', patternsText: '[]' });
    expect(draft.rules[1]).toMatchObject({ priority: 5, actionsText: 'set c to 3' });
    expect(JSON.parse(draft.rules[1].patternsText)).toEqual([{ fact: 'x' }]);
    expect(JSON.parse(draft.rules[2].actionsText)).toEqual([{ op: 'set' }]);
    expect(draft.rules[3].actionsText).toBe('[]');
  });

  test('non-agenda nodes keep their own content and do not alias the input', () => {
    const content = { maxWorkers: 2, nested: { a: 1 } };
    const draft = modernNodeDraft('forkNode', content);
    expect(draft).toEqual(content);
    draft.nested.a = 2;
    expect(content.nested.a).toBe(1);
  });

  test('unknown types produce just the supplied content', () => {
    expect(modernNodeDraft('other', { a: 1 })).toEqual({ a: 1 });
  });
});

describe('normalizeModernDraft', () => {
  const term = (overrides = {}) => ({ term: 'credit score', path: 'customer.creditScore', type: 'number', ...overrides });

  test('action rule round trips', () => {
    const draft = modernNodeDraft('actionRuleNode', { source: 'if true then set x to 1;', vocabulary: [term()] });
    expect(normalizeModernDraft('actionRuleNode', draft)).toEqual(draft);
  });

  test.each([
    ['empty source', { source: '  ', vocabulary: [] }],
    ['oversized source', { source: 'x'.repeat(16385), vocabulary: [] }],
  ])('rejects an action rule with %s', (_name, draft) => {
    expect(() => normalizeModernDraft('businessRuleNode', draft)).toThrow('business rule of at most 16384 characters');
  });

  test.each([
    ['invalid characters', term({ term: '1bad' })],
    ['reserved word', term({ term: 'if score' })],
    ['too long', term({ term: 'a'.repeat(121) })],
    ['bad path', term({ path: 'a..b' })],
    ['path too long', term({ path: 'a'.repeat(257) })],
    ['unsupported type', term({ type: 'date' })],
  ])('rejects a vocabulary entry with %s', (_name, entry) => {
    expect(() => normalizeModernDraft('actionRuleNode', { source: 'x', vocabulary: [entry] })).toThrow();
  });

  test('rejects duplicate terms regardless of case and conflicting path types', () => {
    const base = { source: 'x' };
    expect(() => normalizeModernDraft('actionRuleNode', { ...base, vocabulary: [term(), term({ term: 'CREDIT SCORE', path: 'other' })] }))
      .toThrow('unique words');
    expect(() => normalizeModernDraft('actionRuleNode', { ...base, vocabulary: [term(), term({ term: 'other', type: 'string' })] }))
      .toThrow('same type');
  });

  test('allows several terms to share a path and type, and limits vocabulary size', () => {
    const shared = [term(), term({ term: 'score alias' })];
    expect(normalizeModernDraft('actionRuleNode', { source: 'x', vocabulary: shared }).vocabulary).toHaveLength(2);
    const many = Array.from({ length: 101 }, (_, i) => term({ term: `t${i}`, path: `p${i}` }));
    expect(() => normalizeModernDraft('actionRuleNode', { source: 'x', vocabulary: many })).toThrow('at most 100 business terms');
  });

  const agenda = (overrides = {}) => ({
    maxCycles: 10, conflictResolution: 'priority', vocabulary: [],
    rules: [{ id: 'r1', priority: 1, actionsText: 'set a to 1', patternsText: '' }], ...overrides,
  });

  test('agenda rules are converted back to the saved shape', () => {
    const saved = normalizeModernDraft('inferenceNode', agenda({ rules: [
      { id: 'r1', priority: 1, actionsText: 'set a to 1', patternsText: '' },
      { id: 'r2', priority: 2, actionsText: '[{"op":"set"}]', patternsText: '[{"fact":"x"}]' },
    ] }));
    expect(saved.rules).toEqual([
      { id: 'r1', priority: 1, actions: 'set a to 1', patterns: [] },
      { id: 'r2', priority: 2, actions: [{ op: 'set' }], patterns: [{ fact: 'x' }] },
    ]);
  });

  test.each([
    ['cycle limit too low', agenda({ maxCycles: 0 }), 'Firing limit must be 1–500.'],
    ['cycle limit too high', agenda({ maxCycles: 501 }), 'Firing limit must be 1–500.'],
    ['fractional cycle limit', agenda({ maxCycles: 1.5 }), 'Firing limit must be 1–500.'],
    ['unknown policy', agenda({ conflictResolution: 'random' }), 'supported rule selection policy'],
    ['rules not an array', agenda({ rules: 'x' }), 'at most 500 rules'],
    ['too many rules', agenda({ rules: Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, priority: 0, actionsText: '' })) }), 'at most 500 rules'],
    ['blank rule id', agenda({ rules: [{ id: ' ', priority: 0, actionsText: '' }] }), 'unique and nonempty'],
    ['duplicate rule id', agenda({ rules: [{ id: 'a', priority: 0, actionsText: '' }, { id: 'a', priority: 0, actionsText: '' }] }), 'unique and nonempty'],
    ['non-integer priority', agenda({ rules: [{ id: 'a', priority: 1.5, actionsText: '' }] }), 'priority must be an integer'],
    ['patterns not an array', agenda({ rules: [{ id: 'a', priority: 0, actionsText: '', patternsText: '{}' }] }), 'must be JSON arrays'],
    ['structured actions not an array', agenda({ rules: [{ id: 'a', priority: 0, actionsText: '[1', patternsText: '' }] }), undefined],
  ])('rejects %s', (_name, draft, message) => {
    expect(() => normalizeModernDraft('ruleAgendaNode', draft)).toThrow(message);
  });

  test('fork workers are bounded and a blank join id is dropped', () => {
    expect(() => normalizeModernDraft('forkNode', { maxWorkers: 0 })).toThrow('Parallel workers must be 1–8.');
    expect(() => normalizeModernDraft('forkNode', { maxWorkers: 9 })).toThrow('Parallel workers must be 1–8.');
    expect(() => normalizeModernDraft('forkNode', { maxWorkers: 2.5 })).toThrow('Parallel workers must be 1–8.');
    expect(normalizeModernDraft('forkNode', { maxWorkers: 8, joinId: ' ' })).toEqual({ maxWorkers: 8 });
    expect(normalizeModernDraft('forkNode', { maxWorkers: 1, joinId: 'j1' })).toEqual({ maxWorkers: 1, joinId: 'j1' });
  });

  test('join requires a known merge policy', () => {
    expect(() => normalizeModernDraft('joinNode', { mergePolicy: 'any' })).toThrow('Select a merge policy.');
    for (const mergePolicy of ['error', 'first', 'last']) {
      expect(normalizeModernDraft('joinNode', { mergePolicy })).toEqual({ mergePolicy });
    }
  });

  test('does not mutate the draft it is given', () => {
    const draft = agenda();
    normalizeModernDraft('inferenceNode', draft);
    expect(draft.rules[0]).toHaveProperty('actionsText');
  });
});

describe('decision state', () => {
  test('mergeSavedModels keeps unsaved and dirty local drafts over server copies', () => {
    const current = { a: { version: 1 }, b: { version: 2, _dirty: true, name: 'edited' }, c: { name: 'new draft' } };
    const saved = { a: { version: 5 }, b: { version: 3 }, d: { version: 1 } };
    expect(mergeSavedModels(current, saved)).toEqual({
      a: { version: 5 }, b: { version: 2, _dirty: true, name: 'edited' }, c: { name: 'new draft' }, d: { version: 1 },
    });
  });

  test('savePayload fills defaults and always sends an expected version', () => {
    expect(savePayload({ id: 'x', name: 'N', graph: { nodes: [] } })).toEqual({
      id: 'x', name: 'N', description: '', graph: { nodes: [] }, defaultInput: {}, accessPolicy: 'private', expectedVersion: 0,
    });
    expect(savePayload({ id: 'x', name: 'N', description: 'd', graph: {}, defaultInput: { a: 1 }, accessPolicy: 'shared', version: 4 }))
      .toMatchObject({ description: 'd', defaultInput: { a: 1 }, accessPolicy: 'shared', expectedVersion: 4 });
  });

  test.each([
    ['no model', null, { username: 'u' }, false],
    ['no user', { version: 1 }, null, false],
    ['unsaved draft with access', { owner: 'someone' }, { username: 'u', canAuthor: true }, true],
    ['unsaved draft without access', { owner: 'someone' }, { username: 'u' }, false],
    ['administrator', { version: 1, owner: 'someone' }, { username: 'u', isAdmin: true }, true],
    ['owner with access', { version: 1, owner: 'u' }, { username: 'u', canAuthor: true }, true],
    ['owner without access', { version: 1, owner: 'u' }, { username: 'u' }, false],
    ['another member', { version: 1, owner: 'someone' }, { username: 'u' }, false],
  ])('canEdit: %s', (_name, model, user, expected) => {
    expect(canEdit(model, user)).toBe(expected);
  });

  test('newDraft is a valid connected graph marked as unsaved', () => {
    const draft = newDraft('abc');
    expect(draft).toMatchObject({ id: 'abc', _dirty: true, status: 'draft', accessPolicy: 'private' });
    const ids = new Set(draft.graph.nodes.map((node: { id: string }) => node.id));
    expect(ids.size).toBe(draft.graph.nodes.length);
    for (const edge of draft.graph.edges) {
      expect(ids.has(edge.sourceId) && ids.has(edge.targetId)).toBe(true);
    }
    expect(newDraft('other').graph).not.toBe(newDraft('other').graph);
  });

  test('applySavedModel adopts the server copy only when nothing changed meanwhile', () => {
    const submitted = { name: 'N', graph: { nodes: [] }, version: 1 };
    const saved = { ...submitted, version: 2, status: 'active', environment: 'prod', owner: 'u', updatedAt: 't' };
    expect(applySavedModel(null, submitted, saved)).toBe(saved);
    expect(applySavedModel({ ...submitted }, submitted, saved)).toBe(saved);
    const edited = { ...submitted, name: 'Edited again' };
    expect(applySavedModel(edited, submitted, saved)).toEqual({
      ...edited, version: 2, status: 'active', environment: 'prod', owner: 'u', updatedAt: 't', _dirty: true,
    });
  });

  test('mergeProviderSettings', () => {
    const previous = { watsonx: { key: 'draft', revision: 1 }, other: { x: 1 } };
    const loaded = { watsonx: { key: 'server', revision: 2, credential_configured: true, last_test: 'ok' }, other: { x: 2 } };
    expect(mergeProviderSettings(previous, loaded, undefined)).toBe(loaded);
    expect(mergeProviderSettings(previous, loaded, 'watsonx')).toEqual({ watsonx: loaded.watsonx, other: { x: 1 } });
    expect(mergeProviderSettings(previous, loaded, 'watsonx', true)).toEqual({
      watsonx: { key: 'draft', revision: 2, credential_configured: true, last_test: 'ok' }, other: { x: 1 },
    });
  });

  test('savedModelsChanged compares revisions, not local draft content', () => {
    const model = { version: 1, status: 's', environment: 'e', accessPolicy: 'private', owner: 'u', updatedAt: 't' };
    expect(savedModelsChanged({ a: model }, { a: { ...model, name: 'draft only' } })).toBe(false);
    expect(savedModelsChanged({ a: model }, { a: { ...model, version: 2 } })).toBe(true);
    expect(savedModelsChanged({ a: model }, { b: model })).toBe(true);
    expect(savedModelsChanged({ a: model }, { a: model, b: model })).toBe(true);
    expect(savedModelsChanged({}, {})).toBe(false);
  });
});

describe('apiRequest', () => {
  const reply = (ok: boolean, status: number, body: unknown, badJson = false) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => { if (badJson) throw new Error('x'); return body; } });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  test('constants keep authentication on the same origin', () => {
    expect(API_BASE).toBe('');
    expect(DECISIONS_API).toBe('/api/decisions');
  });

  test('sends same-origin credentials and returns the JSON body', async () => {
    const fetchMock = reply(true, 200, { ok: 1 });
    expect(await apiRequest('/models', { method: 'POST' })).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/decisions/models', { credentials: 'same-origin', method: 'POST' });
  });

  test('a successful response without JSON yields null', async () => {
    reply(true, 204, null, true);
    expect(await apiRequest('/x')).toBeNull();
  });

  test.each([
    ['string detail', { detail: 'Not allowed' }, 'Not allowed'],
    ['object detail', { detail: { message: 'Version conflict' } }, 'Version conflict'],
    ['unusable detail', { detail: [] }, 'Request failed (HTTP 409).'],
    ['no body', null, 'Request failed (HTTP 409).'],
  ])('errors use the %s', async (_name, body, message) => {
    reply(false, 409, body);
    await expect(apiRequest('/x')).rejects.toThrow(message);
  });

  test('errors fall back when the body is not JSON', async () => {
    reply(false, 502, null, true);
    await expect(apiRequest('/x')).rejects.toThrow('Request failed (HTTP 502).');
  });
});
