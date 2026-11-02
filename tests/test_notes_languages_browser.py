"""Synthetic note content: verify live interface language changes without translation of content."""
import asyncio, os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

COPY = {
 'en': ['Saved notes','Save note','Attachments','Version history','Export Markdown','Export PDF','1 saved note','butter paper','1 saved version'],
 'el': ['Αποθηκευμένες σημειώσεις','Αποθήκευση σημείωσης','Συνημμένα','Ιστορικό εκδόσεων','Εξαγωγή Markdown','Εξαγωγή PDF','1 αποθηκευμένη σημείωση','Χαρτί: βουτυρί','1 αποθηκευμένη έκδοση'],
 'hi': ['सहेजे गए नोट्स','नोट सहेजें','अटैचमेंट','संस्करण इतिहास','Markdown निर्यात करें','PDF निर्यात करें','1 सहेजा गया नोट','हल्का पीला काग़ज़','1 सहेजा गया संस्करण'],
 'mt': ['Noti ssejvjati','Issejvja n-nota','Annessi','Storja tal-verżjonijiet','Esporta Markdown','Esporta PDF','1 nota ssejvjata','Karta isfar ċar','1 verżjoni ssejvjata'],
}
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1400,'height':1100})
  await page.add_init_script("localStorage.setItem('bob-ui-language','en')")
  row={'id':1,'title':'User authored title','body':'Original user-authored English content.','color':'butter','collection':'Custom Collection','tags':['user-tag'],'favorite':False,'sources':[],'created_at':'2026-10-15T10:00:00Z'}
  errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
  async def api(route):
   path=urlsplit(route.request.url).path
   if path.endswith('/versions'):await route.fulfill(json={'items':[{'id':1,'note_id':1,'created_at':'2026-10-15T10:00:00Z','snapshot':row}]});return
   if path.endswith('/attachments'):await route.fulfill(json={'items':[]});return
   await route.fulfill(json={'items':[row],'next_before_id':None,'default_collection':'2026-10-15'})
  await page.route('**/api/notes**',api)
  await page.goto(os.getenv('NOTES_FIXTURE_URL','http://127.0.0.1:3004/sticky_notes_fixture.html')+'?board')
  await page.locator('[data-note-id="1"]').wait_for()
  async def language(code):
   await page.evaluate("code=>{localStorage.setItem('bob-ui-language',code);dispatchEvent(new StorageEvent('storage',{key:'bob-ui-language',newValue:code}));}",code)
   await page.wait_for_function('code=>document.documentElement.lang===code',arg=code)
  for code,copy in COPY.items():
   await language(code)
   await page.get_by_role('region',name=copy[0],exact=True).wait_for()
   assert copy[6] in await page.locator('.notes-count').inner_text()
   await page.get_by_role('button',name=copy[4],exact=True).wait_for()
   await page.get_by_role('button',name=copy[5],exact=True).wait_for()
   assert await page.locator('[data-note-id="1"] h2').inner_text()=='User authored title'
   assert 'Original user-authored English content.' in await page.locator('[data-note-id="1"]').inner_text()
  await page.locator('[data-note-edit]').click()
  await page.locator('[data-note-details]').wait_for()
  for code,copy in COPY.items():
   await language(code)
   await page.get_by_role('button',name=copy[1],exact=True).wait_for()
   await page.get_by_role('heading',name=copy[2],exact=True).wait_for()
   assert copy[3] in await page.locator('[data-note-history] summary').inner_text()
   assert copy[8] in await page.locator('[data-note-history] summary').inner_text()
   await page.get_by_role('button',name=copy[7],exact=True).wait_for()
   assert await page.locator('.notes-editor input[maxlength="160"]').input_value()=='User authored title'
   assert await page.locator('.notes-editor textarea[maxlength="6000"]').input_value()==row['body']
   await page.locator('.notes-enrichment-toggle').click()
   assert await page.locator('.notes-enrichment-presets button').count()==4
   assert (await page.locator('.notes-enrichment-content textarea').input_value()).strip()
   await page.locator('.notes-enrichment-toggle').click()
  assert not errors,errors
  await browser.close()
  print('Notes four-language live switching, counts, colors, editor, attachments/history, exports and content preservation passed')

asyncio.run(main())
