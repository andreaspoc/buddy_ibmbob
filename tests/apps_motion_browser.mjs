// Synthetic app registry; no services are opened.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/apps.html');
 await page.locator('#install').click();await page.locator('#launch').click();
 const dialog=page.getByRole('dialog');
 await dialog.waitFor();
 assert.equal(await dialog.evaluate(el=>el.getAnimations({subtree:true}).length),0);
 assert.equal(await dialog.locator('.installed-app-card').count(),4);
 await dialog.getByRole('searchbox').fill('Notes');
 assert.equal(await dialog.locator('.installed-app-card').count(),1);
 await dialog.getByRole('button',{name:/Notes/}).click();
 assert.equal(await page.locator('.installed-app-launch-flight').count(),0);
 await page.waitForFunction(()=>document.querySelector('#last').textContent==='notes');
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.locator('#launch').click();
 await dialog.waitFor();
 assert.equal(await dialog.evaluate(el=>el.getAnimations({subtree:true}).length),0);
 await page.keyboard.press('Escape');
 await dialog.waitFor({state:'hidden'});
 assert.equal(await page.locator('#launch').evaluate(e=>e===document.activeElement),true);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.setViewportSize({width:390,height:844});await page.locator('#device').click();
 await page.locator('#launch').click();
 assert.equal(await dialog.evaluate(el=>el.getAnimations().length),0);
 assert.equal(await dialog.getByRole('button',{name:/Office Suite/}).count(),0);
 assert(await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1}));
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log('PASS: Apps opens, launches and closes immediately without animations; search, focus restoration and mobile behavior preserved');
} finally {await browser.close();}
