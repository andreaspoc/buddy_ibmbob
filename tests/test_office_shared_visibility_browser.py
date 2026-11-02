"""Synthetic recipient library regression; all Office APIs intercepted, no real files or accounts."""
import asyncio
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright


async def main():
    owned = {'id': 'fixture-owned', 'name': 'Synthetic owned.docx', 'extension': 'docx',
             'size': 100, 'revision': 1, 'save_sequence': 1, 'saved_at': '2026-01-01T00:00:00Z',
             'is_owner': True, 'access': 'owner'}
    shared = {'id': 'fixture-received', 'name': 'Synthetic received.html', 'extension': 'html',
              'size': 100, 'revision': 1, 'save_sequence': 1, 'saved_at': '2026-01-01T00:00:00Z',
              'is_owner': False, 'access': 'write', 'owner': 'fixture-sender', 'owner_display': 'Synthetic sender',
              'folder_id': 'sender-private-folder'}
    granted = True
    file_reads = 0
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('bob-ui-language','en')")

        async def route(request):
            nonlocal file_reads
            path = urlsplit(request.request.url).path
            data = {}
            if path == '/api/office/files':
                file_reads += 1
                data = {'items': [owned] + ([shared] if granted else [])}
            elif path == '/api/office/folders':
                data = {'items': []}
            elif path == '/api/office/status':
                data = {'ready': True}
            await request.fulfill(json=data)

        await page.route('**/api/office/**', route)
        await page.goto(os.getenv('OFFICE_SHARED_VISIBILITY_URL', 'http://127.0.0.1:3021/tests/office-shared-visibility.html'))
        recipient = page.get_by_role('button', name=shared['name'], exact=True)
        owner = page.get_by_role('button', name=owned['name'], exact=True)
        filters = page.get_by_role('group', name='File type filter')
        await recipient.wait_for()
        await owner.wait_for()
        assert await filters.get_by_role('button', name='All files', exact=True).get_attribute('aria-pressed') == 'true'
        await filters.get_by_role('button', name='HTML presentations', exact=True).click()
        await recipient.wait_for()
        assert await owner.count() == 0
        await filters.get_by_role('button', name='Shared with me', exact=True).click()
        await recipient.wait_for()
        assert await owner.count() == 0
        await page.locator('.office-sidebar').get_by_role('button', name='My files').click()
        await owner.wait_for()
        assert await recipient.count() == 0
        await filters.get_by_role('button', name='All files', exact=True).click()
        await recipient.wait_for()

        async def synchronize(event):
            before = file_reads
            if event == 'focus':
                await page.evaluate("window.dispatchEvent(new Event('focus'))")
            else:
                await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            for _ in range(100):
                if file_reads > before:
                    return
                await asyncio.sleep(.02)
            raise AssertionError(f'{event} did not reload library')

        granted = False
        await synchronize('focus')
        await recipient.wait_for(state='detached')
        await owner.wait_for()
        granted = True
        await synchronize('visibilitychange')
        await recipient.wait_for()
        await owner.wait_for()
        granted = False
        await synchronize('visibilitychange')
        await recipient.wait_for(state='detached')
        await owner.wait_for()
        granted = True
        await synchronize('focus')
        await recipient.wait_for()
        assert not errors, errors
        print('PASS shared HTML default All files, HTML, Shared, My files isolation, live grant/revoke on focus and visibility')
        await browser.close()


asyncio.run(main())
