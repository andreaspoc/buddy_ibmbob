"""Synthetic UI interaction and responsive checks for workspace additions."""
import asyncio
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.route('**/synthetic/artifacts/revision?*', lambda route: route.fulfill(json={'content': 'Heading\nOld content'}))
        await page.goto(os.getenv('WORKSPACE_FIXTURE_URL', 'http://127.0.0.1:3011/workspace_enhancements_fixture.html'))
        await page.get_by_role('button', name='Commands').click()
        commands = page.get_by_role('combobox', name='Search workspace commands')
        await commands.fill('Notes')
        await page.get_by_role('button', name='Pin Notes', exact=True).click()
        await commands.press('Enter')
        await page.get_by_role('status').filter(has_text='Synthetic notes opened').wait_for()
        assert await page.get_by_label('Pinned workspace shortcuts').get_by_role('button', name='Notes', exact=True).count() == 1
        await page.reload()
        await page.get_by_label('Pinned workspace shortcuts').get_by_role('button', name='Notes', exact=True).wait_for()
        await page.keyboard.press('Control+Shift+K')
        await page.get_by_role('combobox', name='Search workspace commands').fill('New conversation')
        await page.keyboard.press('Enter')
        assert await page.get_by_role('region', name='Continue working').count() == 0
        await page.keyboard.press('Control+Shift+K')
        await page.get_by_role('combobox', name='Search workspace commands').fill('Synthetic conversation')
        await page.keyboard.press('Enter')
        await page.get_by_role('button', name='Outline').click()
        await page.get_by_role('navigation', name='Conversation outline').get_by_role('button', name='Prompt Synthetic second prompt').click()
        assert await page.evaluate("document.activeElement.id") == 'chat-message-prompt2'
        await page.get_by_role('combobox', name='Conversation project').select_option('example')
        assert await page.get_by_role('combobox', name='Conversation project').input_value() == 'example'
        await page.get_by_role('button', name='Focus', exact=True).click()
        assert not await page.locator('.sidebar').is_visible()
        await page.get_by_role('button', name='Exit focus', exact=True).click()
        assert await page.locator('.sidebar').is_visible()
        for width, height in [(320,568),(390,844),(768,1024),(1280,800),(1920,1080)]:
            await page.set_viewport_size({'width':width,'height':height})
            await page.get_by_role('button', name='Commands').click()
            await page.get_by_role('dialog').wait_for()
            issue = await page.evaluate('''() => ({overflow:document.documentElement.scrollWidth > innerWidth + 1, paletteOutside:(()=>{const r=document.querySelector('.wh-palette').getBoundingClientRect(); return r.left < 0 || r.right > innerWidth+1 || r.bottom > innerHeight+1;})()})''')
            assert not any(issue.values()), (width,issue)
            await page.keyboard.press('Escape')
        await page.screenshot(path='/tmp/workspace-enhancements-mobile.png',full_page=True)
        await page.set_viewport_size({'width':1440,'height':1000})
        await page.screenshot(path='/tmp/workspace-enhancements-desktop.png',full_page=True)
        await page.goto(os.getenv('WORKSPACE_FIXTURE_URL', 'http://127.0.0.1:3011/workspace_enhancements_fixture.html') + '?compare')
        await page.get_by_text('Old content',exact=False).wait_for()
        assert await page.locator('.changed-before').count() == 1
        assert await page.locator('.changed-after').count() == 1
        assert not errors, errors
        print('PASS: palette keyboard execution, pin persistence, recent resume, context selection, outline focus, focus mode, five viewport sizes, actual revision source comparison')
        await browser.close()

asyncio.run(main())
