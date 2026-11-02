"""Synthetic browser fixture: persistence requests are intercepted, not real notes."""
import asyncio, json, os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280,'height':1000})
        saved=[]
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        async def route_api(route):
            request=route.request
            if request.url.endswith(('/versions','/attachments')):
                await route.fulfill(json={'items':[]});return
            if request.method=='POST':
                value=json.loads(request.post_data)
                value.setdefault('collection','2026-10-15')
                value.update(id=len(saved)+1,created_at='2026-10-15T10:00:00Z')
                saved.append(value)
                await route.fulfill(status=201,json=value)
            elif request.method=='PATCH':
                note=next(note for note in saved if str(note['id'])==request.url.rsplit('/',1)[-1])
                note.update(json.loads(request.post_data))
                await route.fulfill(json=note)
            elif request.method=='DELETE':
                saved[:]=[note for note in saved if str(note['id'])!=request.url.rsplit('/',1)[-1]]
                await route.fulfill(status=204)
            else:
                await route.fulfill(json={'items':saved,'next_before_id':None,'default_collection':'2026-10-15'})
        await page.route('**/api/notes',route_api)
        await page.route('**/api/notes/*',route_api)
        await page.route('**/api/notes/workspace',lambda route: route.fulfill(status=201,json={'id':'a'*32}))
        revision={'title':'Review the proposal','body':'**Enriched** synthetic note with a [source](https://example.com).'}
        async def revision_stream(route):
            payload=json.loads(route.request.post_data)
            assert payload['ui_language'] in ('en','el','hi','mt'), payload['ui_language']
            assert payload['workspace_id']=='a'*32
            assert 'SOURCE NOTE' in payload['prompt']
            await route.fulfill(content_type='application/x-ndjson',headers={'X-Bob-Job-Id':'fixture-note-job'},body=json.dumps({'type':'delta','text':json.dumps(revision)})+'\n'+json.dumps({'type':'done'})+'\n')
        await page.route('**/chat/stream',revision_stream)
        base=os.getenv('NOTES_FIXTURE_URL','http://127.0.0.1:3002/sticky_notes_fixture.html')
        await page.goto(base)
        await page.get_by_role('button',name='Save to Notes',exact=True).first.click()
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for(state='hidden')
        assert len(saved)==1 and saved[0]['collection']=='2026-10-15'
        await page.reload()
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for(state='hidden')
        assert len(saved)==1
        await page.goto(base+'?board')
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for()
        await page.get_by_role('searchbox').fill('missing note')
        await page.get_by_role('heading',name='No matching notes').wait_for()
        await page.get_by_role('searchbox').fill('')
        await page.get_by_role('button',name='View full note').click()
        await page.get_by_role('button',name='Edit note: Review the proposal',exact=True).click()
        await page.get_by_label('Collection',exact=True).fill('Research')
        await page.get_by_label('Note content',exact=True).fill('**Updated** research note with [source](https://example.com).')
        await page.get_by_role('tab',name='Preview',exact=True).click()
        await page.locator('.notes-editor-preview strong').get_by_text('Updated',exact=True).wait_for()
        await page.get_by_role('button',name='mint paper',exact=True).click()
        await page.get_by_role('button',name='Save note',exact=True).click()
        await page.locator('[data-note-editor]').wait_for(state='hidden')
        assert saved[0]['collection']=='Research' and saved[0]['color']=='mint'
        original_body=saved[0]['body']
        await page.get_by_role('button',name='Enrich note: Review the proposal',exact=True).click()
        await page.get_by_role('button',name='Add examples',exact=True).click()
        await page.get_by_role('button',name='Ask Bob for a revision').click()
        await page.locator('[data-note-revision]').wait_for()
        assert saved[0]['body']==original_body, 'Suggestions must not overwrite saved notes'
        await page.get_by_role('button',name='Use this revision',exact=True).click()
        assert saved[0]['body']==original_body, 'Applying to draft must still await Save'
        await page.get_by_role('button',name='Save note',exact=True).click()
        await page.locator('[data-note-editor]').wait_for(state='hidden')
        assert saved[0]['body']==revision['body']
        await page.get_by_role('button',name='Enrich note: Review the proposal',exact=True).click()
        await page.get_by_role('button',name='Ask Bob for a revision').click()
        await page.locator('[data-note-revision]').wait_for()
        await page.get_by_role('button',name='Discard suggestion',exact=True).click()
        await page.locator('[data-note-revision]').wait_for(state='hidden')
        await page.get_by_role('button',name='Cancel',exact=True).click()
        assert saved[0]['body']==revision['body']
        await page.reload()
        await page.get_by_role('button',name='▱ Research 1',exact=True).click()
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for()
        await page.get_by_role('button',name='New note').click()
        await page.get_by_label('Title',exact=True).fill('A fresh idea')
        await page.get_by_label('Note content',exact=True).fill('A manually created note.')
        await page.get_by_role('button',name='Save note',exact=True).click()
        await page.locator('[data-note-editor]').wait_for(state='hidden')
        assert len(saved)==2 and saved[1]['collection']=='Research'
        # Global search finds content in another collection and by date.
        saved[1]['collection']='2026-10-14'
        await page.reload()
        await page.get_by_role('button',name='▱ Research 1',exact=True).click()
        assert await page.get_by_role('heading',name='A fresh idea',exact=True).count()==0
        await page.get_by_role('searchbox').fill('fresh')
        await page.get_by_role('heading',name='A fresh idea',exact=True).wait_for()
        await page.get_by_role('heading',name='Search all notes',exact=True).wait_for()
        await page.get_by_role('searchbox').fill('2026-10-14')
        await page.get_by_role('heading',name='A fresh idea',exact=True).wait_for()
        assert await page.get_by_role('heading',name='Review the proposal',exact=True).count()==0
        await page.get_by_role('searchbox').fill('Research')
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for()
        await page.locator('.notes-collections').get_by_role('button',name='All notes 2',exact=True).click()
        await page.screenshot(path='/tmp/sticky-notes-desktop.png',full_page=True)
        await page.set_viewport_size({'width':390,'height':844})
        await page.screenshot(path='/tmp/sticky-notes-mobile.png',full_page=True)
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile overflow'
        await page.get_by_role('button',name='Delete note: Review the proposal',exact=True).click()
        await page.get_by_role('button',name='Delete',exact=True).click()
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for(state='hidden')
        await page.get_by_role('button',name='Delete note: A fresh idea',exact=True).click()
        await page.get_by_role('button',name='Delete',exact=True).click()
        await page.get_by_role('heading',name='Your next good idea belongs here').wait_for()
        assert not saved
        await page.emulate_media(reduced_motion='reduce')
        await page.goto(base)
        animation=await page.locator('.sticky-note').first.evaluate('(el)=>getComputedStyle(el).animationDuration')
        assert animation in ('0s','0.01ms','1e-05s'), animation
        # Moving the entire response leaves a persistent completion receipt.
        await page.emulate_media(reduced_motion='no-preference')
        await page.get_by_role('button',name='Save to Notes',exact=True).first.click()
        await page.locator('.sticky-note-flight').wait_for(state='attached')
        await page.locator('.sticky-note-flight .sticky-note-plane').wait_for(state='attached')
        duration = await page.locator('.sticky-note-flight').evaluate('(el)=>el.getAnimations()[0].effect.getTiming().duration')
        assert duration == 2000, duration
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for(state='hidden')
        await page.get_by_role('button',name='Save to Notes',exact=True).click()
        await page.locator('[data-notes-moved]').wait_for()
        assert await page.locator('[data-notes-moved]').inner_text() == 'All notes moved to My Notes.\nYou can find and organize them in the Notes tab.'
        assert await page.locator('.sticky-note-flight').count()==0
        saved[0]['title']='Edited saved note'
        saved[0]['body']='Updated privately in Notes'
        await page.reload()
        await page.locator('[data-notes-moved]').wait_for()
        assert await page.locator('[data-note-save]').count()==0
        # A failed save must retain the draft and expose retry feedback.
        saved.clear()
        await page.reload()
        async def fail_save(route):
            if route.request.method=='POST': await route.fulfill(status=500,json={'detail':'Synthetic failure'})
            else: await route_api(route)
        await page.route('**/api/notes',fail_save)
        await page.get_by_role('button',name='Save to Notes',exact=True).first.click()
        await page.get_by_role('alert').wait_for()
        assert await page.locator('[data-note-save]').count()==2
        assert await page.locator('.sticky-note-flight').count()==0
        await page.unroute('**/api/notes',fail_save)
        await page.emulate_media(reduced_motion='reduce')
        await page.get_by_role('button',name='Save to Notes',exact=True).first.click()
        await page.get_by_role('heading',name='Review the proposal',exact=True).wait_for(state='hidden')
        assert await page.locator('.sticky-note-flight').count()==0
        assert not errors,errors
        print('Sticky notes browser: flight, completion receipt, failure retention, save/reload, collections, editor, mobile and reduced motion passed')
        await browser.close()
asyncio.run(main())
