"""AI UI smoke test: the custom Bob panel replaces the vendor AI plugin."""
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
            for kind in ('word',):
                r=await api.post('/api/office/create',json={'name':'Synthetic '+kind,'kind':kind});r.raise_for_status();files.append(r.json())
            print('created formats',[f['extension'] for f in files])
            async with async_playwright() as p:
                browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                context=await browser.new_context(ignore_https_errors=True,viewport={'width':1600,'height':1100})
                await context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                page=await context.new_page(); page.set_default_timeout(15000); errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.on('console',lambda m: print('console error',m.text[:220]) if m.type=='error' else None)
                await page.goto(base+'/office/files/'+files[0]['id'])
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                await page.locator('.office-assistant-connection.is-ready').wait_for(timeout=45000)
                assert await page.get_by_role('textbox',name='Instructions for Buddy').is_visible()
                native=next(frame for frame in page.frames if '/documenteditor/main/' in frame.url)
                assert await native.get_by_text('AI',exact=True).count()==0
                catalog=await api.get('/office-editor/plugins.json');catalog.raise_for_status()
                assert '9DC93CDB-B576-4F0C-B55E-FCC9C48DD007' not in catalog.text.upper()
                assert not errors,errors
                print('Custom Bob panel connected; native AI catalog and tab absent')
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
