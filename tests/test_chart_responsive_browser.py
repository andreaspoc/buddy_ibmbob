"""Browser checks for synthetic chart data at phone, tablet and desktop widths."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('STRUCTURED_DIAGRAM_FIXTURE_URL', 'http://127.0.0.1:3002/structured_diagram_fixture.html'))
        await page.wait_for_function('typeof window.setDiagramFixture === "function"')
        async def render(spec):
            await page.evaluate('text => window.setDiagramFixture(text, false)', '```bobchart\n' + json.dumps(spec) + '\n```')
            await page.locator('.interactive-chart-card svg').wait_for()
        for width in (320, 768, 1440):
            await page.set_viewport_size({'width': width, 'height': 900})
            await render({'type': 'bar', 'title': 'Synthetic signed values', 'labels': ['Loss', 'Gain'], 'data': [-10, 20]})
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Page overflow at {width}'
            rects = await page.locator('.interactive-chart-card svg rect').evaluate_all('nodes => nodes.map(node => ({y:+node.getAttribute("y"),height:+node.getAttribute("height")}))')
            assert rects[0]['height'] > 0 and rects[0]['y'] > rects[1]['y']
            await render({'type': 'line', 'title': 'Synthetic dense line', 'labels': [f'Category {i}' for i in range(40)], 'datasets': [{'label': 'Synthetic actual', 'data': list(range(40))}, {'label': 'Synthetic plan', 'data': list(range(1, 41))}]})
            wrapper = page.locator('.interactive-chart-card svg').locator('..')
            assert await wrapper.evaluate('node => node.scrollWidth > node.clientWidth'), f'Expected chart scrolling at {width}'
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Dense page overflow at {width}'
            toggle = page.get_by_role('button', name='Synthetic actual', exact=True)
            await toggle.focus()
            await page.keyboard.press('Enter')
            assert await toggle.get_attribute('aria-pressed') == 'false'
            assert await toggle.evaluate('node => node === document.activeElement')
            assert await page.locator('.interactive-chart-card svg circle').count() == 40
            await page.get_by_role('button', name='Maximize chart: Synthetic dense line', exact=True).click()
            dialog = page.get_by_role('dialog', name='Synthetic dense line', exact=True)
            await dialog.wait_for()
            assert await dialog.locator('svg circle').count() == 40
            assert await dialog.get_by_role('button', name='Synthetic actual', exact=True).get_attribute('aria-pressed') == 'false'
            assert await dialog.evaluate('node => { const r=node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }'), f'Dialog overflow at {width}'
            await page.keyboard.press('Escape')
            await dialog.wait_for(state='hidden')
            assert await page.get_by_role('button', name='Maximize chart: Synthetic dense line', exact=True).evaluate('node => node === document.activeElement')
            assert await page.locator('.interactive-chart-card svg circle').count() == 40
            await render({'type': 'doughnut', 'title': 'Synthetic single slice', 'labels': ['Only category'], 'data': [12]})
            path = page.locator('.interactive-chart-card svg path')
            box = await path.bounding_box()
            assert box['width'] > 50 and box['height'] > 50, 'Single slice must occupy a full ring'
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        await browser.close()
        print('PASS: 320/768/1440px charts, signed values, dense local scrolling, singleton doughnut, keyboard toggles and maximize state/focus')

asyncio.run(main())
