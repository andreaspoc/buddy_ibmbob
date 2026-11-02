"""Synthetic UI regression: scaled member chat must not cover composing controls."""
import asyncio
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280,'height':800})
        page.set_default_timeout(12000)
        errors=[]
        unread_count=0
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:shape-fixture','seen')")
        async def respond(route):
            path=urlsplit(route.request.url).path
            if path=='/' or path.startswith(('/assets/','/static/')) or path.endswith(('.svg','.png','.ico')):
                await route.continue_();return
            data=[]
            if path=='/auth/status': data={'user':{'username':'shape-fixture','is_admin':False}}
            elif path=='/api/community/rooms': data=[{'id':10,'kind':'direct','name':'Synthetic member','subscribed':True,'unread_count':unread_count}] if unread_count else []
            elif path=='/personalization/tutorials': data={'disabled':True}
            elif path=='/api/apps': data={'apps':[{'id':'people','name':'Member chat','description':'Synthetic app fixture','kind':'installed','desktop_only':False,'launch':{'kind':'people'}}]}
            elif path.endswith('/capabilities'): data={'web_search':False}
            elif path.startswith('/auth/microsoft'): data={'configured':False,'connected':False}
            await route.fulfill(json=data)
        await page.route('**/*',respond)
        url=os.getenv('CARBON_PREVIEW_URL','http://127.0.0.1:8080')
        await page.goto(url)
        await page.locator('.member-chat-launcher').wait_for()
        await page.wait_for_function("() => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) === .85")
        async def clear_composer():
            await page.locator('#prompt-input').fill('')
            await page.locator('#prompt-input').blur()
        async def check_gap():
            await page.wait_for_function('''() => {
                const launcher=document.querySelector('.member-chat-launcher')?.getBoundingClientRect();
                const composer=document.querySelector('.composer-wrap')?.getBoundingClientRect();
                return launcher && composer && launcher.bottom <= composer.top-8 && launcher.top >= 0 && launcher.right <= innerWidth+1;
            }''')
            assert await page.locator('.member-chat-launcher').evaluate('''el => {
                const a=el.getBoundingClientRect(),b=document.querySelector('.send-button').getBoundingClientRect();
                return !(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top);
            }'''), 'Member chat covers the main send button'
        for width,height in [(1280,800),(1440,900),(1920,1080)]:
            await page.set_viewport_size({'width':width,'height':height})
            for scale in ('85','75','100'):
                await page.get_by_role('button',name='Settings menu',exact=True).click()
                await page.get_by_role('combobox',name='Display scale',exact=True).select_option(scale)
                await page.keyboard.press('Escape')
                await page.wait_for_function('(scale)=>Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"))-Number(scale)/100)<.001',arg=scale)
                await clear_composer()
                await check_gap()
                await page.locator('#prompt-input').fill('\n'.join(['Synthetic multiline draft']*8))
                await page.locator('#prompt-input').blur()
                await check_gap()
                await page.locator('.member-chat-launcher').click()
                await page.locator('.member-chat-panel').wait_for()
                await page.wait_for_function('''() => {
                    const p=document.querySelector('.member-chat-panel').getBoundingClientRect();
                    const l=document.querySelector('.member-chat-launcher').getBoundingClientRect();
                    return p.top>=-1 && p.bottom <= l.top-8 && p.height>150;
                }''')
                assert await page.locator('.member-chat-panel').evaluate("el=>getComputedStyle(el).borderRadius==='0px'")
                await page.locator('.member-chat-launcher').click()
                await clear_composer()
            print(f'PASS member chat clearance: {width}x{height}, 75/85/100%, expanded draft and panel',flush=True)
        await page.set_viewport_size({'width':1280,'height':800})
        await page.get_by_role('button',name='Settings menu',exact=True).click()
        await page.get_by_role('combobox',name='Display scale',exact=True).select_option('85')
        await page.get_by_role('combobox',name='Display density',exact=True).select_option('comfortable')
        await page.keyboard.press('Escape')
        await check_gap()
        await page.locator('.sidebar').get_by_role('button',name='Notes',exact=True).click()
        await page.locator('.notes-workspace').wait_for()
        await page.wait_for_function("() => document.querySelector('.member-chat-launcher').getBoundingClientRect().bottom > innerHeight-40")
        await page.get_by_role('button',name='← Back to chat',exact=True).click()
        await page.locator('#prompt-input').wait_for()
        await check_gap()
        assert await page.locator('.composer').evaluate("el=>getComputedStyle(el).borderRadius==='8px'")
        assert await page.locator('.live-dot').first.evaluate("el=>getComputedStyle(el).borderRadius==='50%'")
        # Authored slide content is outside the UI geometry contract.
        protected=await page.evaluate('''() => {
            const stage=document.createElement('div');stage.className='html-deck-stage';
            const button=document.createElement('button');button.style.borderRadius='18px';stage.append(button);document.body.append(stage);
            const radius=getComputedStyle(button).borderRadius;stage.remove();return radius;
        }''')
        assert protected=='18px'
        for count,display in [(5,'5'),(42,'42'),(120,'99+'),(0,None)]:
            unread_count=count
            await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
            badge=page.locator('.member-chat-launcher .member-chat-unread')
            if display is None:
                await badge.wait_for(state='detached')
            else:
                await page.wait_for_function('(text)=>document.querySelector(".member-chat-launcher .member-chat-unread")?.textContent===text',arg=display)
                assert f'{count} unread messages' in await page.locator('.member-chat-launcher').get_attribute('aria-label')
            await check_gap()
        assert await page.locator('.member-chat-launcher').evaluate("el=>{const r=el.getBoundingClientRect();return Math.abs(r.width-r.height)<1&&getComputedStyle(el).borderRadius==='50%'}")
        unread_count=5
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await page.locator('.member-chat-launcher .member-chat-unread').wait_for()
        print('PASS circular launcher, live unread counts, zero state and 99+ display with exact accessible total',flush=True)
        await page.screenshot(path='/tmp/carbon-corners-85.png',animations='disabled')
        assert not errors,errors
        print('PASS live density/view changes, square UI corners, circular status indicators and authored content protection',flush=True)
        touch=await browser.new_page(has_touch=True,viewport={'width':390,'height':844})
        touch.on('pageerror',lambda error:errors.append(str(error)))
        await touch.route('**/*',respond)
        await touch.goto(url)
        await touch.locator('.member-chat-launcher').wait_for()
        await touch.wait_for_function("() => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) === .85")
        await touch.wait_for_function("() => document.querySelector('.member-chat-launcher').getBoundingClientRect().bottom <= document.querySelector('.composer-wrap').getBoundingClientRect().top-8")
        await touch.locator('#prompt-input').focus()
        await touch.evaluate("Object.defineProperty(visualViewport,'height',{configurable:true,value:360});visualViewport.dispatchEvent(new Event('resize'))")
        await touch.wait_for_function("() => document.querySelector('#prompt-input').getBoundingClientRect().bottom <= 361")
        assert await touch.locator('.member-chat-launcher').is_hidden(), 'Floating chat must not intercept touch composing'
        assert not errors,errors
        print('PASS touch keyboard viewport and focused-composer clearance',flush=True)
        await browser.close()

asyncio.run(main())
