// Synthetic catalog; exercises the real composer without model requests.
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
await page.route('**/workflows/capabilities',r=>r.fulfill({json:{web_search:false}}));
try {
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183') + '/tests/skill-selection.html');
 const catalog=page.locator('.skill-picker');
 await catalog.getByRole('heading',{name:'Choose skills',exact:true}).waitFor();
 const input=page.locator('#prompt-input');
 await input.fill('Combine the selected instructions');
 const cards=catalog.locator('.skill-picker-card');
 assert.equal(await cards.count(),7);
 for(let i=0;i<6;i++) await cards.nth(i).click();
 assert.equal(await catalog.locator('[aria-pressed="true"].skill-picker-card').count(),6);
 assert(await cards.nth(6).isDisabled());
 assert.equal(await input.inputValue(),'Combine the selected instructions');
 assert.equal(await page.evaluate(()=>window.skillSubmissions?.length || 0),0);
 await cards.nth(0).click();
 assert.equal(await cards.nth(6).isDisabled(),false);
 await cards.nth(6).click();
 await input.press('Enter');
 const sent=await page.evaluate(()=>window.skillSubmissions.at(-1));
 assert.equal(sent.skill.length,6); assert.equal(new Set(sent.skill).size,6);
 assert.equal(sent.prompt,'Combine the selected instructions');
 await page.getByRole('button',{name:'Clear skills',exact:true}).click();
 assert.equal(await page.locator('.composer-skill-summary').count(),0);
 await page.getByRole('button',{name:'Skills',exact:true}).click();
 await cards.nth(0).click();
 for(const width of [1440,768,390,320]) {
  await page.setViewportSize({width,height:1000});
  assert(await catalog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`catalog overflow at ${width}`);
 }
 await page.getByRole('button',{name:'Switch fixture conversation'}).click();
 assert.equal(await page.locator('.composer-skill-summary').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: six-skill limit, deselection, draft preservation, no auto-send, multi-skill submission, clear, session isolation, four widths');
} finally {await browser.close();}
