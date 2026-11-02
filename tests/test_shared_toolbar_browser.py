"""Shared toolbar appearance and behavior using synthetic browser fixtures only."""
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
            elif path == '/api/office/files':
                data = {'items': [{'id':'11111111-1111-4111-8111-111111111111','name':'Synthetic review.docx','extension':'docx','size':100,'saved_at':'2026-10-20T08:00:00Z','revision':1,'access':'owner','is_owner':True}]}
            elif path == '/api/office/files/11111111-1111-4111-8111-111111111111':
                data = {'id':'11111111-1111-4111-8111-111111111111','name':'Synthetic review.docx','extension':'docx','size':100,'saved_at':'2026-10-20T08:00:00Z','revision':1,'access':'owner','is_owner':True}
            elif path == '/api/office/files/11111111-1111-4111-8111-111111111111/editor':
                data = {'script_url':'/11111111-1111-4111-8111-111111111111.js','config':{},'file':{'id':'11111111-1111-4111-8111-111111111111','access':'owner'}}
            elif path == '/11111111-1111-4111-8111-111111111111.js':
                await route.fulfill(content_type='text/javascript',body="window.DocsAPI={DocEditor:function(id,config){this.destroyEditor=()=>{};setTimeout(()=>config.events.onDocumentReady(),10)}}")
                return
            elif path in ('/api/office/folders', '/api/notes'):
                data = {'items': []}
            elif path == '/sessions':
                data = [{'id': SID, 'title': 'Synthetic toolbar data', 'updated_at': 1}]
            elif path == f'/sessions/{SID}/history':
                data = [{'type': 'request', 'prompt': 'Synthetic table fixture', 'mode': 'agent'}, {'type': 'delta', 'text': '| Name | Value |\n| --- | --- |\n| Alpha | 10 |\n| Beta | 20 |'}, {'type': 'done'}]
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))

        await page.route('**/*', handle)
        await page.goto(base + '/?conversation=' + SID)
        grid = page.locator('.it-toolbar')
        await grid.wait_for()
        reference = await grid.evaluate('el=>getComputedStyle(el).backgroundImage')
        assert reference == 'none', reference
        assert await grid.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(233, 223, 245)'
        for selector in ('.topbar', '.chat-context-bar', '.composer-header', '.it-toolbar'):
            bar = page.locator(selector)
            assert await bar.evaluate('el=>el.classList.contains("buddy-toolbar")'), selector
            assert await bar.evaluate('el=>getComputedStyle(el).backgroundImage') == reference, selector
        for selector in ('.workspace-menu-trigger', '.it-action-btn', '.it-search-input', '.chat-context-bar select'):
            control = page.locator(selector).first
            assert await control.evaluate('el=>getComputedStyle(el).color') == 'rgb(22, 22, 22)', selector
            assert await control.evaluate('el=>getComputedStyle(el).fontSize') == '14px', selector
            assert await control.evaluate('el=>getComputedStyle(el).minHeight') == '32px', selector
            assert await control.evaluate('el=>getComputedStyle(el).paddingTop') == '5px', selector
        copy_control = grid.locator('.it-action-btn').first
        normal_background = await copy_control.evaluate('el=>getComputedStyle(el).backgroundColor')
        await copy_control.hover()
        await page.wait_for_function('(background)=>getComputedStyle(document.querySelector(".it-action-btn")).backgroundColor!==background', arg=normal_background)
        assert await copy_control.evaluate('el=>getComputedStyle(el).backgroundColor') != normal_background
        await page.mouse.move(0, 0)
        assert await grid.locator('.it-view-btn.is-active').evaluate('el=>getComputedStyle(el).boxShadow') != 'none'
        await page.get_by_role('searchbox', name='Filter table rows', exact=True).fill('Alpha')
        assert await page.locator('.it-grid-table tbody tr').count() == 1
        await page.get_by_role('searchbox', name='Filter table rows', exact=True).fill('')
        await page.locator('.it-header-cell').last.click()
        await page.locator('.it-header-cell').last.click()
        assert 'Beta' in await page.locator('.it-grid-table tbody tr').first.inner_text()
        for label in ('Bar', 'Line', 'Donut', 'Table'):
            await grid.get_by_role('button', name=label, exact=False).click()
        await grid.get_by_role('button', name='Copy', exact=False).click()
        assert 'Alpha' in await page.evaluate('window.fixtureClipboard')
        async with page.expect_download() as download:
            await grid.get_by_role('button', name='CSV', exact=False).click()
        assert (await download.value).suggested_filename.endswith('.csv')
        print('PASS Data Grid filtering, sorting, chart views, Copy and CSV retain their behavior')

        for width, height in [(320, 568), (390, 844), (768, 1024), (1280, 720), (1440, 900), (1920, 1080)]:
            await page.set_viewport_size({'width': width, 'height': height})
            await page.wait_for_timeout(100)
            assert await page.locator('.mobile-menu').is_visible() == (width <= 1100), (width, 'sidebar toggle visibility changed')
            assert await page.evaluate("document.documentElement.scrollWidth*(Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1)<=innerWidth+1"), (width, 'page overflow')
            assert await page.locator('#prompt-input').evaluate('el=>el.getBoundingClientRect().bottom<=innerHeight+1'), (width, 'composer below viewport')
            trigger = page.get_by_role('button', name='Settings menu', exact=True)
            await trigger.click()
            panel = page.get_by_role('dialog', name='Settings menu', exact=True)
            await panel.wait_for()
            assert await panel.evaluate('el=>getComputedStyle(el).backgroundImage') == reference
            assert await panel.locator('.workspace-panel-heading').evaluate('el=>getComputedStyle(el).backgroundImage') == reference
            await page.keyboard.press('Escape')
            assert await trigger.evaluate('el=>document.activeElement===el')
            # Check each visible toolbar control against its actual wrapping bar.
            issues = await page.locator('.topbar').evaluate('''el => {
                const r=el.getBoundingClientRect();
                return [...el.querySelectorAll('button,select')].map(x=>x.getBoundingClientRect()).filter(x=>x.width&&x.height).some(x=>x.left<r.left-1||x.right>r.right+1||x.top<r.top-1||x.bottom>r.bottom+1);
            }''')
            assert not issues, (width, 'header control outside toolbar')
            print(f'PASS {width}: wrapping, Settings dropdown and keyboard focus')
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await page.screenshot(path='/tmp/buddy-shared-toolbar-grid.png', full_page=True)
        await page.get_by_role('button', name='Office Suite', exact=True).first.click()
        await page.get_by_role('dialog', name='Office Suite', exact=True).wait_for()
        for selector in ('.office-top', '.office-library-tools', '.office-folder-heading'):
            assert await page.locator(selector).evaluate('el=>getComputedStyle(el).backgroundImage') == reference, selector
        # The library header must still hide when the editor takes over.
        await page.locator('.office-content').evaluate("el=>el.classList.add('office-content-editing')")
        assert not await page.locator('.office-top').is_visible()
        await page.locator('.office-content').evaluate("el=>el.classList.remove('office-content-editing')")
        await page.get_by_role('textbox', name='Search office files', exact=True).fill('Synthetic')
        await page.screenshot(path='/tmp/buddy-shared-toolbar-office.png', full_page=True)
        await page.get_by_role('textbox', name='Search office files', exact=True).fill('')
        await page.get_by_role('button', name='Synthetic review.docx', exact=True).click()
        await page.locator('.office-assistant').wait_for()
        field = page.locator('.office-assistant textarea')
        assert await field.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(252, 249, 255)'
        assert await field.evaluate('el=>getComputedStyle(el).color') == 'rgb(22, 22, 22)'
        await page.screenshot(path='/tmp/buddy-neutral-office-assistant.png', full_page=True)
        print('PASS Office assistant input and editor chrome (synthetic editor bridge)')
        await page.get_by_role('button', name='Close Office Suite', exact=True).click()
        await page.get_by_role('button', name='Apps', exact=True).click()
        apps = page.get_by_role('dialog', name='Apps', exact=True)
        await apps.wait_for()
        assert await apps.locator('.buddy-section-header').evaluate('el=>getComputedStyle(el).backgroundImage') == reference
        await page.keyboard.press('Escape')
        for language in ('el', 'hi', 'mt'):
            await page.evaluate('(language)=>localStorage.setItem("bob-ui-language",language)', language)
            # add_init_script intentionally sets English for each fresh document;
            # replace the live language using the existing toolbar selector.
            await page.locator('.workspace-toolbar-language select').select_option(language)
            for width in (390, 768, 1440):
                await page.set_viewport_size({'width': width, 'height': 1000})
                await page.wait_for_timeout(100)
                assert await page.evaluate("document.documentElement.scrollWidth*(Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1)<=innerWidth+1"), (language, width, 'overflow')
                assert await page.locator('#prompt-input').evaluate('el=>el.getBoundingClientRect().bottom<=innerHeight+1'), (language, width, 'composer hidden')
        assert not errors, errors
        print('PASS Office, portaled Apps, editor header visibility, and Greek/Hindi/Maltese layouts; no browser errors')
        await browser.close()


asyncio.run(main())
