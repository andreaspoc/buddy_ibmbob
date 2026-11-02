"""Synthetic auth/data checks against the built app; no real user account or notes."""
import asyncio,json,os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1280,'height':900})
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        async def request(route):
            path=urlsplit(route.request.url).path
            if path in ('/','/notes','/notes/') or path.startswith(('/assets/','/static/')) or path.endswith(('.png','.svg','.ico')):
                await route.continue_();return
            data=[]
            if path=='/auth/status':data={'user':{'username':'fixture-user','is_admin':False}}
            elif path=='/api/notes':data={'items':[],'next_before_id':None,'default_collection':'2026-10-15'}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path.endswith('/capabilities'):data={'web_search':True}
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await route.fulfill(json=data)
        await page.route('**/*',request)
        base=os.getenv('NOTES_APP_URL','http://127.0.0.1:8080')
        await page.goto(base+'/notes')
        await page.locator('[data-notes-workspace]').wait_for()
        await expect(page.locator('.workspace-hub')).to_have_count(1, timeout=2000)
        await expect(page.locator('.wh-toolbar')).to_have_count(0)
        language=page.locator('.workspace-toolbar-language select')
        await language.wait_for()
        assert await page.locator('.workspace-tools-panel .language-selector').count()==0
        await page.screenshot(path='/tmp/notes-route-initial.png',full_page=True)
        await page.get_by_role('button',name='Back to chat').click(timeout=5000)
        assert urlsplit(page.url).path=='/'
        await page.locator('.workspace-notes-tab').click()
        assert urlsplit(page.url).path=='/notes'
        await page.go_back()
        assert urlsplit(page.url).path=='/'
        await page.go_forward()
        await page.locator('[data-notes-workspace]').wait_for()
        await page.reload()
        await page.locator('[data-notes-workspace]').wait_for()
        await page.locator('.sidebar-nav').get_by_role('button',name='Tasks',exact=True).click()
        assert urlsplit(page.url).path=='/'
        await expect(page.locator('.workspace-hub')).to_have_count(1)
        await page.locator('.sidebar-nav').get_by_role('button',name='Notes',exact=True).click()
        await page.locator('[data-notes-workspace]').wait_for()
        assert urlsplit(page.url).path=='/notes'
        # Account-scoped sibling views must never leave orphaned toolbar instances.
        for _ in range(4):
            await page.get_by_role('button',name='Back to chat').click()
            await expect(page.locator('.workspace-hub')).to_have_count(1)
            await page.locator('.workspace-notes-tab').click()
            await page.locator('[data-notes-workspace]').wait_for()
            assert urlsplit(page.url).path=='/notes'
            await expect(page.locator('.workspace-hub')).to_have_count(1)
            await expect(page.locator('.wh-toolbar')).to_have_count(0)
        await page.get_by_role('button', name='Buddy menu', exact=True).click()
        await page.get_by_role('button', name='Commands', exact=True).click()
        await expect(page.locator('.wh-palette')).to_have_count(1)
        await page.keyboard.press('Escape')
        await expect(page.locator('.wh-palette')).to_have_count(0)
        await page.keyboard.press('Control+Shift+K')
        await expect(page.locator('.wh-palette')).to_have_count(1)
        await page.keyboard.press('Escape')
        for width in [1280,768,390,320]:
            await page.set_viewport_size({'width':width,'height':900})
            await page.wait_for_timeout(150)
            await expect(page.locator('.wh-toolbar')).to_have_count(0)
            box=await language.bounding_box()
            assert box and box['x']>=0 and box['x']+box['width']<=width+1,(width,box)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),width
        await page.screenshot(path='/tmp/notes-workspace-toolbar-mobile.png',full_page=True)
        assert not errors,errors
        print('Notes direct URL, back/forward, refresh, repeated navigation, no top shortcut row, single workspace/palette, keyboard shortcuts, visible language and mobile checks passed')
        await browser.close()
asyncio.run(main())
