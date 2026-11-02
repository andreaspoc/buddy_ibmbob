"""Shared link sign-in, normal chat rendering and read-only isolation; synthetic data."""
import asyncio,os
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  fixture=os.getenv('SHARED_UI_FIXTURE_URL','http://127.0.0.1:3005/tests/shared-conversation.html')
  await page.goto(fixture)
  await page.get_by_text('Sign in to your account to view this shared conversation.',exact=True).wait_for()
  assert await page.locator('.shared-conversation-view').count()==0
  assert await page.evaluate("sharedTest.requests.filter(p=>p.startsWith('/api/shared/')).length") == 0
  sso=await page.locator('#auth-keycloak').get_attribute('href')
  assert 'next=%2Fshared%2F' in sso
  await page.get_by_label('Username',exact=True).fill('synthetic-reader')
  await page.get_by_label('Password',exact=True).fill('synthetic-password')
  await page.get_by_role('button',name='Sign In',exact=True).click()
  await page.get_by_role('heading',name='Synthetic shared conversation',exact=True).wait_for()
  await page.locator('.structured-node[aria-label="Synthetic first step"]').wait_for()
  assert await page.locator('.shell .sidebar').count()==1
  assert await page.locator('.message.user').count()==1
  assert await page.locator('.message.assistant').count()==1
  assert await page.locator('.markdown-body strong').get_by_text('Important test text',exact=True).count()==1
  assert await page.locator('.markdown-body table').count()==1
  assert await page.locator('.react-flow__node').count()==2
  assert await page.locator('.composer-wrap').count()==0
  assert await page.locator('.structured-diagram').get_by_role('button',name='Save',exact=True).count()==0
  assert await page.get_by_text('Private file',exact=True).get_attribute('href') is None
  assert await page.locator('.markdown-body img[src]').count()==0
  assert not await page.evaluate('Boolean(window.sharedXss)')
  assert await page.evaluate("sharedTest.requests.filter(p=>p.startsWith('/sessions/'+'a'.repeat(32))).length") == 0
  assert '/shared/'+'a'*32+'/' in page.url
  await page.get_by_role('button',name='Back to my conversations',exact=True).click()
  assert '/shared/' not in page.url
  await page.get_by_role('textbox',name='Message',exact=True).wait_for()
  # A revoked snapshot shows an error in the signed-in UI, never a composer.
  await page.goto(fixture)
  await page.get_by_label('Username',exact=True).fill('synthetic-reader')
  await page.get_by_label('Password',exact=True).fill('synthetic-password')
  await page.evaluate('sharedTest.revoked=true')
  await page.get_by_role('button',name='Sign In',exact=True).click()
  await page.get_by_role('alert').get_by_text('This share link is unavailable or has been revoked.',exact=True).wait_for()
  assert await page.locator('.composer-wrap').count()==0
  assert not errors,errors
  await browser.close()
  print('PASS: account gate, sign-in return URL, normal chat bubbles/Markdown/table/flow, read-only controls, private file isolation, revoked-link state')
asyncio.run(main())
