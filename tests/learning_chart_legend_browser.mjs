/** Real Carbon charts with synthetic data; no server or learner records required. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { durationSlow02 } = require('@carbon/motion');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ reducedMotion: 'no-preference' });
  await page.setContent('<div id="chart" style="width:640px;height:360px"></div>');
  await page.addStyleTag({ path: fileURLToPath(new URL('../app/static/carbon-charts.css', import.meta.url)) });
  await page.addScriptTag({ path: fileURLToPath(new URL('../app/static/carbon-charts.bundle.js', import.meta.url)) });
  await page.evaluate(() => {
    window.handle = window.BuddyCarbonCharts.create(document.getElementById('chart'), {
      type: 'donut', data: [{ group: 'A', value: 2 }, { group: 'B', value: 3 }],
      options: { height: '360px', animations: true, toolbar: { enabled: false } },
    });
  });
  const settle = () => page.evaluate(async () => {
    await Promise.all(Object.values(window.handle.chart.services.transitions.getPendingTransitions()).map(t => t.end().catch(() => {})));
    await Promise.all(document.getElementById('chart').getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  });
  await settle();
  const group = name => page.locator('.legend-item').filter({ hasText: new RegExp(`^${name}$`) });
  await group('A').click();
  const exits = await page.locator('[data-buddy-exiting-mark]').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().map(animation => animation.effect.getTiming().duration)));
  assert.ok(exits.length, 'Disabling a legend group fades its exiting marks');
  assert.ok(exits.every(value => value === parseFloat(durationSlow02)), 'Exit timing matches shared chart updates');
  await settle();
  assert.equal(await page.locator('path.slice').count(), 1);
  assert.equal(await page.locator('[data-buddy-exiting-mark]').count(), 0);
  await group('B').locator('.checkbox').focus();
  await page.keyboard.press('Space');
  const entering = await page.evaluate(() => Object.values(window.handle.chart.services.transitions.getPendingTransitions()).map(t => t.duration()));
  assert.ok(entering.length && entering.every(value => value === parseFloat(durationSlow02)), 'Re-enabling a legend group uses shared native transitions');
  await settle();
  assert.equal(await page.locator('path.slice').count(), 2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await group('A').click();
  assert.equal(await page.locator('[data-buddy-exiting-mark]').count(), 0);
  const reduced = await page.evaluate(() => Object.values(window.handle.chart.services.transitions.getPendingTransitions()).map(t => t.duration()));
  assert.ok(reduced.every(value => value === 0));
  await page.evaluate(() => window.handle.dispose());
  assert.equal(await page.locator('[data-buddy-exiting-mark]').count(), 0);
  console.log('PASS: pointer hide, keyboard restore, common timing, exit cleanup, reduced motion');
} finally { await browser.close(); }
