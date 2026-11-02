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
            events.append({'type': 'request', 'prompt': '' if prefix+'u' in deleted else ('[Attached document: Synthetic-design-brief.pdf]\nPlease review this design brief and suggest three improvements.' if index == 0 else 'How can we make the workspace easier to use?\n\nPlease consider navigation, readable text, and the experience on a small phone.\n' + 'Synthetic-long-reference-' * 12),
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
        for width,height in [(1440,1000),(768,1024),(390,844),(320,568)]:
            await page.set_viewport_size({'width':width,'height':height})
            await page.locator('.message.user').first.scroll_into_view_if_needed()
            for bubble in await page.locator('.messages > .message.user > .bubble').all():
                assert await bubble.evaluate("el=>getComputedStyle(el).backgroundColor") == 'rgb(86, 49, 138)'
                assert await bubble.locator('p').evaluate("el=>getComputedStyle(el).color") == 'rgb(255, 255, 255)'
                assert await bubble.evaluate("el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}")
                assert await bubble.evaluate("el=>{const p=el.querySelector('p').getBoundingClientRect(),b=el.querySelector('button').getBoundingClientRect();return p.right<=b.left}")
            assert await page.locator('.conversation').evaluate("el=>getComputedStyle(el).backgroundColor") == 'rgb(255, 255, 255)'
            assert await page.locator('.chat-layout-main').evaluate("el=>getComputedStyle(el).backgroundColor") == 'rgb(255, 255, 255)'
            await page.locator('.message.user').first.scroll_into_view_if_needed()
            await page.screenshot(path=f'/tmp/buddy-question-{width}.png',animations='disabled')
            print(f'PASS sent question {width}: attachment, multiline/long text, white canvas, no text/control overlap',flush=True)
        await browser.close()
asyncio.run(main())
