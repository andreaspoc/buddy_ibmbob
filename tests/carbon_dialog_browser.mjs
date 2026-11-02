// Checks the real AppDialog against synthetic requests, without a backend.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(`${process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177'}/tests/carbon-dialog.html`);
  await page.getByRole('button', { name: 'Queue confirmations', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm action', exact: true });
  await dialog.getByText('First synthetic confirmation', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await dialog.getByText('Second synthetic confirmation', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Confirmation results').textContent(), '[false,true]');

  await page.getByRole('button', { name: 'Show notice', exact: true }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Synthetic temporary notice' });
  await notice.waitFor();
  await notice.hover();
  await page.clock.fastForward(9000);
  assert.equal(await notice.isVisible(), true);
  await page.getByRole('button', { name: 'Show notice', exact: true }).hover();
  await page.clock.fastForward(9000);
  await notice.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Open host dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Show persistent error', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Synthetic persistent error' });
  await error.waitFor();
  await page.clock.fastForward(60000);
  assert.equal(await error.isVisible(), true);
  await error.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await error.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('PASS confirmation queue, Cancel focus, Escape, notification pause/resume, and persistent errors above a native modal');
} finally {
  await browser.close();
}
