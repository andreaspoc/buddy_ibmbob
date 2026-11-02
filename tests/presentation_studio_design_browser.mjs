// Synthetic studio data validates layout and local controls, without a model call.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const html = '<!doctype html><html><head><title>Synthetic deck</title><style>body{margin:0;background:#ffffff;color:#161616;font:24px Arial}.slide{padding:32px;min-height:500px}</style></head><body><section class="slide"><h1>Synthetic presentation</h1><p>This content exists only for the studio layout test.</p></section></body></html>';
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/artifacts/source')) return route.fulfill({ json: { content: html, sha256: 'synthetic-version' } });
    if (path === '/workspace/page') return route.fulfill({ json: { html } });
    if (path.startsWith('/api/') || path.startsWith('/sessions/') || path.startsWith('/office/')) return route.fulfill({ json: {} });
    return route.continue();
  });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const populated of [false, true]) {
      await page.goto(`${process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183'}/tests/presentation-studio.html${populated ? '?populated' : ''}`);
      await page.getByRole('heading', { name: 'Presentation Studio', exact: true }).waitFor();
      const studio = page.getByRole('complementary', { name: 'Presentation Studio' });
      if (populated) {
        const selector = page.getByRole('combobox', { name: 'Select presentation' });
        await selector.selectOption('synthetic-roadmap.html');
        assert.equal(await selector.inputValue(), 'synthetic-roadmap.html');
        await page.locator('.html-deck-viewer').waitFor();
      } else {
        await page.getByRole('heading', { name: 'Turn an idea into a presentation' }).waitFor();
        assert.match(await studio.innerText(), /Presentation Buddy skill/);
        assert.equal(await page.locator('.studio-empty-steps li').count(), 3);
        assert.ok(await page.locator('.mod-generating-card h3').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 20), 'Readable empty-state heading');
        assert.ok(await page.locator('.mod-generating-card p').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16), 'Readable empty-state body');
      }
      const refresh = page.getByRole('button', { name: 'Refresh presentation', exact: true });
      await refresh.focus();
      assert.equal(await refresh.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      await page.keyboard.press('Enter');
      await page.getByText('Refreshes: 1', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Expand Presentation Studio', exact: true }).click();
      await page.getByRole('button', { name: 'Return beside chat', exact: true }).waitFor();
      const layout = await studio.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll('.mod-panel-header button,.studio-file-toolbar button,.studio-file-toolbar select,.bobdeck-header button')];
        const themeProbe = document.createElement('span');
        themeProbe.style.color = 'var(--cds-text-primary)';
        themeProbe.style.background = 'var(--cds-layer)';
        element.append(themeProbe);
        const theme = { text: getComputedStyle(themeProbe).color, surface: getComputedStyle(themeProbe).backgroundColor };
        themeProbe.remove();
        return {
          theme,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          outside: controls.some(control => { const r = control.getBoundingClientRect(); return r.left < rect.left - 1 || r.right > rect.right + 1; }),
          viewerToolsOverlap: (() => { const header = element.querySelector('.bobdeck-header'); if (!header) return false; const h = header.getBoundingClientRect(); return [...header.querySelectorAll('button')].some(button => button.getBoundingClientRect().bottom > h.bottom + 1); })(),
          background: getComputedStyle(element.querySelector('.mod-panel-header')).backgroundColor,
          title: getComputedStyle(element.querySelector('.mod-panel-title')).color,
        };
      });
      assert.equal(layout.overflow, false, `${width} page overflow`);
      assert.equal(layout.outside, false, `${width} controls outside studio`);
      assert.equal(layout.viewerToolsOverlap, false, `${width} viewer tools overlap slide`);
      assert.equal(layout.background, layout.theme.surface);
      assert.equal(layout.title, layout.theme.text);
      await page.screenshot({ path: `/tmp/presentation-studio-${width}-${populated ? 'deck' : 'empty'}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Close Presentation Studio', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByText('Studio closed', { exact: true }).waitFor();
      console.log('PASS presentation studio', width, populated ? 'deck' : 'empty', layout);
    }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
