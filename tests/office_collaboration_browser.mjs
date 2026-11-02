// Synthetic NDJSON events exercise the same UI-agnostic envelope as production.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:390,height:1000}});
 const task='Review the recorded project milestones for the report';
 const handoff=(stage)=>({type:'tool',id:'synthetic-project-handoff',name:'Project Buddy',status:stage==='started'?'started':'completed',collaboration:{version:1,call_id:'synthetic-project-handoff',agent_id:'projects',agent_name:'Project Buddy',stage,message:stage==='started'?'Project Buddy is reviewing the task':'Project Buddy returned findings',task}});
 const events=[handoff('started'),handoff('completed'),{type:'plan',plan:{version:1,kind:'word',reply:'Synthetic reviewed project report',actions:[]}}];
 await page.route('**/api/office/assistant/files/*/draft',route=>route.fulfill({contentType:'application/x-ndjson',body:events.map(JSON.stringify).join('\n')+'\n'}));
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/office-branding.html?extension=docx');
 await page.getByRole('textbox',{name:'Instructions for Buddy'}).fill('Draft a report about the project milestones');
 await page.getByRole('textbox',{name:'Instructions for Buddy'}).press('Enter');
 const trace=page.getByRole('list',{name:'App collaboration'});
 await trace.getByText('Project Buddy returned findings').waitFor();
 assert.equal(await trace.locator('li').count(),1);
 assert.equal(await trace.locator('li').getAttribute('data-stage'),'completed');
 assert.match(await trace.textContent(),/recorded project milestones/);
 assert.equal(await page.getByRole('button',{name:'Apply to document',exact:true}).count(),0);
 assert(await page.locator('.office-assistant').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.getByRole('button',{name:'Send to Buddy',exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Instructions for Buddy'}).fill('Retry with my notes');
 const failed={...handoff('completed'),id:'synthetic-failed',collaboration:{...handoff('completed').collaboration,call_id:'synthetic-failed',stage:'failed',message:'Notes Buddy could not complete the task'}};
 await page.unroute('**/api/office/assistant/files/*/draft');
 await page.route('**/api/office/assistant/files/*/draft',route=>route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify(failed)+'\n'+JSON.stringify({type:'plan',plan:{version:1,kind:'word',reply:'No findings are available',actions:[]}})+'\n'}));
 await page.getByRole('textbox',{name:'Instructions for Buddy'}).press('Enter');
 await page.getByText('Notes Buddy could not complete the task').waitFor();
 assert.equal(await page.locator('.app-collaboration-activity [data-stage="failed"]').count(),1);
 console.log('PASS: named task, completed/failed progress, stable handoff IDs, persistent review trace, no auto-apply, narrow layout.');
} finally {await browser.close();}
