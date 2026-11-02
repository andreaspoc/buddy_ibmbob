/** Capture current UI with an empty, explicitly synthetic account. No real API calls. */
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const destination=process.env.TUTORIAL_SCREENSHOTS_DIR || root+'/app/static/tutorials';
const base=process.env.WELCOME_PREVIEW_URL || 'https://192.0.2.10';
mkdirSync(destination,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const results=[];
try {
for (const language of (process.env.TUTORIAL_LANGUAGES || 'en,el,hi,mt').split(',')) {
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960},deviceScaleFactor:1,reducedMotion:'reduce'});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(language=>{localStorage.setItem('bob-ui-language',language);localStorage.setItem('buddy-display-scale','100');sessionStorage.setItem('buddy-welcome-v1:example-workspace','seen');},language);
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path==='/' || path.startsWith('/assets/') || path==='/favicon.svg' || path==='/icons.svg')return route.continue();
  let data=[];
  if(path==='/auth/status')data={user:{username:'example-workspace',display_name:'',is_admin:false},local_login_enabled:true};
  else if(path==='/personalization/tutorials')data={disabled:true};
  else if(path==='/api/apps')data={apps:[]};
  else if(path==='/projects')data=[{id:'exampleagents',name:'Agents',is_active:true}];
  else if(path==='/sessions' && route.request().method()==='POST')data={id:'a'.repeat(32)};
  else if(path.includes('/capabilities'))data={web_search:false};
  else if(path.startsWith('/auth/microsoft'))data={configured:false,connected:false};
  await route.fulfill({json:data});
 });
 await page.goto(base,{waitUntil:'networkidle'});await page.locator('.composer').waitFor();await page.evaluate(()=>document.fonts.ready);
 async function capture(name,container,target) {
  const focus=target?page.locator(target):null;
  if(focus)await focus.evaluate(el=>{el.style.outline='3px solid #e65925';el.style.outlineOffset='4px';});
  await page.locator(container).screenshot({path:`${destination}/${language}-${name}.png`,animations:'disabled'});
  if(focus)await focus.evaluate(el=>{el.style.outline='';el.style.outlineOffset='';});
  results.push({language,screen:name});
 }
 await capture('workspace','.shell');
 await capture('ask','.composer','#prompt-input');
 await capture('guide','.composer','.slash-button');
 await capture('attach','.composer','.composer-clip-btn');
 await page.locator('.workspace-menu-buddy > button').click();
 await capture('approvals','.workspace-panel-buddy','.approval-inline select');
 await capture('tools','.workspace-panel-buddy','.workspace-panel-buddy section:first-of-type button');
 await page.locator('.workspace-menu-buddy > button').click();
 await page.locator('[data-mode-target="agents"]').click();
 await page.waitForFunction(()=>document.querySelector('.conversation-page')?.dataset.mode==='agents');
 await capture('a2a','.shell','[data-mode-target="agents"]');
 if(errors.length)throw new Error(language+': '+errors.join('; '));
 console.log(`Captured ${language}: workspace, ask, guide, attach, approvals, tools, a2a`);
 await context.close();
}
writeFileSync(destination+'/capture-manifest.json',JSON.stringify({capturedAt:new Date().toISOString(),source:'Actual current UI rendered with empty synthetic account; API calls intercepted, no personal data or real agent connections.',viewport:{width:1440,height:960},screens:results},null,2)+'\n');
}finally{await browser.close();}
