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
                browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'] + (['--unsafely-treat-insecure-origin-as-secure='+base] if base.startswith('http://') else []))
                browser_context=await browser.new_context(ignore_https_errors=True,viewport={'width':1600,'height':1100})
                await browser_context.add_cookies([{'name':auth.COOKIE,'value':token,'url':base}])
                await browser_context.add_init_script("""window.addEventListener('message',event=>{const m=event.data;if(event.origin===location.origin&&m?.bridge==='buddy-office'&&m.type==='connected')window.actualOfficeConnection={target:event.source,channel:m.channel};});""")
                page=await browser_context.new_page();page.set_default_timeout(20000)
                page.on('console',lambda m: print('console',m.text[:200]) if m.type=='error' else None)
                await page.goto(base)
                await page.get_by_role('button',name=re.compile('Office Suite')).click()
                await page.get_by_role('button',name='Synthetic word.docx',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                async def connect():
                    # Use the app's established channel; a second handshake can
                    # race the app and discard in-flight command responses.
                    await page.locator('.office-assistant-connection.is-ready').wait_for()
                    await page.wait_for_function('Boolean(window.actualOfficeConnection)')
                    await page.evaluate("""() => {
                        const {target,channel}=window.actualOfficeConnection;
                        let seq=0;const pending=new Map();
                        window.bobBridgeConnected=true;
                        window.bobBridgeCall=(command,payload)=>new Promise((resolve,reject)=>{const id='test'+(++seq);const timer=setTimeout(()=>reject(Error('Bridge timeout')),45000);pending.set(id,{resolve,reject,timer});target.postMessage({bridge:'buddy-office',type:'request',channel,id,command,payload},location.origin);});
                        window.addEventListener('message',e=>{const m=e.data;if(e.source!==target||e.origin!==location.origin||m.bridge!=='buddy-office'||m.channel!==channel)return;const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}});
                    }""")
                await connect()
                native_editor=next(f for f in page.frames if '/documenteditor/' in f.url)
                assert await native_editor.get_by_text('AI',exact=True).count()==0
                print('Native AI tab absent; Bob bridge connected')
                snapshot=await page.evaluate("bobBridgeCall('context')")
                print('word context',json.dumps(snapshot)[:500])
                plan={'version':1,'kind':'word','reply':'Synthetic test draft','actions':[
                    {'type':'set_header','text':'Synthetic Company','alignment':'left','font_color':'#123456'},
                    {'type':'set_footer','text':'Synthetic page','alignment':'center','page_numbers':True},
                    {'type':'set_page_layout','size':'a4','orientation':'landscape','margins_mm':20},
                    {'type':'insert_blocks','position':'end','blocks':[
                        {'type':'title','text':'Synthetic title'},
                        {'type':'heading','text':'Synthetic heading','level':1,'bold':False,'font_color':'#8A3FFC','fill':'#F6F2FF'},
                        {'type':'paragraph','text':'Synthetic body'},
                        {'type':'table','rows':[['Column','Amount'],['Example','42']],'header':True,'header_fill':'#123456','header_font_color':'#FFFFFF','font_color':'#161616'},
                        {'type':'page_break'}, {'type':'paragraph','text':'Synthetic second page'}]}]}
                result=await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':snapshot});print('word apply',result)
                assert result['applied']==4
                after=await page.evaluate("bobBridgeCall('context')");assert 'Synthetic heading' in after['text'];assert 'Synthetic Company' in after['header'];assert 'Synthetic page' in after['footer']
                try: await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':snapshot})
                except Exception as e: assert 'changed since' in str(e)
                else: raise AssertionError('Stale plan accepted')
                editor=next(f for f in page.frames if '/documenteditor/' in f.url)
                await editor.locator('#area_id').focus()
                await page.keyboard.press('Control+z')
                undone=await page.evaluate("bobBridgeCall('context')")
                assert undone['text']==snapshot['text'] and not undone['header'].strip() and not undone['footer'].strip(),undone
                print('Native single undo restores entire four-action Word plan')
                result=await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':undone});assert result['applied']==4
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[0]['id']+'/download')).content
                from zipfile import ZipFile
                from xml.etree import ElementTree as etree
                with ZipFile(io.BytesIO(raw)) as doc:
                    ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                    tree=etree.fromstring(doc.read('word/document.xml'))
                    styles=etree.fromstring(doc.read('word/styles.xml'))
                    style_names={s.attrib.get('{'+ns['w']+'}styleId'):s.find('w:name',ns).attrib.get('{'+ns['w']+'}val') for s in styles.findall('w:style',ns) if s.find('w:name',ns) is not None}
                    used_styles=[p.attrib.get('{'+ns['w']+'}val') for p in tree.findall('.//w:pStyle',ns)]
                    assert any((style_names.get(x) or '').lower().replace(' ','')=='heading1' for x in used_styles)
                    assert tree.findall('.//w:tbl',ns)
                    colors={n.attrib.get('{'+ns['w']+'}val','').upper() for n in tree.findall('.//w:color',ns)}
                    fills={n.attrib.get('{'+ns['w']+'}fill','').upper() for n in tree.findall('.//w:shd',ns)}
                    assert {'8A3FFC','FFFFFF','161616'} <= colors, colors
                    assert {'F6F2FF','123456'} <= fills, fills
                    assert tree.findall('.//w:pgSz[@w:orient="landscape"]',ns)
                    assert any(b'Synthetic Company' in doc.read(n) for n in doc.namelist() if re.match(r'word/header[0-9]+.xml',n))
                    assert all(len(etree.fromstring(doc.read(n)).findall('.//w:p',ns))==1 for n in doc.namelist() if re.match(r'word/(?:header|footer)[0-9]+.xml',n))
                    assert any(b'PAGE' in doc.read(n) for n in doc.namelist() if re.match(r'word/footer[0-9]+.xml',n))
                print('Verified saved DOCX headings, native table, true header/footer PAGE field, landscape')
                await page.get_by_role('button',name='Back to file library',exact=True).click()
                await page.get_by_role('button',name='Synthetic excel.xlsx',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                await page.evaluate('window.bobBridgeConnected=false')
                await connect()
                snapshot=await page.evaluate("bobBridgeCall('context')");print('cell context',json.dumps(snapshot)[:500])
                plan={'version':1,'kind':'cell','reply':'Synthetic cells','actions':[
                    {'type':'set_cells','sheet':None,'range':'A1:B2','values':[['Amount','Total'],[41,'=A2+1']]},
                    {'type':'format_range','sheet':None,'range':'A1:B1','bold':True,'fill':'#FFEEAA'}]}
                result=await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':snapshot});print('cell apply',result)
                assert result['applied']==2
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[1]['id']+'/download')).content
                from openpyxl import load_workbook
                workbook=load_workbook(io.BytesIO(raw));assert workbook.active['A2'].value==41;assert workbook.active['B2'].value=='=A2+1';assert workbook.active['A1'].font.bold
                assert load_workbook(io.BytesIO(raw),data_only=True).active['B2'].value==42
                print('Verified XLSX cells, formula, cached result, native formatting saved to Office Suite')
                editor=next(f for f in page.frames if '/spreadsheeteditor/' in f.url)
                await editor.locator('#ce-cell-name').fill('A1:AE201');await editor.locator('#ce-cell-name').press('Enter')
                try: await page.evaluate("bobBridgeCall('context')")
                except Exception as e: assert 'Select fewer cells' in str(e)
                else: raise AssertionError('Oversized selection accepted')
                print('Oversized spreadsheet selections return clear bounds error')
                await page.get_by_role('button',name='Back to file library',exact=True).click()
                await page.get_by_role('button',name='Synthetic csv.csv',exact=True).click()
                editor=page.frame_locator('iframe').first
                await editor.get_by_text('Choose CSV options',exact=True).wait_for(timeout=60000)
                await editor.get_by_role('button',name='OK',exact=True).click()
                await page.get_by_text('Ready to edit',exact=True).wait_for(timeout=120000)
                await page.evaluate('window.bobBridgeConnected=false');await connect()
                snapshot=await page.evaluate("bobBridgeCall('context')")
                plan={'version':1,'kind':'cell','reply':'Synthetic CSV','actions':[{'type':'set_cells','sheet':None,'range':'A1:B2','values':[['Label','Value'],['Synthetic CSV',42]]}]}
                assert (await page.evaluate("p=>bobBridgeCall('apply',p)",{'plan':plan,'expectedContext':snapshot}))['applied']==1
                await page.get_by_role('button',name='Save to Office Suite',exact=True).click()
                await page.get_by_text('Saved to Office Suite',exact=True).wait_for(timeout=90000)
                raw=(await api.get('/api/office/files/'+files[2]['id']+'/download')).content
                assert b'Synthetic CSV' in raw and b'42' in raw and not raw.startswith(b'PK')
                print('Verified CSV bridge changes saved as CSV to Office Suite')
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
