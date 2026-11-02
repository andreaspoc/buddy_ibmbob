/** Standalone integration checks against the bundled, real Carbon Charts library. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<section id="screen"><div id="chart" style="height:360px;width:100%"></div></section>')
  await page.addStyleTag({ path: path.join(root, 'app/static/carbon-charts.css') })
  await page.addScriptTag({ path: path.join(root, 'app/static/carbon-charts.bundle.js') })
  await page.evaluate(() => {
    window.BobPreviewLive = true
    window.replays = 0
    document.addEventListener('buddy:chart-replayed', () => window.replays++)
    window.handle = BuddyCarbonCharts.create(document.querySelector('#chart'), {
      type: 'grouped-bar',
      data: [{ group: 'Alpha', key: 'One', value: 3 }, { group: 'Beta', key: 'One', value: 7 }],
      options: { axes: { left: { mapsTo: 'value' }, bottom: { mapsTo: 'key', scaleType: 'labels' } } },
    })
    window.originalChart = window.handle.chart
  })
  await page.waitForTimeout(800)
  assert.equal(await page.locator('.bar').count(), 2)
  assert.equal(await page.evaluate(() => handle.chart.model.getOptions().animations), false)
  assert.equal(await page.evaluate(() => replays), 0)
  await page.evaluate(() => { window.BobPreviewLive = false; BuddyCarbonCharts.replayVisible() })
  assert.equal(await page.evaluate(() => handle.chart.model.getOptions().animations), true)
  assert.equal(await page.evaluate(() => handle.chart.model.getOptions().color.scale.Alpha), '#0f62fe')
  assert.equal(await page.evaluate(() => handle.chart.model.getOptions().color.scale.Beta), '#6929c4')
  await page.evaluate(() => {
    const other = document.createElement('div')
    other.id = 'other-chart'
    document.body.append(other)
    window.otherHandle = BuddyCarbonCharts.create(other, {
      type: 'bar',
      data: [{ group: 'Beta', key: 'Two', value: 2 }, { group: 'Alpha', key: 'Two', value: 4 }],
      options: { axes: { left: { mapsTo: 'value' }, bottom: { mapsTo: 'key', scaleType: 'labels' } } },
    })
  })
  assert.deepEqual(await page.evaluate(() => otherHandle.chart.model.getOptions().color.scale), await page.evaluate(() => handle.chart.model.getOptions().color.scale))
  await page.evaluate(() => otherHandle.update({ data: [{ group: 'Gamma', key: 'Two', value: 6 }, { group: 'Beta', key: 'Two', value: 8 }] }))
  assert.equal(await page.evaluate(() => otherHandle.chart.model.getOptions().color.scale.Beta), '#6929c4')
  assert.equal(await page.evaluate(() => otherHandle.chart.model.getOptions().color.scale.Gamma), '#1192e8')
  await page.evaluate(() => otherHandle.update({ options: { color: { scale: { Beta: '#009d9a' } } } }))
  assert.equal(await page.evaluate(() => otherHandle.chart.model.getOptions().color.scale.Beta), '#009d9a')
  await page.evaluate(() => { otherHandle.dispose(); document.querySelector('#other-chart')?.remove() })
  // Actual Carbon legend selection and model data updates remain on the same chart instance.
  await page.locator('.legend-item').first().click()
  const selected = await page.evaluate(() => [...handle.chart.model.getOptions().data.selectedGroups])
  assert.ok(selected.length > 0)
  await page.evaluate(() => handle.update({ data: [{ group: 'Alpha', key: 'One', value: 5 }, { group: 'Beta', key: 'One', value: 9 }] }))
  await page.waitForTimeout(750)
  assert.equal(await page.evaluate(() => handle.chart === originalChart), true)
  assert.deepEqual(await page.evaluate(() => handle.chart.model.getOptions().data.selectedGroups), selected)
  const before = await page.evaluate(() => replays)
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => document.querySelector('#screen').hidden = true)
    await page.waitForTimeout(40)
    await page.evaluate(() => document.querySelector('#screen').hidden = false)
    await page.waitForTimeout(80)
  }
  assert.ok(await page.evaluate(() => replays) >= before + 2)
  assert.deepEqual(await page.evaluate(() => handle.chart.model.getOptions().data.selectedGroups), selected)
  await page.evaluate(() => BuddyCarbonCharts.replayVisible())
  await page.waitForTimeout(30)
  assert.ok(await page.locator('.bar').first().evaluate(el => el.getAnimations().length) > 0)
  assert(await page.locator('.bar').first().evaluate(el => el.getAnimations().every(animation => animation.effect.getTiming().duration === 1400)), 'slower chart replay matches shared UI pacing')
  await page.setViewportSize({ width: 390, height: 700 })
  await page.waitForTimeout(300)
  assert.ok(await page.locator('#chart').evaluate(el => el.getBoundingClientRect().width) < 390)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => handle.replay())
  await page.waitForTimeout(30)
  assert.equal(await page.evaluate(() => handle.chart.model.getOptions().animations), false)
  assert.equal(await page.locator('.bar').first().evaluate(el => el.getAnimations().length), 0)
  await page.evaluate(() => handle.dispose())
  assert.equal(await page.locator('#chart svg').count(), 0)
  assert.equal(await page.locator('#chart').count(), 1)
  await page.evaluate(() => {
    const replacement = BuddyCarbonCharts.create(document.querySelector('#chart'), {
      type: 'bar', data: [{ group: 'Alpha', key: 'One', value: 4 }],
      options: { axes: { left: { mapsTo: 'value' }, bottom: { mapsTo: 'key', scaleType: 'labels' } } },
    })
    replacement.dispose()
  })
  assert.equal(await page.locator('#chart').count(), 1)
  assert.deepEqual(errors, [])
  console.log('Carbon integration passed: actual rendering, preview-live motion, stable group palette and overrides, legend state, updates, repeated activation, responsive layout, reduced motion, disposal.')
} finally { await browser.close() }
