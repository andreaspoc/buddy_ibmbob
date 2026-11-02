"""Synthetic browser-only data verifies motion, confirmed actions and live invalidation."""
import asyncio, os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

BASE = os.getenv('MOTION_PREVIEW_URL', 'http://buddy-motion-preview:3901')
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
  for reduced in [False, True]:
   context = await browser.new_context(viewport={'width':1500,'height':1100}, reduced_motion='reduce' if reduced else 'no-preference')
   notes, files, errors = [], [], []
   fail_save = True
   async def route_api(route):
    nonlocal fail_save
    path, method = urlsplit(route.request.url).path, route.request.method
    data = {'items':[]}
    if path.endswith('/chat-capabilities'): data = {'version':1}
    elif path.endswith('/folders'): data = {'items':[]}
    elif path == '/api/office/import-conversation':
     if fail_save:
      fail_save = False
      await route.fulfill(status=503,json={'detail':'Synthetic save failure'}); return
     files.append({'id':'fixture-file','name':'fixture.docx','extension':'docx','size':100,'saved_at':'2026-10-19T12:00:00Z'})
     data = files[-1]
    elif path == '/api/notes/office': data = {'id':'fixture-notes-file'}
    elif path == '/api/notes/from-office': data = {'id':42,'title':'Synthetic snapshot'}
    elif path == '/api/notes': data = {'items':notes,'next_before_id':None}
    elif path == '/api/office/files': data = {'items':files}
    elif path.startswith('/tasks/'): data = {'id':'fixture-task','session_id':'fixture-session','kind':'chat','title':'Synthetic task','status':'completed','progress':'Complete','mode':'agent','created_at':'2026-10-19T12:00:00Z','updated_at':'2026-10-19T12:00:00Z','steps':[],'result':'Synthetic result'}
    await route.fulfill(json=data)
   await context.route('**/api/**',route_api)
   await context.route('**/tasks/**',route_api)
   await context.route('**/people/**',route_api)
   page = await context.new_page()
   page.set_default_timeout(15000)
   page.on('pageerror', lambda error: errors.append(str(error)))
   await page.goto(BASE+'/tests/interface_motion_fixture.html')
   await page.get_by_role('button',name='Copy answer',exact=True).wait_for()
   # Clipboard success must follow resolution, and failures must never say copied.
   await page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.fixtureClipboard=text;}}})")
   await page.get_by_role('button',name='Copy answer',exact=True).click()
   await page.get_by_role('button',name='✓ Copied',exact=True).wait_for()
   assert await page.evaluate('window.fixtureClipboard') == 'Synthetic clipboard content'
   await page.evaluate("() => { navigator.clipboard.writeText=async()=>{throw Error('Synthetic denied clipboard')}; }")
   await page.get_by_role('button',name='✓ Copied',exact=True).click()
   await page.get_by_role('alert').filter(has_text='Could not copy').wait_for()
   print('Verified clipboard; reduced_motion='+str(reduced),flush=True)
   # Entrances are subtle; closing removes content immediately without cloning it.
   await page.get_by_role('button',name='Open motion panel',exact=True).click()
   panel = page.get_by_role('dialog',name='Synthetic panel',exact=True)
   await panel.wait_for()
   if not reduced: await page.wait_for_function("document.querySelector('[aria-label=\"Synthetic panel\"]').getAnimations().length > 0")
   else: assert await panel.evaluate('(el)=>el.getAnimations().length') == 0
   await page.get_by_role('button',name='Close motion panel',exact=True).click()
   assert await page.locator('[data-motion-ghost]').count() == 0
   await page.locator('[data-motion-ghost]').wait_for(state='detached')
   await page.get_by_role('button',name='Apps',exact=True).click()
   await page.locator('dialog.installed-apps[open]').wait_for()
   assert await page.locator('dialog.installed-apps').evaluate('(el)=>el.getAnimations().length') == 0
   await page.locator('dialog.installed-apps').get_by_role('button',name='Close',exact=True).click()
   await page.wait_for_function("!document.querySelector('[data-motion-ghost]')")
   print('Verified panel lifecycle; reduced_motion='+str(reduced),flush=True)
   # Only a successful server response creates a document flight.
   await page.get_by_role('button',name='Save a copy to Office Suite',exact=True).click()
   await page.get_by_role('button',name='Save copy',exact=True).click()
   await page.get_by_role('alert').filter(has_text='Synthetic save failure').wait_for()
   assert await page.locator('.workspace-transfer-flight').count() == 0
   await page.get_by_role('button',name='Save copy',exact=True).click()
   await page.get_by_role('status').filter(has_text='Copy saved to Office Suite.').wait_for()
   if not reduced: await page.locator('.workspace-transfer-flight').wait_for(state='attached')
   await page.locator('.workspace-transfer-flight').wait_for(state='detached')
   await page.get_by_role('button',name='Close',exact=True).click()
   await page.get_by_role('button',name='Copy selected notes to Office',exact=True).click()
   await page.get_by_role('button',name='Save copy',exact=True).click()
   await page.get_by_role('status').filter(has_text='Copy saved to Office Suite.').wait_for()
   await page.wait_for_function("!document.querySelector('.workspace-transfer-flight')")
   await page.get_by_role('button',name='Close',exact=True).click()
   await page.get_by_role('button',name='Save text snapshot to Notes',exact=True).click()
   await page.get_by_role('status').filter(has_text='Note saved.').wait_for()
   await page.wait_for_function("!document.querySelector('.workspace-transfer-flight')")
   print('Verified transfer success/failure; reduced_motion='+str(reduced),flush=True)
   # Open reference pickers refresh on updates from another tab without reopening.
   await page.get_by_role('button',name='Selected notes (0/5)',exact=True).click()
   await page.get_by_role('dialog',name='Select notes',exact=True).wait_for()
   other = await context.new_page()
   await other.goto(BASE+'/tests/interface_motion_fixture.html')
   await page.bring_to_front()
   notes.append({'id':1,'title':'Synthetic cross-tab note','body':'Synthetic','color':'sky'})
   await other.evaluate("window.dispatchEvent(new Event('buddy-notes-changed'))")
   await page.get_by_text('Synthetic cross-tab note',exact=True).wait_for()
   await page.get_by_role('button',name='Done',exact=True).click()
   await page.get_by_role('button',name='Use Office files',exact=True).click()
   files.append({'id':'second-file','name':'Synthetic cross-tab file.docx','extension':'docx','size':100,'saved_at':'2026-10-19T12:00:00Z'})
   await other.evaluate("window.dispatchEvent(new Event('buddy-office-changed'))")
   await page.locator('.office-reference-results label').filter(has_text='Synthetic cross-tab file.docx').wait_for()
   await page.get_by_role('button',name='Done',exact=True).click()
   await page.get_by_role('button',name='office',exact=True).click()
   await page.get_by_role('button',name='fixture.docx',exact=True).wait_for()
   files.append({'id':'third-file','name':'Synthetic live library.docx','extension':'docx','size':100,'saved_at':'2026-10-19T12:00:00Z'})
   await other.evaluate("window.dispatchEvent(new Event('buddy-office-changed'))")
   await page.get_by_role('button',name='Synthetic live library.docx',exact=True).wait_for()
   await page.get_by_role('button',name='Close Office Suite',exact=True).click()
   await other.close()
   print('Verified cross-tab updates; reduced_motion='+str(reduced),flush=True)
   # Task completion highlights only a real transition and exposes its result.
   await page.get_by_role('button',name='tasks',exact=True).click()
   assert await page.locator('[data-just-completed]').count() == 0
   await page.get_by_role('button',name='Finish synthetic task',exact=True).click()
   await page.locator('.task-card[data-just-completed="true"]').wait_for()
   await page.locator('.task-card').click()
   await page.get_by_role('button',name='Open result',exact=True).click()
   assert await page.locator('[data-opened]').inner_text() == 'fixture-session'
   print('Verified task completion; reduced_motion='+str(reduced),flush=True)
   # Upload feedback follows the pending promise rather than a synthetic timer.
   await page.get_by_role('button',name='upload',exact=True).click()
   await page.locator('input[type="file"]').set_input_files({'name':'synthetic.csv','mimeType':'text/csv','buffer':b'name\nfixture'})
   await page.locator('.upload-pending[aria-busy="true"]:not([data-motion-ghost])').wait_for()
   assert await page.locator('.attached-chip:not(.upload-pending)').count() == 0
   await page.evaluate('window.failFixtureUpload()')
   await page.get_by_role('alert').filter(has_text='Synthetic upload failure').wait_for()
   assert await page.locator('.attached-chip:not(.upload-pending)').count() == 0
   await page.locator('input[type="file"]').set_input_files({'name':'synthetic.csv','mimeType':'text/csv','buffer':b'name\nfixture'})
   await page.locator('.upload-pending[aria-busy="true"]:not([data-motion-ghost])').wait_for()
   await page.evaluate('window.finishFixtureUpload()')
   await page.locator('.attached-chip:not(.upload-pending) .upload-complete-mark').wait_for()
   await page.set_viewport_size({'width':390,'height':844})
   assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile overflow'
   assert not errors, errors
   await page.wait_for_function("!document.querySelector('[data-motion-ghost],.workspace-transfer-flight')")
   print('PASS clipboard, transfers/failures, panel lifecycle, cross-tab Notes/Office, task completion and uploads; reduced_motion='+str(reduced),flush=True)
   await context.close()
  await browser.close()
asyncio.run(main())
