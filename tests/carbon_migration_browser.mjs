// Synthetic UI fixtures only; backend, accounts, and model services are never contacted.
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage();page.setDefaultTimeout(10000);
let signedIn=false, sso=true, localLogin=true, authFailure=false, acceptLogin=false, errors=[]; const requests=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');localStorage.setItem('bob-ui-language','en');});
await page.route('**/*',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path==='/' || path==='/notes' || path.startsWith('/src/') || path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/assets/') || /\.(svg|png|ico|woff2)$/.test(path)) return route.continue();
 let data=[];
 if(path==='/auth/status' && authFailure) return route.fulfill({status:503,json:{detail:'Synthetic unavailable auth status'}});
 if(path==='/auth/status') data={user:signedIn?{username:'fixture-user',is_admin:true}:null,local_login_enabled:localLogin,keycloak_configured:sso};
 else if(path==='/auth/login'||path==='/auth/register'){requests.push([path,route.request().postDataJSON()]);return route.fulfill(acceptLogin ? {json:{username:'synthetic-user',is_admin:false}} : {status:401,json:{detail:'Synthetic credential error'}});}
 else if(path==='/personalization/tutorials') data={disabled:true};
 else if(path==='/api/apps') data={apps:[]};
 else if(path==='/api/office/files'||path==='/api/office/folders') data={items:[]};
 else if(path==='/api/office/chat-capabilities') data={version:1};
 else if(path==='/access/me') data={user:{username:'fixture-user',is_admin:true},libraries:[],audiences:[],administrator:true};
 else if(path.endsWith('/capabilities')) data={web_search:false};
 return route.fulfill({json:data});
});
const url=process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
try {
for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:900});
 await page.goto(url);await page.getByLabel('Username',{exact:true}).waitFor();
 await page.getByLabel('Username',{exact:true}).fill('synthetic-user');const pass=page.getByLabel('Password',{exact:true});await pass.fill('synthetic-password');
 await page.getByRole('button',{name:'Show password',exact:true}).click();assert.equal(await pass.getAttribute('type'),'text');
 await page.getByRole('button',{name:'Hide password',exact:true}).click();assert.equal(await pass.getAttribute('type'),'password');
 await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic credential error'}).waitFor();
 await page.getByRole('button',{name:'Dismiss error',exact:true}).click();await page.locator('.buddy-error-banner').waitFor({state:'hidden'});
 assert.deepEqual(requests.at(-1),['/auth/login',{username:'synthetic-user',password:'synthetic-password'}]);
 const m=await page.evaluate(()=>{const el=document.querySelector('#buddy-username');const rect=el.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth+1,fieldOutside:rect.left<0||rect.right>innerWidth+1,buttonRadius:getComputedStyle(document.querySelector('.buddy-submit-button')).borderRadius};});
 console.log('login',width,m);assert.equal(m.overflow,false);assert.equal(m.fieldOutside,false);assert.equal(m.buttonRadius,'4px');
}
// Auth modes and failures are tested without creating a real session.
sso=false;
await page.goto(url);await page.getByLabel('Username',{exact:true}).fill('synthetic-user');
await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
await page.getByRole('button',{name:'Create one',exact:true}).click();
await page.getByRole('button',{name:'Create Account',exact:true}).click();
await page.locator('.buddy-error-banner').waitFor();assert.equal(requests.at(-1)[0],'/auth/register');
sso=true;localLogin=false;
await page.goto(url);await page.getByRole('link',{name:'Sign in with Keycloak',exact:true}).waitFor();
assert.equal(await page.getByLabel('Username',{exact:true}).count(),0);
assert.match(await page.locator('#auth-keycloak').getAttribute('href'),/^\/auth\/keycloak\/login\?next=/);
sso=false;
await page.goto(url);await page.getByRole('alert').filter({hasText:'Authentication is not configured'}).waitFor();
authFailure=true;
await page.goto(url);await page.getByRole('alert').filter({hasText:'Could not load sign-in options'}).waitFor();
authFailure=false;localLogin=true;acceptLogin=true;
await page.goto(url);await page.getByLabel('Username',{exact:true}).fill('synthetic-user');
await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
await page.getByRole('button',{name:'Sign In',exact:true}).click();
await page.getByRole('alert').filter({hasText:'Your session could not be saved'}).waitFor();
assert.equal(await page.locator('.topbar').count(),0);
console.log('PASS registration, SSO-only, unconfigured/error states, and session verification');
acceptLogin=false;signedIn=true;
for(const width of [320,390,667,768,1280,1920]){
 await page.setViewportSize({width,height:900});await page.goto(url);await page.locator('#prompt-input').waitFor();
 const m=await page.evaluate(()=>{const header=document.querySelector('.topbar'), r=header.getBoundingClientRect();const kids=[...header.querySelectorAll('.mobile-menu,.workspace-navigation > *,.topbar-notifications,.topbar-actions > *')].map(e=>e.getBoundingClientRect()).filter(r=>r.width&&r.height);return {overflow:document.documentElement.scrollWidth>innerWidth+1,headerOutside:kids.some(a=>a.left<r.left-1||a.right>r.right+1||a.bottom>r.bottom+1),nestedMain:!!document.querySelector('main main'),radii:[...document.querySelectorAll('.workspace-menu-trigger,.workspace-notes-tab')].map(e=>getComputedStyle(e).borderRadius)};});
 console.log('workspace',width,m);assert.equal(m.overflow,false);assert.equal(m.headerOutside,false);assert.equal(m.nestedMain,false);assert.ok(m.radii.every(r=>r==='4px'));
 const prompt=page.locator('#prompt-input'), composer=page.locator('.composer');
 await page.locator('.topbar').click({position:{x:1,y:1}});
 const restingBorder=await composer.evaluate(el=>getComputedStyle(el).borderColor);
 await prompt.click();
 const clicked=await composer.evaluate(el=>({radius:getComputedStyle(el).borderRadius,outline:getComputedStyle(el).outlineStyle,shadow:getComputedStyle(el).boxShadow,border:getComputedStyle(el).borderColor}));
 assert.equal(clicked.radius,'16px');assert.equal(clicked.outline,'none');assert.equal(clicked.shadow,'none');assert.equal(clicked.border,restingBorder);
 assert.equal(await prompt.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
 await prompt.fill('Synthetic draft');assert.equal(await composer.evaluate(el=>getComputedStyle(el).outlineStyle),'none');await prompt.fill('');
 await page.locator('.composer-clip-btn').focus();await page.keyboard.press('Tab');assert.equal(await prompt.evaluate(el=>el===document.activeElement),true);
 assert.equal(await composer.evaluate(el=>getComputedStyle(el).outlineStyle),'solid');assert.equal(await prompt.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
 await prompt.click();assert.equal(await composer.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
 console.log('PASS rounded composer, quiet pointer focus, single keyboard focus indicator',width);
}
assert.deepEqual(errors,[]);console.log('PASS Carbon login, navigation geometry, landmarks and keyboard focus');
const rows=[{id:1,title:'Synthetic research note',body:'## Test heading\n\nA synthetic note used only for UI verification.',color:'butter',collection:'Research',tags:['test'],favorite:false,sources:[],created_at:'2026-10-21T10:00:00Z'}];
await page.route('**/api/notes**', async route=>{
 const req=route.request(),path=new URL(req.url()).pathname;
 if(path==='/api/notes'){
  if(req.method()==='POST'){let row={...req.postDataJSON(),id:rows.length+1,created_at:'2026-10-21T10:00:00Z'};rows.push(row);return route.fulfill({status:201,json:row});}
  return route.fulfill({json:{items:rows,next_before_id:null,default_collection:'Research'}});
 }
 if(/\/api\/notes\/\d+$/.test(path)){
  const id=Number(path.split('/').at(-1)),row=rows.find(r=>r.id===id);
  if(req.method()==='PATCH'){Object.assign(row,req.postDataJSON());return route.fulfill({json:row});}
  if(req.method()==='DELETE'){rows.splice(rows.indexOf(row),1);return route.fulfill({status:204});}
 }
 return route.fulfill({json:{items:[]}});
});

for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:900});await page.goto(url);await page.locator('#prompt-input').waitFor();await page.locator('.composer-tool-shortcut').filter({hasText:'Notes'}).first().click();await page.locator('.notes-workspace').waitFor();await page.getByRole('button',{name:'Edit note: Synthetic research note',exact:true}).waitFor();
 const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,nestedMain:!!document.querySelector('main main'),radii:[...document.querySelectorAll('.notes-new,.notes-editor')].map(e=>getComputedStyle(e).borderRadius)}));console.log('notes',width,result);assert.equal(result.overflow,false);assert.equal(result.nestedMain,false);
 const colors=await page.locator('.notes-toolbar .notes-color-dot').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).backgroundColor));assert.ok(new Set(colors).size>1,'Note color choices must remain visually distinct');
 assert.equal(await page.locator('.notes-library-filters').evaluate(el=>getComputedStyle(el).borderRadius),'8px');
 await page.getByRole('button',{name:'Edit note: Synthetic research note',exact:true}).click();const dialog=page.locator('[data-note-editor]');await dialog.waitFor();
 await page.getByRole('tab',{name:'Write',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Preview',exact:true}).getAttribute('aria-selected'),'true');
 await page.keyboard.press('ArrowLeft');assert.equal(await page.getByRole('tab',{name:'Write',exact:true}).getAttribute('aria-selected'),'true');
 const m=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();let children=[...el.querySelectorAll('input,textarea,select,button')].filter(e=>e.getClientRects().length).map(e=>({name:e.getAttribute('aria-label')||e.textContent,rect:e.getBoundingClientRect()}));return{left:r.left,right:r.right,viewport:innerWidth,radius:getComputedStyle(el).borderRadius,outside:children.filter(c=>c.rect.left<r.left-1||c.rect.right>r.right+1).map(c=>c.name)};});console.log('notes editor',width,m);assert.ok(m.left>=-1&&m.right<=m.viewport+1);assert.equal(m.radius,'8px');assert.deepEqual(m.outside,[]);
 await page.getByLabel('Note content',{exact:true}).fill('## Test heading\n\nEdited synthetic content.');await page.getByRole('button',{name:'Save note',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.ok(rows[0].body.includes('Edited'));
 const wasFavorite=rows[0].favorite;await page.getByRole('button',{name:wasFavorite?'Unfavorite note: Synthetic research note':'Favorite note: Synthetic research note',exact:true}).click();await page.getByRole('button',{name:wasFavorite?'Favorite note: Synthetic research note':'Unfavorite note: Synthetic research note',exact:true}).waitFor();
 if(process.env.CARBON_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.CARBON_SCREENSHOT_DIR}/carbon-notes-${width}.png`,fullPage:true});
}
await page.getByRole('button',{name:'＋ New note',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Synthetic created note');await page.getByLabel('Note content',{exact:true}).fill('Synthetic new note body');await page.getByRole('button',{name:'Save note',exact:true}).click();await page.locator('[data-note-editor]').waitFor({state:'hidden'});assert.ok(rows.some(n=>n.title==='Synthetic created note'));
assert.deepEqual(errors,[]);console.log('PASS Notes edit, preview keyboard tabs, save, create, favorites, layout on four widths');

} finally { await browser.close(); }
