// Synthetic route regression: APIs and model replies are intercepted; no live data.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({args:['--no-sandbox']});
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(12000);
const base = process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
let signedIn=true, submissions=0;
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
await page.addInitScript(()=>{sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');localStorage.setItem('bob-ui-language','en');});
const user={username:'fixture-user',is_admin:true};
const portfolio={can_manage:true,projects:[],people:[],assignments:[],dependencies:[],work_items:[],impact:{items:[],summary:{confirmed:0,risks:0,affected_projects:0}},events:[],recent_change_impacts:[]};
await page.route('**/*',async route=>{
 const request=route.request(), path=new URL(request.url()).pathname;
 if(request.isNavigationRequest() || path.startsWith('/src/') || path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/assets/') || /\.(svg|png|ico|woff2)$/.test(path)) return route.continue();
 let data=[];
 if(path==='/auth/status')data={user:signedIn?user:null,local_login_enabled:true,keycloak_configured:true};
 else if(path==='/auth/login'){signedIn=true;data=user;}
 else if(path==='/personalization/tutorials')data={disabled:true};
 else if(path==='/api/apps')data={apps:[{id:'projects',name:'Projects',description:'Synthetic fixture',kind:'installed',desktop_only:false,launch:{kind:'projects'}}]};
 else if(path==='/api/projects/context')data={portfolio,instructions:'Use recorded facts only.'};
 else if(path.startsWith('/api/projects'))data=portfolio;
 else if(path==='/sessions' && request.method()==='POST')data={id:'route-bob-session'};
 else if(path==='/chat/stream'){submissions++;return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'delta',text:'Synthetic route response.'})+'\n'+JSON.stringify({type:'done'})+'\n'});}
 else if(path==='/access/me')data={user,libraries:[],audiences:[],administrator:true};
 else if(path.endsWith('/capabilities'))data={web_search:false};
 return route.fulfill({json:data});
});
const workspace=page.getByRole('region',{name:'Projects portfolio'});
const pathname=()=>new URL(page.url()).pathname;
async function assertLocalChrome(){assert.equal(await page.locator('.topbar:visible').count(),0);assert.equal(await workspace.getByRole('navigation',{name:'Projects views',exact:true}).count(),1);assert.equal(await workspace.getByRole('navigation',{name:'Project sections',exact:true}).count(),0);}
async function openFromLauncher(){await page.locator('.workspace-notes-tab').click();await page.locator('.installed-apps').getByRole('button',{name:/Projects/}).click();await workspace.waitFor();assert.equal(pathname(),'/projects');await assertLocalChrome();}
try{
 await page.goto(base+'/projects');await workspace.waitFor();assert.equal(pathname(),'/projects');await assertLocalChrome();
 await page.reload();await workspace.waitFor();assert.equal(pathname(),'/projects');
 await workspace.getByRole('button',{name:'Back to Buddy',exact:true}).click();await page.locator('#prompt-input').waitFor();assert.equal(pathname(),'/');assert.equal(await page.locator('.topbar:visible').count(),1);
 await page.goBack();await workspace.waitFor();assert.equal(pathname(),'/projects');
 await page.goForward();await page.locator('#prompt-input').waitFor();assert.equal(pathname(),'/');assert.equal(await page.locator('.topbar:visible').count(),1);
 await openFromLauncher();
 // Embedded assistant submissions must preserve the dedicated portfolio route.
 if(!await page.locator('.projects-assistant').count())await workspace.getByRole('button',{name:'Toggle project assistant',exact:true}).click();
 await page.locator('.projects-assistant textarea').fill('Explain the empty recorded portfolio.');await page.getByRole('button',{name:'Send to Bob',exact:true}).click();
 await page.locator('.projects-bob-messages').getByText('Synthetic route response.',{exact:true}).waitFor();assert.equal(submissions,1);assert.equal(pathname(),'/projects');
 await workspace.getByRole('button',{name:'Back to Buddy',exact:true}).click();assert.equal(pathname(),'/');
 await page.goBack();await workspace.waitFor();assert.equal(pathname(),'/projects');
 await page.goto(base+'/projects/');await workspace.waitFor();assert.match(pathname(),/^\/projects\/?$/);
 // A signed-out deep link must retain its destination through local sign-in.
 signedIn=false;await page.goto(base+'/?next=%2Fprojects');await page.getByLabel('Username',{exact:true}).waitFor();
 const sso=page.getByRole('link',{name:/Keycloak|company account|company sign/i});
 assert.equal(await sso.count(),1);assert.match(await sso.first().getAttribute('href'),/next=/);
 await page.getByLabel('Username',{exact:true}).fill('fixture-user');await page.getByLabel('Password',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:/^sign in$/i}).click();
 await workspace.waitFor();assert.equal(pathname(),'/projects');assert.equal(new URL(page.url()).searchParams.has('next'),false);
 assert.deepEqual(errors,[]);console.log('PASS Projects direct URL, refresh, history, launcher, close, Bob URL persistence, trailing slash and sign-in return');
}catch(error){await page.screenshot({path:'/tmp/projects-route-failure.png',fullPage:true});console.log('DEBUG',page.url(),errors,await page.locator('body').innerText());throw error;}finally{await browser.close();}
