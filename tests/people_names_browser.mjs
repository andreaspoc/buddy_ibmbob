// Synthetic conversations only; all app API calls are intercepted.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const rooms=[{id:10,kind:'direct',name:'Synthetic Member Name',subscribed:true,unread_count:0},{id:11,kind:'channel',name:'Synthetic Project Group',visibility:'private',member_count:2,subscribed:true,unread_count:0}];
try {
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.addInitScript(()=>sessionStorage.setItem('buddy-approval-guide:shape-fixture','seen'));
  await page.route('**/*',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/'||path.startsWith('/src/')||path.startsWith('/@')||path.startsWith('/node_modules/')||path.startsWith('/assets/')||path.startsWith('/static/')||/\.(svg|png|ico)$/.test(path))return route.continue();
   let data=[];
   if(path==='/auth/status')data={user:{username:'shape-fixture',is_admin:false}};
   else if(path==='/api/community/rooms')data=rooms;
   else if(/\/members$/.test(path))data=[{username:'peer',display_name:'Synthetic Member Name'}];
   else if(/\/rooms\/\d+\/messages$/.test(path))data=[1,2,3].map(id=>({id,sender:id===3?'shape-fixture':'peer',sender_name:'Synthetic Member Name',body:`Synthetic message ${id}`,created_at:`2026-10-23T10:0${id}:00Z`,attachments:[]}));
   else if(path==='/personalization/tutorials')data={disabled:true};
   else if(path==='/api/apps')data={apps:[{id:'people',name:'Member chat',kind:'installed',launch:{kind:'people'}}]};
   await route.fulfill({json:data});
  });
  await page.goto(process.env.CARBON_PREVIEW_URL||'http://127.0.0.1:3183');
  await page.locator('.member-chat-launcher').click();
  assert(!await page.locator('.member-chat-panel').evaluate(e=>e.classList.contains('is-expanded')));
  const roomName=page.locator('.member-chat-room-copy strong').first();await roomName.waitFor();
  await page.locator('.member-chat-room').first().click();
  await page.locator('.member-chat-message').nth(2).waitFor();
  const names=page.locator('.member-chat-message-meta strong');
  assert.equal(await names.count(),3);
  for(const name of [page.locator('.member-chat-conversation-header h2'),...await names.all()]) {
   const facts=await name.evaluate(el=>{
    const rgb=s=>s.match(/[\d.]+/g)?.map(Number)||[];
    let bg=el;while(bg.parentElement&&getComputedStyle(bg).backgroundColor==='rgba(0, 0, 0, 0)')bg=bg.parentElement;
    const lum=c=>{const a=rgb(c).slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722;};
    const fg=lum(getComputedStyle(el).color),back=lum(getComputedStyle(bg).backgroundColor),r=el.getBoundingClientRect();
    return {width:r.width,height:r.height,contrast:(Math.max(fg,back)+.05)/(Math.min(fg,back)+.05),clip:getComputedStyle(el).clipPath};
   });
   assert(facts.width>8&&facts.height>8,JSON.stringify(facts));assert(facts.contrast>=4.5,JSON.stringify(facts));assert.equal(facts.clip,'none');
  }
  if(width>768){
   await page.getByRole('button',{name:'Expand chat',exact:true}).click();
   await page.getByRole('button',{name:'Compact chat',exact:true}).waitFor();
  }
  await page.getByRole('button',{name:'Minimize chat',exact:true}).click();
  await page.locator('.member-chat-launcher').click();
  assert(!await page.locator('.member-chat-panel').evaluate(e=>e.classList.contains('is-expanded')));
  await page.close();
 }
 console.log('PASS: conversation and all sender names remain visible with readable contrast; chat opens/reopens compact; manual desktop expansion and readable mobile names.');
}finally{await browser.close();}
