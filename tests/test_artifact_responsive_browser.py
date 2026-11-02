"""Artifact docking checks with explicitly synthetic session and HTML fixtures."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(has_touch=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        artifact = {'path': 'fixture.html', 'kind': 'html', 'sha256': 'synthetic', 'content': '<h1>Synthetic artifact preview</h1>', 'is_presentation': False}
        async def respond(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/', '/src/', '/@', '/node_modules/', '/static/')) or path.endswith(('.png', '.svg', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'is_admin': True}}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path == '/artifact-comments':
                data = {'items': [], 'has_more': False}
            elif path == '/sessions':
                data = [{'id': 'synthetic-artifact', 'title': 'Synthetic artifact layout', 'updated_at': 0}]
            elif path.endswith('/artifacts/source'):
                data = artifact
            elif path.endswith('/artifacts'):
                data = [artifact]
            elif path.endswith('/capabilities'):
                data = {'web_search': False}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))
        await page.route('**/*', respond)
        await page.add_init_script("try { sessionStorage.setItem('buddy-approval-guide:fixture-user','seen'); } catch {}")
        await page.goto(os.getenv('RESPONSIVE_PREVIEW_URL', 'http://127.0.0.1:3002') + '/?conversation=synthetic-artifact')
        await page.locator('.conversation-row .mode-item.active').wait_for(state='attached')
        await page.get_by_role('button', name='Buddy menu', exact=True).click()
        await page.get_by_role('button', name='Artifact editor', exact=True).click()
        await page.frame_locator('.artifact-preview[aria-hidden="false"]').get_by_role('heading', name='Synthetic artifact preview').wait_for()
        sizes = [(320,568),(390,844),(667,375),(768,1024),(820,1180),(1180,820),(1024,1366),(1366,1024),(1024,768),(1280,720),(1366,768),(1920,1080),(2560,1440),(3840,2160)]
        for scale in ['75', '85', '100']:
            await page.get_by_role('button', name='Settings menu', exact=True).click()
            await page.get_by_role('combobox', name='Display scale', exact=True).select_option(scale)
            await page.keyboard.press('Escape')
            for width, height in sizes:
                await page.set_viewport_size({'width': width, 'height': height})
                await page.wait_for_timeout(100)
                result = await page.evaluate('''() => {
                    const panel = document.querySelector('.artifact-workspace-panel').getBoundingClientRect();
                    const input = document.querySelector('#prompt-input').getBoundingClientRect();
                    const chat = document.querySelector('.chat-layout-main').getBoundingClientRect();
                    const overlaps = (a,b) => a.left < b.right-1 && a.right > b.left+1 && a.top < b.bottom-1 && a.bottom > b.top+1;
                    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
                    return { overlap: overlaps(panel, chat), inputCovered: overlaps(panel, input),
                        inputOutside: input.top < 0 || input.bottom > innerHeight+1 || input.right > innerWidth+1,
                        panelOutside: panel.top < 0 || panel.bottom > innerHeight+1 || panel.right > innerWidth+1,
                        overflow: document.documentElement.scrollWidth * scale > innerWidth+1 };
                }''')
                assert not any(result.values()), (scale, width, height, result)
                await page.locator('#prompt-input').click()
                assert await page.locator('#prompt-input').evaluate('el => el === document.activeElement')
            for width, height, orientation in [(1920,1080,'vertical'),(390,844,'horizontal')]:
                await page.set_viewport_size({'width': width, 'height': height})
                handle = page.get_by_role('separator', name='Resize artifact panel')
                await page.wait_for_timeout(100)
                assert await handle.get_attribute('aria-orientation') == orientation
                metric = 'width' if orientation == 'vertical' else 'height'
                before = (await page.locator('.artifact-workspace-panel').bounding_box())[metric]
                await handle.focus()
                await page.keyboard.press('ArrowLeft' if orientation == 'vertical' else 'ArrowDown')
                after = (await page.locator('.artifact-workspace-panel').bounding_box())[metric]
                assert after > before, (scale, orientation, before, after)
                grip = await handle.bounding_box()
                x,y = grip['x'] + grip['width']/2, grip['y'] + grip['height']/2
                await page.mouse.move(x,y)
                await page.mouse.down()
                await page.mouse.move(x - 60 if orientation == 'vertical' else x, y + 40 if orientation == 'horizontal' else y, steps=5)
                await page.mouse.up()
                dragged = (await page.locator('.artifact-workspace-panel').bounding_box())[metric]
                assert dragged > after, (scale, orientation, after, dragged)
                assert await page.locator('#prompt-input').evaluate('el => el.getBoundingClientRect().bottom <= innerHeight + 1')
                await handle.dblclick()
            print(f'PASS {scale}%: artifact and chat have separate space at {len(sizes)} resolutions; chat input remains usable')
        await page.get_by_role('separator', name='Resize artifact panel').focus()
        await page.keyboard.press('ArrowUp')
        await page.wait_for_timeout(100)
        saved = await page.evaluate("localStorage.getItem('buddy-artifact-size')")
        await page.locator('.artifact-editor').get_by_role('button', name='Close', exact=True).click()
        assert await page.locator('.artifact-workspace-panel').count() == 0
        await page.get_by_role('button', name='Buddy menu', exact=True).click()
        await page.get_by_role('button', name='Artifact editor', exact=True).click()
        await page.locator('.artifact-resize-handle').wait_for()
        assert await page.evaluate("localStorage.getItem('buddy-artifact-size')") == saved
        assert await page.get_by_role('separator', name='Resize artifact panel').get_attribute('aria-valuenow') == str(round(json.loads(saved)['height']))
        assert not errors, errors
        await browser.close()

asyncio.run(main())
