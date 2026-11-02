"""Synthetic business diagrams verify semantic layouts and interactive behavior."""
import asyncio,json,os
from playwright.async_api import async_playwright

def document(spec): return '```bobdiagram\n'+json.dumps(spec)+'\n```'
star={'id':'StrategySynthetic','kind':'flow','title':'Synthetic strategy','direction':'TB','nodes':[{'id':n,'label':n,'shape':'rounded'} for n in ['Goal','People','Process','Technology','Customers']],'edges':[{'id':f'Spoke{i}','source':'Goal','target':n,'label':'Supports','animated':False} for i,n in enumerate(['People','Process','Technology','Customers'])]}
business={'id':'BusinessSynthetic','kind':'flow','title':'Synthetic approval owners','layout':'swimlane','motion':'flow','direction':'LR','lanes':[{'id':'Requester','label':'Synthetic requester','tone':'blue'},{'id':'Reviewer','label':'Synthetic reviewer','tone':'teal'}],'nodes':[{'id':'Prepare','label':'Prepare request','shape':'rounded','lane':'Requester'},{'id':'Approve','label':'Approved?','shape':'diamond','lane':'Reviewer'},{'id':'Proceed','label':'Proceed','shape':'ellipse','lane':'Requester'}],'edges':[{'id':'Submit','source':'Prepare','target':'Approve','label':'Review','animated':True},{'id':'Yes','source':'Approve','target':'Proceed','label':'Yes','animated':True},{'id':'Rework','source':'Approve','target':'Prepare','label':'Revise','animated':True}]}
async def main():
 async with async_playwright() as runtime:
  browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  await page.goto(os.getenv('STRUCTURED_DIAGRAM_FIXTURE_URL','http://127.0.0.1:3005/structured_diagram_fixture.html'))
  await page.wait_for_function('typeof window.setDiagramFixture === "function"')
  await page.evaluate('(text)=>setDiagramFixture(text,false)',document(business))
  await page.locator('.structured-lane[aria-label="Synthetic requester"]').wait_for()
  await page.wait_for_function("document.querySelectorAll('.react-flow__node-diagram').length===3 && document.querySelectorAll('.react-flow__edge').length===3")
  assert await page.locator('.structured-lane').count()==2
  await page.wait_for_timeout(400)
  assert await page.locator('.diagram-moving-particle').count()==3
  await page.screenshot(path='/tmp/synthetic-business-owner-diagram.png',full_page=True)
  await page.get_by_role('button',name='Maximize',exact=True).click()
  dialog=page.get_by_role('dialog',name='Maximized diagram',exact=True)
  await dialog.locator('.structured-lane').first.wait_for()
  assert await dialog.locator('.structured-lane').count()==2
  await dialog.get_by_role('button',name='Restore',exact=True).click()
  await dialog.wait_for(state='detached')
  for algorithm in ('tree','radial','force'):
   spec={**star,'layout':algorithm,'motion':'none'}
   await page.evaluate('(text)=>setDiagramFixture(text,false)',document(spec))
   await page.wait_for_function("document.querySelectorAll('.react-flow__node-diagram').length===5 && document.querySelectorAll('.react-flow__edge').length===4")
   await page.wait_for_timeout(450)
   assert await page.locator('.diagram-moving-particle').count()==0
   assert await page.locator('.structured-node').first.evaluate('el=>getComputedStyle(el).animationName')=='none'
   assert await page.get_by_role('button',name='Pause motion',exact=True).count()==0
   if algorithm=='force':
    await page.get_by_role('button',name='Maximize',exact=True).click()
    await dialog.locator('.react-flow__node-diagram').first.wait_for()
    await page.wait_for_timeout(550)
    node=dialog.locator('.react-flow__node[data-id="Goal"]')
    before=await node.bounding_box()
    await node.evaluate('el=>window.beforeArrangePosition=el.getAttribute("style")')
    await page.mouse.move(before['x']+before['width']/2,before['y']+before['height']/2)
    await page.mouse.down();await page.mouse.move(before['x']+before['width']/2+50,before['y']+before['height']/2+30,steps=10);await page.mouse.up()
    after=await node.bounding_box()
    assert abs(after['x']-before['x'])>25,'Relationship nodes must remain draggable'
    await dialog.get_by_role('button',name='Arrange',exact=True).click()
    await page.wait_for_function("document.querySelector('dialog .react-flow__node[data-id=\"Goal\"]').getAttribute('style')===window.beforeArrangePosition")
    await dialog.get_by_role('button',name='Restore',exact=True).click()
    await dialog.wait_for(state='detached')
  # Role grouping is preserved at phone widths too.
  await page.set_viewport_size({'width':390,'height':900})
  await page.evaluate('(text)=>setDiagramFixture(text,false)',document(business))
  await page.locator('.structured-lane').first.wait_for()
  assert await page.locator('.structured-lane').count()==2
  assert await page.locator('.react-flow__node-diagram').count()==3
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  # Numerical content still uses the existing tables and Carbon chart renderer.
  content='| Category | Amount |\n| --- | --- |\n| Synthetic A | 12 |\n| Synthetic B | 24 |\n\n```bobchart\n'+json.dumps({'type':'bar','title':'Synthetic numeric comparison','labels':['Synthetic A','Synthetic B'],'data':[12,24]})+'\n```'
  await page.evaluate('(text)=>setDiagramFixture(text,false)',content)
  await page.locator('.interactive-chart-card svg').wait_for()
  assert await page.locator('table').count()==1
  assert await page.locator('.structured-diagram').count()==0
  assert not errors,errors
  await browser.close()
  print('PASS: owner groups/branches/rework/motion, tree/radial/force rendering, static relationship semantics, drag/Arrange, maximize, phone owner groups and unchanged numeric charts/tables')
asyncio.run(main())
