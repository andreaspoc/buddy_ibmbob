"""Carbon answer actions using synthetic browser fixtures only."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

SID = 'a' * 32


async def main():
    build = os.getenv('TOOLBAR_PREVIEW_BUILD')
    base = os.getenv('TOOLBAR_PREVIEW_URL', 'http://127.0.0.1:8080')
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce', accept_downloads=True)
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("""localStorage.setItem('bob-ui-language','en');
            sessionStorage.setItem('buddy-approval-guide:toolbar-fixture','seen');
            Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureClipboard=text}},configurable:true});""")

        async def handle(route):
            path = urlsplit(route.request.url).path
            if path in ('/', '/notes', '/office') or path.startswith('/assets/'):
                if build:
                    file = Path(build) / (path.lstrip('/') if path.startswith('/assets/') else 'index.html')
                    await route.fulfill(path=str(file))
                else:
                    await route.continue_()
                return
            if path.endswith(('.svg', '.png', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'toolbar-fixture', 'display_name': 'Toolbar Fixture', 'is_admin': True}}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path == '/api/apps':
                data = {'apps': [{'id': 'office', 'name': 'Office Suite', 'description': 'Synthetic office launcher', 'kind': 'installed', 'desktop_only': True, 'launch': {'kind': 'office'}}]}
            elif path == '/api/office/status':
                data = {'ready': True}
            elif path in ('/api/office/files', '/api/office/folders', '/api/notes'):
                data = {'items': []}
            elif path == '/sessions':
                data = [{'id': SID, 'title': 'Synthetic toolbar data', 'updated_at': 1}]
            elif path == f'/sessions/{SID}/history':
                data = [{'type': 'request', 'prompt': 'Synthetic table fixture', 'mode': 'agent'}, {'type': 'delta', 'text': '| Name | Value |\n| --- | --- |\n| Alpha | 10 |\n| Beta | 20 |'}, {'type': 'done', 'tokens': 1200, 'cost': 0.002}]
            elif path == '/feedback/answer':
                data = {'sources': [], 'submitted': None}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))

        await page.route('**/*', handle)
        await page.goto(base + '/?conversation=' + SID)
        grid = page.locator('.it-toolbar')
        await grid.wait_for()
        actions = page.get_by_role('group', name='Answer actions', exact=True)
        labels = ['Copy answer', 'Delete answer', 'Share to people', 'Make notes', 'Branch conversation', 'Read aloud', 'Report an issue', 'Executive Deck']
        for label in labels:
            button = actions.get_by_role('button', name=label, exact=True)
            assert await button.locator('svg').count() == 1, label
            assert await button.evaluate('el=>el.getBoundingClientRect().width') >= 32, label
            await button.hover()
            assert await button.locator('.answer-action-tooltip').is_visible(), label
            await page.keyboard.press('Escape')
            assert not await button.locator('.answer-action-tooltip').is_visible(), label
            await page.mouse.move(0, 0)
            await button.focus()
            assert await button.locator('.answer-action-tooltip').is_visible(), label
            assert await button.evaluate('el=>getComputedStyle(el).outlineStyle') == 'solid', label
        await actions.get_by_role('button', name='Copy answer', exact=True).click()
        await actions.get_by_role('button', name='Copied', exact=True).wait_for()
        assert 'Alpha' in await page.evaluate('window.fixtureClipboard')
        usage = actions.locator('.answer-usage')
        await usage.focus()
        assert await usage.locator('.answer-action-tooltip').is_visible()
        assert 'Bobcoins' in await usage.locator('.answer-action-tooltip').inner_text()
        summary = actions.locator('.answer-details-compact > summary')
        await summary.focus()
        await summary.press('Enter')
        assert await actions.locator('.answer-details-compact').evaluate('el=>el.open')
        await summary.press('Enter')
        await actions.get_by_role('button', name='Share to people', exact=True).click()
        await page.get_by_role('dialog').filter(has=page.get_by_role('heading', name='Share to people', exact=True)).wait_for()
        await page.get_by_role('button', name='Close share dialog', exact=True).click()
        await actions.get_by_role('button', name='Report an issue', exact=True).click()
        await page.get_by_role('heading', name='Answer feedback', exact=True).wait_for()
        await page.get_by_role('button', name='Cancel', exact=True).click()
        for width in [320, 390, 768, 1440]:
            await page.set_viewport_size({'width': width, 'height': 1000})
            assert await actions.evaluate('el=>el.getBoundingClientRect().right <= innerWidth + 1')
        assert not errors, errors
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await actions.get_by_role('button', name='Make notes', exact=True).hover()
        await page.screenshot(path='/tmp/buddy-answer-actions.png')
        print('PASS Carbon icons, hover/focus tooltips, Escape dismissal, copy, native details, share/feedback dialogs and responsive actions')
        await browser.close()

asyncio.run(main())
