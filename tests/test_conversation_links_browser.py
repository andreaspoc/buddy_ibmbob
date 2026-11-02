"""Synthetic browser verifies address-bar IDs, deep links and sharing controls."""
import asyncio,os
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  base=os.getenv('CONVERSATION_LINK_FIXTURE_URL','http://127.0.0.1:3005/tests/background.html')
  await page.goto(base)
  await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
  await page.get_by_role('button',name='Alpha chat',exact=True).click()
  await page.wait_for_function("new URL(location.href).searchParams.get('conversation')==='a'.repeat(32)")
  personal_url=page.url
  await page.locator('.project-select').select_option('project-one')
  await page.get_by_role('button',name='Project chat',exact=True).wait_for()
  await page.wait_for_function("new URL(location.href).searchParams.get('conversation')==='c'.repeat(32)")
  assert await page.evaluate("new URL(location.href).searchParams.get('project')")=='project-one'
  project_url=page.url
  await page.reload()
  await page.get_by_role('button',name='Project chat',exact=True).wait_for()
  assert page.url==project_url
  assert await page.locator('.project-select').input_value()=='project-one'
  await page.evaluate('''() => {
   const transport=window.fetch;
   window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.origin);
    const match=url.pathname.match(/^\\/sessions\\/([^/]+)\\/share$/);
    if(match && init.method==='POST') return new Response(JSON.stringify({url:location.origin+'/shared/'+match[1]+'/'+'t'.repeat(43)}),{headers:{'Content-Type':'application/json'}});
    if(match && init.method==='DELETE') return new Response(null,{status:204});
    return transport(input,init);
   };
   Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
  }''')
  await page.get_by_role('button',name='Export & share',exact=True).click()
  await page.get_by_role('button',name='Create share link',exact=True).click()
  field=page.get_by_role('textbox',name='Read-only link',exact=True)
  await field.wait_for()
  link=await field.input_value()
  assert '/shared/'+'c'*32+'/' in link
  assert await page.get_by_role('link',name='Open shared conversation',exact=True).get_attribute('href')==link
  await page.get_by_role('button',name='Copy link',exact=True).click()
  await page.get_by_role('status').filter(has_text='Link copied.').wait_for()
  await page.get_by_role('button',name='Revoke all links',exact=True).click()
  assert await field.count()==0
  # Opening a copied private URL restores personal scope as well.
  await page.goto(personal_url)
  await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
  assert await page.locator('.project-select').input_value()==''
  assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')")=='a'*32
  await page.get_by_role('button',name='New conversation',exact=True).click()
  assert await page.evaluate("new URL(location.href).searchParams.get('conversation')") is None
  assert not errors,errors
  await browser.close()
  print('PASS: browser address-bar IDs, personal/project deep links, reload, ID-bearing share URL, HTTP clipboard fallback, revoke controls')
asyncio.run(main())
