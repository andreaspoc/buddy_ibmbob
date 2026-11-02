"""Synthetic Office message deletion regression; fake editor bridge and intercepted model requests."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

async def main():
    calls = []
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:3019'])
        page = await browser.new_page()
        page.on('pageerror', lambda error: print('PAGEERROR', str(error), flush=True))
        async def draft(route):
            body = route.request.post_data_json
            calls.append(body)
            plan = {'version': 1, 'kind': 'word', 'reply': f'Synthetic reply {len(calls)}', 'actions': []}
            await route.fulfill(content_type='application/x-ndjson', body=json.dumps({'type': 'plan', 'plan': plan})+'\n')
        await page.route('**/api/office/assistant/files/synthetic-only/draft', draft)
        await page.goto(os.getenv('OFFICE_MESSAGE_DELETION_URL', 'http://127.0.0.1:3019/tests/office-message-deletion.html'))
        async def send(text):
            expected = len(calls) + 1
            await page.get_by_label('Instructions for Buddy').fill(text)
            await page.get_by_role('button', name='Send to Buddy', exact=True).click()
            try:
                await page.get_by_text(f'Synthetic reply {expected}', exact=True).wait_for(timeout=10000)
            except Exception:
                print('DEBUG', calls, await page.locator('body').inner_text(), flush=True)
                raise
            await page.get_by_role('button', name='Delete answer', exact=True).last.wait_for(state='visible')
        async def delete(label):
            await page.get_by_role('button', name=label, exact=True).first.click()
            await page.get_by_role('dialog').get_by_role('button', name='Confirm', exact=True).click()
        await send('Synthetic secret question')
        await delete('Delete question')
        await page.locator('.office-assistant-user').filter(has_text='Synthetic secret question').wait_for(state='detached')
        await page.get_by_text('Synthetic reply 1', exact=True).wait_for()
        await send('Synthetic follow-up')
        assert calls[1]['history'] == [{'prompt': '', 'reply': 'Synthetic reply 1', 'state': 'applied'}], calls
        await delete('Delete answer')
        await page.get_by_text('Synthetic reply 1', exact=True).wait_for(state='detached')
        await delete('Delete answer')
        await page.get_by_text('Synthetic reply 2', exact=True).wait_for(state='detached')
        await page.locator('.office-assistant-user').filter(has_text='Synthetic follow-up').wait_for()
        await send('Third synthetic question')
        assert calls[2]['history'] == [{'prompt': 'Synthetic follow-up', 'reply': '', 'state': 'discarded'}], calls
        assert 'Synthetic secret question' not in json.dumps(calls[1:])
        assert 'Synthetic reply 1' not in json.dumps(calls[2])
        print('PASS Office independently deletes questions/answers and sends only surviving follow-up roles')
        await browser.close()

asyncio.run(main())
