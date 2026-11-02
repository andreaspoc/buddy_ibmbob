"""Synthetic regression: sidebar catalog latency must not delay chat submission."""
import asyncio,json,os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    gate=asyncio.Event();received=asyncio.Event();created=False
    sid='a'*32
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(has_touch=True,viewport={'width':390,'height':844})
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen')")
        async def route(r):
            nonlocal created
            path=urlsplit(r.request.url).path
            if path=='/' or path.startswith(('/assets/','/src/','/@','/node_modules/','/static/')) or path.endswith(('.svg','.png','.ico')):
                await r.continue_();return
            data=[]
            if path=='/auth/status':data={'user':{'username':'fixture-user','is_admin':False}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path.endswith('/capabilities'):data={'web_search':False}
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            elif path=='/presentation/intent':data={'presentation':False,'templates':[],'html_artifact':False}
            elif path=='/sessions':
                if r.request.method=='POST':
                    created=True;data={'id':sid}
                elif created:
                    await gate.wait()
                    data=[{'id':sid,'title':'Synthetic startup check','updated_at':0}]
            elif path=='/chat/stream':
                received.set()
                body=r.request.post_data_json
                correlation={key:body[key] for key in ('correlation_id','user_message_id','assistant_message_id')}
                correlation['workspace_id']=sid
                events=[{'type':'start'},{'type':'delta','text':'Synthetic timing response.'},{'type':'done'}]
                await r.fulfill(content_type='application/x-ndjson',body='\n'.join(json.dumps({**event,**correlation}) for event in events)+'\n');return
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.goto(os.getenv('RESPONSIVE_PREVIEW_URL','http://127.0.0.1:3003'))
        await page.locator('#prompt-input').fill('Synthetic startup check')
        await page.locator('.send-button').click()
        try:
            await asyncio.wait_for(received.wait(),timeout=5)
            assert not gate.is_set()
            await page.get_by_text('Synthetic timing response.',exact=True).wait_for()
            print('PASS chat submitted and first text rendered while sidebar refresh remains pending',flush=True)
        finally:
            gate.set()
            await browser.close()
asyncio.run(main())
