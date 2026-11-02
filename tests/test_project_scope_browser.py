"""Synthetic transport verifies project switching cannot restore a stale scope."""
import asyncio, os
from playwright.async_api import async_playwright

async def main():
 async with async_playwright() as runtime:
  browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  await page.goto(os.getenv('PROJECT_SCOPE_FIXTURE_URL','http://127.0.0.1:3005/tests/background.html'))
  await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
  await page.get_by_role('button',name='Alpha chat',exact=True).click()
  await page.evaluate('''() => {
   const transport=window.fetch;
   window.pendingScopes=[];
   window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.origin);
    if(url.pathname==='/sessions' && url.searchParams.get('project_id')==='project-one' && (!init.method || init.method==='GET')) {
     const response=await transport(input,init);
     return new Promise(resolve=>pendingScopes.push(()=>resolve(response)));
    }
    return transport(input,init);
   };
  }''')
  await page.locator('.project-select').select_option('project-one')
  await page.wait_for_function('pendingScopes.length===1')
  assert await page.get_by_role('button',name='Alpha chat',exact=True).count()==0
  assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')") in ('',None)
  # Return to personal before the project list finishes loading.
  await page.locator('.project-select').select_option('')
  await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
  await page.evaluate('pendingScopes.shift()()')
  await page.wait_for_timeout(200)
  assert await page.locator('.project-select').input_value()==''
  assert await page.get_by_role('button',name='Project chat',exact=True).count()==0
  assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')")=='a'*32
  # Leaving and returning to the same project must invalidate its first request.
  await page.locator('.project-select').select_option('project-one')
  await page.wait_for_function('pendingScopes.length===1')
  await page.locator('.project-select').select_option('')
  await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
  await page.locator('.project-select').select_option('project-one')
  await page.wait_for_function('pendingScopes.length===2')
  await page.evaluate('pendingScopes.shift()()')
  await page.wait_for_timeout(200)
  assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')") in ('',None)
  await page.evaluate('pendingScopes.shift()()')
  await page.get_by_role('button',name='Project chat',exact=True).wait_for()
  await page.wait_for_function("sessionStorage.getItem('buddy-active-session:testuser')==='c'.repeat(32)")
  assert await page.get_by_role('button',name='Alpha chat',exact=True).count()==0
  # A delayed project chat creation must not take over personal conversations.
  await page.get_by_role('button',name='New conversation',exact=True).click()
  await page.evaluate('''() => {
   const transport=window.fetch;
   window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.origin);
    if(url.pathname==='/sessions' && init.method==='POST') {
     window.creatingProject=url.searchParams.get('project_id');
     return new Promise(resolve=>window.finishCreation=()=>resolve(new Response(JSON.stringify({id:'d'.repeat(32),project_id:'project-one',title:'Delayed project chat'}),{headers:{'Content-Type':'application/json'}})));
    }
    return transport(input,init);
   };
  }''')
  await page.get_by_role('textbox',name='Message',exact=True).fill('A project-only question')
  await page.get_by_role('textbox',name='Message',exact=True).press('Enter')
  await page.wait_for_function('typeof finishCreation === "function"')
  assert await page.evaluate('creatingProject')=='project-one'
  await page.locator('.project-select').select_option('')
  await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
  await page.evaluate('finishCreation()')
  await page.wait_for_timeout(200)
  assert await page.evaluate('testState.requests.length')==0
  assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')")=='a'*32
  await page.get_by_role('textbox',name='Message',exact=True).fill('An unrelated personal question')
  await page.get_by_role('textbox',name='Message',exact=True).press('Enter')
  await page.wait_for_function('testState.requests.length===1')
  assert await page.evaluate('testState.requests[0].sessionId')=='a'*32
  assert not errors,errors
  await browser.close()
  print('PASS: immediate scope clearing, stale project list rejection, repeated project switch isolation, personal request workspace')

asyncio.run(main())
