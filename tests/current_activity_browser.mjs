// Synthetic status/work-log events; no model request or real tools run.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/current-activity.html');
 const disclosure=page.locator('.answer-details'),summary=disclosure.locator('summary');
 await summary.getByText('Searching the knowledge base…',{exact:true}).waitFor();
 assert.equal(await disclosure.getAttribute('open'),null);
 const base={id:'progress',role:'assistant',content:'',isStreaming:true,deliveryState:'running',statusText:'Reading search results…',workLog:[{text:'Searching sources',state:'completed',timestamp:1},{text:'Reading search results…',state:'running',timestamp:2}]};
 const show=async patch=>page.evaluate(answer=>window.setActivityFixture(answer),{...base,...patch});
 await show({});
 await summary.getByText('Reading search results…',{exact:true}).waitFor();
 assert.equal(await disclosure.getAttribute('open'),null);
 await summary.focus();await page.keyboard.press('Enter');
 await disclosure.locator('.answer-activity-list').getByText('Reading search results…',{exact:true}).waitFor();
 await show({statusText:'Preparing the report…'});
 await summary.getByText('Preparing the report…',{exact:true}).waitFor();
 assert.notEqual(await disclosure.getAttribute('open'),null);
 await page.keyboard.press('Enter');
 assert.equal(await disclosure.getAttribute('open'),null);
 await show({statusText:'Using skill analysis-buddy…'});
 await summary.getByText('Using skill Analysis Buddy…',{exact:true}).waitFor();
 await show({statusText:'Calling API token=synthetic-secret'});
 await summary.getByText('Calling API token=[redacted]',{exact:true}).waitFor();
 assert(!(await summary.innerText()).includes('synthetic-secret'));
 for(const [patch,label] of [[{deliveryState:'queued'},'Queued'],[{isStopping:true},'Stopping'],[{approvals:[{status:'pending'}]},'Waiting for approval'],[{deliveryState:'failed'},'Failed']]){
  await show(patch);await summary.getByText(label,{exact:true}).waitFor();
 }
 await show({statusText:'Reading '+ 'LongSourceName'.repeat(30)});
 for(const width of [1440,768,390,320]){
  await page.setViewportSize({width,height:900});
  assert(await summary.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`summary overflow at ${width}`);
  assert(await summary.locator('.answer-current-activity').evaluate(el=>el.getBoundingClientRect().height<=45),`compact step height at ${width}`);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`page overflow at ${width}`);
 }
 await page.screenshot({path:'/tmp/current-activity-phone.png',fullPage:true});
 await show({isStreaming:false,deliveryState:'completed',statusText:'Searching sources'});
 assert.equal(await summary.locator('[role=status]').count(),0,'no stale live status after completion');
 assert.equal(await summary.locator('.answer-recorded-step-count').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: collapsed live step updates, drawer keyboard/open preservation, friendly skills, masking, priority states, 4 widths, terminal cleanup');
}finally{await browser.close();}
