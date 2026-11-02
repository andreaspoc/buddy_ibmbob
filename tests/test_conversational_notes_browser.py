"""Synthetic server events verify conversational save feedback; no model or real notes."""
import asyncio,json,os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
SESSION='a'*32
DRAFTS=[{'title':f'Synthetic draft {i}','body':f'Preserved draft {i} with [source](https://example.com/{i}).','color':color} for i,color in [(1,'sky'),(2,'mint'),(3,'rose')]]
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for reduced in [False,True]:
   page=await browser.new_page(viewport={'width':390 if reduced else 1440,'height':1000},reduced_motion='reduce' if reduced else 'no-preference')
   errors=[];saved=[];writes=[];manual_failures=1
   page.on('pageerror',lambda error:errors.append(str(error)))
   await page.add_init_script("""(()=>{sessionStorage.setItem('buddy-active-session:note-selection-fixture','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const original=window.fetch;window.fetch=(input,options={})=>input==='/chat/stream'?Promise.resolve(new Response(new ReadableStream({start(controller){window.noteRequest=JSON.parse(options.body);window.emitNoteEvent=event=>controller.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\\n'));window.finishNoteStream=()=>controller.close();}}),{headers:{'Content-Type':'application/x-ndjson'}})):original(input,options);})();""")
   async def respond(route):
    nonlocal manual_failures
    path=urlsplit(route.request.url).path
    if path=='/' or path.startswith('/assets/'):
     build=os.getenv('NOTES_PREVIEW_BUILD')
     if build: await route.fulfill(path=str(Path(build)/('index.html' if path=='/' else path.lstrip('/'))))
     else: await route.continue_()
     return
    if path.startswith('/static/') or path.endswith(('.svg','.png','.ico')):await route.continue_();return
    data=[]
    if path=='/auth/status':data={'user':{'username':'note-selection-fixture','is_admin':False}}
    elif path=='/personalization/tutorials':data={'disabled':True}
    elif path=='/sessions':data=[{'id':SESSION,'title':'Synthetic note selection','updated_at':1}]
    elif path==f'/sessions/{SESSION}/history':data=[{'type':'request','prompt':'Draft three notes','mode':'agent'},{'type':'delta','text':'```bobnotes\n'+json.dumps({'notes':DRAFTS})+'\n```\nWhich notes would you like me to save, and to which collection?'},{'type':'done'}]
    elif path=='/api/notes':
     if route.request.method=='POST':
      value=route.request.post_data_json;writes.append(value)
      if manual_failures:
       manual_failures-=1;await route.fulfill(status=503,json={'detail':'Synthetic save failure'});return
      value.update(id=55,collection='Synthetic default collection');saved.append(value)
      await route.fulfill(status=201,json=value);return
     data={'items':saved,'next_before_id':None,'default_collection':'Synthetic default collection'}
    elif path.endswith('/capabilities'):data={'web_search':False}
    elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
    await route.fulfill(json=data)
   await page.route('**/*',respond)
   await page.goto(os.getenv('NOTES_PREVIEW_URL','http://127.0.0.1:8080')+'/?conversation='+SESSION)
   await page.locator('.sticky-note[data-note-title]').nth(2).wait_for()
   assert not writes and not saved,'Generating drafts must not save notes'
   prompt=page.locator('#prompt-input');await prompt.fill('Save notes 1 and 3 to Project Alpha');await prompt.press('Enter')
   await page.wait_for_function('typeof window.emitNoteEvent==="function"')
   assert 'Save notes 1 and 3 to Project Alpha' in await page.evaluate('window.noteRequest.prompt')
   # Put the original drafts above the viewport. Saving should find them and
   # scroll there, rather than inventing a substitute card near the composer.
   await page.locator('[data-sticky-notes]').evaluate('el=>el.style.marginBottom="1800px"')
   await page.locator('#prompt-input').scroll_into_view_if_needed()
   for index in [0,2]:
    note={**DRAFTS[index],'id':41+index,'collection':'Project Alpha','source_session_id':SESSION,'source_message_id':'later-confirmed-save','source_note_index':index}
    # A failed tool does not produce notes_changed, a write, or a flight.
    if index==0:
     await page.evaluate("emitNoteEvent({type:'tool',id:'failed-save',name:'notes_create',status:'failed'})")
     assert await page.locator('.sticky-note-flight').count()==0
    # Normalization by the server must not cause the original card to return.
    note['body'] += '\n'
    saved.append(note)
    event={'type':'app_action','action':'notes_changed','note_id':note['id'],'note_title':note['title'],'note_color':note['color'],'note_collection':note['collection']}
    await page.evaluate('(event)=>emitNoteEvent(event)',event)
    if not reduced:
     await page.locator('.sticky-note-flight .sticky-note-plane').wait_for(state='attached')
     card=page.locator('[data-sticky-notes] .sticky-note[data-note-title="'+note['title']+'"]')
     assert await card.evaluate('el=>el.getBoundingClientRect().bottom>0 && el.getBoundingClientRect().top<innerHeight'), 'Original note must scroll into view before flying'
     await page.locator('.sticky-note-flight').wait_for(state='detached')
    await page.locator(f'.sticky-note[data-note-title="{note["title"]}"]').wait_for(state='detached')
    await page.evaluate('(event)=>emitNoteEvent(event)',event)
    assert await page.locator('.sticky-note-flight').count()==0,'Replayed save events must not fly again'
   assert await page.locator('.sticky-note[data-note-title]').count()==1
   assert await page.locator('.sticky-note[data-note-title]').get_attribute('data-note-title')=='Synthetic draft 2'
   assert not writes,'Server-confirmed saves must not trigger another client POST'
   await page.evaluate("emitNoteEvent({type:'delta',text:'Saved the selected drafts to Project Alpha.'});emitNoteEvent({type:'done'});finishNoteStream()")
   await page.reload()
   await page.wait_for_function('document.querySelectorAll("[data-sticky-notes] .sticky-note[data-note-title]").length===1')
   # Manual saves still fold into a plane only after persistence succeeds.
   remaining=page.locator('.sticky-note[data-note-title="Synthetic draft 2"]')
   await remaining.get_by_role('button',name='Save to Notes',exact=True).click()
   await remaining.locator('[role="alert"]').wait_for()
   assert await page.locator('.sticky-note-flight').count()==0
   await remaining.get_by_role('button',name='Save to Notes',exact=True).click()
   if not reduced:
    await page.locator('.sticky-note-flight').wait_for(state='attached')
    await page.locator('.sticky-note-flight').wait_for(state='detached')
   await page.locator('[data-notes-moved]').wait_for()
   assert saved[-1]['title']=='Synthetic draft 2'
   # A completed save must reconcile drafts even if its app_action notification
   # was missed by the transport. All data remains browser-only synthetic data.
   saved.clear()
   await page.reload()
   await page.locator('.sticky-note[data-note-title]').nth(2).wait_for()
   await page.locator('#prompt-input').fill('Send all notes to my personal notes')
   await page.locator('#prompt-input').press('Enter')
   await page.wait_for_function('typeof window.emitNoteEvent==="function"')
   saved.extend([{**draft,'id':100+index,'collection':'Personal Notes','source_session_id':SESSION,
                 'source_message_id':'bulk-save-turn','source_note_index':index} for index,draft in enumerate(DRAFTS)])
   await page.evaluate("emitNoteEvent({type:'delta',text:'Saved all notes to Personal Notes.'});emitNoteEvent({type:'done'});finishNoteStream()")
   await page.locator('[data-notes-moved]').wait_for()
   assert await page.locator('.sticky-note[data-note-title]').count()==0
   assert not errors,errors
   assert await page.locator('.error-boundary-card').count()==0
   print('PASS selected drafts fly after confirmation, remaining draft stays, duplicate events ignored; reduced motion='+str(reduced),flush=True)
   await page.close()
  await browser.close()
asyncio.run(main())
