import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs');
execFileSync('python3',['tests/carbon_dashboard_fixture.py','--source','--output','/tmp/carbon-dashboard-source.html']);
const html=readFileSync('/tmp/carbon-dashboard-source.html','utf8');
const browser=await chromium.launch({args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__carbon_dashboard_fixture',route=>route.fulfill({body:html,contentType:'text/html'}));
 await page.route('**/static/carbon-charts.bundle.js',route=>route.fulfill({body:readFileSync('app/static/carbon-charts.bundle.js'),contentType:'application/javascript'}));
 await page.route('**/static/carbon-charts.css',route=>route.fulfill({body:readFileSync('app/static/carbon-charts.css'),contentType:'text/css'}));
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/carbon-artifact-preview.html');
 await page.getByRole('button',{name:'Replay chart animations',exact:true}).waitFor();
 // The active frame is whichever native iframe is visible; avoid the buffered snapshot.
 const frame=await page.locator('iframe[aria-hidden="false"]').elementHandle().then(element=>element.contentFrame());
 await frame.waitForFunction(()=>window.barHandle && window.carbonReplays>0);
 const before=await frame.evaluate(()=>window.carbonReplays);
 await page.getByRole('button',{name:'Replay chart animations',exact:true}).click();
 await frame.waitForFunction(count=>window.carbonReplays>count,before);
 for(let repeat=0;repeat<2;repeat++){
  const count=await frame.evaluate(()=>window.carbonReplays);
  await page.getByRole('button',{name:'Hide dashboard screen',exact:true}).click();await page.waitForTimeout(100);
  await page.getByRole('button',{name:'Show dashboard screen',exact:true}).click();
  await frame.waitForFunction(count=>window.carbonReplays>count,count);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: actual Carbon in sandbox preview, local assets, Replay control, repeated dashboard screen returns');
}finally{await browser.close();}
