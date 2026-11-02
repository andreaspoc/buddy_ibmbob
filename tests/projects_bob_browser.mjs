// Synthetic UI fixtures only: no live accounts, portfolio changes, or model calls.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const viewportWidth = Number(process.env.CARBON_VIEWPORT_WIDTH || 1280);
const page = await browser.newPage({viewport:{width:viewportWidth,height:1000}});
page.setDefaultTimeout(12000);
const errors = [], submissions = [], previewRequests = [], writes = [];
let sessionCreates = 0, denyContext = false;
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  sessionStorage.setItem('buddy-approval-guide:fixture-user', 'seen');
  localStorage.setItem('bob-ui-language', 'en');
});
const portfolio = {
  can_manage: true,
  projects: [{ id: 1, name: 'Synthetic connected project', description: 'Browser fixture only', status: 'active', priority: 'high', due_date: null, milestone: '' }],
  people: [{ id: 'fixture-user', name: 'Synthetic Alex', email: 'alex@example.test', status: 'active', departure_date: null }],
  assignments: [{ id: 3, project_id: 1, person_id: 'fixture-user', responsibility: 'Synthetic project review', role: 'owner', backup_person_id: null, allocation: 25 }],
  dependencies: [],
  work_items: [{ id: 11, project_id: 1, kind: 'task', title: 'Synthetic handover task', description: 'Browser fixture only', owner_id: 'fixture-user', status: 'todo', priority: 'high', due_date: null }],
  impact: { items: [], summary: { confirmed: 0, risks: 0, affected_projects: 0 } },
  recent_change_impacts: [], events: [],
};
const impact = { items: [{ project_id: 1, level: 'confirmed', reason: 'Synthetic responsibility gap', evidence: { person_id: 'fixture-user' }, path: [1] }], summary: { confirmed: 1, risks: 0, affected_projects: 1 } };
await page.route('**/*', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/' || path === '/notes' || path.startsWith('/src/') || path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/assets/') || /\.(svg|png|ico|woff2)$/.test(path)) return route.continue();
  let data = [];
  if (path === '/auth/status') data = { user: { username: 'fixture-user', is_admin: true }, local_login_enabled: true, keycloak_configured: true };
  else if (path === '/personalization/tutorials') data = { disabled: true };
  else if (path === '/api/apps') data = { apps: [{ id: 'projects', name: 'Projects', description: 'Synthetic fixture', kind: 'installed', desktop_only: false, launch: { kind: 'projects' } }] };
  else if (path === '/api/projects/context') {
    if (denyContext) return route.fulfill({ status: 403, json: { detail: 'Synthetic revoked access' } });
    data = { portfolio, instructions: 'Use recorded facts only.' };
  } else if (path === '/api/projects/impact/preview') { previewRequests.push(request.postDataJSON()); data = impact; }
  else if (path.startsWith('/api/projects')) {
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    data = portfolio;
  } else if (path === '/sessions') {
    if (request.method() === 'POST') { sessionCreates++; data = { id: 'portfolio-session' }; }
  } else if (path === '/chat/stream') {
    submissions.push(request.postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'delta', text: `Synthetic Bob response ${submissions.length}.` }) + '\n' + JSON.stringify({ type: 'done' }) + '\n' });
  } else if (path === '/access/me') data = { user: { username: 'fixture-user', is_admin: true }, libraries: [], audiences: [], administrator: true };
  else if (path.endsWith('/capabilities')) data = { web_search: false };
  return route.fulfill({ json: data });
});
const workspace = page.getByRole('region', { name: 'Projects portfolio' });
async function ask(buttonName, marker, expectedFocus) {
  await workspace.getByRole('button', { name: buttonName, exact: true }).first().click();
  const count = submissions.length;
  await page.locator('.projects-assistant textarea').fill(marker);
  await page.getByRole('button', { name: 'Send to Bob', exact: true }).click();
  await page.locator('.projects-bob-messages').getByText(`Synthetic Bob response ${count + 1}.`, { exact: true }).waitFor();
  assert.equal(submissions.length, count + 1);
  const submitted = submissions.at(-1);
  assert.equal(submitted.workspace_id, 'portfolio-session');
  assert.equal(submitted.agent_name, null);
  assert.equal(submitted.mode, 'agent');
  assert.deepEqual(submitted.note_ids, []);
  assert.deepEqual(submitted.office_file_ids, []);
  assert.match(submitted.prompt, /Synthetic connected project/);
  assert.match(submitted.prompt, new RegExp(marker));
  const snapshot = JSON.parse(submitted.prompt.split('Authorized portfolio snapshot:\n')[1].split('\n\nUser question:')[0]);
  assert.ok(snapshot.focus[expectedFocus] || (expectedFocus === 'scenario' && snapshot.scenario), 'Selected context must be explicitly included');
  if (expectedFocus === 'project') assert.equal(snapshot.focus.project.id, 1);
  if (expectedFocus === 'person') assert.equal(snapshot.focus.person.id, 'fixture-user');
  if (expectedFocus === 'work_item') assert.equal(snapshot.focus.work_item.id, 11);
  assert.equal(await workspace.isVisible(), true);
  assert.equal(await page.locator('.chat-view-container').isVisible(), false);
}
try {
  await page.goto(process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177');
  await page.locator('#prompt-input').waitFor();
  await page.locator('.workspace-notes-tab').click();
  await page.locator('.installed-apps').getByRole('button', { name: /Projects/ }).click();
  await workspace.waitFor();
  await workspace.getByRole('button', { name: 'Portfolio', exact: true }).click();
  await workspace.getByRole('button', { name: 'Open project', exact: true }).first().click();
  assert.equal(await page.locator('.topbar:visible').count(), 0);
  assert.equal(await workspace.getByRole('navigation', { name: 'Projects views', exact: true }).count(), 1);
  assert.equal(await workspace.getByRole('navigation', { name: 'Project sections', exact: true }).count(), 0);
  for (const name of ['Work plan', 'Risks, issues & decisions', 'People & responsibilities', 'Dependencies']) {
    assert.equal(await workspace.getByRole('heading', { name, exact: true }).count(), 1, name + ' should be visible without another menu');
  }
  if (process.env.CARBON_AXE_MODULE) {
    const {default:AxeBuilder} = await import(process.env.CARBON_AXE_MODULE);
    const audit = await new AxeBuilder({page}).include('.projects-workspace').withRules(['color-contrast','label','button-name','nested-interactive','aria-valid-attr-value']).analyze();
    assert.deepEqual(audit.violations.map(item => ({id:item.id,nodes:item.nodes.map(node=>node.target)})), []);
  }
  if (process.env.CARBON_SCREENSHOT_DIR) await page.screenshot({path:process.env.CARBON_SCREENSHOT_DIR + '/projects-menu-detail-' + viewportWidth + '.png',fullPage:true});
  await ask('Ask Bob about Synthetic connected project', 'Explain selected project', 'project');
  await workspace.getByRole('button', { name: 'People', exact: true }).first().click();
  await ask('Ask Bob about Synthetic Alex', 'Explain selected person', 'person');
  await workspace.getByRole('button', { name: 'Portfolio', exact: true }).click();
  await workspace.getByRole('button', { name: 'Open project', exact: true }).first().click();
  await ask('Ask Bob about Synthetic handover task', 'Explain selected work item', 'work_item');
  await workspace.getByRole('button', { name: 'Change impact', exact: true }).click();
  await page.getByLabel('Person', { exact: true }).selectOption('fixture-user');
  await page.getByLabel('Proposed status').selectOption('departed');
  await page.getByRole('button', { name: 'Preview impact', exact: true }).click();
  await page.getByRole('heading', { name: 'What-if preview' }).waitFor();
  const beforeScenario = previewRequests.length;
  await ask('Ask Bob about this scenario', 'Explain unsaved scenario', 'scenario');
  assert.equal(previewRequests.length, beforeScenario + 1, 'Bob must revalidate scenario against server');
  assert.equal(previewRequests.at(-1).status, 'departed');
  assert.match(submissions.at(-1).prompt, /"applied":false/);
  assert.equal(writes.length, 0, 'Contextual Bob and preview must not save portfolio changes');
  assert.equal(sessionCreates, 1, 'Context switches reuse the embedded project conversation');
  denyContext = true;
  const beforeDenied = submissions.length;
  await page.locator('.projects-assistant textarea').fill('Question after revoked context');
  await page.getByRole('button', { name: 'Send to Bob', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /context|access|authorized/i }).first().waitFor();
  assert.equal(submissions.length, beforeDenied, 'Unavailable authorized context must prevent model submission');
  assert.equal(await page.locator('.projects-assistant textarea').inputValue(), 'Question after revoked context', 'Failed questions must remain available for retry');
  assert.deepEqual(errors, []);
  console.log('PASS Embedded Projects Bob: project/person/work item/scenario focus, server revalidation, no writes, shared session, revoked-context failure');
} catch (error) {
  await page.screenshot({ path: '/tmp/projects-bob-failure.png', fullPage: true });
  console.log('DEBUG', JSON.stringify({ sessionCreates, errors, submissions: submissions.length, previewRequests, writes }), await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
