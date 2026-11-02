import asyncio
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        # Synthetic notification fixtures; no operational data.
        notices=[dict(id='design-fixture',kind='task',title='Notification design fixture',status='completed',occurred_at='2026-10-16T10:00:00Z',read_at=None,job_id='fixture-job',session_id='fixture-session')]
        reads=[]
        async def route(r):
            from urllib.parse import urlsplit
            path=urlsplit(r.request.url).path
            if path=='/' or path.startswith(('/assets/','/static/')):
                await r.continue_(); return
            data=[]
            if path=='/auth/status':data={'user':{'username':'notification-design-fixture','display_name':'Design Fixture','is_admin':False}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path=='/notifications':data=notices
            elif path=='/notifications/read':
                reads.append(r.request.post_data)
                notices[0]['read_at']='2026-10-16T10:01:00Z'
                data={'ok':True}
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.add_init_script("sessionStorage.setItem('buddy-welcome-v1:notification-design-fixture','seen')")
        await page.goto('http://127.0.0.1:8080')
        bell=page.locator('.topbar-notifications')
        await expect(bell).to_be_visible()
        await bell.click()
        dialog=page.locator('.notification-inbox')
        await expect(dialog).to_be_visible()
        await expect(dialog.locator('.notification-card.is-unread')).to_have_count(1)
        await page.screenshot(path='/tmp/notification-inbox-desktop.png')
        await dialog.get_by_role('button',name='Mark read',exact=True).click()
        await expect(dialog.locator('.notification-card.is-unread')).to_have_count(0)
        await dialog.get_by_role('button',name='Unread',exact=False).click()
        await expect(dialog.locator('.notification-empty')).to_be_visible()
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        await expect(bell).to_be_focused()
        await page.set_viewport_size({'width':390,'height':844})
        await bell.click()
        await expect(dialog).to_be_visible()
        assert await dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth'), 'Inbox overflow'
        await page.screenshot(path='/tmp/notification-inbox-mobile.png')
        assert len(reads)==1,reads
        assert not errors,errors
        print('PASS: inbox filtering, mark read, Escape, restored focus, desktop/mobile layout; no browser errors')
        await browser.close()
asyncio.run(main())
