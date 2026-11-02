"""Simple sign-in UX using synthetic auth responses; no account mutations."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(has_touch=True)
        page.set_default_timeout(10000)
        options = {'user': None, 'local_login_enabled': True, 'keycloak_configured': True}
        requests = []
        accept_login = False
        async def respond(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/','/src/','/@','/node_modules/','/static/')) or path.endswith(('.svg','.png','.ico')):
                await route.continue_(); return
            if path == '/auth/status':
                await route.fulfill(json=options); return
            if path in ('/auth/login','/auth/register'):
                requests.append((path, route.request.post_data_json))
                if accept_login:
                    await route.fulfill(json={'username':'synthetic-user','is_admin':False}); return
                await route.fulfill(status=401, json={'detail':'Synthetic credential error'}); return
            await route.fulfill(json=[])
        await page.route('**/*',respond)
        url = os.getenv('LOGIN_PREVIEW_URL', 'http://127.0.0.1:3003')
        for width,height in [(320,568),(390,844),(844,390),(768,1024),(820,1180),(1180,820),(1024,1366),(1366,1024),(1440,900)]:
            await page.set_viewport_size({'width':width,'height':height})
            for local,sso in [(True,True),(True,False),(False,True),(False,False)]:
                options.update(local_login_enabled=local,keycloak_configured=sso)
                await page.goto(url)
                await page.locator('.buddy-card-title').wait_for()
                await page.wait_for_timeout(100)
                assert await page.locator('.buddy-hero-section').count() == 0
                assert await page.locator('.buddy-capabilities-grid').count() == 0
                assert await page.locator('.buddy-error-banner').count() == 0
                if sso:
                    link=page.get_by_role('link',name='Sign in with Keycloak')
                    await link.scroll_into_view_if_needed()
                    assert await link.is_visible()
                    assert '/auth/keycloak/login?next=' in await link.get_attribute('href')
                if local:
                    await page.get_by_label('Username',exact=True).fill('synthetic-user')
                    password=page.get_by_label('Password',exact=True)
                    await password.fill('synthetic-password')
                    await page.get_by_role('button',name='Show password',exact=True).click()
                    assert await password.get_attribute('type') == 'text'
                    await page.get_by_role('button',name='Hide password',exact=True).click()
                    await password.focus()
                    await page.evaluate("Object.defineProperty(visualViewport,'height',{configurable:true,value:Math.min(340,innerHeight)});visualViewport.dispatchEvent(new Event('resize'))")
                    await page.wait_for_timeout(100)
                    assert await password.evaluate('el=>{const r=el.getBoundingClientRect();return r.top>=-1&&r.bottom<=visualViewport.height+1}'), (width,height,'keyboard')
                    await page.get_by_role('button',name='Sign In',exact=True).click()
                    await page.get_by_role('alert').filter(has_text='Synthetic credential error').wait_for()
                    assert requests[-1] == ('/auth/login',{'username':'synthetic-user','password':'synthetic-password'})
                    await page.get_by_role('button',name='Dismiss error').click()
                    if not sso:
                        await page.get_by_role('button',name='Create one',exact=True).click()
                        await page.get_by_role('button',name='Create Account',exact=True).click()
                        assert requests[-1][0] == '/auth/register'
                    await page.evaluate("delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'))")
                result=await page.evaluate('''() => {
                    const scale=Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1;
                    const nodes=[...document.querySelectorAll('.buddy-login-header,.buddy-input-field,.buddy-submit-button,.buddy-sso-button')];
                    return nodes.every(el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1}) && document.documentElement.scrollWidth*scale<=innerWidth+1;
                }''')
                assert result,(width,height,local,sso,'horizontal overflow')
                assert await page.locator('.error-boundary-card').count()==0
            print(f'PASS simplified login {width}x{height}: local/SSO, keyboard, password toggle, errors, registration, no overflow',flush=True)
        # A successful password response must not unlock the app without a session.
        accept_login = True
        options.update(local_login_enabled=True, keycloak_configured=True)
        await page.goto(url)
        await page.get_by_label('Username',exact=True).fill('synthetic-user')
        await page.get_by_label('Password',exact=True).fill('synthetic-password')
        await page.get_by_role('button',name='Sign In',exact=True).click()
        await page.get_by_role('alert').filter(has_text='Your session could not be saved.').wait_for()
        assert await page.locator('.topbar').count() == 0
        # A legacy secure-login URL must never hide the local form.
        options['local_login_url'] = 'https://secure.example.invalid'
        await page.goto(url)
        await page.get_by_label('Username',exact=True).wait_for()
        assert await page.get_by_label('Password',exact=True).is_visible()
        assert await page.get_by_role('link',name='Sign in with local credentials',exact=True).count() == 0
        assert await page.get_by_role('link',name='Sign in with Keycloak').get_attribute('href') == '/auth/keycloak/login?next=%2F'
        options.pop('local_login_url')
        print('PASS: local credentials always visible; session verified before tutorial; Keycloak link unchanged',flush=True)
        await page.screenshot(path='/tmp/buddy-simple-login-desktop.png')
        await page.set_viewport_size({'width':390,'height':844})
        options.update(local_login_enabled=True,keycloak_configured=True)
        await page.goto(url)
        await page.get_by_label('Username',exact=True).wait_for()
        await page.screenshot(path='/tmp/buddy-simple-login-mobile.png')
        await browser.close()
asyncio.run(main())
