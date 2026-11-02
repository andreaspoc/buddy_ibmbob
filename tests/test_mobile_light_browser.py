"""Compact phone UI with synthetic auth fixtures; no chat tasks are submitted."""
import asyncio,json,os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as runtime:
        browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(has_touch=True)
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen')")
        async def respond(route):
            path=urlsplit(route.request.url).path
            if path=='/' or path.startswith(('/assets/','/src/','/@','/node_modules/','/static/')) or path.endswith(('.svg','.png','.ico')):
                await route.continue_();return
            data=[]
            if path=='/auth/status':data={'user':{'username':'fixture-user','is_admin':True}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path.endswith('/capabilities'):data={'web_search':False}
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await route.fulfill(json=data)
        await page.route('**/*',respond)
        await page.goto(os.getenv('RESPONSIVE_PREVIEW_URL','http://127.0.0.1:3003'))
        await page.locator('.topbar').wait_for()
        resources=await page.evaluate("performance.getEntriesByType('resource').map(entry=>entry.name)")
        assert not any('/elk.bundled-' in url or '/pptxgen.es-' in url for url in resources), 'Heavy optional libraries loaded during normal chat'
        for width,height in [(320,568),(390,844),(430,932),(667,375)]:
            await page.set_viewport_size({'width':width,'height':height})
            await page.wait_for_timeout(100)
            toggle=page.get_by_role('button',name='Prompt templates',exact=True)
            await toggle.wait_for()
            assert await toggle.get_attribute('aria-expanded')=='false'
            assert await page.locator('.suggestions').is_hidden()
            assert await page.locator('.welcome-buddy-hero').evaluate("el=>getComputedStyle(el).backgroundImage==='none'&&getComputedStyle(el).boxShadow==='none'")
            assert await page.locator('.topbar').evaluate("el=>getComputedStyle(el).backdropFilter==='none'"), await page.locator('.topbar').evaluate("el=>({filter:getComputedStyle(el).backdropFilter,webkit:getComputedStyle(el).webkitBackdropFilter,width:innerWidth,light:matchMedia('(max-width:700px)').matches})")
            await toggle.click()
            assert await page.locator('.suggestions').is_visible()
            assert await page.locator('.suggestion').count()==6
            await page.locator('.suggestion-quick-edit-btn').last.scroll_into_view_if_needed()
            await toggle.click()
            assert await page.locator('.suggestions').is_hidden()
            await page.get_by_role('button',name='Compare options',exact=False).click()
            assert await page.locator('#prompt-input').input_value()=='Help me compare '
            await expect(page.locator('#prompt-input')).to_be_focused()
            for selector in ['.chat-context-bar select','.chat-context-bar button']:
                for control in await page.locator(selector).all():
                    await control.scroll_into_view_if_needed()
                    assert await control.evaluate('el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1}')
            assert await page.evaluate("document.documentElement.scrollWidth*(Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1)<=innerWidth+1")
            assert await page.locator('#prompt-input').evaluate('el=>el.getBoundingClientRect().bottom<=innerHeight+1')
            assert await page.locator('.member-chat-launcher').evaluate("el=>el.getBoundingClientRect().bottom<=document.querySelector('.composer-wrap').getBoundingClientRect().top+1"), 'Member chat covers composer'
            print(f'PASS lightweight phone {width}x{height}: collapsed templates, all controls reachable, flat surfaces, no overflow',flush=True)
        await page.set_viewport_size({'width':1440,'height':1000})
        await page.wait_for_timeout(100)
        assert await page.get_by_role('button',name='Prompt templates',exact=True).is_hidden()
        assert await page.locator('.suggestions').is_visible()
        assert await page.locator('.welcome-buddy-hero').evaluate("el=>getComputedStyle(el).backgroundImage!=='none'")
        assert not errors,errors
        print('PASS desktop keeps full welcome, visible templates and original styling; optional engines deferred',flush=True)
        await page.set_viewport_size({'width':390,'height':844})
        await page.wait_for_timeout(300)
        await page.locator('#prompt-input').fill('')
        await page.locator('.conversation').evaluate('el=>el.scrollTop=0')
        await page.locator('.chat-context-bar').evaluate('el=>el.scrollLeft=0')
        await page.screenshot(path='/tmp/buddy-light-mobile.png')
        await browser.close()
asyncio.run(main())
