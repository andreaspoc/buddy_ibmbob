"""Real ACP monthly-profit summary using nonstandard source columns and real dates."""
import asyncio, io, json, os, secrets
from uuid import uuid4
from zipfile import ZipFile
import httpx
from fastapi import Response
from starlette.requests import Request
from playwright.async_api import async_playwright
from app import auth, office, job_queue

async def main():
    username='office-assistant-test-'+uuid4().hex[:10]
    user=auth.create_user(username,secrets.token_urlsafe(24)); response=Response()
    auth.start_session(response,user,Request({'type':'http','scheme':'http','path':'/','headers':[],'server':('localhost',8080)}))
    token=response.headers['set-cookie'].split(';')[0].split('=',1)[1]
    base=os.environ['PUBLIC_BASE_URL'];browser=None
    try:
        async with httpx.AsyncClient(base_url=base,cookies={auth.COOKIE:token},timeout=210) as api:
            await api.put('/personalization/tutorials',json={'disabled':True})
            from openpyxl import Workbook,load_workbook
            from datetime import datetime
            workbook=Workbook();source=workbook.active;source.title='Sales Ledger 2026'
            for col,value in enumerate(['Product','Total Profit','Date Closed','Expenses','Gross Revenue','Notes'],3):source.cell(4,col,value)
            for row,(profit,day) in enumerate([(125,datetime(2026,1,10)),(75,datetime(2026,2,10)),(50,datetime(2026,1,20)),(-25,datetime(2026,2,20))],5):
                for col,value in enumerate(['Synthetic item',profit,day,999,888,'Synthetic test only'],3):source.cell(row,col,value)
                source.cell(row,5).number_format='dd/mm/yyyy'
            buffer=io.BytesIO();workbook.save(buffer)
            created=await api.post('/api/office/files',files={'file':('Synthetic profit.xlsx',buffer.getvalue())});created.raise_for_status();file=created.json()
            original=(await api.get('/api/office/files/'+file['id']+'/download')).content
            async with async_playwright() as p:
                browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                context=await browser.new_context(ignore_https_errors=True,viewport={'width':1700,'height':1100})
                await context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                page=await context.new_page();page.set_default_timeout(20000)
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                requests=[]
                page.on('request',lambda r: requests.append(r.post_data_json) if '/api/office/assistant/files/' in r.url and r.method=='POST' else None)
                await page.goto(base+'/office/files/'+file['id'])
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                if not await page.locator('.office-assistant').is_visible():
                    await page.get_by_role('button',name='Ask Buddy',exact=True).click()
                await page.locator('.office-assistant-connection.is-ready').wait_for(timeout=45000)
                brand=await page.locator('.office-assistant .buddy-section-brand').inner_text()
                assert 'Company A' in brand and 'Buddy' in brand,brand
                fonts=await page.evaluate("[getComputedStyle(document.querySelector('.office-assistant')).fontFamily,getComputedStyle(document.body).fontFamily]")
                assert fonts[0]==fonts[1],fonts
                print('Buddy branding and inherited main app font verified',flush=True)
                editor=page.locator('.office-editor-frame iframe').first
                initial_src=await editor.get_attribute('src')
                await page.evaluate("window.officeTestFrames=0;new MutationObserver(m=>{window.officeTestFrames+=m.filter(x=>x.type==='childList'&&[...x.addedNodes,...x.removedNodes].some(n=>n.nodeName==='IFRAME')).length}).observe(document.querySelector('.office-editor-frame'),{childList:true,subtree:true})")
                prompt=('Build a monthly summary of total profit from this workbook in a new worksheet. '
                    'Use formulas so the totals update. Use the actual source columns, keep the original sheet unchanged, '
                    'and show each month and year present in the data. This workbook contains synthetic test data.')
                await page.get_by_role('textbox',name='Instructions for Buddy').fill(prompt)
                await page.evaluate("window.officeTestGeometry=[];window.officeTestSample=setInterval(()=>{const r=document.querySelector('.office-editor-frame').getBoundingClientRect();window.officeTestGeometry.push([r.x,r.y,r.width,r.height,window.scrollY]);},100)")
                await page.get_by_role('button',name='Send to Buddy',exact=True).click()
                await page.get_by_role('button',name='Apply to document',exact=True).wait_for(timeout=210000)
                assert not await page.locator('.office-assistant-error').count(),await page.locator('.office-assistant-error').all_text_contents()
                geometry=await page.evaluate('clearInterval(window.officeTestSample);window.officeTestGeometry')
                assert geometry and len(set(tuple(round(v,1) for v in sample) for sample in geometry))==1,('Editor geometry moved during generation',geometry[:5],geometry[-5:])
                assert requests and requests[-1]['context']['workbook'][0]['name']=='Sales Ledger 2026',requests
                sample=requests[-1]['context']['workbook'][0]
                assert sample['range'].startswith('C4:'),sample
                assert 'Total Profit' in sample['values'][0] and 'Date Closed' in sample['values'][0],sample
                preview=await page.locator('.office-assistant-preview').inner_text()
                assert 'Write cells' in preview and 'Add worksheet' in preview,preview
                print('Real ACP monthly summary preview received; editor geometry/scroll stable',flush=True)
                before=(await api.get('/api/office/files/'+file['id']+'/download')).content
                assert before==original,'Preview must not modify the saved document'
                assert await editor.get_attribute('src')==initial_src
                assert await page.evaluate('window.officeTestFrames')==0,'Editor iframe remounted while streaming'
                await page.get_by_role('button',name='Apply to document',exact=True).click()
                await page.get_by_text('Applied in the editor · Save to Office Suite to keep these changes',exact=True).wait_for(timeout=60000)
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=120000)
                raw=(await api.get('/api/office/files/'+file['id']+'/download')).content
                from pathlib import Path
                Path('/tmp/office-monthly-synthetic.xlsx').write_bytes(raw)
                saved=load_workbook(io.BytesIO(raw));cached=load_workbook(io.BytesIO(raw),data_only=True)
                assert list(saved['Sales Ledger 2026'].values)==list(workbook['Sales Ledger 2026'].values),'Source data changed'
                summaries=[sheet for sheet in saved if sheet.title!='Sales Ledger 2026']
                assert summaries,'Summary worksheet missing'
                formulas=[cell.value for sheet in summaries for row in sheet for cell in row if cell.data_type=='f']
                assert formulas,'Summary must contain working formulas'
                assert any('Sales Ledger 2026' in formula for formula in formulas),formulas
                assert not any('Sheet1!' in formula for formula in formulas),formulas
                numbers=[cell.value for sheet in cached if sheet.title!='Sales Ledger 2026' for row in sheet for cell in row if isinstance(cell.value,(int,float))]
                assert 175 in numbers and 50 in numbers,('Monthly profit incorrect',numbers,formulas)
                print('Monthly profit 175 and 50 verified from actual Total Profit column; source preserved',flush=True)
                await page.route('**/api/office/assistant/files/*/draft',lambda route: route.fulfill(status=200,content_type='application/x-ndjson',body='{"type":"start"}\n{"type":"delta","text":"UNVALIDATED PROPOSAL"}\n{"type":"error","code":"invalid_plan","message":"Buddy could not prepare supported document edits. No changes were applied. Try a smaller, more specific editing request."}\n'))
                await page.get_by_role('textbox',name='Instructions for Buddy').fill('Synthetic validation error check')
                await page.get_by_role('button',name='Send to Buddy',exact=True).click()
                await page.locator('.office-assistant-error').wait_for()
                assert not await page.get_by_text('UNVALIDATED PROPOSAL',exact=True).count()
                assert not await page.get_by_role('button',name='Apply to document',exact=True).count()
                assert 'supported document edits' in await page.locator('.office-assistant-error').inner_text()
                assert not errors,errors
                assert await page.evaluate('window.officeTestFrames')==0
                await page.screenshot(path='/tmp/office-monthly-real.png',full_page=True)
                print('Real ACP monthly summary saved in Office Suite; invalid plan preview correctly cleared; iframe stable')
                await browser.close();browser=None
                await asyncio.sleep(3)
    finally:
        office.ensure_schema();prefix=f'users/{username}/office/';client=office.s3();bucket=os.environ['BOB_S3_BUCKET']
        for chunk in client.get_paginator('list_object_versions').paginate(Bucket=bucket,Prefix=prefix):
            entries=[{'Key':i['Key'],'VersionId':i['VersionId']} for i in chunk.get('Versions',[])+chunk.get('DeleteMarkers',[])]
            if entries:client.delete_objects(Bucket=bucket,Delete={'Objects':entries})
        for item in client.list_objects_v2(Bucket=bucket,Prefix=prefix).get('Contents',[]):client.delete_object(Bucket=bucket,Key=item['Key'])
        with job_queue._connect() as db:
            db.execute('DELETE FROM office.bob_office_sessions WHERE file_id IN (SELECT id FROM office.bob_office_files WHERE username=%s)',(username,))
            for table in ('office.bob_office_files','sessions','bob_user_profiles','bob_personalization','bob_storage_files','bob_storage_users','users'):
                db.execute('DELETE FROM '+table+' WHERE username=%s',(username,))
        print('Disposable Office assistant user cleaned')

asyncio.run(main())
