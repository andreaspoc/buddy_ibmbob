// Synthetic fixture only. Timeline data never calls operational APIs.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const {default:AxeBuilder}=await import(process.env.CARBON_AXE_MODULE || '@axe-core/playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const base=process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
const errors=[];
for(const width of [390,1440]) {
 const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'America/Los_Angeles'}),page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(base+'/tests/project-gantt.html?scenario=empty');await page.getByRole('heading',{name:'Your portfolio timeline starts with a project'}).waitFor();assert.equal(await page.locator('.gantt-bar').count(),0);
 await page.goto(base+'/tests/project-gantt.html?scenario=undated');await page.getByText('No dates have been recorded for the selected projects and work items.',{exact:false}).waitFor();assert.equal(await page.locator('.gantt-scroll').count(),0);assert.equal(await page.locator('.gantt-unscheduled li').count(),2);
 await page.goto(base+'/tests/project-gantt.html?scenario=mixed');await page.getByRole('region',{name:'Gantt chart timeline'}).waitFor();assert.equal(await page.locator('.gantt-bar').count(),1);assert.equal(await page.locator('.gantt-marker').count(),6);assert.equal(await page.locator('.gantt-unscheduled li').count(),1);
 await page.getByRole('group',{name:'Synthetic due-only task: Due 2027-01-08 · duration unknown',exact:true}).waitFor();await page.getByRole('group',{name:'Synthetic start-only task: Starts 2027-01-03 · deadline unknown',exact:true}).waitFor();await page.getByRole('group',{name:'Synthetic decision: 2027-01-04 to 2027-01-05 · Milestone',exact:true}).waitFor();
 await page.getByRole('group',{name:'Synthetic release milestone: Milestone due 2027-01-09 · Milestone',exact:true}).waitFor();
 for (const label of ['Synthetic accepted deliverable','Synthetic applied lesson']) { const row=page.getByRole('row').filter({hasText:label});assert.equal(await row.locator('.status-overdue').count(),0);assert(await row.locator('.status-completed').count()>0); }
 await page.getByLabel('Filter timeline by status',{exact:true}).selectOption('completed');assert.equal(await page.locator('tbody tr').count(),2);await page.getByLabel('Filter timeline by status',{exact:true}).selectOption('all');
 const before=await page.locator('.gantt-bar').evaluate(el=>el.getBoundingClientRect().width);await page.getByRole('button',{name:'Months',exact:true}).click();const after=await page.locator('.gantt-bar').evaluate(el=>el.getBoundingClientRect().width);assert(after<=before);
 await page.getByRole('button',{name:'Hide work items for Synthetic scheduled project'}).click();assert.equal(await page.locator('.gantt-marker').count(),0);await page.getByRole('button',{name:'Show work items for Synthetic scheduled project'}).click();assert.equal(await page.locator('.gantt-marker').count(),6);
 await page.getByRole('button',{name:'Ask Bob about timeline for Synthetic due-only task',exact:true}).click();assert.equal(JSON.parse(await page.locator('output').textContent()).workItemId,'10');
 await page.getByLabel('Filter timeline by project',{exact:true}).selectOption('2');assert.equal(await page.locator('.gantt-bar').count(),0);assert.equal(await page.locator('.gantt-scroll').count(),0);await page.getByLabel('Filter timeline by project',{exact:true}).selectOption('all');
 await page.locator('.gantt-scroll').focus();assert(await page.locator('.gantt-scroll').evaluate(el=>el===document.activeElement));
 const axe=await new AxeBuilder({page}).withRules(['color-contrast','label','button-name','nested-interactive','aria-valid-attr-value','table-duplicate-name','scope-attr-valid']).analyze();assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('main').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`/tmp/projects-gantt-${width}.png`,fullPage:true});await context.close();
}
assert.deepEqual(errors,[]);await browser.close();console.log('Gantt passed: empty, unscheduled, actual spans, due/start-only markers, decisions, filtering, zoom, expansion, Bob, accessibility and contained mobile scrolling.');
