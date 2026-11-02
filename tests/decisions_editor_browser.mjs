// Synthetic UI fixtures only: no real decision data, provider calls or deployments.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'decisions-buddy/dist');
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs');
const server = createServer(async (req,res) => {
  try {
    const pathname = new URL(req.url,'http://fixture').pathname;
    const relative = pathname.replace(/^\/decisions\/?/,'') || 'index.html';
    const filename = path.resolve(dist, relative);
    if (!filename.startsWith(dist + path.sep)) { res.writeHead(404).end(); return; }
    const content = await readFile(filename);
    res.writeHead(200, {'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html'}).end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});page.setDefaultTimeout(10000);
let readonly = false;
const requests = [];
let model = { id: 'synthetic-editor', name: 'Synthetic editor regression', owner: 'fixture-admin', version: 1, status: 'draft', defaultInput: { value: 3 }, graph: {
  graphExtension: { retained: true },
  nodes: [
    { id: 'input', name: 'Input fixture', type: 'inputNode', position: { x: 0, y: 100 }, content: {}, extension: 'keep-input' },
    { id: 'switch', name: 'Switch fixture', type: 'switchNode', position: { x: 260, y: 100 }, content: { statements: [{ id: 'positive', condition: 'value > 0' }, { id: 'fallback', condition: '' }], customOption: 'keep-switch' } },
    { id: 'yes', name: 'Positive fixture', type: 'expressionNode', position: { x: 620, y: 0 }, content: { expressions: [{ key: 'result', value: '1' }], customOption: 'keep-expression' }, extension: { retained: true } },
    { id: 'no', name: 'Fallback fixture', type: 'expressionNode', position: { x: 620, y: 250 }, content: { expressions: [{ key: 'result', value: '0' }] } },
    { id: 'ai-a', name: 'Watsonx fixture A', type: 'watsonxAiNode', position: { x: 50, y: 450 }, content: { endpoint: 'https://a.example.invalid', projectId: 'project-a', modelId: 'model-a', promptTemplate: 'A', outputField: 'aiA', customOption: 'keep-ai' } },
    { id: 'ai-b', name: 'Watsonx fixture B', type: 'watsonxAiNode', position: { x: 500, y: 450 }, content: { endpoint: 'https://b.example.invalid', projectId: 'project-b', modelId: 'model-b', promptTemplate: 'B', outputField: 'aiB' } },
  ], edges: [
    { id: 'input-switch', sourceId: 'input', targetId: 'switch', extension: 'keep-edge' },
    { id: 'yes-edge', sourceId: 'switch', targetId: 'yes', sourceHandle: 'positive', targetHandle: null, extension: { retained: true } },
    { id: 'no-edge', sourceId: 'switch', targetId: 'no', sourceHandle: 'fallback' },
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
  await node('switch').waitFor();
  assert.equal(await page.getByRole('button', {name: /^Function\b/}).count(), 0, 'unsupported Function authoring must be absent');
  assert.equal(await node('switch').locator('.react-flow__handle[data-handleid="positive"]').count(), 1);
  await openNode('switch');
  await page.getByLabel('Node Name', {exact:true}).fill('Renamed switch fixture');
  await page.getByLabel('Branch 1 condition', {exact:true}).fill('value >= 10');
  await page.getByRole('dialog').getByRole('button', {name:'Save Node Rules',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  let graph = await exportGraph();
  assert.equal(graph.nodes.find(n=>n.id==='switch').content.statements[0].condition,'value >= 10');
  assert.equal(graph.nodes.find(n=>n.id==='switch').content.customOption,'keep-switch');
  assert.equal(graph.edges.find(e=>e.id==='yes-edge').sourceHandle,'positive');
  assert.equal(graph.edges.find(e=>e.id==='yes-edge').targetHandle,null);
  assert.deepEqual(graph.edges.find(e=>e.id==='yes-edge').extension,{retained:true});
  assert.deepEqual(graph.graphExtension,{retained:true});
  await page.getByRole('button',{name:'Save decision',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.carbon-page-subtitle')].some(e=>e.textContent.includes('Version 2')));
  assert.equal(requests.length,1);assert.equal(requests[0].graph.nodes.find(n=>n.id==='switch').name,'Renamed switch fixture');
  await openNode('yes');await page.getByLabel('Node Name',{exact:true}).fill('Edited expression fixture');
  await page.getByRole('dialog').getByRole('button',{name:'Save Node Rules',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  graph = await exportGraph();assert.equal(graph.nodes.find(n=>n.id==='yes').content.customOption,'keep-expression');assert.deepEqual(graph.nodes.find(n=>n.id==='yes').extension,{retained:true});
  await openNode('ai-a');assert.equal(await page.getByLabel('watsonx.ai Service Endpoint',{exact:true}).inputValue(),'https://a.example.invalid');await closeModal();
  await openNode('ai-b');assert.equal(await page.getByLabel('watsonx.ai Service Endpoint',{exact:true}).inputValue(),'https://b.example.invalid');await closeModal();
  // Adding a node updates the canonical draft without clicking Save & Run.
  await page.getByRole('button',{name:'Expression Action Task',exact:true}).click();
  graph=await exportGraph();assert.equal(graph.nodes.length,7);assert.equal(graph.edges.find(e=>e.id==='yes-edge').sourceHandle,'positive');
  // New statement handles create real branch-specific graph connections.
  await openNode('switch');await page.getByRole('button',{name:'Add branch',exact:true}).click();
  await page.getByLabel('Branch 3 condition',{exact:true}).fill('value < 0');
  await page.getByRole('button',{name:'Move branch 3 up',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Save Node Rules',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  graph=await exportGraph();const branchId=graph.nodes.find(n=>n.id==='switch').content.statements[1].id;
  const branchHandle=node('switch').locator(`.react-flow__handle[data-handleid="${branchId}"]`);
  await branchHandle.scrollIntoViewIfNeeded();
  const source=await branchHandle.boundingBox(), target=await node('no').locator('.react-flow__handle.target').boundingBox();
  await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:15});await page.mouse.up();
  graph=await exportGraph();assert.ok(graph.edges.some(edge=>edge.sourceId==='switch'&&edge.targetId==='no'&&edge.sourceHandle===branchId),'drawn branch connection must persist named source handle');
  // Removing the fallback deletes only its attached edge and persists through global export.
  await openNode('switch');await page.getByRole('button',{name:'Remove branch 3',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Save Node Rules',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  graph=await exportGraph();assert.equal(graph.edges.some(e=>e.id==='no-edge'),false);assert.equal(graph.edges.some(e=>e.id==='yes-edge'),true);
  readonly=true;await page.reload();await page.getByRole('tab',{name:'Visual editor',exact:true}).click();
  await page.getByText('Read-only graph',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Edit Node',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Delete Node',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Expression Action Task',exact:true}).getAttribute('aria-disabled'),'true');
  const before=await exportGraph();await page.getByRole('button',{name:'Expression Action Task',exact:true}).click({force:true});assert.deepEqual(await exportGraph(),before);
  assert.deepEqual(errors,[]);
  if(process.env.CARBON_SCREENSHOT_DIR){await mkdir(process.env.CARBON_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.CARBON_SCREENSHOT_DIR,'decisions-editor-readonly-synthetic.png'),fullPage:true});}
  console.log('Decisions canonical canvas, metadata/branch round-trip, global save/export, Watsonx modal reset, branch removal and read-only interactions passed. Synthetic fixtures only.');
} catch(error) { await page.screenshot({path:'/tmp/decisions-editor-failure.png',fullPage:true}); throw error; }
finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
