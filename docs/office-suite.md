"""Welcome journey checks with synthetic account fixtures; no tasks are sent."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page()
        preference = {'disabled': False}
        fail_save = False
        writes = []
        office_requests = []
        async def route_request(route):
            nonlocal fail_save
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/src/', '/@', '/node_modules/', '/assets/', '/static/')) or path.endswith(('.png', '.svg', '.ico')):
                await route.continue_()
                return
            data = []
            if path.startswith('/api/office'):
                office_requests.append((route.request.method, path))
            if path == '/auth/status':
                data = {'user': {'username': 'tutorial-fixture', 'display_name': 'Tutorial Fixture', 'is_admin': False}}
            elif path == '/personalization/tutorials':
                if route.request.method == 'PUT':
                    writes.append(route.request.post_data_json)
                    if fail_save:
                        await route.fulfill(status=500, content_type='application/json', body='{"detail":"Unable to save"}')
                        return
                    preference.update(route.request.post_data_json)
                data = preference
            elif path.endswith('/capabilities'):
                data = {'web_search': False}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))
        await page.route('**/*', route_request)
        await page.goto(os.getenv('WELCOME_PREVIEW_URL', 'http://127.0.0.1:3002'))
        await page.locator('.welcome-tour').wait_for()
        assert await page.locator('.tutorial-choices').count() == 0
        for width, height in [(320,568),(768,1024),(1440,900)]:
            await page.set_viewport_size({'width':width,'height':height})
            for chapter in ['Welcome','Ask','Guide','Explore','Control','Notes','Office Suite','Ready']:
                await page.get_by_role('button', name=chapter, exact=False).filter(has=page.locator('span')).first.click()
                assert await page.locator('.welcome-tour').evaluate('el => el.scrollWidth <= el.clientWidth'), (width,chapter)
        await page.locator('.welcome-progress button').nth(1).click()
        await page.get_by_role('textbox', name='Your goal').fill('Explain my document')
        assert 'Explain my document' in await page.locator('.welcome-request').inner_text()
        await page.locator('.welcome-progress button').nth(4).click()
        await page.get_by_role('button', name='Auto-approve', exact=False).click()
        assert await page.get_by_role('button', name='Review before acting', exact=False).get_attribute('aria-pressed') == 'true'
        await page.locator('.welcome-progress button').nth(5).click()
        await page.locator('[data-tutorial-notes]').wait_for()
        await page.get_by_role('button', name='Save to Notes', exact=False).click()
        await page.get_by_role('status').filter(has_text='practice note has landed').wait_for()
        assert await page.locator('.welcome-notes-target small').inner_text() == '1'
        await page.get_by_role('button', name='Try the animation again').click()
        assert await page.get_by_role('button', name='Save to Notes', exact=False).is_enabled()
        await page.locator('.welcome-progress button').nth(6).click()
        await page.locator('[data-tutorial-office]').wait_for()
        await page.get_by_role('combobox', name='Choose a practice file').select_option('html')
        assert 'practice.html' in await page.locator('[data-tutorial-office] .welcome-request').inner_text()
        await page.get_by_role('button', name='Save practice file', exact=True).click()
        assert await page.get_by_role('button', name='Practice file saved', exact=False).is_disabled()
        assert len(writes) == 0 and not office_requests, 'Office practice must not write preferences or contact file APIs'
        await page.get_by_role('button', name='Reset practice library').click()
        assert await page.get_by_role('button', name='Save practice file', exact=True).is_enabled()
        await page.keyboard.press('Escape')
        fail_save = True
        await page.get_by_role('button', name='No, don’t show it again').click()
        await page.get_by_role('alert').wait_for()
        assert await page.locator('.welcome-tour').count() == 1
        fail_save = False
        await page.get_by_role('button', name='No, don’t show it again').click()
        await page.locator('.welcome-tour').wait_for(state='detached')
        assert preference['disabled'] and writes[-1] == {'disabled': True}
        assert await page.locator('.approval-guide').count() == 0
        await page.evaluate('sessionStorage.clear()')
        await page.reload()
        await page.locator('.topbar').wait_for()
        await page.wait_for_timeout(500)
        assert await page.locator('.welcome-tour').count() == 0
        preference['disabled'] = False
        await page.reload()
        await page.locator('.welcome-tour').wait_for()
        await page.get_by_role('button', name='Skip tour').click()
        await page.get_by_role('button', name='Yes, show it on future logins').click()
        await page.locator('.welcome-tour').wait_for(state='detached')
        assert writes[-1] == {'disabled': False}
        await page.evaluate('sessionStorage.clear()')
        await page.reload()
        await page.locator('.welcome-tour').wait_for()
        # Every chapter and its actual UI screenshot follow the selected language.
        for language in ['en', 'el', 'hi', 'mt']:
            await page.locator('.welcome-top select').select_option(language)
            for index in range(8):
                await page.locator('.welcome-progress button').nth(index).click()
                if index == 5:
                    assert await page.locator('[data-tutorial-notes]').count() == 1
                    assert await page.locator('.welcome-notes-guide').count() == 1
                    if language != 'en':
                        assert await page.locator('#skills-guide-title').inner_text() != 'Keep the ideas worth coming back to'
                    assert await page.locator('.welcome-tour').evaluate('el => el.scrollWidth <= el.clientWidth')
                    continue
                if index == 6:
                    await page.locator('[data-tutorial-office]').wait_for()
                    assert await page.locator('.welcome-screenshot').count() == 0
                    assert await page.locator('[data-tutorial-office] select option').count() == 5
                    if language != 'en':
                        assert await page.locator('#skills-guide-title').inner_text() != 'Your files, ready for the next step'
                    assert await page.locator('.welcome-tour').evaluate('el => el.scrollWidth <= el.clientWidth')
                    continue
                img = page.locator('.welcome-screenshot img')
                await img.scroll_into_view_if_needed()
                await page.wait_for_function("() => {const img=document.querySelector('.welcome-screenshot img');return img.complete && img.naturalWidth > 0}")
                assert f'/tutorials/{language}-' in await img.get_attribute('src')
                assert await page.locator('.welcome-tour').evaluate('el => el.scrollWidth <= el.clientWidth')
                if language != 'en':
                    assert await page.locator('#skills-guide-title').inner_text() not in ['Meet your new working partner', 'A great result starts with a clear request', 'Choose how Buddy works', 'Bring your own context', 'Stay in control', 'Your workspace is ready']
            await page.locator('.welcome-progress button').nth(1).click()
            if language != 'en':
                assert await page.locator('.welcome-practice input').input_value() != 'Summarize this document'
        if os.getenv('WELCOME_SCREENSHOT_PATH'):
            await page.locator('.welcome-top select').select_option('en')
            await page.locator('.welcome-progress button').nth(0).click()
            await page.set_viewport_size({'width': 1440, 'height': 1000})
            await page.locator('.welcome-tour').screenshot(path=os.environ['WELCOME_SCREENSHOT_PATH'])
        print('PASS: all four languages, eight localized chapters, Notes and Office Suite practice and 24 screenshots')
        print('PASS: responsive chapters, practice interactions, save failure/retry, opt-out and future-login replay')
        await browser.close()

asyncio.run(main())
