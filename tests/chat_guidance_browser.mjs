// Synthetic guidance lifecycle checks with the app's real CSS.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{const p=new URL(r.request().url()).pathname;return p.startsWith('/api/')||p.startsWith('/sessions/')?r.fulfill({json:[]}):r.continue()});
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:900});await page.goto(`${process.env.CARBON_PREVIEW_URL||'http://127.0.0.1:3177'}/tests/chat-guidance.html`);
  const input=page.getByRole('textbox',{name:'Guide this response',exact:true}),send=page.getByRole('button',{name:'Send guidance',exact:true});await input.fill('Focus on the next step.');
  const colors=await page.locator('.chat-guidance .bubble').first().evaluate(e=>({background:getComputedStyle(e).backgroundColor,text:[e,...e.querySelectorAll('p,small,span')].map(n=>getComputedStyle(n).color)}));
  assert.ok(colors.text.every(c=>c==='rgb(255, 255, 255)'));assert.notEqual(colors.background,'rgba(0, 0, 0, 0)');
  await send.click();assert.equal(await send.getAttribute('aria-busy'),'true');assert.equal(await send.isDisabled(),true);await send.getByText('Sending…',{exact:true}).waitFor();
  const bounds=await page.locator('.composer').evaluate(e=>{const r=e.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth+1,outside:[...e.querySelectorAll('.composer-row textarea,.composer-row button')].filter(n=>n.getClientRects().length).some(n=>{const b=n.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1}),radius:getComputedStyle(e.querySelector('.guidance-send-button')).borderRadius}});
  console.log(width,bounds);await page.screenshot({path:`/tmp/guidance-${width}.png`,fullPage:true});assert.equal(bounds.overflow,false);assert.equal(bounds.outside,false);assert.equal(bounds.radius,'8px');
  await page.getByText('Guidance sent to Buddy.',{exact:true}).waitFor();assert.equal(await input.inputValue(),'');
  await page.getByRole('button',{name:'Mark guidance applied'}).click();assert.ok((await page.locator('.chat-guidance-status').allTextContents()).every(x=>x==='Applied'));
  await page.getByRole('button',{name:'Toggle guidance error'}).click();await input.fill('Keep this instruction on failure.');await send.click();await page.locator('#guidance-status.error').waitFor();assert.equal(await input.inputValue(),'Keep this instruction on failure.');assert.equal(await send.isEnabled(),true);
  await input.focus();await page.keyboard.press('Tab');assert.equal(await send.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
  await page.getByRole('button',{name:'Stop generation',exact:true}).click();await page.locator('.guidance-send-button').waitFor({state:'hidden'});
  console.log('PASS guidance sending, applied, error/retry, focus and Stop',width);
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close()}
