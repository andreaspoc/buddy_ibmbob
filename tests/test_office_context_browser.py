"""All six real editors and ACP chat; restricted-mode boundary responses use explicit fixtures."""
import asyncio, io, json, os, secrets, sys
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
            files=[]
            for kind in ('word','excel','csv','powerpoint','pdf'):
                result=await api.post('/api/office/create',json={'name':'Synthetic context '+kind,'kind':kind})
                result.raise_for_status();files.append(result.json())
            result=await api.post('/api/office/files',files={'file':('Synthetic-context.html',b'<!doctype html><html><body><h1>Synthetic Context Marker ORCHID</h1><p>This is a synthetic test presentation.</p></body></html>','text/html')})
            result.raise_for_status();files.append(result.json())
            async with async_playwright() as runtime:
                browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                context=await browser.new_context(ignore_https_errors=True,viewport={'width':1700,'height':1100})
                await context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                page=await context.new_page();page.set_default_timeout(20000)
                for file in files:
                    if len(sys.argv)>1 and file['extension'] not in sys.argv[1:]:
                        continue
                    extension=file['extension'];requests=[]
                    print('Opening real editor:', extension, flush=True)
                    await page.goto(base+'/office/files/'+file['id'])
                    if extension=='csv':
                        frame=page.frame_locator('iframe').first
                        await frame.get_by_text('Choose CSV options',exact=True).wait_for(timeout=90000)
                        await frame.get_by_role('button',name='OK',exact=True).click()
                    toggle=page.get_by_role('button',name='Ask Buddy',exact=True)
                    await toggle.wait_for()
                    if extension!='html':
                        await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                    if not await page.locator('.office-assistant').is_visible():
                        await toggle.click()
                    await page.locator('.office-assistant-connection.is-ready').wait_for(timeout=120000)
                    print('Editor connected:', extension, flush=True)
                    def capture(request):
                        if '/draft' in request.url and request.method=='POST':requests.append(request.post_data_json)
                    page.on('request',capture)
                    prompt='What kind of file is currently open? Use the supplied current editor context. Explain what content you can read and any limitations. Do not edit or propose edits.'
                    if extension=='html':prompt='What is the exact synthetic marker in the heading of the open document? Read it from the current document. Do not edit or propose edits.'
                    await page.get_by_role('textbox',name='Instructions for Buddy').fill(prompt)
                    await page.get_by_role('button',name='Send to Buddy',exact=True).click()
                    await page.wait_for_function("() => {const e=document.querySelector('.office-assistant-turn');return e && !e.classList.contains('state-working')}",timeout=210000)
                    errors=await page.locator('.office-assistant-error').all_text_contents()
                    assert not errors,(extension,errors)
                    reply=await page.locator('.office-assistant-reply').inner_text()
                    assert len(reply)>20,(extension,reply)
                    assert requests and requests[-1]['context_mode']=='document',extension
                    expected={'docx':'word','xlsx':'cell','csv':'cell','pptx':'slide','pdf':'pdf','html':'html'}[extension]
                    assert requests[-1]['context']['kind']==expected,(extension,requests)
                    if extension=='html':assert 'ORCHID' in reply,reply
                    print('PASS real editor + ACP chat:',extension,reply[:200].replace('\n',' '),flush=True)
                    # Capture request boundaries for both restricted context options without spending another model turn.
                    async def answer(route):
                        payload={'type':'plan','plan':{'version':1,'kind':expected,'reply':'Synthetic boundary fixture response','actions':[]}}
                        await route.fulfill(content_type='application/x-ndjson',body=json.dumps(payload)+'\n')
                    await page.route('**/api/office/assistant/files/*/draft',answer)
                    for mode in ('selection','none'):
                        await page.locator('.office-assistant-context select').select_option(mode)
                        await page.get_by_role('textbox',name='Instructions for Buddy').fill('Explain the available context')
                        count=await page.locator('.office-assistant-turn').count()
                        await page.get_by_role('button',name='Send to Buddy',exact=True).click()
                        await page.wait_for_function("n => {const turns=document.querySelectorAll('.office-assistant-turn');return turns.length>n && !turns[turns.length-1].classList.contains('state-working')}",arg=count,timeout=45000)
                        sent=requests[-1]
                        assert sent['context_mode']==mode and not sent['history'] and not sent['context']['text'],(extension,mode,sent)
                        if mode=='none':assert not sent['context'].get('selection') and not sent['context'].get('values'),(extension,sent)
                    await page.unroute('**/api/office/assistant/files/*/draft',answer)
                    page.remove_listener('request',capture)
                    print('PASS selection/none request boundaries:',extension,flush=True)
                await browser.close();browser=None
    finally:
        if browser is not None:
            try:
                print('Browser failure page:', (await page.locator('body').inner_text())[-5000:], flush=True)
                await page.screenshot(path='/tmp/office-context-failure.png')
                await browser.close()
            except Exception as exc:
                print('Browser cleanup:', type(exc).__name__, flush=True)
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
