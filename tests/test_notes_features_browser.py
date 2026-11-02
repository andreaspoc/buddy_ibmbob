"""Synthetic UI fixtures; real persistence and privacy covered by backend integration tests."""
import asyncio,json,os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':1000})
  await page.add_init_script("localStorage.setItem('bob-ui-language','en')")
  rows=[{'id':1,'title':'Alpha idea','body':'Original synthetic alpha content.','color':'butter','collection':'Research','tags':['study'],'favorite':False,'sources':[],'created_at':'2026-10-15T10:00:00Z'}, {'id':2,'title':'Beta idea','body':'See [[note:1|Alpha idea]] for context.','color':'mint','collection':'2026-10-15','tags':[],'favorite':False,'sources':[],'created_at':'2026-10-15T10:00:00Z'}]
  versions={1:[],2:[]};attachments={1:[],2:[]}; exports=[];asks=[];errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  async def route_api(route):
   request=route.request;path=urlsplit(request.url).path;parts=path.split('/')
   if path=='/api/notes/workspace':await route.fulfill(status=201,json={'id':'a'*32});return
   if path=='/chat/stream':
    asks.append(json.loads(request.post_data))
    revision={'title':'Combined ideas','body':'A synthetic summary of [[note:1|Alpha idea]] and [[note:2|Beta idea]].'}
    await route.fulfill(content_type='application/x-ndjson',headers={'X-Bob-Job-Id':'fixture-job'},body=json.dumps({'type':'done','text':json.dumps(revision)})+'\n');return
   if path=='/api/notes/export':
    exports.append(request.url);await route.fulfill(body=b'%PDF-fixture' if 'format=pdf' in request.url else b'# Exported fixture',content_type='application/octet-stream');return
   if path=='/api/notes':
    if request.method=='POST':
     value=json.loads(request.post_data);value.update(id=len(rows)+1,created_at='2026-10-15T12:00:00Z');rows.append(value);versions[value['id']]=[];attachments[value['id']]=[]
     await route.fulfill(status=201,json=value)
    else:await route.fulfill(json={'items':rows,'next_before_id':None,'default_collection':'2026-10-15'})
    return
   identifier=int(parts[3]);note=next(row for row in rows if row['id']==identifier)
   if len(parts)>4 and parts[4]=='versions':
    if request.method=='POST':
     version=next(version for version in versions[identifier] if version['id']==int(parts[5]));note.update(version['snapshot']);await route.fulfill(json=note)
    else:await route.fulfill(json={'items':versions[identifier]})
   elif len(parts)>4 and parts[4]=='attachments':
    if request.method=='POST':
     attachment={'id':1,'filename':'reference.md','content_type':'text/markdown','size':12,'created_at':'2026-10-15T12:00:00Z'};attachments[identifier].append(attachment);await route.fulfill(status=201,json=attachment)
    elif request.method=='DELETE':attachments[identifier].clear();await route.fulfill(status=204)
    else:await route.fulfill(json={'items':attachments[identifier]})
   elif request.method=='PATCH':
    snapshot={key:note.get(key) for key in ('title','body','color','collection','tags','favorite','sources')}
    versions[identifier].insert(0,{'id':len(versions[identifier])+1,'note_id':identifier,'created_at':'2026-10-15T12:00:00Z','snapshot':snapshot})
    note.update(json.loads(request.post_data));await route.fulfill(json=note)
   else:await route.fulfill(status=404)
  await page.route('**/api/notes**',route_api);await page.route('**/chat/stream',route_api)
  base=os.getenv('NOTES_FIXTURE_URL','http://127.0.0.1:3002/sticky_notes_fixture.html')+'?board'
  await page.goto(base)
  await page.get_by_role('button',name='Favorite note: Alpha idea',exact=True).click()
  await page.get_by_role('button',name='Unfavorite note: Alpha idea',exact=True).wait_for()
  assert rows[0]['favorite']
  await page.get_by_role('button',name='Edit note: Alpha idea',exact=True).click()
  await page.get_by_label('Note tags',exact=True).fill('study, important')
  await page.get_by_label('Note content',exact=True).fill('Updated alpha with an actionable point.')
  await page.locator('.notes-source-editor summary').click()
  await page.get_by_role('button',name='Add source',exact=False).click()
  await page.get_by_label('Source title 1',exact=True).fill('Reference')
  await page.get_by_label('Source URL 1',exact=True).fill('https://example.com/reference')
  await page.get_by_role('button',name='Save note',exact=True).click()
  await page.locator('[data-note-editor]').wait_for(state='hidden')
  assert rows[0]['tags']==['study','important'] and rows[0]['sources'][0]['url']=='https://example.com/reference'
  await page.get_by_role('button',name='Edit note: Alpha idea',exact=True).click()
  await page.locator('.notes-links-panel').get_by_role('button',name='Beta idea').wait_for()
  await page.get_by_label('Attach a file',exact=True).set_input_files({'name':'reference.md','mimeType':'text/markdown','buffer':b'Test fixture'})
  await page.get_by_role('link',name='reference.md',exact=True).wait_for()
  await page.get_by_text('Version history',exact=False).click()
  await page.locator('[data-note-history] button').first.click()
  await page.get_by_role('button',name='Restore this version',exact=True).click()
  await page.get_by_role('button',name='Confirm restore',exact=True).click()
  assert rows[0]['body']=='Original synthetic alpha content.'
  await page.get_by_role('button',name='Cancel',exact=True).click()
  # Wiki link navigation opens the linked note.
  await page.get_by_role('button',name='View full note',exact=False).last.click()
  await page.locator('[data-note-id="2"] a[href="#note-1"]').click()
  assert await page.get_by_label('Title',exact=True).input_value()=='Alpha idea'
  await page.get_by_role('button',name='Cancel',exact=True).click()
  await page.get_by_label('Select note: Alpha idea',exact=True).check()
  await page.get_by_label('Select note: Beta idea',exact=True).check()
  async with page.expect_download():await page.get_by_role('button',name='Export Markdown',exact=True).click()
  async with page.expect_download():await page.get_by_role('button',name='Export PDF',exact=True).click()
  assert len(exports)==2 and all('ids=1,2' in url for url in exports)
  await page.get_by_role('button',name='Summarize',exact=False).click()
  await page.get_by_label('Title',exact=True).wait_for()
  assert await page.get_by_label('Title',exact=True).input_value()=='Combined ideas'
  assert len(rows)==2,'Synthesis must remain a draft until saved'
  assert 'Alpha idea' in asks[0]['prompt'] and 'Beta idea' in asks[0]['prompt']
  await page.get_by_role('button',name='Save note',exact=True).click()
  await page.locator('[data-note-editor]').wait_for(state='hidden');assert len(rows)==3
  await page.set_viewport_size({'width':390,'height':844})
  assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  await page.screenshot(path='/tmp/notes-extended-mobile.png',full_page=True)
  assert not errors,errors
  print('Notes features UI: favorites, tags, sources, attachments, history restore, backlinks/wiki navigation, Markdown/PDF downloads, reviewed multi-note summary and mobile passed')
  await browser.close()
asyncio.run(main())
