"""Standalone README dashboard layout and real controls in Chromium."""
import asyncio,os
from playwright.async_api import async_playwright

async def main():
 async with async_playwright() as runtime:
  browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[];external=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('request',lambda request:external.append(request.url) if request.url.startswith('http') and '127.0.0.1' not in request.url and '127.0.0.1' not in request.url else None)
  await page.goto(os.getenv('README_DASHBOARD_FIXTURE_URL','http://127.0.0.1:3002/@fsartifacts/readme-dashboard.html'))
  await page.get_by_role('heading').first.wait_for()
  assert await page.locator('script[src]').count()==0,'Standalone dashboard requires external script'
  await page.locator('.tab[data-section="documents"]').click()
  assert await page.locator('#documents').is_visible()
  assert await page.locator('#architecture').is_hidden()
  await page.locator('#reset').click()
  await page.locator('#search').fill('no-such-readme-content-xyz')
  assert await page.locator('#empty').is_visible()
  await page.locator('#reset').click()
  await page.locator('[data-component="knowledge"]').click()
  assert 'Docling' in await page.locator('#component-detail').inner_text()
  await page.locator('[data-component="db"]').focus()
  await page.keyboard.press('Enter')
  assert 'PostgreSQL' in await page.locator('#component-detail').inner_text()
  await page.locator('[data-goto="setup"]').click()
  check=page.locator('[data-check="setup-0"]')
  await check.check()
  await page.reload()
  await page.locator('.tab[data-section="setup"]').click()
  assert await check.is_checked(),'Personal checklist did not persist'
  await page.locator('.tab[data-section="commands"]').click()
  await page.locator('.copy').first.click()
  assert await page.locator('#toast').is_visible()
  fallback=page.locator('textarea.copy-fallback')
  if await fallback.count():
   assert await fallback.input_value()
  await page.locator('#readme-source summary').click()
  assert await page.locator('#readme-source').get_attribute('open') is not None
  await page.locator('[data-source-line]').first.click()
  assert await page.locator('.source-highlight').count()==1
  assert await page.locator('[id^="source-line-"]').count()>700
  await page.locator('#readme-source summary').click()
  await page.locator('#reset').click()
  for width in (1280,390,320):
   await page.set_viewport_size({'width':width,'height':900})
   await page.wait_for_timeout(150)
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'Overflow at {width}px'
   await page.screenshot(path=f'/tmp/readme-dashboard-{width}.png',full_page=True)
  assert not errors,errors
  assert not external,external
  await browser.close()
  print('PASS: standalone dashboard desktop/mobile widths, no JavaScript errors or external dependencies')

asyncio.run(main())
