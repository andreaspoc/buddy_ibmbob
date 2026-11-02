// Synthetic Office bridge and model output only; no real documents or services.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({args: ['--no-sandbox']});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const base = process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
await page.route('**/api/**', route => {
  if (route.request().url().endsWith('/draft')) return route.fulfill({contentType:'application/x-ndjson', body:JSON.stringify({type:'plan',plan:{version:1,kind:'word',reply:'Synthetic assistant reply.',actions:[{type:'replace_document',blocks:[{type:'paragraph',text:'Synthetic preview text.'}]}]}})+'\n'});
  return route.fulfill({json:{items:[]}});
});
async function type(selector, size, line) {
  const actual = await page.locator(selector).first().evaluate(el => {
    const css = getComputedStyle(el);
    return {size:parseFloat(css.fontSize),line:parseFloat(css.lineHeight),font:css.fontFamily};
  });
  assert.equal(actual.size,size,`${selector} size`);
  assert(Math.abs(actual.line-line)<.02,`${selector} line height: ${actual.line}`);
  assert(actual.font.includes('IBM Plex Sans'),`${selector} font`);
}
try {
  for (const extension of ['docx','xlsx','pptx','pdf','html']) {
    await page.goto(`${base}/tests/office-branding.html?extension=${extension}`);
    await page.locator('.office-assistant-title').waitFor();
    await page.evaluate(()=>document.fonts.ready);
    for (const theme of ['carbon','copilotkit']) {
      await page.evaluate(theme=>{document.documentElement.dataset.uiTheme=theme;},theme);
      for (const width of [1440,768,390,320]) {
        await page.setViewportSize({width,height:1000});
        await type('.office-assistant-title',16,22);
        await type('.office-assistant-subtitle',14,20);
        await type('.office-assistant-connection',12,16);
        await type('.office-assistant-intro p',14,20);
        await type('.office-assistant-chips > button',14,20);
        await type('.office-assistant-composer textarea',16,24);
        await type('.office-assistant-composer small',12,16);
        await type('.office-assistant-composer button',14,20);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${extension}/${theme}/${width} page overflow`);
      }
    }
  }
  await page.goto(`${base}/tests/office-branding.html?extension=docx`);
  await page.getByLabel('Instructions for Buddy').fill('Synthetic typography request');
  await page.getByRole('button',{name:'Send to Buddy',exact:true}).click();
  await page.getByText('Synthetic assistant reply.',{exact:true}).waitFor();
  await type('.office-assistant-user',16,24);
  await type('.office-assistant-text .markdown-body',16,24);
  await type('.office-assistant-reply > strong',12,16);
  await type('.office-assistant-preview ul',14,20);
  await type('.office-assistant-actions button',14,20);
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  await type('.office-assistant-text .markdown-body',32,48);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% text page overflow');
  assert.deepEqual(errors,[]);
  console.log('PASS: five Office formats, two themes, four widths, message/preview styles and 200% reading text.');
} finally { await browser.close(); }
