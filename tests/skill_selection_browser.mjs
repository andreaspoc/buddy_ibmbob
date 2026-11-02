// Synthetic catalog and submissions; exercises the real ChatView send path.
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/workflows/capabilities',r=>r.fulfill({json:{web_search:false}}));
try {
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/skill-selection.html');
 await page.getByRole('heading',{name:'Choose skills'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Templates',exact:true}).count(),0);
 const input=page.locator('#prompt-input');
 await input.fill('Explain the supplied report');
 const catalog=page.locator('.skill-picker');
 await catalog.getByRole('searchbox').fill('Analysis Buddy');
 await catalog.getByRole('button',{name:/Analysis Buddy/}).click();
 assert.equal(await input.inputValue(),'Explain the supplied report');
 assert.equal(await input.evaluate(el=>el===document.activeElement),true);
 assert.equal(await page.evaluate(()=>window.skillSubmissions?.length || 0),0);
 assert.equal(await page.getByRole('button',{name:'Remove Analysis Buddy',exact:true}).count(),1);
 await input.press('Enter');
 assert.deepEqual(await page.evaluate(()=>window.skillSubmissions),[{prompt:'Explain the supplied report',skill:'analysis-buddy'}]);
 await page.getByRole('button',{name:'Skills',exact:true}).click();
 await catalog.getByRole('searchbox').fill('written');
 assert.equal(await catalog.locator('.skill-picker-card').count(),1);
 await catalog.getByRole('button',{name:/Writing Buddy/}).click();
 await input.fill('Polish this paragraph');await input.press('Enter');
 assert.deepEqual(await page.evaluate(()=>window.skillSubmissions.at(-1).skill),['analysis-buddy','writing-buddy']);
 await page.getByRole('button',{name:'Clear skills',exact:true}).click();
 assert.equal(await page.locator('.composer-skill-summary').count(),0);
 await page.getByRole('combobox',{name:'Select skill'}).selectOption('analysis-buddy');
 await page.getByRole('button',{name:'Switch fixture conversation'}).click();
 assert.equal(await page.locator('.composer-skill-summary').count(),0);
 for(const width of [1440,768,390,320]) {
  await page.setViewportSize({width,height:1000});
  if (!(await catalog.isVisible())) await page.getByRole('button',{name:'Skills',exact:true}).click();
  await catalog.waitFor();
  assert(await catalog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`skill catalog overflow ${width}`);
  await catalog.getByRole('searchbox').fill('no matching skill');
  assert.equal(await catalog.getByText('No matching skills',{exact:true}).count(),1);
  await catalog.getByRole('searchbox').fill('');
  await catalog.getByRole('button',{name:/Presentation Buddy/}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:'Remove Presentation Buddy',exact:true}).count(),1);
  await page.getByRole('button',{name:'Clear skills',exact:true}).click();
 }
 await page.getByRole('button',{name:'Toggle fixture busy'}).click();
 assert(await page.getByRole('combobox',{name:'Select skill'}).isDisabled());
 if (!(await catalog.isVisible())) await page.getByRole('button',{name:'Skills',exact:true}).click();
 assert(await catalog.getByRole('button',{name:/Analysis Buddy/}).isDisabled());
 await page.getByRole('button',{name:'Toggle fixture busy'}).click();
 await page.getByRole('button',{name:'Toggle fixture skills'}).click();
 await catalog.getByText('No skills are available. You can still ask Buddy a question.').waitFor();
 assert.equal(await page.locator('.composer-skill-summary').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: skill cards preserve draft, no auto-send, skill-aware submissions, search, clear, conversation isolation, keyboard, busy/empty states, 4 widths');
} finally {await browser.close();}
