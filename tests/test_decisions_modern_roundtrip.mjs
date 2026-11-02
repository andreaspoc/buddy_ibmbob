// Pure authoring-state tests use synthetic policies and never call provider APIs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { modernNodeDraft, modernNodeDefaults, normalizeModernDraft } from '../decisions-buddy/src/lib/modernNodes.js';

test('all new modern node defaults survive editor normalization', () => {
  for (const type of ['actionRuleNode', 'businessRuleNode', 'balRuleNode', 'inferenceNode', 'ruleAgendaNode', 'forkNode', 'joinNode']) {
    const { content } = modernNodeDefaults(type);
    const saved = normalizeModernDraft(type, modernNodeDraft(type, content));
    assert.equal(saved.customOption, undefined);
    if (type.endsWith('RuleNode')) assert.equal(saved.source, content.source);
  }
});

test('imported minimal valid modern nodes receive the defaults shown by controls', () => {
  assert.equal(normalizeModernDraft('forkNode', modernNodeDraft('forkNode', {})).maxWorkers, 4);
  assert.equal(normalizeModernDraft('joinNode', modernNodeDraft('joinNode', {})).mergePolicy, 'error');
  const saved = normalizeModernDraft('inferenceNode', modernNodeDraft('inferenceNode', {
    rules: [{ condition: 'true', actions: ['set approved to true'] }]
  }));
  assert.equal(saved.maxCycles, 50);
  assert.equal(saved.rules[0].priority, 0);
  assert.ok(saved.rules[0].id);
});

test('typed inherited vocabulary and extension metadata survive action-rule edits', () => {
  const vocabulary = [{ term: 'applicant age', path: 'customer.age', type: 'integer', required: true }];
  const original = { rule: 'if applicant age >= 18 then set approved to true;', customOption: { retained: true } };
  const draft = modernNodeDraft('balRuleNode', original, vocabulary);
  draft.source = 'if applicant age >= 21 then set approved to true;';
  const saved = normalizeModernDraft('balRuleNode', draft);
  assert.deepEqual(saved.vocabulary, vocabulary);
  assert.deepEqual(saved.customOption, { retained: true });
  assert.equal(saved.source, 'if applicant age >= 21 then set approved to true;');
  assert.equal(original.source, undefined);
  assert.equal(vocabulary[0].term, 'applicant age');
});

test('fact patterns and structured actions roundtrip without editor-only fields', () => {
  const content = {
    maxCycles: 20, conflictResolution: 'specificity', customOption: 'retained',
    rules: [{ id: 'pending', priority: 3, condition: 'order.total > 10',
      patterns: [{ collection: 'facts.orders', as: 'order', equals: { status: 'pending' }, where: 'order.total > 0' }],
      actions: [{ op: 'update', fact: 'order', values: { approved: 'true' } }],
      extension: 'preserved', loopable: false }]
  };
  const saved = normalizeModernDraft('inferenceNode', modernNodeDraft('inferenceNode', content));
  assert.deepEqual(saved.rules, content.rules);
  assert.equal(saved.customOption, 'retained');
  assert.equal(saved.conflictResolution, 'specificity');
  assert.equal('actionsText' in saved.rules[0], false);
  assert.equal('patternsText' in saved.rules[0], false);
});

test('quoted semicolon actions retain their text and explicit fork join roundtrips', () => {
  const content = { maxCycles: 50, rules: [{ id: 'note', priority: 0, actions: ['set note to "if; then; else"', 'set approved to true'] }] };
  const saved = normalizeModernDraft('inferenceNode', modernNodeDraft('inferenceNode', content));
  assert.equal(saved.rules[0].actions, 'set note to "if; then; else";\nset approved to true');
  const fork = { maxWorkers: 2, joinId: 'join', extension: 1 };
  assert.deepEqual(normalizeModernDraft('forkNode', modernNodeDraft('forkNode', fork)), fork);
});
