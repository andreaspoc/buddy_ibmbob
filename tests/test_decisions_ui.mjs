import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const frontend = path.join(root, existsSync(path.join(root, 'decisions-buddy')) ? 'decisions-buddy' : 'carbon-zen-engine');
const { mergeSavedModels, savePayload, canEdit, newDraft, applySavedModel, mergeProviderSettings, savedModelsChanged } = await import(pathToFileURL(path.join(frontend, 'src/decision-state.js')));
const { apiRequest } = await import(pathToFileURL(path.join(frontend, 'src/config.js')));

test('refresh preserves dirty drafts but replaces clean snapshots and removes deleted clean models', () => {
  const dirty = { id: 'dirty', name: 'Local edit', version: 3, _dirty: true };
  const draft = { id: 'new', name: 'New', _dirty: true };
  const saved = { clean: { id: 'clean', version: 2 }, dirty: { id: 'dirty', version: 4 } };
  const merged = mergeSavedModels({ dirty, new: draft, clean: { id: 'clean', version: 1 }, deleted: { id: 'deleted', version: 1 } }, saved);
  assert.equal(merged.dirty, dirty);
  assert.equal(merged.new, draft);
  assert.equal(merged.clean.version, 2);
  assert.equal(merged.deleted, undefined);
});

test('save binds expected version, defaults private, and never supplies actor/admin claims', () => {
  const model = { ...newDraft('synthetic'), name: 'Rules', version: 7, username: 'someone-else', isAdmin: true, owner: 'synthetic-owner' };
  const payload = savePayload(model);
  assert.equal(payload.expectedVersion, 7);
  assert.equal(payload.accessPolicy, 'private');
  assert.equal(payload.username, undefined);
  assert.equal(payload.owner, undefined);
  assert.equal(payload.isAdmin, undefined);
  assert.equal(savePayload(newDraft('new')).expectedVersion, 0);
});

test('editing saved models requires the authenticated owner or administrator', () => {
  const model = { version: 1, owner: 'alice' };
  assert.equal(canEdit(model, null), false);
  assert.equal(canEdit(model, { username: 'bob', isAdmin: false }), false);
  assert.equal(canEdit(model, { username: 'alice', isAdmin: false }), false);
  assert.equal(canEdit(model, { username: 'alice', isAdmin: false, canAuthor: true }), true);
  assert.equal(canEdit(model, { username: 'bob', isAdmin: false, canAuthor: true }), false);
  assert.equal(canEdit(model, { username: 'bob', isAdmin: true }), true);
});

test('API requests use the application namespace and authenticated same-origin session', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ version: 3 }) }; };
  const result = await apiRequest('/models');
  assert.equal(requests[0].url, '/api/decisions/models');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(result.version, 3);
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ detail: { message: 'Synthetic revision conflict' } }) });
  await assert.rejects(apiRequest('/models'), /Synthetic revision conflict/);
});

test('embedded frame accepts close messages only from its own origin and frame', () => {
  const framePath = path.join(root, 'web/src/components', existsSync(path.join(root, 'web/src/components/DecisionsWorkspace.tsx')) ? 'DecisionsWorkspace.tsx' : 'ZenWorkspace.tsx');
  const frame = readFileSync(framePath, 'utf8');
  assert.match(frame, /event\.origin !== window\.location\.origin/);
  assert.match(frame, /event\.source !== frame\.current\?\.contentWindow/);
  assert.doesNotMatch(frame, /user=|admin=|encodeURIComponent\(user/);
  const sidebar = readFileSync(path.join(frontend, 'src/components/CarbonDocSidebar.jsx'), 'utf8');
  assert.match(sidebar, /postMessage\(.+window\.location\.origin/);
});

test('application never auto-loads fictional samples, auto-polls drafts, or evaluates imported code in browser', () => {
  const application = readFileSync(path.join(frontend, 'src/App.jsx'), 'utf8');
  const repl = readFileSync(path.join(frontend, 'src/components/ReplTab.jsx'), 'utf8');
  assert.match(application, /useState\(\{\}\)/);
  assert.doesNotMatch(application, /setInterval|evaluateDecisionGraph|params\.get\('admin'\)/);
  assert.doesNotMatch(repl, /evaluateUnary|evaluateExpression|new Function/);
  assert.match(application, /Fictional example for learning/);
});

test('a completed save cannot overwrite edits made while the request was pending', () => {
  const submitted = newDraft('draft');
  const changed = { ...submitted, name: 'Edited while saving' };
  const saved = { ...submitted, name: 'Untitled decision', version: 1, _dirty: undefined };
  const merged = applySavedModel(changed, submitted, saved);
  assert.equal(merged.name, 'Edited while saving');
  assert.equal(merged.version, 1);
  assert.equal(merged._dirty, true);
  assert.equal(applySavedModel({ ...submitted }, submitted, saved), saved);
});

test('saving or testing one provider preserves unsaved changes in the other provider', () => {
  const previous = { ikc: { revision: 2, base_url: 'https://old.example' }, wxdi: { revision: 1, base_url: 'https://unsaved.example', api_key: 'synthetic-unsaved-credential' } };
  const loaded = { ikc: { revision: 3, base_url: 'https://saved.example', last_test: { status: 'connected' } }, wxdi: { revision: 1, base_url: 'https://old.example' } };
  const saved = mergeProviderSettings(previous, loaded, 'ikc');
  assert.equal(saved.wxdi, previous.wxdi);
  assert.equal(saved.ikc, loaded.ikc);
  const tested = mergeProviderSettings(previous, loaded, 'ikc', true);
  assert.equal(tested.wxdi, previous.wxdi);
  assert.equal(tested.ikc.base_url, previous.ikc.base_url);
  assert.equal(tested.ikc.last_test.status, 'connected');
});


test('own save echo does not become a remote update after its response updates the saved snapshot', () => {
  const saved = { id: 'policy', version: 2, status: 'draft', environment: 'development', updatedAt: 'confirmed-save' };
  assert.equal(savedModelsChanged({ policy: saved }, { policy: { ...saved } }), false);
  assert.equal(savedModelsChanged({ policy: saved }, { policy: { ...saved, version: 3 } }), true);
});

test('remote detection includes additions, removals and governance changes, independent of local drafts', () => {
  const known = { policy: { id: 'policy', version: 2, status: 'draft' } };
  assert.equal(savedModelsChanged(known, {}), true);
  assert.equal(savedModelsChanged(known, { ...known, other: { id: 'other', version: 1 } }), true);
  assert.equal(savedModelsChanged(known, { policy: { ...known.policy, status: 'in_review' } }), true);
  const draft = { ...known.policy, _dirty: true, graph: { local: true } };
  const loaded = { policy: { ...known.policy, version: 3 } };
  assert.equal(savedModelsChanged(known, loaded), true);
  assert.equal(mergeSavedModels({ policy: draft }, loaded).policy, draft);
});
