// Real app components with synthetic API responses; no live operational data.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:1280,height:900}});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const base=process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
const motionBase=process.env.MOTION_PREVIEW_URL || 'http://127.0.0.1:3901';
await page.route('**/api/**',route=>route.fulfill({json:route.request().url().includes('/api/projects') ? {projects:[],people:[],assignments:[],dependencies:[],work_items:[]} : {items:[]}}));
await page.route('**/workflows/capabilities',route=>route.fulfill({json:{web_search:false}}));
const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try {
  await page.goto(`${motionBase}/tests/interface_motion_fixture.html`);
  await page.getByRole('button',{name:'Open motion panel',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Synthetic panel',exact:true});
  await panel.waitFor();
  await frame();
  const entrance=await panel.evaluate(el=>el.getAnimations().map(animation=>animation.effect.getTiming()));
  assert(entrance.some(timing=>timing.duration===240),'Carbon surface entrance');
  await page.emulateMedia({reducedMotion:'reduce'});
  await frame();
  assert.equal(await panel.evaluate(el=>el.getAnimations().filter(a=>a.playState==='running').length),0,'live reduced motion finishes entrance');
  await page.getByRole('button',{name:'Close motion panel',exact:true}).click();
  assert.equal(await page.locator('[data-motion-ghost]').count(),0,'no cloned exit content');
  await page.getByRole('button',{name:'Open motion panel',exact:true}).click();
  await frame();
  assert.equal(await panel.evaluate(el=>el.getAnimations().length),0,'reduced-motion entrance');
  await page.getByRole('button',{name:'Close motion panel',exact:true}).click();

  // Every lazy surface and pseudo-element inherits reduced motion. Verify with
  // real Office and Projects styles, including an intentionally active spinner.
  for(const url of ['/tests/office-branding.html','/tests/projects-workspace.html']) {
    await page.goto(base+url); await page.locator('#root > *').waitFor();
    const active=await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length);
    assert.equal(active,0,`${url} reduced-motion animations`);
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto(`${base}/tests/streaming.html`);
  await page.waitForFunction(()=>typeof window.renderAnswer==='function');
  await page.evaluate(async()=>{
    await import('/src/carbonFoundation.scss');
    const {startInterfaceMotion}=await import('/src/lib/interfaceMotion.ts');
    window.stopTestMotion=startInterfaceMotion();
  });
  const result=await page.evaluate(async()=>{
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const base='Intro.\n\n1. First\n2. Second';
    const body=document.querySelector('.markdown-body');
    const intro=body.querySelector('p'),list=body.querySelector('ol');
    window.renderAnswer(base+' item\n3. Third',true);await frame();
    if(body.querySelector('p')!==intro||body.querySelector('ol')!==list)throw Error('Streaming replaced stable nodes');
    const long='Intro.\n\n'+Array.from({length:60},(_,i)=>`${i+1}. Synthetic detail ${i}`).join('\n');
    window.renderAnswer(long,true);await frame();
    const scroller=document.querySelector('.conversation');
    if(scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop>2)throw Error('Not following output');
    window.renderAnswer(long,false);await frame();
    if(body.querySelector('p')!==intro)throw Error('Completion rebuilt content');
    return {stableNodes:true,following:true};
  });
  await page.locator('.conversation').hover();
  await page.mouse.wheel(0,-350); await frame();
  const top=await page.locator('.conversation').evaluate(el=>el.scrollTop);
  await page.evaluate(()=>window.renderAnswer('Intro.\n\n'+Array.from({length:70},(_,i)=>`${i+1}. Synthetic detail ${i}`).join('\n'),true));
  await frame();
  assert(Math.abs(await page.locator('.conversation').evaluate(el=>el.scrollTop)-top)<=2,'reader scroll preserved');
  const input=page.locator('#prompt-input');
  await input.fill('Typing while the answer updates');
  await page.evaluate(()=>window.renderAnswer('Intro.\n\n'+Array.from({length:75},(_,i)=>`${i+1}. Synthetic detail ${i}`).join('\n'),true));
  await frame();
  assert.equal(await input.inputValue(),'Typing while the answer updates','typing preserved');
  assert.deepEqual(await page.locator('.markdown-body').evaluate(el=>el.getAnimations({subtree:true}).filter(animation=>animation.animationName !== 'stream-cursor-blink').map(animation=>animation.animationName || 'surface entrance')),[],'streaming text has no entrance animation');
  assert.deepEqual(errors,[]);
  console.log('PASS: Carbon entrance timing, live reduced motion, immediate close, lazy Office/Projects, stable streaming DOM, reader scrolling and typing.',result);
} finally {await browser.close();}
