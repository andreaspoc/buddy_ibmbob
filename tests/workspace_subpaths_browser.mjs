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
 if(path==='/' || path.startsWith('/app/') || path==='/notes' || path.startsWith('/src/') || path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/assets/') || /\.(svg|png|ico|woff2)$/.test(path)) return route.continue();
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
 signedIn=true;
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(url);await page.locator('#prompt-input').waitFor();
 await page.getByRole('button',{name:'Tasks',exact:true}).click();
 await page.waitForURL('**/app/tasks');
 assert.equal(await page.locator('main.main').getAttribute('data-active-view'),'tasks');
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('main.main')?.dataset.activeView==='tasks');
 await page.evaluate(()=>window.dispatchEvent(new Event('buddy-open-knowledge')));
 await page.waitForURL('**/app/knowledge');
 await page.goBack();
 await page.waitForFunction(()=>document.querySelector('main.main')?.dataset.activeView==='tasks');
 await page.goForward();
 await page.waitForFunction(()=>document.querySelector('main.main')?.dataset.activeView==='knowledge');
 await page.goto(url+'/?next='+encodeURIComponent('/app/tasks'));
 await page.waitForURL('**/app/tasks');
 await page.waitForFunction(()=>document.querySelector('main.main')?.dataset.activeView==='tasks');
 assert.deepEqual(errors,[]);
 console.log('PASS workspace subpaths, refresh, browser Back and Forward');
} finally {await browser.close();}
