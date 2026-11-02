"""Real Chromium checks against the synthetic clarification_fixture.html Vite fixture.

Serve with: node web/node_modules/vite/bin/vite.js --config tests/clarification_vite.config.mjs --configLoader runner
Set CLARIFICATION_FIXTURE_URL when running in Docker.
"""
import asyncio
import json
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280,'height':1000})
        errors=[]
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('CLARIFICATION_FIXTURE_URL','http://127.0.0.1:3002/clarification_fixture.html'))
        cards = page.locator('.clarification-card')
        await cards.first.wait_for()
        print('fixture loaded',flush=True)
        for width in [1280,390,320]:
            await page.set_viewport_size({'width':width,'height':1000})
            await page.evaluate("document.fonts.ready")
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Page overflows at {width}px'
            assert await cards.first.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1'), f'Card overflows at {width}px'
            for tile in await cards.first.locator('.clarification-option-tile').all():
                assert await tile.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1'), f'Option overflows at {width}px'
            assert await cards.first.evaluate("""node => [...node.querySelectorAll('.clarification-options-grid')].every(grid => {
                const tiles = [...grid.children].map(tile => tile.getBoundingClientRect());
                return tiles.every((tile, index) => tiles.slice(index + 1).every(other =>
                    tile.right <= other.left + 1 || other.right <= tile.left + 1 ||
                    tile.bottom <= other.top + 1 || other.bottom <= tile.top + 1));
            })"""), f'Options overlap at {width}px'
            assert await cards.first.locator('.clarification-options-grid').first.evaluate("(grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length") == 1
            if os.getenv('CLARIFICATION_SCREENSHOT_PATH') and width == 1280:
                await cards.first.screenshot(path=os.environ['CLARIFICATION_SCREENSHOT_PATH'])
        print('layout passed',flush=True)
        submit = cards.first.get_by_role('button',name='Continue',exact=True)
        assert await submit.is_disabled()
        first_radio=cards.first.get_by_role('radio').first
        print('keyboard start',flush=True)
        await first_radio.focus()
        await page.keyboard.press('Space')
        assert await first_radio.is_checked()
        assert await first_radio.evaluate("node => node.matches(':focus-visible')")
        await cards.nth(1).locator('.clarification-option-tile').first.click()
        assert await first_radio.is_checked(), 'Selecting a separate card deselected the first card'
        question=cards.first.locator('fieldset').nth(1)
        await question.locator('.clarification-custom-tile').click()
        assert await submit.is_disabled()
        await question.get_by_role('textbox').fill('A custom detailed answer')
        assert await submit.is_enabled()
        print('submitting',flush=True)
        await cards.first.evaluate("node => {node.requestSubmit(); node.requestSubmit();}")
        assert await page.evaluate('window.replyCount') == 1
        output=await page.locator('output').text_content()
        assert 'A custom detailed answer' in output and 'strategic decision making' in output
        assert await cards.first.locator('fieldset').first.evaluate('node => node.disabled')
        assert await cards.first.get_by_role('button',name='Continue',exact=True).count()==0
        await page.screenshot(path='/tmp/bob-clarification-mobile.png',full_page=True)
        assert not errors, '\n'.join(errors)
        print(json.dumps({'passed':'desktop narrow container; 390px and 320px mobile; long options; keyboard selection; independent forms; custom answer; completion gating; submission; answered state','pageErrors':errors}))
        await browser.close()

asyncio.run(main())
