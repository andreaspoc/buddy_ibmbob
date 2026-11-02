"""Native Bob bridge integration using disposable synthetic Word/Excel documents."""
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
            plugin_list=await api.get('/office-editor/plugins.json')
            plugin_list.raise_for_status()
            assert '9DC93CDB-B576-4F0C-B55E-FCC9C48DD007' not in plugin_list.text
            print('Native AI excluded from plugin manifest')
            for kind in ('word','excel','csv'):
                r=await api.post('/api/office/create',json={'name':'Synthetic '+kind,'kind':kind});r.raise_for_status();files.append(r.json())
            print('created formats',[f['extension'] for f in files])
            async with async_playwright() as p:
                browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                browser_context=await browser.new_context(ignore_https_errors=True,viewport={'width':1600,'height':1100})
                await browser_context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                page=await browser_context.new_page();page.set_default_timeout(20000)
                page.on('console',lambda m: print('console',m.text[:200]) if m.type=='error' else None)
                await page.goto(base)
                await page.get_by_role('button',name=re.compile('Office Suite')).click()
                await page.get_by_role('button',name='Synthetic word.docx',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                async def connect():
                    await page.wait_for_function("""() => {function scan(d){for(const f of d.querySelectorAll('iframe')){try {if(f.src.includes('/static/office-bridge/'))return true;if(f.contentDocument&&scan(f.contentDocument))return true;}catch{}}return false;}return scan(document);}""",timeout=120000)
                    await page.evaluate("""() => {
                        function scan(d){for(const f of d.querySelectorAll('iframe')){try {if(f.src.includes('/static/office-bridge/'))return f.contentWindow;const child=f.contentDocument&&scan(f.contentDocument);if(child)return child;}catch{}}}
                        const target=scan(document),channel=crypto.randomUUID();let seq=0;const pending=new Map();
                        window.bobBridgeCall=(command,payload)=>new Promise((resolve,reject)=>{const id='test'+(++seq);const timer=setTimeout(()=>reject(Error('Bridge timeout')),45000);pending.set(id,{resolve,reject,timer});target.postMessage({bridge:'buddy-office',type:'request',channel,id,command,payload},location.origin);});
                        window.addEventListener('message',e=>{const m=e.data;if(e.source!==target||e.origin!==location.origin||m.bridge!=='buddy-office'||m.channel!==channel)return;if(m.type==='connected'){window.bobBridgeConnected=true;return;}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}});
                        const retry=setInterval(()=>{if(window.bobBridgeConnected){clearInterval(retry);return;}target.postMessage({bridge:'buddy-office',type:'connect',channel},location.origin);},500);
                        target.postMessage({bridge:'buddy-office',type:'connect',channel},location.origin);
                    }""")
                    await page.wait_for_function('window.bobBridgeConnected===true')
                await connect()
                editor=next(f for f in page.frames if '/documenteditor/' in f.url)
                snapshot=await page.evaluate("bobBridgeCall('context')")
                prefix='Synthetic prefix ';selected='old selected phrase';suffix=' synthetic suffix.'
                plan={'version':1,'kind':'word','reply':'Synthetic seed','actions':[{'type':'replace_document','blocks':[{'type':'paragraph','text':prefix+selected+suffix},{'type':'paragraph','text':'Untouched paragraph.'}]}]}
                assert (await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':snapshot}))['applied']==1
                await editor.locator('#area_id').focus();await page.keyboard.press('Control+Home')
                for _ in prefix:await page.keyboard.press('ArrowRight')
                for _ in selected:await page.keyboard.press('Shift+ArrowRight')
                snapshot=await page.evaluate("bobBridgeCall('context')")
                print('Selected context',snapshot,flush=True)
                assert snapshot['selection']==selected
                plan={'version':1,'kind':'word','reply':'Synthetic replacement','actions':[{'type':'insert_blocks','position':'replace_selection','blocks':[{'type':'paragraph','text':'new rewritten phrase'}]}]}
                result=await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':snapshot});print('Replacement result',result,flush=True)
                after=await page.evaluate("bobBridgeCall('context')");print('Replacement context',after,flush=True)
                assert prefix+'new rewritten phrase'+suffix in after['text']
                assert selected not in after['text'] and 'Untouched paragraph.' in after['text']
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[0]['id']+'/download')).content
                from zipfile import ZipFile
                from xml.etree import ElementTree as etree
                with ZipFile(io.BytesIO(raw)) as doc:
                    tree=etree.fromstring(doc.read('word/document.xml'));text=''.join(tree.itertext())
                    assert prefix+'new rewritten phrase'+suffix in text and selected not in text and 'Untouched paragraph.' in text
                print('Selected substring replaced in place, surrounding text preserved, saved DOCX verified',flush=True)
                await browser.close();await asyncio.sleep(12)
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
