"""Admin management through Tools, with synthetic responses and no real mutations."""
import asyncio,json,os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    errors=[]; writes=[]
    template={'id':'fixture','name':'Synthetic server','description':'Fixture only','icon':'plug','transport':'http','url':'https://example.invalid/mcp','args':[],'fields':[],'users':[],'groups':[],'access_mode':'grants','enabled':True,'allowed':False,'ready':True,'connected':False,'auth_mode':'none'}
    async with async_playwright() as runtime:
        browser=await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1440,'height':900})
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('bob-ui-language','en');sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
        async def route_request(route):
            req=route.request; path=urlsplit(req.url).path
            if path=='/' or path.startswith('/assets/') or path.endswith(('.svg','.png','.ico')):
                await route.continue_();return
            data=[]
            if path=='/auth/status':data={'user':{'username':'fixture-user','display_name':'Synthetic Admin','is_admin':True}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path=='/admin/users':data={'users':[{'username':'fixture-user','display_name':'Synthetic Admin'}]}
            elif path=='/mcps':data=[{'name':'shared-fixture','transport':'stdio','target':'fixture','can_manage':True}]
            elif path=='/mcps/shared-fixture/config':data={'command':'fixture','args':[],'env':{}}
            elif path=='/mcps/shared-fixture/access':writes.append((path,req.post_data_json));data={}
            elif path=='/mcp-catalog':data=[template]
            elif path=='/mcp-catalog/fixture/access':
                writes.append((path,req.post_data_json));template.update(req.post_data_json,allowed=True);data={}
            elif path.endswith('/check'):data={'status':'working','message':'Synthetic handshake','tools':[]}
            elif path.startswith('/auth/microsoft'):data={'connected':False,'configured':False}
            await route.fulfill(status=200,content_type='application/json',body=json.dumps(data))
        await page.route('**/*',route_request)
        await page.goto(os.getenv('LANGUAGE_PREVIEW_URL','http://127.0.0.1:8080'))
        await page.get_by_role('button',name='Settings menu',exact=True).click()
        await page.get_by_role('button',name='Add connections',exact=True).click()
        dialog=page.get_by_role('dialog',name='MCP server catalogue',exact=True)
        shared=dialog.locator('.mcp-connection-card')
        await shared.get_by_label('Available to',exact=True).select_option('both')
        await shared.get_by_role('button',name='Save access',exact=True).click()
        await shared.get_by_text('Connection access saved.',exact=True).wait_for()
        await dialog.get_by_role('button',name='Assign access',exact=True).click()
        form=dialog.get_by_role('form',name='Assign MCP server access',exact=True)
        await form.wait_for()
        assert await form.evaluate('(el) => el.getBoundingClientRect().top < innerHeight'), 'Access form must scroll into view'
        await form.get_by_label('All company employees',exact=True).check()
        await form.get_by_role('button',name='Save access',exact=True).click()
        await dialog.get_by_role('button',name='Edit template & access',exact=True).click()
        await dialog.get_by_label('Name',exact=True).wait_for()
        assert await dialog.get_by_label('Name',exact=True).evaluate('(el) => el.getBoundingClientRect().top < innerHeight'), 'Configuration must scroll into view'
        await dialog.locator('.catalog-form').get_by_role('button',name='Cancel',exact=True).click()
        await shared.get_by_role('status').filter(has_text='Online').wait_for()
        await shared.get_by_role('button',name='Configure shared-fixture',exact=True).click()
        await page.get_by_role('heading',name='Configure shared-fixture',exact=True).wait_for()
        assert await page.get_by_role('dialog',name='MCP server catalogue',exact=True).count()==0
        assert len(writes)==2,writes
        assert not errors,errors
        await browser.close()
    print('PASS: administrators can assign shared/catalog access and open configuration from Tools; editors scroll into view (synthetic fixtures).')
asyncio.run(main())
