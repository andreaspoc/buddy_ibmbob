"""Synthetic main-chat deletion UI regression. All API calls are intercepted; no user data is touched."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright


async def main():
    sid = 'd' * 32
    deleted = set()
    calls = []
    cleanup_pending = False

    def history():
        events = []
        for index in range(2):
            prefix = f'fixture{index}'
            events.append({'type': 'request', 'prompt': '' if prefix+'u' in deleted else f'Synthetic question {index}',
                           'user_message_id': prefix+'u', 'assistant_message_id': prefix+'a',
                           'user_deleted': prefix+'u' in deleted, 'assistant_deleted': prefix+'a' in deleted})
            if prefix+'a' not in deleted:
                events += [{'type': 'delta', 'text': f'Synthetic answer {index}'}, {'type': 'done', 'session_id': 'old-context'}]
        return events

    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');localStorage.setItem('bob-ui-language','en')")

        async def route(request):
            path = urlsplit(request.request.url).path
            if path == '/' or path.startswith(('/assets/', '/src/', '/@', '/node_modules/', '/static/')) or path.endswith(('.svg', '.png', '.ico')):
                await request.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'is_admin': False}}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path.endswith('/capabilities'):
                data = {'web_search': False}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            elif path == '/sessions':
                data = [{'id': sid, 'title': 'Synthetic deletion chat', 'updated_at': 0}]
            elif path == f'/sessions/{sid}/history':
                data = history()
            elif path.startswith(f'/sessions/{sid}/messages/'):
                assert request.request.method == 'DELETE'
                message_id = path.rsplit('/', 1)[1]
                calls.append(message_id)
                deleted.add(message_id)
                data = {'deleted': True, 'cleanup_pending': cleanup_pending}
            await request.fulfill(json=data)

        await page.route('**/*', route)
        await page.goto(os.getenv('MESSAGE_DELETION_PREVIEW_URL', 'http://127.0.0.1:3019') + f'/?conversation={sid}')
        await page.get_by_text('Synthetic answer 1', exact=True).wait_for()
        await page.get_by_role('button', name='Delete question', exact=True).first.click()
        await page.get_by_role('dialog').get_by_role('button', name='Cancel', exact=True).click()
        assert calls == []
        await page.get_by_role('button', name='Delete question', exact=True).first.click()
        assert await page.locator('#prompt-input').is_disabled()
        await page.get_by_role('dialog').get_by_role('button', name='Confirm', exact=True).click()
        await page.get_by_text('Synthetic question 0', exact=True).wait_for(state='detached')
        await page.get_by_text('Synthetic answer 0', exact=True).wait_for()
        await page.reload()
        await page.get_by_text('Synthetic answer 0', exact=True).wait_for()
        assert await page.get_by_text('Synthetic question 0', exact=True).count() == 0
        await page.get_by_role('button', name='Delete answer', exact=True).last.click()
        await page.get_by_role('dialog').get_by_role('button', name='Confirm', exact=True).click()
        await page.get_by_text('Synthetic answer 1', exact=True).wait_for(state='detached')
        await page.get_by_text('Synthetic question 1', exact=True).wait_for()
        cleanup_pending = True
        await page.get_by_role('button', name='Delete question', exact=True).click()
        await page.get_by_role('dialog').get_by_role('button', name='Confirm', exact=True).click()
        await page.get_by_text('Synthetic question 1', exact=True).wait_for(state='detached')
        await page.get_by_text('Message removed from chat. Stored cache cleanup is pending and will be retried automatically.', exact=True).wait_for()
        await page.reload()
        await page.get_by_text('Synthetic answer 0', exact=True).wait_for()
        assert await page.get_by_text('Synthetic question 1', exact=True).count() == 0
        assert await page.get_by_text('Synthetic answer 1', exact=True).count() == 0
        await page.locator('#prompt-input').fill('Continue from the remaining answer')
        assert await page.locator('.send-button').is_enabled()
        assert calls == ['fixture0u', 'fixture1a', 'fixture1u']
        print('PASS independent question/answer deletion, cancel, reload, empty last turn, cleanup notice, follow-up composer')
        await browser.close()


asyncio.run(main())
