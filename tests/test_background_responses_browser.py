"""Verify background response isolation and notification clicks with a mocked App.

Serve web/tests/background.html with Vite on port 3001. No real Bob job,
notification, or account is used. Set BACKGROUND_PREVIEW_URL if needed.
"""
import asyncio
import json
import os
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'),
            args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('BACKGROUND_PREVIEW_URL',
            'http://host.docker.internal:3001/tests/background.html'))
        await page.get_by_role('button', name='Alpha chat', exact=True).wait_for()
        await page.wait_for_timeout(100)
        assert await page.locator('.welcome').count() == 1, 'Initial load restored an old chat'
        await page.get_by_role('button', name='Alpha chat', exact=True).click()

        async def send(text, count):
            await page.get_by_role('textbox', name='Message', exact=True).fill(text)
            await page.get_by_role('textbox', name='Message', exact=True).press('Enter')
            await page.wait_for_function('(count) => testState.requests.length === count', arg=count)

        await send('Alpha pending question', 1)
        await page.get_by_role('button', name='Beta chat', exact=True).click()
        await send('Beta pending question', 2)
        await page.evaluate("completeResponse(0, 'Alpha final answer')")
        await page.wait_for_function('testState.notices.length === 1')
        assert await page.locator('.stop-button').count() == 1, 'Old completion stopped the new chat'
        assert 'Alpha final answer' not in await page.locator('.conversation').inner_text()
        assert not await page.evaluate('testState.requests[0].signal.aborted'), 'Switch cancelled the original request'

        # Desktop completion click navigates directly to the originating chat.
        await page.evaluate('testState.notices[0].onclick()')
        await page.get_by_text('Alpha final answer', exact=True).wait_for()
        assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')") == 'a' * 32
        await page.evaluate("completeResponse(1, 'Beta final answer')")
        await page.wait_for_function('testState.notices.length === 2')
        await page.evaluate('testState.notices[1].onclick()')
        await page.get_by_text('Beta final answer', exact=True).wait_for()

        # Foreground completions and failures stay silent.
        await send('Visible question', 3)
        await page.evaluate("completeResponse(2, 'Visible final answer')")
        await page.get_by_text('Visible final answer', exact=True).wait_for()
        await page.wait_for_timeout(200)
        assert await page.evaluate('testState.notices.length') == 2
        await send('Failed question', 4)
        await page.get_by_role('button', name='Alpha chat', exact=True).click()
        await page.evaluate("completeResponse(3, '', 'failed')")
        await page.wait_for_timeout(200)
        assert await page.evaluate('testState.notices.length') == 2

        # Background browser-tab completion also notifies; project chat clicks
        # resolve the correct project even when another project is selected.
        await page.locator('.project-select').select_option('project-one')
        await page.get_by_role('button', name='Project chat', exact=True).wait_for()
        await send('Hidden project question', 5)
        await page.evaluate("testState.hidden=true; completeResponse(4, 'Project final answer')")
        await page.wait_for_function('testState.notices.length === 3')
        await page.evaluate('testState.hidden=false')
        await page.locator('.project-select').select_option('')
        await page.get_by_role('button', name='Alpha chat', exact=True).wait_for()
        await page.evaluate('testState.notices[2].onclick()')
        await page.get_by_text('Project final answer', exact=True).wait_for()
        assert await page.locator('.project-select').input_value() == 'project-one'
        assert await page.evaluate("sessionStorage.getItem('buddy-active-session:testuser')") == 'c' * 32
        await page.reload()
        await page.get_by_role('button', name='Project chat', exact=True).wait_for()
        await page.wait_for_timeout(100)
        assert await page.locator('.project-select').input_value() == 'project-one'
        assert await page.evaluate("new URL(location.href).searchParams.get('conversation')") == 'c' * 32
        await page.get_by_role('button', name='New conversation', exact=True).click()
        assert await page.locator('.welcome').count() == 1, 'New conversation did not start a blank chat'
        assert await page.evaluate("new URL(location.href).searchParams.get('conversation')") is None
        if errors:
            raise AssertionError(errors)
        print(json.dumps({'backgroundStreamsContinue': True, 'oldCompletionIsolated': True,
            'desktopClickOpensChat': True, 'projectChatNavigation': True,
            'foregroundAndFailureSilent': True, 'conversationUrlReopensChat': True, 'notifications': 3}))
        await browser.close()


asyncio.run(main())
