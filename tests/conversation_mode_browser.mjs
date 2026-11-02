// Synthetic API responses; exercises the actual App mode switch.
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>sessionStorage.setItem('buddy-welcome-v1:fixture','seen'));
await page.route('**/*',async r=>{
 const u=new URL(r.request().url()),p=u.pathname;
 if(p.startsWith('/src/') || p.startsWith('/node_modules/') || p.startsWith('/@') || p==='/' || /\.(svg|png|css|woff2?|js|tsx?|html)$/.test(p)) return r.continue();
 let data=[];
 if(p==='/auth/status') data={user:{username:'fixture',is_admin:true},local_login_enabled:true};
 else if(p==='/projects') data=[{id:'fixtureagents',name:'Agents',is_active:true}];
 else if(p==='/auth/microsoft/status') data={configured:false,connected:false};
 else if(p==='/api/apps') data={apps:[]};
 else if(p.includes('tutorial')) data={disabled:true};
 else if(p==='/modes') data=[{slug:'agent',name:'Agent'}];
 else if(p==='/skills') data=[{name:'analysis-buddy',description:'Synthetic analysis skill'}];
 else if(p.includes('capabilities')) data={};
 if(p==='/sessions' && u.searchParams.has('project_id')) await new Promise(resolve=>setTimeout(resolve,200));
 return r.fulfill({json:data});
});
try {
 await page.goto(process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183');
 const modes=page.getByRole('group',{name:'Conversation mode',exact:true});
 await modes.waitFor();
 await modes.getByRole('button',{name:'A2A agents',exact:true}).click();
 assert.equal(await modes.getAttribute('aria-busy'),'true');
 const indicator=page.locator('[data-mode-transition="agents"]');
 await indicator.waitFor();
 const timings=await indicator.evaluate(el=>el.getAnimations({subtree:true}).map(animation=>animation.effect.getTiming()));
 assert.equal(timings.length,2);
 assert(timings.every(timing=>timing.duration===1400));
 assert.equal(await indicator.locator('svg').count(),2);
 assert(Math.abs(await indicator.evaluate(el=>parseFloat(getComputedStyle(el).width))-72)<.1);
 assert.equal(await page.locator('[data-flight-visual]').count(),0);
 await indicator.evaluate(el=>{for(const animation of el.getAnimations({subtree:true})){animation.pause();animation.currentTime=700;}});
 await page.screenshot({path:'/tmp/conversation-minimal-transition.png'});
 await indicator.evaluate(el=>{for(const animation of el.getAnimations({subtree:true}))animation.play();});
 await page.waitForFunction(()=>document.querySelector('.conversation-stage > .conversation-page')?.dataset.mode==='agents');
 await modes.getByRole('button',{name:'Skills',exact:true}).click();
 await page.locator('[data-mode-transition="skills"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('.conversation-stage > .conversation-page')?.dataset.mode==='skills');
 await page.emulateMedia({reducedMotion:'reduce'});
 await modes.getByRole('button',{name:'A2A agents',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.conversation-page')?.dataset.mode==='agents');
 assert.equal(await page.locator('[data-mode-transition]').count(),0);
 assert.equal(await page.locator('.conversation-page').evaluate(el=>el.getAnimations().length),0);
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:390,height:844});
 await modes.getByRole('button',{name:'Skills',exact:true}).click();
 await page.locator('[data-mode-transition="skills"]').waitFor();
 // Changing the OS preference also completes a switch already in progress.
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>document.querySelector('.conversation-stage > .conversation-page')?.dataset.mode==='skills');
 assert.equal(await page.locator('[data-mode-transition]').count(),0);
 await page.emulateMedia({reducedMotion:'no-preference'});
 // Note-save feedback retains its separate 400ms timing.
 await page.evaluate(async()=>{
   const {flyNoteToNotes}=await import('/src/lib/noteFlight.ts');
   const note=document.createElement('div'); note.className='sticky-note';
   Object.assign(note.style,{position:'fixed',left:'30px',top:'180px',width:'250px',height:'180px'});
   note.textContent='Synthetic note'; document.body.append(note);
   window.noteFlight=flyNoteToNotes(note,new Map()).finally(()=>note.remove());
 });
 const noteFlight=page.locator('[data-flight-visual="plane"]');
 await noteFlight.waitFor();
 assert.equal(await noteFlight.locator('.conversation-flight-symbol').count(),0);
 assert.equal(await noteFlight.evaluate(el=>el.getAnimations().some(a=>a.effect.getTiming().duration===400)),true);
 await page.evaluate(()=>window.noteFlight);
 await page.screenshot({path:'/tmp/conversation-mode-motion.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS: actual App mode switch, loading state, minimal stationary 1400ms skills/collaboration cue, reverse switch, live reduced motion and 400ms note feedback');
}finally{await browser.close();}
