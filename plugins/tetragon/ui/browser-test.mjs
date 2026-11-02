// Synthetic intercepted APIs only. This checks UI workflows, not kernel blocking.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs'); // NOSONAR: intentional test runtime path with env override
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../buddy_tetragon/static');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let rules = [], policies = [], connected = true, failedApply = false;
const mutations = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('http://tetragon.test/**', async route => {
  const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
  const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (url.pathname === '/api/tetragon/status') return json({ connected, message: connected ? 'Synthetic test engine connected' : 'Synthetic engine unavailable', policies });
  if (url.pathname === '/api/tetragon/rules' && req.method() === 'GET') return json({rules, audit: []});
  if (url.pathname === '/api/tetragon/preview') return json({ yaml: 'apiVersion: cilium.io/v1alpha1\nkind: TracingPolicy\n# Synthetic preview', policy: {} });
  if (url.pathname === '/api/tetragon/rules' && req.method() === 'POST') { const rule = {...body, id:'test-rule', policy_name:'buddy-test-rule', enabled:false, revision:1}; rules.push(rule); mutations.push(['save',body]); return json(rule); }
  if (url.pathname.endsWith('/apply')) {
    mutations.push(['apply',body]);
    assert.equal(body.expected_revision,rules[0].revision);
    rules[0].revision++; rules[0].enabled=true;
    if (failedApply) { rules[0].last_error='Synthetic apply failed'; return json({detail:'Synthetic apply failed'},502); }
    policies=[{name:'buddy-test-rule',state:'enabled',mode:'enforce'}]; return json(rules[0]);
  }
  if (url.pathname.endsWith('/remove')) { mutations.push(['remove',body]); assert.equal(body.expected_revision,rules[0].revision); rules[0].revision++; rules[0].enabled=false; rules[0].last_error='';policies=[];return json(rules[0]); }
  if (url.pathname === '/api/tetragon/rules/test-rule' && req.method() === 'DELETE') { mutations.push(['delete']);rules=[];return json({ok:true}); }
  const filename = url.pathname.startsWith('/tetragon/assets/') ? url.pathname.slice('/tetragon/assets/'.length) : 'index.html';
  if (!/^[\w.\-]+$/.test(filename)) return route.fulfill({status:404});
  const contentType = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
  return route.fulfill({contentType,body:await readFile(path.join(root,filename))});
});
try {
  await page.goto('http://tetragon.test/tetragon/');
  await page.getByRole('heading',{name:'Connected to the host engine'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),true);
  await page.getByLabel('Rule name',{exact:true}).fill('Synthetic credentials rule');
  await page.getByLabel('Protected file paths',{exact:true}).fill('/run/secrets/test-fixture');
  await page.getByLabel('Process scope',{exact:true}).fill('/usr/bin/test-runtime');
  await page.getByRole('button',{name:'Preview policy',exact:true}).click();
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByRole('button',{name:'Apply blocking rule',exact:true}).waitFor();
  await page.getByRole('button',{name:'Apply blocking rule',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(mutations.some(m=>m[0]==='apply'),false);
  await page.getByRole('button',{name:'Apply blocking rule',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Apply rule',exact:true}).click();
  await page.getByText('Reported mode: enforce.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Apply blocking rule',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Remove from engine',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Remove rule',exact:true}).click();
  await page.getByText('Reported mode: Not reported.',{exact:false}).waitFor();
  failedApply=true;
  await page.getByRole('button',{name:'Apply blocking rule',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Apply rule',exact:true}).click();
  await page.getByText('Synthetic apply failed',{exact:true}).first().waitFor();
  await page.getByRole('button',{name:'Remove from engine',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Remove rule',exact:true}).click();
  await page.getByRole('tabpanel',{name:'Rules',exact:true}).getByRole('button',{name:'Delete draft',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Delete draft',exact:true}).click();
  await page.getByRole('heading',{name:'No rules yet',exact:true}).waitFor();
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:1000});
    await page.getByRole('tab',{name:'Supported controls',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
    await page.getByRole('tab',{name:'Rules',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`rules overflow at ${width}`);
  }
  if (process.env.CARBON_AXE_MODULE) { const { default: AxeBuilder } = await import(process.env.CARBON_AXE_MODULE); const report = await new AxeBuilder({page}).analyze(); assert.deepEqual(report.violations.map(v=>({id:v.id,description:v.description})),[]); }
  if (process.env.CARBON_SCREENSHOT_DIR) { await mkdir(process.env.CARBON_SCREENSHOT_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.CARBON_SCREENSHOT_DIR,'tetragon-rules-synthetic.png'),fullPage:true}); }
  connected=false;
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  await page.getByRole('heading',{name:'Tetragon is not connected',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Tetragon Carbon UI: preview/save/apply/cancel/remove/delete, failed-apply revision recovery, disconnected status and 4 responsive widths passed. Synthetic fixtures only.');
} finally { await browser.close(); }
