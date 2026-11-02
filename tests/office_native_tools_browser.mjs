// Synthetic selections and plans; no real documents or model calls.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:1000}});
const requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
let plan;
await page.route('**/api/office/assistant/files/*/draft',r=>{requests.push(r.request().postDataJSON());return r.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'plan',plan})+'\n'});});
try{
 const base=process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183';
 await page.goto(base+'/tests/office-branding.html?extension=xlsx');
 await page.getByRole('button',{name:'Add selectable dropdowns',exact:true}).click();
 assert.equal(requests.length,0);
 assert.match(await page.getByRole('textbox',{name:'Instructions for Buddy'}).inputValue(),/selected cells/);
 await page.getByRole('combobox',{name:'Include context'}).selectOption('selection');
 plan={version:1,kind:'cell',reply:'Review these native dropdown choices.',actions:[{type:'set_validation',sheet:'Data',range:'B2:B8',rule:'list',options:['Open','Closed']}]};
 await page.getByRole('button',{name:'Send to Buddy',exact:true}).click();
 await page.getByRole('button',{name:'Apply to document',exact:true}).waitFor();
 assert.equal(requests[0].context_mode,'selection');assert.equal(requests[0].context.sheet,'Data');assert.equal(requests[0].context.range,'B2:B8');assert(!requests[0].context.workbook);
 assert.match(await page.locator('.office-assistant-preview').textContent(),/Open, Closed/);
 assert.match(await page.locator('.office-assistant-context-used').textContent(),/Data · B2:B8/);
 await page.getByRole('button',{name:'Apply to document',exact:true}).click();
 await page.waitForFunction(()=>window.officeAppliedPlan?.actions[0]?.type==='set_validation');
 await page.goto(base+'/tests/office-branding.html?extension=pptx');
 await page.getByRole('combobox',{name:'Include context'}).selectOption('selection');
 await page.getByRole('textbox',{name:'Instructions for Buddy'}).fill('Change this label to Updated label');
 plan={version:1,kind:'slide',reply:'Only the selected label will change.',actions:[{type:'replace_slide_text',slide_index:1,shape_index:1,old_text:'Selected label',text:'Updated label'}]};
 await page.getByRole('button',{name:'Send to Buddy',exact:true}).click();
 await page.getByRole('button',{name:'Apply to document',exact:true}).waitFor();
 assert.equal(requests[1].context.slide_shapes.length,1);assert.equal(requests[1].context.slide_shapes[0].selected,true);
 assert.equal(requests[1].context.slide_width,254);assert.match(await page.locator('.office-assistant-context-used').textContent(),/Slide 1 · 1 selected objects/);
 assert(await page.locator('.office-assistant').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 assert.deepEqual(errors,[]);
 console.log('PASS: native dropdown preview/apply, context selector, active sheet/range, selected-object privacy, slide dimensions, narrow panel');
}finally{await browser.close();}
