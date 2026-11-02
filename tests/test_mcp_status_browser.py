"""Automatic status in Tools, using explicitly synthetic MCP browser fixtures."""
import asyncio,json,os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    checks=[]; errors=[]; online=True
    async with async_playwright() as runtime:
        browser=await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda error: errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('bob-ui-language','en');sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
        async def route_request(route):
            path=urlsplit(route.request.url).path
            if path=='/' or path.startswith('/assets/') or path.endswith(('.svg','.png','.ico')):
                await route.continue_();return
            data=[]
            if path=='/auth/status':data={'user':{'username':'fixture-user','display_name':'Synthetic User','is_admin':False}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path=='/mcps':data=[{'name':'shared-fixture','transport':'stdio','target':'fixture','can_manage':False}, {'name':'disabled-fixture','transport':'stdio','target':'fixture','disabled':True}]
            elif path=='/mcp-catalog':data=[{'id':'catalog-fixture','name':'Synthetic Catalog','description':'Fixture only','allowed':True,'connected':True,'enabled':True,'ready':True,'fields':[],'users':[],'groups':[]}]
            elif path.endswith('/check'):
                checks.append(path)
                data={'status':'working' if online else 'error','message':'Synthetic health result','tools':['fixture_tool'],'checked_at':'2026-10-15T00:00:00Z'}
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await route.fulfill(status=200,content_type='application/json',body=json.dumps(data))
        await page.route('**/*',route_request)
        await page.clock.install()
        await page.goto(os.getenv('LANGUAGE_PREVIEW_URL','http://127.0.0.1:8080'))
        await page.get_by_role('button',name='Settings menu',exact=True).click()
        await page.get_by_role('button',name='Add connections',exact=True).click()
        dialog=page.get_by_role('dialog',name='MCP server catalogue',exact=True)
        await dialog.locator('.mcp-connection-card').filter(has_text='shared-fixture').get_by_role('status').filter(has_text='Online').wait_for()
        await dialog.locator('.catalog-card').get_by_role('status').filter(has_text='Online').wait_for()
        assert sorted(checks)==['/mcp-catalog/catalog-fixture/check','/mcps/shared-fixture/check'], checks
        await dialog.locator('.mcp-connection-card').filter(has_text='disabled-fixture').get_by_role('status').filter(has_text='Disabled').wait_for()
        online=False
        await page.clock.fast_forward(61000)
        await dialog.locator('.catalog-card').get_by_role('status').filter(has_text='Offline').wait_for()
        card=dialog.locator('.mcp-connection-card').filter(has_text='shared-fixture')
        await card.get_by_role('button',name='Test again',exact=True).click()
        await card.get_by_role('status').filter(has_text='Offline').wait_for()
        await dialog.get_by_role('button',name='Refresh catalog',exact=True).click()
        await dialog.locator('.catalog-card').get_by_role('status').filter(has_text='Offline').wait_for()
        assert '/mcps/disabled-fixture/check' not in checks
        assert not errors,errors
        await browser.close()
    print('PASS: Tools shows shared/catalog MCPs, auto checks, disabled state, rechecks and refreshed failures (synthetic fixtures).')

asyncio.run(main())
