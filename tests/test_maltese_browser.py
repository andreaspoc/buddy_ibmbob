"""Maltese language switching using explicitly synthetic account and API fixtures."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("if (!localStorage.getItem('bob-ui-language')) localStorage.setItem('bob-ui-language','en'); sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
        async def handle(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/', '/src/', '/@', '/node_modules/', '/static/')) or path.endswith(('.png', '.svg', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'display_name': 'Fixture User', 'is_admin': True}}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            elif path in ('/research/capabilities', '/workflows/capabilities'):
                data = {'web_search': True}
            elif path == '/sessions':
                data = [{'id': 'a' * 32, 'title': 'Unchanged fixture conversation', 'updated_at': 1}]
            await route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        await page.route('**/*', handle)
        await page.goto(os.getenv('LANGUAGE_PREVIEW_URL', 'http://127.0.0.1:8080'))
        await page.get_by_role('button', name='Settings menu', exact=True).click()
        await page.get_by_role('combobox', name='Language', exact=True).select_option('mt')
        await page.get_by_role('heading', name='Konfigurazzjoni', exact=True).wait_for()
        assert await page.locator('html').get_attribute('lang') == 'mt'
        assert await page.evaluate("localStorage.getItem('bob-ui-language')") == 'mt'
        await page.get_by_text('Lingwa', exact=True).first.wait_for()
        assert await page.get_by_text('Unchanged fixture conversation', exact=True).count() > 0
        await page.get_by_role('combobox', name='Lingwa', exact=True).select_option('en')
        await page.get_by_role('heading', name='Settings', exact=True).wait_for()
        await page.get_by_role('combobox', name='Language', exact=True).select_option('mt')
        await page.get_by_role('heading', name='Konfigurazzjoni', exact=True).wait_for()
        await page.reload()
        await page.get_by_role('button', name='Menu tal-konfigurazzjoni', exact=True).click()
        await page.get_by_role('heading', name='Konfigurazzjoni', exact=True).wait_for()
        assert await page.locator('html').get_attribute('lang') == 'mt'
        assert not errors, errors
        print('PASS: Maltese controls, switching, persistence, and original conversation titles in browser.')
        await browser.close()

asyncio.run(main())
