"""URL regressions with synthetic auth fixtures; no real sign-in is performed."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.async_api import async_playwright


async def main():
    base = os.getenv('AUTH_URL_PREVIEW_URL', 'http://127.0.0.1:8080')
    build = os.getenv('AUTH_URL_PREVIEW_BUILD')
    signed_in = True
    user = {'username': 'url-fixture', 'display_name': 'URL Fixture', 'is_admin': False}
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('bob-ui-language','en');sessionStorage.setItem('buddy-approval-guide:url-fixture','seen');")

        async def route_request(route):
            nonlocal signed_in
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
                data = {'user': user if signed_in else None, 'keycloak_configured': True, 'local_login_enabled': True}
            elif path == '/auth/login':
                signed_in = True
                data = {'ok': True}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path == '/api/apps':
                data = {'apps': [{'id': 'office', 'name': 'Office Suite', 'description': 'Synthetic launcher', 'kind': 'installed', 'desktop_only': True, 'launch': {'kind': 'office'}}]}
            elif path in ('/api/notes', '/api/office/files', '/api/office/folders'):
                data = {'items': []}
            elif path == '/api/office/status':
                data = {'ready': True}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))

        await page.route('**/*', route_request)
        for path in ('/', '/notes', '/office'):
            await page.goto(base + path + '?keep=1&keycloak_error=Sign-in+failed.&keycloak_error=old#anchor')
            await page.locator('.topbar').wait_for()
            await page.wait_for_function("!new URL(location.href).searchParams.has('keycloak_error')")
            current = urlsplit(page.url)
            assert current.path == path and parse_qs(current.query) == {'keep': ['1']} and current.fragment == 'anchor', page.url
        print('PASS authenticated root, Notes and Office remove stale errors and preserve other URL values')

        await page.goto(base + '/?keep=1&keycloak_error=old#anchor')
        await page.locator('.topbar').wait_for()
        await page.get_by_role('button', name='Office Suite', exact=True).first.click()
        await page.get_by_role('dialog', name='Office Suite', exact=True).wait_for()
        # Older history entries may still contain a callback marker.
        await page.evaluate("history.replaceState({...history.state,officeReturnPath:'/?keep=1&keycloak_error=old#anchor'},'',location.href)")
        await page.get_by_role('button', name='Close Office Suite', exact=True).click()
        await page.wait_for_function("location.pathname==='/'")
        assert urlsplit(page.url).query == 'keep=1' and urlsplit(page.url).fragment == 'anchor', page.url
        print('PASS Office return navigation cannot restore the obsolete sign-in error')

        await page.goto(base + '/?keep=1&microsoft=connected#anchor')
        await page.locator('.topbar').wait_for()
        await page.wait_for_function("!new URL(location.href).searchParams.has('microsoft')")
        assert urlsplit(page.url).query == 'keep=1' and urlsplit(page.url).fragment == 'anchor', page.url
        print('PASS Microsoft callback cleanup preserves unrelated query values and fragment')

        signed_in = False
        await page.goto(base + '/?keep=1&keycloak_error=Sign-in+failed.+Please+try+again.#anchor')
        await page.get_by_text('Sign-in failed. Please try again.', exact=True).wait_for()
        await page.wait_for_function("!new URL(location.href).searchParams.has('keycloak_error')")
        link = await page.locator('#auth-keycloak').get_attribute('href')
        assert parse_qs(urlsplit(link).query)['next'] == ['/?keep=1'], link
        print('PASS actual login failures remain visible and the retry link omits the old error')
        await page.get_by_label('Username', exact=True).fill('url-fixture')
        await page.get_by_label('Password', exact=True).fill('synthetic-password')
        await page.locator('.buddy-submit-button').click()
        await page.locator('.topbar').wait_for()
        assert parse_qs(urlsplit(page.url).query) == {'keep': ['1']}, page.url
        print('PASS successful local sign-in keeps the URL clean')
        assert not errors, errors
        await browser.close()


asyncio.run(main())
