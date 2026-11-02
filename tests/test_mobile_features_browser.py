"""Touch layout and feature-access checks with explicitly synthetic API fixtures."""
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
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen')")
        async def respond(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/', '/src/', '/@', '/node_modules/', '/static/')) or path.endswith(('.svg','.png','.ico')):
                await route.continue_(); return
            data = []
            if path == '/auth/status': data = {'user': {'username': 'fixture-user', 'is_admin': True}}
            elif path == '/access/me': data = {'user': {'username': 'fixture-user', 'is_admin': True}, 'libraries': [], 'audiences': [], 'administrator': True}
            elif path == '/admin/users': data = {'users': [], 'pending_admins': []}
            elif path == '/api/apps': data = {'apps': [{'id': identity, 'name': label, 'description': 'Synthetic app fixture', 'kind': 'core', 'desktop_only': False, 'launch': {'kind': identity}} for identity, label in [('research', 'Research reports'), ('knowledge', 'Knowledge base'), ('productivity', 'Productivity workspace'), ('workflows', 'Workflows'), ('search', 'Search saved work'), ('presentations', 'Presentations')]]}
            elif path == '/personalization/tutorials': data = {'disabled': True}
            elif path.endswith('/capabilities'): data = {'web_search': False}
            elif path.startswith('/auth/microsoft'): data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))
        await page.route('**/*', respond)
        url = os.getenv('RESPONSIVE_PREVIEW_URL', 'http://127.0.0.1:3002')
        features = [('Buddy menu','Memory & presets'), ('Apps','Research reports'),
                    ('Apps','Knowledge base'), ('Apps','Productivity workspace'),
                    ('Topbar','Notifications'), ('Settings menu','Add connections'),
                    ('Settings menu','Add agents'), ('Apps','Search saved work'),
                    ('Buddy menu','Compare documents'), ('Apps','Workflows'),
                    ('Settings menu','My access'), ('Settings menu','User groups & administrators'),
                    ('Settings menu','Connected services'), ('Settings menu','Mods')]
        for width,height in [(320,568),(390,844),(768,1024),(820,1180),(1180,820),(1024,1366),(1366,1024),(844,390)]:
            await page.set_viewport_size({'width':width,'height':height})
            for menu,action in features:
                await page.goto(url)
                if menu == 'Topbar':
                    await page.get_by_role('button', name=action, exact=True).click()
                else:
                    await page.get_by_role('button', name=menu, exact=True).click()
                    dialog = page.get_by_role('dialog', name=menu, exact=True)
                    if menu == 'Apps':
                        await dialog.locator('.installed-app-card').filter(has_text=action).click()
                    else:
                        await dialog.get_by_role('button',name=action,exact=True).click()
                await page.wait_for_timeout(150)
                assert await page.locator('.error-boundary-card').count() == 0, (width, height, action, 'render failed')
                result = await page.evaluate('''() => {
                    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
                    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(el => el.getBoundingClientRect().width);
                    return {overflow: document.documentElement.scrollWidth * scale > innerWidth+1,
                        dialogs: dialogs.map(el => {const r=el.getBoundingClientRect();return {label:el.getAttribute('aria-label'), outside:r.left < -1 || r.right > innerWidth+1 || r.top < -1 || r.bottom > innerHeight+1};})};
                }''')
                assert not result['overflow'] and not any(d['outside'] for d in result['dialogs']), (width,height,action,result)
            await page.goto(url)
            await page.locator('#prompt-input').fill('Synthetic mobile draft')
            # Model an iOS keyboard shrinking the visual viewport without a layout resize.
            await page.evaluate('''() => {
                Object.defineProperty(visualViewport, 'height', {configurable:true, value:Math.min(360,innerHeight)});
                visualViewport.dispatchEvent(new Event('resize'));
            }''')
            await page.wait_for_timeout(100)
            assert await page.locator('#prompt-input').evaluate('el => el.getBoundingClientRect().bottom <= visualViewport.height+1'), (width,height,'keyboard covers composer')
            assert await page.locator('#prompt-input').input_value() == 'Synthetic mobile draft'
            await page.evaluate("delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize'))")
            print(f'PASS touch {width}x{height}: 14 feature entries and keyboard viewport', flush=True)
        assert not errors, errors
        await browser.close()

asyncio.run(main())
