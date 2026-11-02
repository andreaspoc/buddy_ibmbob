"""Chromium checks against synthetic knowledge responses in the Vite fixture."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1280, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('KNOWLEDGE_DROPZONE_FIXTURE_URL', 'http://127.0.0.1:3002/knowledge_dropzone_fixture.html'))
        trigger = page.locator('.knowledge-dropzone-trigger')
        await trigger.wait_for()
        for width in [1280, 390, 320]:
            await page.set_viewport_size({'width': width, 'height': 1100})
            await page.evaluate('document.fonts.ready')
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}px'
            assert await trigger.evaluate('node => node.scrollWidth <= node.clientWidth'), f'Upload content overflow at {width}px'
            assert await trigger.bounding_box(), 'Upload control must be visible'
            await trigger.scroll_into_view_if_needed()
            await page.screenshot(path=f'/tmp/knowledge-dropzone-{width}.png', full_page=True)
        await trigger.focus()
        assert await trigger.evaluate('node => node === document.activeElement')
        async with page.expect_file_chooser() as chooser:
            await page.keyboard.press('Enter')
        await (await chooser.value).set_files({'name': 'synthetic.md', 'mimeType': 'text/markdown', 'buffer': b'# Synthetic source'})
        review = page.get_by_role('region', name='Review uploads')
        await review.wait_for()
        assert 'synthetic.md' in await review.text_content()
        await review.get_by_role('button', name='Cancel', exact=True).click()
        async def drop(name):
            transfer = await page.evaluate_handle('(name) => {const data = new DataTransfer(); data.items.add(new File(["# Synthetic source"], name, {type: "text/markdown"})); return data;}', name)
            await page.locator('.knowledge-dropzone').dispatch_event('drop', {'dataTransfer': transfer})
            await transfer.dispose()
        await drop('synthetic-drop.md')
        await review.wait_for()
        assert 'synthetic-drop.md' in await review.text_content()
        await review.get_by_role('button', name='Upload', exact=False).click()
        await page.wait_for_function('window.fixtureState.requests === 1')
        assert await trigger.is_disabled()
        await drop('must-not-replace.md')
        assert 'must-not-replace.md' not in await review.text_content()
        await page.evaluate('window.fixtureState.finishUpload()')
        await page.get_by_role('status').filter(has_text='source added').wait_for()
        assert await trigger.is_enabled()
        assert not errors, errors
        print(json.dumps({'passed': 'desktop/mobile overflow, keyboard file chooser, selection and drop review, upload busy protection', 'pageErrors': errors}))
        await browser.close()

asyncio.run(main())
