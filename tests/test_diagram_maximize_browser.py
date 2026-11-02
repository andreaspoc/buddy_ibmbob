"""Synthetic long-flow maximize, focus, streaming and mobile regressions."""
import asyncio,json,os
from playwright.async_api import async_playwright

def record(**value): return json.dumps(value)+'\n'
def flow(count=12):
 text='```bobdiagram\n'+record(type='diagram',id='MaximizeSynthetic',kind='flow',title='Synthetic long flow',direction='LR')
 for index in range(count):
  text+=record(type='node',id=f'Step{index}',label=f'Synthetic stage {index+1}',shape='rounded')
  if index: text+=record(type='edge',id=f'Link{index}',source=f'Step{index-1}',target=f'Step{index}')
 return text+'```'

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  await page.goto(os.getenv('STRUCTURED_DIAGRAM_FIXTURE_URL','http://127.0.0.1:3005/structured_diagram_fixture.html'))
  await page.wait_for_function('typeof window.setDiagramFixture === "function"')
  for width in (1280,390):
   await page.set_viewport_size({'width':width,'height':900})
   await page.evaluate('(text)=>setDiagramFixture(text,false)',flow())
   await page.wait_for_function("document.querySelectorAll('main .react-flow__node').length===12")
   await page.wait_for_timeout(500)
   inline=page.locator('main .structured-diagram')
   before=await inline.locator('.structured-flow-scroll').bounding_box()
   await inline.locator('.react-flow__node').first.evaluate('node=>window.originalMaximizeNode=node')
   viewport_before=await inline.locator('.react-flow__viewport').get_attribute('style')
   maximize=inline.get_by_role('button',name='Maximize',exact=True)
   await maximize.click()
   dialog=page.get_by_role('dialog',name='Maximized diagram',exact=True)
   await dialog.wait_for()
   await page.wait_for_function("document.querySelectorAll('dialog .react-flow__node').length===12")
   await page.wait_for_timeout(700)
   bounds=await dialog.bounding_box()
   zoom=await page.evaluate("() => parseFloat(getComputedStyle(document.documentElement).zoom) || 1")
   assert bounds['width']>=(width-40)*zoom-20 and bounds['height']>=(850-50)*zoom-20,bounds
   viewer=dialog.locator('.structured-flow-scroll')
   # The inline graph now grows to its content; the modal stays within the window.
   assert (await viewer.bounding_box())['height']>200
   assert (await viewer.bounding_box())['height']<=bounds['height']+2
   assert not await dialog.locator('.diagram-reading-view').count(),'Maximize must start fitted, not scrolling'
   assert await viewer.evaluate('el=>el.scrollHeight<=el.clientHeight+2 && el.scrollWidth<=el.clientWidth+2')
   assert await dialog.locator('.react-flow__node').evaluate_all('''nodes=>{
    const panel=document.querySelector('dialog .structured-flow-scroll').getBoundingClientRect();
    return nodes.every(n=>{const r=n.getBoundingClientRect();return r.left>=panel.left-5 && r.right<=panel.right+5 && r.top>=panel.top-5 && r.bottom<=panel.bottom+5});
   }'''),'Every stage must be visible in the fitted full-window view'
   # Fitting the modal must not alter the inline graph's DOM or viewport.
   assert await inline.locator('.react-flow__node').first.evaluate('node=>node===window.originalMaximizeNode')
   assert await inline.locator('.react-flow__viewport').get_attribute('style')==viewport_before
   await page.keyboard.press('Escape')
   await dialog.wait_for(state='detached')
   assert await dialog.count()==0
   assert await maximize.evaluate('el=>el===document.activeElement'),'Escape should return focus to Maximize'
   await maximize.click()
   await dialog.wait_for()
   await page.wait_for_timeout(500)
   live_viewport = await dialog.locator('.react-flow__viewport').get_attribute('style')
   await page.evaluate('(text)=>setDiagramFixture(text,true)',flow(13)[:-3])
   await page.wait_for_function("document.querySelectorAll('dialog .react-flow__node').length===13")
   await page.wait_for_timeout(400)
   assert await dialog.locator('.react-flow__viewport').get_attribute('style') == live_viewport, 'Streaming diagram refitted the viewport'
   assert await dialog.get_by_text('Drawing…',exact=True).count()==1
   await dialog.get_by_role('button',name='Return',exact=True).click()
   await dialog.wait_for(state='detached')
   assert await dialog.count()==0
   assert await page.locator('main .react-flow__node').count()==13
  assert not errors,errors
  await browser.close()
  print('PASS: desktop/mobile maximize, fitted whole flow without scroll, inline DOM/viewport preservation, Escape/focus restore, live streaming, Return control')
asyncio.run(main())
