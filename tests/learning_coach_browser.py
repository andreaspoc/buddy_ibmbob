"""Synthetic browser regression checks against a staged Learning build; API calls are intercepted."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page()
  calls=[]
  deleted=[]
  async def route(r):
   path=r.request.url.split('/api/learning',1)[1].split('?')[0]
   data={'items':[]}
   if path=='/me':data={'username':'synthetic','is_admin':False,'can_create_quizzes':True}
   elif path=='/folders':data={'items':[{'id':'folder1','name':'Synthetic class','can_delete':True,'is_class':True}]}
   elif path.endswith('/contents'):data={'books':[],'quizzes':([] if deleted else [{'id':'draft1','title':'Synthetic draft','is_creator':True,'status':'draft','version':0}])+[{'id':'published1','title':'Synthetic published','is_creator':True,'status':'published','version':1}],'lessons':[]}
   elif path=='/quizzes/draft1' and r.request.method=='DELETE':
    deleted.append(path);data={'deleted':True}
   elif path.endswith('/assistant'):
    calls.append(r.request.post_data_json)
    data={'reply':'## Heading\n\n**Bold** and *italic*\n\n- First\n- Second\n\n```python\nprint(1)\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Link](https://example.com)\n<script>window.coachXss=true</script><img src=x onerror="window.coachXss=true">'}
   await r.fulfill(content_type='application/json',body=json.dumps(data))
  async def spa(r):
   await r.fulfill(content_type='text/html',body=(Path(os.getenv('LEARNING_UI_DIST','/results/dist')) / 'learning.html').read_text())
  await page.route('**/learning/**',spa)
  await page.route('**/api/learning/**',route)
  await page.goto('http://127.0.0.1:5193/learning/folders/folder1?tab=quizzes')
  await page.get_by_role('button',name='Delete draft',exact=True).click()
  await page.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
  assert not deleted
  assert await page.get_by_role('button',name='Delete draft',exact=True).count()==1
  await page.get_by_role('button',name='Delete draft',exact=True).click()
  await page.get_by_role('dialog').get_by_role('button',name='Delete',exact=True).click()
  await page.get_by_role('button',name='Delete draft',exact=True).wait_for(state='detached')
  assert len(deleted)==1
  assert await page.get_by_role('heading',name='Synthetic published',exact=True).count()==1
  await page.get_by_role('button',name='Open Learning Coach chat').click()
  box=page.get_by_role('textbox',name='Message Learning Coach')
  await box.fill('hello')
  await box.press('Shift+Enter')
  assert await box.input_value()=='hello\n' and len(calls)==0
  await box.press('Enter')
  await page.locator('.learning-assistant-markdown table').wait_for()
  assert len(calls)==1 and calls[0]['message']=='hello'
  area=page.locator('.learning-assistant-markdown')
  for selector in ['h2','strong','em','ul','pre','table','a']:
   assert await area.locator(selector).count()>0,selector
  assert not await page.evaluate('Boolean(window.coachXss)')
  assert await area.locator('script,[onerror]').count()==0
  await box.fill('composition')
  await box.dispatch_event('keydown',{'key':'Enter','isComposing':True})
  await box.dispatch_event('keydown',{'key':'Enter','repeat':True})
  assert len(calls)==1
  await page.screenshot(path=os.getenv('LEARNING_UI_SCREENSHOT','/tmp/coach-browser.png'))
  print('PASS: Draft delete cancellation/confirmation and published quiz preservation; Enter sends once; Shift+Enter newline; composition/repeat protected; Markdown headings, emphasis, lists, code, tables, links; HTML sanitized.')
  await browser.close()
asyncio.run(main())
