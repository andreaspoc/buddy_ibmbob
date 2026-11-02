"""Carbon UI regression checks using explicitly synthetic API responses.

Run against a built preview with CARBON_PREVIEW_URL. No real user data or writes.
"""
import asyncio
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page()
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen')")

        async def respond(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/', '/static/')) or path.endswith(('.svg', '.png', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'is_admin': True}}
            elif path == '/api/apps':
                data = {'apps': [{'id': key, 'name': name, 'description': 'Synthetic app fixture', 'kind': 'installed', 'desktop_only': key == 'office', 'launch': {'kind': key}} for key, name in [('office', 'Office Suite'), ('people', 'Member chat')]]}
            elif path in ('/api/office/files', '/api/office/folders'):
                data = {'items': []}
            elif path == '/api/office/chat-capabilities':
                data = {'version': 1}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path == '/access/me':
                data = {'user': {'username': 'fixture-user', 'is_admin': True}, 'libraries': [], 'audiences': [], 'administrator': True}
            elif path == '/admin/users':
                data = {'users': [], 'pending_admins': []}
            elif path == '/admin/audit':
                data = {'events': [], 'next_before_id': None}
            elif path == '/admin/feedback/quality':
                data = {'days': 30, 'totals': dict.fromkeys(('reports', 'open', 'reviewed', 'resolved', 'reporters'), 0), 'categories': [], 'sources': [], 'trend': []}
            elif path == '/admin/feedback':
                data = {'items': [], 'next_before_id': None}
            elif path == '/admin/smtp':
                data = {'enabled': False, 'host': '', 'port': 587, 'security': 'starttls', 'username': '', 'from_address': '', 'from_name': '', 'password_configured': False}
            elif path.endswith('/capabilities'):
                data = {'web_search': False}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(json=data)

        await page.route('**/*', respond)
        url = os.getenv('CARBON_PREVIEW_URL', 'http://127.0.0.1:8080')
        for language in ('en', 'el', 'hi', 'mt'):
            await page.add_init_script(f"localStorage.setItem('bob-ui-language', '{language}')")
            for width, height in [(320, 568), (390, 844), (667, 375), (768, 1024), (1280, 800), (1920, 1080)]:
                await page.set_viewport_size({'width': width, 'height': height})
                await page.goto(url)
                await page.locator('#prompt-input').wait_for()
                await page.evaluate('document.fonts.ready')
                result = await page.evaluate('''() => {
                    const font = el => getComputedStyle(el).fontFamily.includes('IBM Plex Sans');
                    const header = document.querySelector('.topbar');
                    const rect = header.getBoundingClientRect();
                    const children = [...header.querySelectorAll('.topbar-heading,.mobile-menu,.workspace-navigation > *,.topbar-notifications,.topbar-actions > *')].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
                    return {
                        overflow: document.documentElement.scrollWidth > innerWidth + 1,
                        headerOutside: children.some(r => r.left < rect.left-1 || r.right > rect.right+1 || r.bottom > rect.bottom+1),
                        headerOverlap: children.some((a,i) => children.slice(i+1).some(b => a.left < b.right-1 && a.right > b.left+1 && a.top < b.bottom-1 && a.bottom > b.top+1)),
                        wrongFont: [...document.querySelectorAll('button,input,select,textarea,h1,h2')].some(el => !font(el)),
                        roundedUi: [...document.querySelectorAll('.welcome-buddy-hero,.workspace-menu-trigger,.workspace-notes-tab')].some(el => getComputedStyle(el).borderRadius !== '0px'),
                        fontLoaded: [...document.fonts].some(f => f.family === 'IBM Plex Sans' && f.weight === '400' && f.status === 'loaded'),
                        promptVisible: (() => { const r = document.querySelector('#prompt-input').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight+1; })(),
                    };
                }''')
                assert not result['overflow'] and not result['headerOutside'] and not result['headerOverlap'], (language, width, result)
                assert not result['roundedUi'] and not result['wrongFont'] and result['fontLoaded'] and result['promptVisible'], (language, width, result)
            print(f'PASS Carbon typography and layout: {language}, six viewport sizes', flush=True)

        await page.add_init_script("localStorage.setItem('bob-ui-language', 'en')")
        for width, height in [(390, 844), (1440, 1000)]:
            await page.set_viewport_size({'width': width, 'height': height})
            for action, selector in [('Tasks', '.tasks-view'), ('Notes', '.notes-workspace'), ('Knowledge base', '.knowledge-page')]:
                await page.goto(url)
                if width <= 1100:
                    await page.locator('.mobile-menu').click()
                await page.locator('.sidebar').get_by_role('button', name=action, exact=True).click()
                await page.locator(selector).wait_for()
                assert await page.locator('.error-boundary-card').count() == 0, action
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), (width, action)
                headings = page.locator(selector).locator('h1,h2')
                assert await headings.first.evaluate("el => getComputedStyle(el).fontFamily.includes('IBM Plex Sans') && getComputedStyle(el).fontWeight === '600'"), action
            await page.goto(url)
            await page.get_by_role('button', name='Settings menu', exact=True).click()
            menu = page.get_by_role('dialog', name='Settings menu', exact=True)
            assert await menu.is_visible()
            assert await menu.evaluate("el=>getComputedStyle(el).borderRadius==='0px'")
            assert await menu.locator('button').first.evaluate("el => getComputedStyle(el).fontSize === '14px'")
            await menu.get_by_role('button', name='User groups & administrators', exact=True).click()
            await page.locator('.administration-page').wait_for()
            await page.wait_for_timeout(150)
            assert await page.locator('.error-boundary-card').count() == 0
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
            await page.screenshot(animations='disabled', path=f'/tmp/carbon-administration-{width}.png')
            await page.goto(url)
            await page.locator('#prompt-input').wait_for()
            await page.screenshot(animations='disabled', path=f'/tmp/carbon-chat-{width}.png')
            print(f'PASS Carbon workspaces and settings: {width}px', flush=True)
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await page.goto(url)
        await page.get_by_role('button', name='Office Suite', exact=True).click()
        office = page.get_by_role('dialog', name='Office Suite', exact=True)
        await office.wait_for()
        assert await office.evaluate("el=>getComputedStyle(el).borderRadius==='0px'")
        await page.get_by_role('heading', name='A fresh workspace', exact=True).wait_for()
        assert await office.locator('h1').evaluate("el => getComputedStyle(el).fontFamily.includes('IBM Plex Sans') && getComputedStyle(el).fontWeight === '600'")
        assert await office.get_by_role('textbox', name='Search office files', exact=True).evaluate("el => getComputedStyle(el).fontSize === '14px'")
        await page.screenshot(animations='disabled', path='/tmp/carbon-office.png')
        await page.get_by_role('button', name='Close Office Suite', exact=True).click()
        await page.get_by_role('button', name='Open member chat', exact=True).click()
        chat = page.locator('.member-chat-panel')
        await chat.wait_for()
        assert await chat.locator('h2').first.evaluate("el => getComputedStyle(el).fontFamily.includes('IBM Plex Sans') && getComputedStyle(el).fontWeight === '600'")
        await page.screenshot(animations='disabled', path='/tmp/carbon-people.png')
        assert await page.locator('.error-boundary-card').count() == 0
        print('PASS Carbon Office and member chat', flush=True)
        assert not errors, errors
        await browser.close()


asyncio.run(main())
