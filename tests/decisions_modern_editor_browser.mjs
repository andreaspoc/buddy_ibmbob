// Synthetic UI fixtures only: no real decision data, provider calls or deployments.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'decisions-buddy/dist');
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs');
const url='http://synthetic-modern.invalid';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
const page=await context.newPage();
await page.route('**/*', async route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.startsWith('/api/')) return route.fallback();
  try {
    const relative = pathname.replace(/^\/decisions\/?/, '') || 'index.html';
    const filename = path.resolve(dist, relative);
    if (!filename.startsWith(dist + path.sep)) return route.fulfill({status:404,body:''});
    const content = await readFile(filename);
    await route.fulfill({body:content,contentType:filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html'});
  } catch { await route.fulfill({status:404,body:''}); }
});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});page.setDefaultTimeout(10000);
let readonly = false;
const requests = [];
let model = { id: 'synthetic-modern', name: 'Synthetic modern authoring', owner: 'fixture-admin', version: 1, status: 'draft', defaultInput: { customer: { age: 20 }, facts: { orders: [] } }, graph: {
  graphExtension: 'preserved', vocabulary: [{ term: 'applicant age', path: 'customer.age', type: 'integer', required: true }],
  nodes: [
    { id: 'input', name: 'Input', type: 'inputNode', position: { x: 0, y: 100 }, content: {} },
    { id: 'fork', name: 'Fork', type: 'forkNode', position: { x: 260, y: 100 }, content: {} },
    { id: 'action', name: 'Business rule', type: 'balRuleNode', position: { x: 520, y: 0 }, content: { rule: 'if applicant age >= 18 then set approved to true;', extension: 'action-preserved' } },
    { id: 'agenda', name: 'Fact agenda', type: 'inferenceNode', position: { x: 520, y: 300 }, content: { rules: [{ condition: 'true', actions: ['set reviewed to true'] }], extension: 'agenda-preserved' } },
    { id: 'join', name: 'Join', type: 'joinNode', position: { x: 800, y: 100 }, content: {} },
    { id: 'output', name: 'Output', type: 'outputNode', position: { x: 1080, y: 100 }, content: {} }
  ], edges: [
    { id: 'if', sourceId: 'input', targetId: 'fork' },
    { id: 'fa', sourceId: 'fork', targetId: 'action' },
    { id: 'fi', sourceId: 'fork', targetId: 'agenda' },
    { id: 'aj', sourceId: 'action', targetId: 'join' },
    { id: 'ij', sourceId: 'agenda', targetId: 'join' },
    { id: 'jo', sourceId: 'join', targetId: 'output' }
  ]
} };
await page.route('**/api/decisions/**', async route => {
  const req = route.request(), pathname = new URL(req.url()).pathname;
  let data = {};
  if (pathname.endsWith('/me')) data = { username: readonly ? 'fixture-viewer' : 'fixture-admin', displayName: 'Synthetic user', isAdmin: !readonly };
  else if (pathname === '/api/decisions/models' && req.method() === 'GET') data = [{ id: model.id, name: model.name, version: model.version }];
  else if (pathname === '/api/decisions/models' && req.method() === 'POST') { const body = req.postDataJSON(); requests.push(body); model = { ...model, ...body, version: model.version + 1 }; data = { decision: model }; }
  else if (pathname === `/api/decisions/models/${model.id}`) data = model;
  else if (pathname.endsWith('/audit-logs')) data = [];
  else if (pathname.endsWith('/cp4d/status') || pathname.endsWith('/admin/integrations')) data = { providers: {} };
  else if (pathname.endsWith('/analyze')) data = { diagnostics: [] };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
});
await page.routeWebSocket('**/api/decisions/ws', () => {});
const node = id => page.locator(`.react-flow__node[data-id="${id}"]`);
async function exportGraph() {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Model', exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
async function openNode(id) { await node(id).getByRole('button', { name: 'Edit Node', exact: true }).click(); }
async function closeModal() { await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('dialog').waitFor({state:'hidden'}); }
try {
  await page.goto(`${url}/decisions/`);
  await page.getByRole('heading', {name: model.name, exact: true}).waitFor();
  await page.getByRole('tab', {name: 'Visual editor', exact: true}).click();
  await node('action').waitFor();
  await openNode('action');
  assert.equal(await page.getByLabel('Business action rule', {exact: true}).inputValue(), 'if applicant age >= 18 then set approved to true;');
  assert.equal(await page.locator('#term-name-0').inputValue(), 'applicant age');
  assert.equal(await page.locator('#term-type-0').inputValue(), 'integer');
  await page.getByLabel('Business action rule', {exact: true}).fill('if applicant age >= 21 then set approved to true; else set approved to false;');
  await page.getByRole('dialog').getByRole('button', {name: 'Save Node Rules', exact: true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  let result = await exportGraph();
  assert.equal(result.nodes.find(n=>n.id==='action').content.source, 'if applicant age >= 21 then set approved to true; else set approved to false;');
  assert.deepEqual(result.nodes.find(n=>n.id==='action').content.vocabulary, model.graph.vocabulary);
  assert.equal(result.nodes.find(n=>n.id==='action').content.extension, 'action-preserved');
  await openNode('agenda');
  assert.equal(await page.locator('#term-name-0').inputValue(), 'applicant age');
  assert.equal(await page.locator('#agenda-firing-limit').inputValue(), '50');
  assert.ok(await page.locator('#agenda-id-0').inputValue());
  assert.equal(await page.locator('#agenda-priority-0').inputValue(), '0');
  await page.locator('#agenda-conflict-resolution').selectOption('specificity');
  await page.locator('#agenda-actions-0').fill(JSON.stringify([{op:'update',fact:'order',values:{approved:'true'}}]));
  await page.getByText('Match facts in collections', {exact:true}).click();
  const patterns = [{collection:'facts.orders',as:'order',equals:{status:'pending'},where:'order.total > 100'}];
  await page.locator('#agenda-patterns-0').fill(JSON.stringify(patterns));
  await page.getByRole('dialog').getByRole('button', {name:'Save Node Rules',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  result = await exportGraph();
  const agenda = result.nodes.find(n=>n.id==='agenda').content;
  assert.equal(agenda.conflictResolution, 'specificity');
  assert.equal(agenda.maxCycles, 50);
  assert.deepEqual(agenda.rules[0].patterns, patterns);
  assert.deepEqual(agenda.rules[0].actions, [{op:'update',fact:'order',values:{approved:'true'}}]);
  assert.equal(agenda.extension, 'agenda-preserved');
  await openNode('fork');
  assert.equal(await page.locator('#parallel-workers').inputValue(), '4');
  await page.locator('#parallel-join-id').selectOption('join');
  await page.locator('#parallel-workers').fill('2');
  await page.getByRole('dialog').getByRole('button', {name:'Save Node Rules',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await openNode('join');
  assert.equal(await page.locator('#parallel-merge-policy').inputValue(), 'error');
  await page.locator('#parallel-merge-policy').selectOption('last');
  await page.getByRole('dialog').getByRole('button', {name:'Save Node Rules',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  result = await exportGraph();
  assert.deepEqual(result.nodes.find(n=>n.id==='fork').content, {maxWorkers:2,joinId:'join'});
  assert.deepEqual(result.nodes.find(n=>n.id==='join').content, {mergePolicy:'last'});
  assert.equal(result.graphExtension, 'preserved');
  await page.getByRole('button',{name:'Save decision',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.carbon-page-subtitle')].some(e=>e.textContent.includes('Version 2')));
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0].graph.nodes.find(n=>n.id==='agenda').content, agenda);
  await page.reload();
  await page.getByRole('tab', {name:'Visual editor',exact:true}).click();
  await openNode('action');
  assert.equal(await page.locator('#term-name-0').inputValue(), 'applicant age');
  assert.ok((await page.locator('#business-rule-source').inputValue()).includes('>= 21'));
  await closeModal();
  assert.deepEqual(errors, []);
  console.log('Modern canvas business vocabulary, action-rule/agenda patterns, omitted defaults, fork/join controls, save/export/reload passed. Synthetic fixtures only.');
} catch(error) { await page.screenshot({path:'/tmp/decisions-modern-editor-failure.png',fullPage:true}); throw error; }
finally { await browser.close(); }
