// Synthetic browser integration only; no real user models, telemetry or provider calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'decisions-buddy/dist');
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs');
const server = createServer(async (req, res) => {
  try {
    const relative = new URL(req.url, 'http://fixture').pathname.replace(/^\/decisions\/?/, '') || 'index.html';
    const filename = path.resolve(dist, relative);
    if (!filename.startsWith(dist + path.sep)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : 'text/html' }).end(await readFile(filename));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const errors = [];
const table = (id, name) => ({ id, name, type: 'decisionTableNode', content: { hitPolicy: 'first', inputs: [{ id: 'condition', field: 'value', name: 'Value' }], outputs: [{ id: 'output', field: 'result', name: 'Result' }], rules: [{ _id: `${id}-first`, _description: `${name} first`, condition: '>= 0', output: '"first"' }, { _id: `${id}-second`, _description: `${name} second`, condition: '-', output: '"second"' }] } });
const initialModel = { id: 'synthetic-functional', name: 'Synthetic functional review', owner: 'owner', accessPolicy: 'public', version: 3, defaultInput: { value: 1 }, status: 'draft', graph: { nodes: [table('one', 'First table'), table('two', 'Second table')], edges: [] } };
let model = structuredClone(initialModel), analyticsFail = true, analyzeFail = false, capturedBatch, savedSuite;
const suite = [{ name: 'Positive', input: { value: 1 }, expected: { result: 'first' } }];
async function setupPage(user) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/api/decisions/ws', () => {});
  await page.route('**/api/decisions/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    let data = {}, status = 200;
    if (pathname.endsWith('/me')) data = { username: user, isAdmin: false, canAuthor: true };
    else if (pathname === '/api/decisions/models' && request.method() === 'GET') data = [{ id: model.id, name: model.name, version: model.version }];
    else if (pathname === '/api/decisions/models' && request.method() === 'POST') { model = { ...model, ...request.postDataJSON(), version: model.version + 1 }; data = { decision: model }; }
    else if (pathname === `/api/decisions/models/${model.id}`) data = model;
    else if (pathname.endsWith('/analytics')) { if (analyticsFail) { status = 503; data = { detail: 'Synthetic unavailable' }; } else data = { totalRuns: 4, avgLatencyMicros: 2, p95LatencyMicros: 4, ruleHeatmap: {} }; }
    else if (pathname.endsWith('/analyze')) { if (analyzeFail) { status = 503; } else data = { diagnostics: [{ code: 'synthetic-check', severity: 'warning', message: 'Synthetic diagnostic evidence' }] }; }
    else if (pathname.endsWith('/evaluate/batch')) { capturedBatch = request.postDataJSON(); data = { results: capturedBatch.items.map((input, index) => ({ index, input, result: { result: 'first' }, durationMicros: 1 })) }; }
    else if (pathname.endsWith('/test-cases')) { if (request.method() === 'PUT') { savedSuite = request.postDataJSON(); data = { suiteRevision: 2 }; } else data = { decisionVersion: model.version, suiteRevision: 1, cases: suite }; }
    else if (pathname.endsWith('/run-tests')) data = { decisionVersion: model.version, suiteRevision: 1, passed: true, results: [{ name: 'Positive', passed: true, expected: suite[0].expected, actual: suite[0].expected }] };
    else if (pathname.endsWith('/audit-logs')) data = [];
    else if (pathname.endsWith('/cp4d/status') || pathname.endsWith('/admin/integrations')) data = { providers: {} };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/decisions/`);
  await page.getByRole('heading', { name: model.name, exact: true }).waitFor();
  return page;
}
try {
  const page = await setupPage('owner');
  await page.getByRole('tab', { name: 'Decision table', exact: true }).click();
  await page.locator('#decision-table-select').selectOption('two');
  await page.getByLabel('Rule 1 description').waitFor();
  assert.equal(await page.getByLabel('Rule 1 description').inputValue(), 'Second table first');
  await page.getByRole('button', { name: /Rule Heatmap/ }).click();
  await page.getByText('Analytics unavailable (HTTP 503).', { exact: true }).waitFor();
  assert.equal(await page.getByText(/0 hits \(0%\)/).count(), 0);
  analyticsFail = false;
  await page.getByRole('button', { name: /Rule Heatmap/ }).click();
  await page.getByText('Unavailable', { exact: true }).first().waitFor();
  assert.equal(await page.getByText(/0 hits \(0%\)/).count(), 0);
  await page.getByRole('button', { name: 'Check Rule Conflicts', exact: true }).click();
  await page.getByText('Synthetic diagnostic evidence', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Move rule 2 up', exact: true }).click();
  assert.equal(await page.getByLabel('Rule 1 description').inputValue(), 'Second table second');
  assert.equal(await page.getByText('Synthetic diagnostic evidence', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Hide Heatmap', exact: true }).count(), 0);
  analyzeFail = true;
  await page.getByRole('button', { name: 'Check Rule Conflicts', exact: true }).click();
  await page.getByText('Static analysis unavailable (HTTP 503).', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Simulator', exact: true }).click();
  await page.getByLabel('Simulation input mode').selectOption('batch');
  await page.locator('#input-json-editor').fill(JSON.stringify(suite));
  await page.getByRole('button', { name: 'Evaluate Independent Scenarios', exact: true }).click();
  await page.getByText('Passed', { exact: true }).waitFor();
  assert.ok(capturedBatch.graph, 'dirty batch binds current graph');
  assert.equal(capturedBatch.decisionId, undefined);
  assert.equal(capturedBatch.graph.nodes.find(node => node.id === 'two').content.rules[0]._id, 'two-second');
  await page.close();
  model = structuredClone(initialModel);
  const savedPage = await setupPage('owner');
  await savedPage.getByRole('tab', { name: 'Simulator', exact: true }).click();
  await savedPage.getByLabel('Simulation input mode').selectOption('batch');
  await savedPage.getByRole('button', { name: 'Load saved cases', exact: true }).click();
  await savedPage.getByText('Saved cases loaded.', { exact: true }).waitFor();
  await savedPage.getByRole('button', { name: 'Evaluate Independent Scenarios', exact: true }).click();
  await savedPage.getByText('Passed', { exact: true }).waitFor();
  assert.equal(capturedBatch.decisionId, model.id); assert.equal(capturedBatch.expectedVersion, 3); assert.equal(capturedBatch.graph, undefined);
  await savedPage.getByRole('button', { name: 'Save test cases', exact: true }).click();
  await savedPage.getByText(/Test cases saved/).waitFor();
  assert.equal(savedSuite.expectedVersion, 3); assert.equal(savedSuite.expectedSuiteRevision, 1); assert.deepEqual(savedSuite.cases, suite);
  await savedPage.getByRole('button', { name: 'Run saved tests', exact: true }).click();
  await savedPage.getByText('Saved suite revision 1, decision version 3.', { exact: true }).waitFor();
  await savedPage.close();
  const reader = await setupPage('reader');
  await reader.getByRole('tab', { name: 'Decision table', exact: true }).click();
  assert.equal(await reader.getByLabel('Rule 1 description').getAttribute('readonly'), '');
  assert.ok(await reader.getByRole('button', { name: 'Move rule 2 up', exact: true }).isDisabled());
  assert.ok(await reader.getByRole('button', { name: 'Add Rule', exact: true }).isDisabled());
  await reader.getByRole('tab', { name: 'Simulator', exact: true }).click();
  await reader.getByLabel('Simulation input mode').selectOption('batch');
  await reader.getByRole('button', { name: 'Load saved cases', exact: true }).click();
  await reader.getByText('Saved cases loaded.', { exact: true }).waitFor();
  assert.ok(await reader.getByRole('button', { name: 'Save test cases', exact: true }).isDisabled());
  await reader.close();
  assert.deepEqual(errors, []);
  console.log('Synthetic Decisions browser checks passed: multi-table selection, row priority, unavailable analytics, diagnostics invalidation/errors, draft/version-bound batches, saved cases, expected-output results, and read-only controls.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
