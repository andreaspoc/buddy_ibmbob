// Synthetic documents and bridge; no model or editor requests.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({args:['--no-sandbox']});const p=await b.newPage({viewport:{width:1280,height:1000}});
const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.route('**/api/office/files/*/assistant/history',r=>r.fulfill({json:{turns:[]}}));
try {
 for(const extension of ['docx','xlsx','pptx','pdf','html']) {
  await p.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/office-branding.html?extension='+extension);
  const avatar=p.locator('.office-assistant-avatar');await avatar.waitFor();
  assert.equal(await avatar.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(138, 63, 252)');
  assert.equal(await p.locator('.office-assistant header strong').evaluate(e=>getComputedStyle(e).color),'rgb(22, 22, 22)');
  assert.equal(await p.locator('.office-assistant-subtitle').evaluate(e=>getComputedStyle(e).color),'rgb(57, 57, 57)');
  await p.getByRole('textbox',{name:'Instructions for Buddy'}).fill('Synthetic styling check');
  await p.waitForTimeout(220);
  assert.equal(await p.getByRole('button',{name:'Send to Buddy',exact:true}).evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(138, 63, 252)');
  for(const width of [1280,390,320]) {
   await p.setViewportSize({width,height:1000});
   for(const selector of ['.office-assistant-title','.office-assistant-subtitle']) {
    assert(await p.locator(selector).isVisible());
    assert(await p.locator(selector).evaluate(e=>{
      const r=e.getBoundingClientRect(),h=e.closest('header').getBoundingClientRect();
      const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return r.width>0 && r.height>0 && r.left>=h.left && r.right<=h.right+1 && r.top>=h.top && r.bottom<=h.bottom && (top===e || e.contains(top));
    }),`header text obscured: ${extension}, ${width}, ${selector}`);
   }
   assert(await p.locator('.office-assistant-log').evaluate(e=>e.clientHeight>250));
   assert(await p.locator('.office-assistant').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   assert(await p.locator('.office-assistant header').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  }
 }
 await p.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/office-branding.html?extension=docx');
 await p.locator('.office-assistant-subtitle').waitFor();
 await p.screenshot({path:'/tmp/office-word-header.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: 5 document types, Carbon purple avatar/send, dark readable header, no panel/header overflow at 3 widths');
} finally {await b.close();}
