"""Real ACP -> reviewed plan -> ONLYOFFICE -> Office Suite round trip; synthetic data only."""
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
            created=await api.post('/api/office/create',json={'name':'Synthetic Bob report','kind':'word'});created.raise_for_status();file=created.json()
            original=(await api.get('/api/office/files/'+file['id']+'/download')).content
            async with async_playwright() as p:
                browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                context=await browser.new_context(ignore_https_errors=True,viewport={'width':1700,'height':1100})
                await context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                page=await context.new_page();page.set_default_timeout(20000)
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                await page.goto(base+'/office/files/'+file['id'])
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                if not await page.locator('.office-assistant').is_visible():
                    await page.get_by_role('button',name='Ask Buddy',exact=True).click()
                await page.locator('.office-assistant-connection.is-ready').wait_for(timeout=45000)
                editor=page.locator('.office-editor-frame iframe').first
                initial_src=await editor.get_attribute('src')
                await page.evaluate("window.officeTestFrames=0;new MutationObserver(m=>{window.officeTestFrames+=m.filter(x=>x.type==='childList'&&[...x.addedNodes,...x.removedNodes].some(n=>n.nodeName==='IFRAME')).length}).observe(document.querySelector('.office-editor-frame'),{childList:true,subtree:true})")
                prompt=('Create a synthetic demonstration report in this current blank document. '
                    'Use title Synthetic Bob Report and a level 1 heading Overview. '
                    'Include a short paragraph explicitly saying this is synthetic test data, '
                    'and a table with two columns Item and Status, one data row Demo and Ready. '
                    'Set real page header to Synthetic Header and real footer to Synthetic Footer with automatic page numbers. '
                    'Use insert_blocks at end and set_header/set_footer actions. Do not replace the document. '
                    'Do not invent real operational facts.')
                await page.get_by_role('textbox',name='Instructions for Buddy').fill(prompt)
                await page.evaluate("window.officeTestGeometry=[];window.officeTestSample=setInterval(()=>{const r=document.querySelector('.office-editor-frame').getBoundingClientRect();window.officeTestGeometry.push([r.x,r.y,r.width,r.height,window.scrollY]);},100)")
                await page.get_by_role('button',name='Send to Buddy',exact=True).click()
                await page.get_by_role('button',name='Apply to document',exact=True).wait_for(timeout=210000)
                assert not await page.locator('.office-assistant-error').count(),await page.locator('.office-assistant-error').all_text_contents()
                geometry=await page.evaluate('clearInterval(window.officeTestSample);window.officeTestGeometry')
                assert geometry and len(set(tuple(round(v,1) for v in sample) for sample in geometry))==1,('Editor geometry moved during generation',geometry[:5],geometry[-5:])
                print('Real ACP report plan preview received; editor geometry/scroll stable',flush=True)
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
                Path('/tmp/office-assistant-synthetic.docx').write_bytes(raw)
                from xml.etree import ElementTree as etree
                ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                with ZipFile(io.BytesIO(raw)) as doc:
                    root=etree.fromstring(doc.read('word/document.xml'))
                    text=' '.join(n.text or '' for n in root.findall('.//w:t',ns))
                    assert 'Synthetic Bob Report' in text,text
                    assert 'Overview' in text,text
                    assert root.findall('.//w:tbl',ns),'Real table missing'
                    styles=etree.fromstring(doc.read('word/styles.xml'))
                    style_names={n.attrib.get('{'+ns['w']+'}styleId'): (n.find('w:name',ns).attrib.get('{'+ns['w']+'}val','') if n.find('w:name',ns) is not None else '') for n in styles.findall('w:style',ns)}
                    applied_styles=[n.attrib.get('{'+ns['w']+'}val','') for n in root.findall('.//w:pStyle',ns)]
                    print('Synthetic paragraph style names',[style_names.get(style,style) for style in applied_styles],flush=True)
                    assert any(style_names.get(style,style).lower().startswith('heading') for style in applied_styles),'Heading style missing'
                    headers=[doc.read(n) for n in doc.namelist() if n.startswith('word/header') and n.endswith('.xml')]
                    footers=[doc.read(n) for n in doc.namelist() if n.startswith('word/footer') and n.endswith('.xml')]
                    assert any(b'Synthetic Header' in h for h in headers),'Real header missing'
                    assert any(b'Synthetic Footer' in f for f in footers),'Real footer missing'
                    assert any(b'PAGE' in f for f in footers),'Automatic page field missing'
                assert not errors,errors
                assert await page.evaluate('window.officeTestFrames')==0
                await page.screenshot(path='/tmp/office-assistant-real.png',full_page=True)
                print('Real ACP title, heading, paragraph, table, header/footer/page numbers saved and verified in Office Suite DOCX; iframe stable')
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
