// Synthetic content only. Serve web/ with Vite before running.
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({args: ['--no-sandbox']});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = (process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183') + '/tests/readable-typography.html';
try {
  await page.goto(url);
  await page.locator('.clarification-title').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const sizes = {'.ia-title':20, '.ia-description':16, '.ia-grid-card-title':20, '.ia-grid-card-body':16, '.ia-fact-value':16, '.ia-card-select-btn':14, '.clarification-title':20, '.clarification-question-text':16, '.clarification-option-text':16, '.clarification-context-pill':14, '.clarification-submit-btn':14};
  for (const [selector, expected] of Object.entries(sizes)) {
    assert.equal(await page.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)), expected, selector);
  }
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).zoom), '0.85', 'default scale');
  for (const theme of ['carbon', 'copilotkit']) {
    await page.evaluate(theme => { if (theme === 'carbon') delete document.documentElement.dataset.uiTheme; else document.documentElement.dataset.uiTheme = theme; }, theme);
  for (const selector of ['.ia-header','.clarification-header-row']) {
    const colors = await page.locator(selector).evaluate(el => ({background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderBottomColor}));
    assert.equal(colors.background, 'rgb(255, 255, 255)', `${selector} light surface`);
    assert.equal(colors.border, 'rgb(198, 198, 198)', `${selector} subtle divider`);
  }
  for (const selector of ['.ia-title','.clarification-title']) {
    assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).color), theme === 'carbon' ? 'rgb(22, 22, 22)' : 'rgb(24, 24, 27)', `${selector} readable heading`);
  }
  }
  assert.equal(await page.locator('.ia-grid-card.is-selected').count(), 0, 'catalog has no arbitrary active card');
  assert.equal(await page.locator('.ia-live-pulse').count(), 0, 'idle widget has no live indicator');
  assert.equal(await page.locator('.next-question-suggestions button').first().evaluate(el => getComputedStyle(el).fontSize), '14px');
  assert.equal(await page.locator('.next-question-suggestions button').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  const searchGeometry = await page.locator('.ia-search-input').evaluate(el => ({padding: parseFloat(getComputedStyle(el).paddingLeft), size: parseFloat(getComputedStyle(el).fontSize)}));
  assert(searchGeometry.padding >= searchGeometry.size * 2, 'search reserves space for its icon');
  await page.screenshot({path: '/tmp/carbon-openai-answers.png', fullPage: true});

  for (const width of [1440,768,390,320]) {
    await page.setViewportSize({width,height:1000});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `page overflow at ${width}`);
    assert.equal(await page.locator('.clarification-options-grid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1, `one option column at ${width}`);
    const suggestions = await page.locator('.next-question-suggestions button').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left}; }));
    assert(suggestions[1].top >= suggestions[0].bottom && suggestions[0].left === suggestions[1].left, `stacked suggestions at ${width}`);
    for (const selector of ['.intelligent-answer','.clarification-card']) {
      assert(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${selector} overflow at ${width}`);
    }
  }
  await page.setViewportSize({width:1280,height:1000});
  await page.getByRole('button',{name:'Details',exact:false}).first().click();
  await page.getByRole('tabpanel').waitFor();
  assert.equal(await page.locator('.ia-item-body').evaluate(el => getComputedStyle(el).fontSize), '16px');
  await page.locator('.clarification-custom-tile').click();
  assert.equal(await page.locator('.clarification-custom-textarea').evaluate(el => getComputedStyle(el).fontSize), '16px');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.locator('.ia-item-body').evaluate(el => getComputedStyle(el).fontSize), '32px');
  assert.equal(await page.locator('.clarification-option-text').first().evaluate(el => getComputedStyle(el).fontSize), '32px');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '200% text page overflow');
  assert.deepEqual(errors, []);
  console.log('PASS: computed typography, 85% default scale, four viewport widths, tab/custom-answer text, 200% text resizing');
} finally { await browser.close(); }
