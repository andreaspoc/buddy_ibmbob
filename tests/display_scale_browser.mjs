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
signedIn=true;
for(const width of [320,390,768,1055,1056,1440,1920]){
 await page.setViewportSize({width,height:900});await page.goto(url);await page.locator('#prompt-input').waitFor();
 await page.getByRole('button',{name:'Settings menu',exact:true}).click();const scale=page.getByRole('combobox',{name:'Display scale',exact:true});
 for(const [choice,expected] of [['auto',width >= 1056 ? 0.90 : 0.80],['100',1],['75',0.75],['85',0.85],['auto',width >= 1056 ? 0.90 : 0.80]]){
  await scale.selectOption(choice);
  await page.waitForFunction(expected=>Math.abs(Number(getComputedStyle(document.documentElement).zoom)-expected)<0.001,expected);
  const state=await page.evaluate(()=>({zoom:Number(getComputedStyle(document.documentElement).zoom),override:document.documentElement.style.getPropertyValue('--preferred-ui-scale'),overflow:document.documentElement.scrollWidth>innerWidth+1,shell:document.querySelector('.shell').getBoundingClientRect().height,sidebar:document.querySelector('.sidebar').getBoundingClientRect().height}));
  assert.equal(state.zoom,expected);if(choice==='auto')assert.equal(state.override,'');assert.equal(state.overflow,false);assert.ok(Math.abs(state.shell-900)<2);assert.ok(Math.abs(state.sidebar-900)<2);
 }
 console.log('PASS display scale automatic/manual switching and full-height layout',width);
}
assert.deepEqual(errors,[]);
}finally{await browser.close()}
