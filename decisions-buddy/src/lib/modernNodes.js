export const ACTION_TYPES = ['actionRuleNode', 'businessRuleNode', 'balRuleNode'];
export const AGENDA_TYPES = ['inferenceNode', 'ruleAgendaNode'];
export const MODERN_TYPES = [...ACTION_TYPES, ...AGENDA_TYPES, 'forkNode', 'joinNode'];
export const TERM_TYPES = ['any', 'string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

export function modernNodeDefaults(type) {
  if (ACTION_TYPES.includes(type)) return { name: 'Business Action Rule', content: {
    source: 'if true\nthen set decision approved to true;\nelse set decision approved to false;',
    vocabulary: [{ term: 'decision approved', path: 'approved', type: 'boolean', required: false }]
  } };
  if (AGENDA_TYPES.includes(type)) return { name: 'Fact Inference', content: {
    rules: [{ id: 'rule1', priority: 0, condition: 'true', actions: ['set approved to true'] }],
    maxCycles: 50, conflictResolution: 'priority', vocabulary: []
  } };
  if (type === 'forkNode') return { name: 'Parallel Fork', content: { maxWorkers: 4 } };
  if (type === 'joinNode') return { name: 'Parallel Join', content: { mergePolicy: 'error' } };
  return null;
}

export function modernNodeDraft(type, content = {}, inheritedVocabulary = []) {
  const draft = { ...(modernNodeDefaults(type)?.content || {}), ...structuredClone(content) };
  if (ACTION_TYPES.includes(type) || AGENDA_TYPES.includes(type)) draft.vocabulary = structuredClone(content.vocabulary ?? inheritedVocabulary);
  if (ACTION_TYPES.includes(type)) draft.source = content.source || content.rule || '';
  if (AGENDA_TYPES.includes(type)) draft.rules = (content.rules || []).map((rule, index) => ({ ...rule, id: rule.id || rule._id || `rule_${index + 1}`, priority: rule.priority ?? 0,
    actionsText: Array.isArray(rule.actions) && rule.actions.every(action => typeof action === 'string')
      ? rule.actions.join(';\n') : typeof rule.actions === 'string' ? rule.actions : JSON.stringify(rule.actions || [], null, 2),
    patternsText: JSON.stringify(rule.patterns || [], null, 2)
  }));
  return draft;
}

export function normalizeModernDraft(type, draft) {
  const content = structuredClone(draft);
  if (ACTION_TYPES.includes(type) && (!content.source?.trim() || content.source.length > 16384)) throw new Error('Provide a business rule of at most 16384 characters.');
  if (content.vocabulary) {
    const seen = new Set(), paths = new Map();
    if (content.vocabulary.length > 100) throw new Error('Use at most 100 business terms.');
    const keywords = new Set('if then else definitions set add to and or not is in true false null'.split(' '));
    for (const entry of content.vocabulary) {
      if (!/^[a-z][a-z0-9_]*( [a-z][a-z0-9_]*)*$/i.test(entry.term) || entry.term.length > 120 || seen.has(entry.term.toLowerCase()) || entry.term.toLowerCase().split(' ').some(word => keywords.has(word))) throw new Error('Business terms must be unique words without language keywords.');
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/i.test(entry.path) || entry.path.length > 256) throw new Error('Map each term to a public JSON field path, such as customer.creditScore.');
      if (!TERM_TYPES.includes(entry.type || 'any')) throw new Error('Select a supported term type.');
      if (paths.has(entry.path) && paths.get(entry.path) !== entry.type) throw new Error('Terms sharing a path must use the same type.');
      seen.add(entry.term.toLowerCase()); paths.set(entry.path, entry.type);
    }
  }
  if (AGENDA_TYPES.includes(type)) {
    if (!Number.isInteger(content.maxCycles) || content.maxCycles < 1 || content.maxCycles > 500) throw new Error('Firing limit must be 1–500.');
    if (!['priority', 'specificity', 'recency'].includes(content.conflictResolution)) throw new Error('Select a supported rule selection policy.');
    if (!Array.isArray(content.rules) || content.rules.length > 500) throw new Error('Use at most 500 rules.');
    const seen = new Set();
    content.rules = content.rules.map(rule => {
      if (!rule.id?.trim() || seen.has(rule.id)) throw new Error('Rule identifiers must be unique and nonempty.');
      if (!Number.isInteger(rule.priority)) throw new Error('Rule priority must be an integer.');
      seen.add(rule.id);
      const { actionsText, patternsText, ...saved } = rule;
      saved.actions = actionsText.trim().startsWith('[') ? JSON.parse(actionsText) : actionsText;
      saved.patterns = JSON.parse(patternsText || '[]');
      if (!Array.isArray(saved.patterns) || (typeof saved.actions !== 'string' && !Array.isArray(saved.actions))) throw new Error('Fact patterns and structured actions must be JSON arrays.');
      return saved;
    });
  }
  if (type === 'forkNode') {
    if (!Number.isInteger(content.maxWorkers) || content.maxWorkers < 1 || content.maxWorkers > 8) throw new Error('Parallel workers must be 1–8.');
    if (!content.joinId?.trim()) delete content.joinId;
  }
  if (type === 'joinNode' && !['error', 'first', 'last'].includes(content.mergePolicy)) throw new Error('Select a merge policy.');
  return content;
}
