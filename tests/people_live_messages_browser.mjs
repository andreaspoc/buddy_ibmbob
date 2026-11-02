// Real authenticated HTTP writes and recipient WebSocket delivery; disposable test room only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE||'playwright');
const fixture=JSON.parse(await readFile('/tmp/people-voice-fixture.json','utf8'));
const base=process.env.CARBON_PREVIEW_URL||'http://127.0.0.1:3183';
const browser=await chromium.launch({args:['--no-sandbox','--ignore-certificate-errors']});const contexts=[],pages=[];const waiting=[];
try{
 for(const user of fixture.users.slice(0,2)){
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:true});contexts.push(ctx);
  await ctx.addCookies([{name:user.cookie,value:user.token,url:base,httpOnly:true,secure:base.startsWith('https:'),sameSite:'Lax'}]);
  const page=await ctx.newPage();pages.push(page);
  await page.addInitScript(u=>{sessionStorage.setItem(`buddy-approval-guide:${u.username}`,'seen');sessionStorage.setItem(`buddy-welcome-v1:${u.username}`,'seen');},user);
  await page.route('**/personalization/tutorials',route=>route.fulfill({json:{disabled:true}}));
  await page.goto(base);await page.locator('.member-chat-launcher').waitFor();
  await page.evaluate(roomId=>window.dispatchEvent(new CustomEvent('community-open-room',{detail:{roomId,kind:'direct'}})),fixture.room_id);
  await page.locator('.member-chat-composer textarea').waitFor();
  await page.waitForFunction(()=>!document.querySelector('.member-chat-conversation')?.textContent?.includes('Loading messages'));
 }
 // Stall message snapshot reads after initial load. Delivery must come from the POST result and WebSocket, not polling or a reload.
 for(const page of pages)await page.route(`**/api/community/rooms/${fixture.room_id}/messages?*`,route=>new Promise(resolve=>{waiting.push({route,resolve});}));
 const [sender,recipient]=pages;const input=sender.locator('.member-chat-composer textarea');
 const sent='Synthetic live-message check '+Date.now();await input.fill(sent);await input.press('Enter');
 await sender.getByText(sent,{exact:true}).waitFor({timeout:5000});
 assert(await input.evaluate(el=>document.activeElement===el),'Enter must preserve composer focus');
 await recipient.getByText(sent,{exact:true}).waitFor({timeout:5000});
 const next=sent+' next';
 await input.pressSequentially(next);
 assert.equal(await input.inputValue(),next);
 assert(await input.evaluate(el=>document.activeElement===el));
 await input.press('Enter');
 await recipient.getByText(next,{exact:true}).waitFor({timeout:5000});
 assert(await input.evaluate(el=>document.activeElement===el));
 console.log('PASS: sender and recipient display real messages without reload or snapshot polling; Enter keeps input focus for consecutive messages.');
}finally{
 for(const {route,resolve} of waiting){await route.abort().catch(()=>{});resolve();}
 for(const ctx of contexts)await ctx.close();await browser.close();
}
