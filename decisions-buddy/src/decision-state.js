/** Pure state rules: drafts remain local until the server confirms a version. */
export function mergeSavedModels(current, saved) {
  const result = { ...saved };
  for (const [id, model] of Object.entries(current)) {
    if (model._dirty || !model.version) result[id] = model;
  }
  return result;
}

export function savePayload(model) {
  return {
    id: model.id, name: model.name, description: model.description || '',
    graph: model.graph, defaultInput: model.defaultInput || {},
    accessPolicy: model.accessPolicy || 'private', expectedVersion: model.version || 0,
  };
}

export function canEdit(model, user) {
  return Boolean(model && user && (user.isAdmin || (user.canAuthor && (!model.version || model.owner === user.username))));
}

export function newDraft(id) {
  return {
    id, name: 'Untitled decision', description: 'Operational decision model evaluating input rules.', accessPolicy: 'private',
    status: 'draft', environment: 'development', defaultInput: { value: 25 }, _dirty: true,
    graph: {
      nodes: [
        { id: 'input', name: 'Input', type: 'inputNode', position: { x: 100, y: 160 }, content: {} },
        { id: 'table', name: 'Decision table', type: 'decisionTableNode', position: { x: 380, y: 160 }, content: {
          hitPolicy: 'first',
          inputs: [{ id: 'value', field: 'value', name: 'Value' }],
          outputs: [{ id: 'result', field: 'result', name: 'Result' }],
          rules: [
            { _id: 'rule_1', value: '>= 0', result: '"Approved"' },
            { _id: 'rule_2', value: '< 0', result: '"Rejected"' },
          ],
        } },
        { id: 'output', name: 'Output', type: 'outputNode', position: { x: 680, y: 160 }, content: {} },
      ],
      edges: [{ id: 'inputtable', sourceId: 'input', targetId: 'table' },
              { id: 'tableoutput', sourceId: 'table', targetId: 'output' }],
    },
  };
}

export function applySavedModel(current, submitted, saved) {
  const content = model => JSON.stringify({ name: model.name, description: model.description || '', graph: model.graph, defaultInput: model.defaultInput || {}, accessPolicy: model.accessPolicy || 'private' });
  if (!current || content(current) === content(submitted)) return saved;
  return { ...current, version: saved.version, status: saved.status, environment: saved.environment,
    owner: saved.owner, updatedAt: saved.updatedAt, _dirty: true };
}

export function mergeProviderSettings(previous, loaded, provider, keepDraft = false) {
  if (!provider) return loaded;
  const updated = loaded[provider];
  const value = keepDraft ? { ...previous[provider], revision: updated.revision,
    credential_configured: updated.credential_configured, last_test: updated.last_test } : updated;
  return { ...previous, [provider]: value };
}

/** Compare authorized saved snapshots, independently of preserved local drafts. */
export function savedModelsChanged(previous, loaded) {
  const revision = model => JSON.stringify([model.version, model.status, model.environment,
    model.accessPolicy, model.owner, model.updatedAt]);
  const ids = Object.keys(previous);
  return ids.length !== Object.keys(loaded).length || ids.some(id => !loaded[id] || revision(previous[id]) !== revision(loaded[id]));
}
