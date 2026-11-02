"""Real editor smoke test using a disposable user and explicitly synthetic documents."""
import asyncio, io, json, re, secrets, time, os
from pathlib import Path
from uuid import uuid4
import httpx
from fastapi import Response
from starlette.requests import Request
from playwright.async_api import async_playwright
from app import auth, office, job_queue

async def main():
    username='office-test-'+uuid4().hex[:12]
    user=auth.create_user(username,secrets.token_urlsafe(24))
    response=Response()
    auth.start_session(response,user,Request({'type':'http','scheme':'http','path':'/','headers':[],'server':('localhost',8080)}))
    token=response.headers['set-cookie'].split(';')[0].split('=',1)[1]
    base=os.environ['PUBLIC_BASE_URL']
    files=[]
    try:
        async with httpx.AsyncClient(base_url=base,cookies={auth.COOKIE:token},timeout=30) as api:
            await api.put('/personalization/tutorials',json={'disabled':True})
            r=await api.get('/api/office/status'); print('status',r.status_code,r.text); r.raise_for_status()
            for kind in ('word','excel','csv'):
                r=await api.post('/api/office/create',json={'name':'Synthetic '+kind,'kind':kind});r.raise_for_status();files.append(r.json())
            print('created formats',[f['extension'] for f in files])
            for saved in files:
                original=(await api.get('/api/office/files/'+saved['id']+'/download')).content
                uploaded=await api.post('/api/office/files',files={'file':('Uploaded '+saved['name'],original)})
                uploaded.raise_for_status()
                copy=(await api.get('/api/office/files/'+uploaded.json()['id']+'/download')).content
                assert copy==original
            invalid=await api.post('/api/office/files',files={'file':('invalid.docx',b'not a document')})
            assert invalid.status_code==422
            print('DOCX, XLSX and CSV uploads/downloads verified; invalid DOCX rejected')
            async with async_playwright() as p:
                browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                context=await browser.new_context(ignore_https_errors=True,viewport={'width':1600,'height':1100})
                await context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                page=await context.new_page(); page.set_default_timeout(15000); errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.on('console',lambda m: print('console error',m.text[:220]) if m.type=='error' else None)
                await page.goto(base);await page.screenshot(path='/tmp/office-before.png');await page.get_by_role('button',name=re.compile('Office Suite')).click()
                await page.get_by_role('heading',name='Room for your next idea.').wait_for()
                await page.screenshot(path='/tmp/office-library.png',full_page=True)
                await page.get_by_role('button',name='Synthetic word.docx',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                frame=next(f for f in page.frames if '/documenteditor/' in f.url)
                await frame.locator('#area_id').focus()
                await page.keyboard.type('Synthetic Office round trip verified.',delay=20)
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[0]['id']+'/download')).content
                from zipfile import ZipFile
                with ZipFile(io.BytesIO(raw)) as doc:
                    assert b'Synthetic Office round trip verified.' in doc.read('word/document.xml')
                print('Word text edited in browser, saved to Office Suite, downloaded and verified')
                await page.screenshot(path='/tmp/office-word.png',full_page=True)
                await page.get_by_role('button',name='Back to file library',exact=True).click()
                await page.get_by_role('button',name='Synthetic excel.xlsx',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                frame=next(f for f in page.frames if '/spreadsheeteditor/' in f.url)
                await frame.locator('#ce-cell-name').fill('A1')
                await frame.locator('#ce-cell-name').press('Enter')
                await frame.locator('#area_id').focus()
                await page.keyboard.type('41',delay=40)
                await page.keyboard.press('Tab')
                await page.keyboard.type('=A1+1',delay=40)
                await page.keyboard.press('Enter')
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[1]['id']+'/download')).content
                from openpyxl import load_workbook
                workbook=load_workbook(io.BytesIO(raw))
                print('workbook values',workbook.active['A1'].value,workbook.active['B1'].value)
                assert workbook.active['A1'].value==41
                assert workbook.active['B1'].value=='=A1+1'
                cached=load_workbook(io.BytesIO(raw),data_only=True)
                assert cached.active['B1'].value==42
                print('Excel values, formula, calculated result saved to Office Suite and verified')
                await page.screenshot(path='/tmp/office-excel.png',full_page=True)
                await page.get_by_role('button',name='Back to file library',exact=True).click()
                await page.get_by_role('button',name='Synthetic csv.csv',exact=True).click()
                frame=page.frame_locator('iframe').first
                await frame.get_by_text('Choose CSV options',exact=True).wait_for(timeout=60000)
                await frame.get_by_role('button',name='OK',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                frame=next(f for f in page.frames if '/spreadsheeteditor/' in f.url)
                await frame.locator('#ce-cell-name').fill('A1')
                await frame.locator('#ce-cell-name').press('Enter')
                await frame.locator('#area_id').focus()
                await page.keyboard.type('CSV round trip verified',delay=30)
                await page.keyboard.press('Enter')
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[2]['id']+'/download')).content
                assert b'CSV round trip verified' in raw and not raw.startswith(b'PK')
                print('CSV values edited in browser, saved as CSV in Office Suite and verified')
                await page.screenshot(path='/tmp/office-csv.png',full_page=True)
                assert not errors,errors
                print('page errors',errors)
                await page.get_by_role('button',name='Back to file library',exact=True).click()
                await page.get_by_role('button',name='Synthetic excel.xlsx',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                frame=next(f for f in page.frames if '/spreadsheeteditor/' in f.url)
                await frame.locator('#ce-cell-name').fill('B1')
                await frame.locator('#ce-cell-name').press('Enter')
                assert (await frame.locator('#ce-cell-content').input_value())=='=A1+1'
                print('Workbook reopened with its saved formula intact')
                await page.get_by_role('button',name='Back to file library',exact=True).click()
                await page.get_by_role('button',name='Close Office Suite',exact=True).click()
                await page.set_viewport_size({'width':390,'height':844})
                assert not await page.get_by_role('button',name=re.compile('Office Suite')).is_visible()
                print('Office Suite hidden on mobile')
                await browser.close()
                await asyncio.sleep(12)
    finally:
        office.ensure_schema()
        prefix=f'users/{username}/office/'
        client=office.s3();bucket=os.environ['BOB_S3_BUCKET']
        for chunk in client.get_paginator('list_object_versions').paginate(Bucket=bucket,Prefix=prefix):
            entries=[{'Key':item['Key'],'VersionId':item['VersionId']} for item in chunk.get('Versions',[])+chunk.get('DeleteMarkers',[])]
            if entries: client.delete_objects(Bucket=bucket,Delete={'Objects':entries})
        for item in client.list_objects_v2(Bucket=bucket,Prefix=prefix).get('Contents',[]): client.delete_object(Bucket=bucket,Key=item['Key'])
        with job_queue._connect() as db:
            db.execute('DELETE FROM office.bob_office_sessions WHERE file_id IN (SELECT id FROM office.bob_office_files WHERE username=%s)',(username,))
            db.execute('DELETE FROM office.bob_office_files WHERE username=%s',(username,))
            db.execute('DELETE FROM sessions WHERE username=%s',(username,))
            db.execute('DELETE FROM bob_user_profiles WHERE username=%s',(username,))
            db.execute('DELETE FROM bob_personalization WHERE username=%s',(username,))
            db.execute('DELETE FROM bob_storage_files WHERE username=%s',(username,))
            db.execute('DELETE FROM bob_storage_users WHERE username=%s',(username,))
            db.execute('DELETE FROM users WHERE username=%s',(username,))
        print('disposable Office test account cleaned')

asyncio.run(main())
