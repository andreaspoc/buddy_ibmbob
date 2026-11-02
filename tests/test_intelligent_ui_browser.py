"""Native answer interactions using explicitly synthetic content in real MarkdownView."""
import asyncio
import json
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('http://127.0.0.1:3012/structured_diagram_fixture.html')
        await page.wait_for_function('typeof window.setDiagramFixture === "function"')
        async def show(spec, streaming=False, suffix=''):
            await page.evaluate('([text,streaming]) => window.setDiagramFixture(text,streaming)', ['Introductory text.\n\n```bobui\n'+json.dumps(spec)+'\n```\n'+suffix, streaming])
        spec = {'kind':'explore','title':'Synthetic learning guide','description':'Explicit test content','items':[{'title':'Overview','body':'Synthetic overview','facts':[{'label':'Format','value':'Native view'}]},{'title':'Details','body':'Synthetic details'}]}
        await show(spec, True)
        await page.get_by_role('tab', name='Details', exact=True).click()
        await page.get_by_role('tabpanel').filter(has_text='Synthetic details').wait_for()
        await show(spec, True, 'More streaming text.')
        assert await page.get_by_role('tab', name='Details', exact=True).get_attribute('aria-selected') == 'true'
        await show(spec, False, 'Completed response.')
        assert await page.get_by_role('tab', name='Details', exact=True).get_attribute('aria-selected') == 'true'
        await page.get_by_role('tab', name='Details', exact=True).focus()
        await page.keyboard.press('ArrowLeft')
        assert await page.get_by_role('tab', name='Overview', exact=True).get_attribute('aria-selected') == 'true'
        spec['actions'] = [{'label':'Learn more','prompt':'Explain the synthetic topic'}]
        await show(spec)
        await page.get_by_role('button', name='Learn more').click()
        assert await page.evaluate('window.lastInteractivePrompt') == 'Explain the synthetic topic'
        await show(spec, True)
        await expect(page.get_by_role('button', name='Learn more')).to_be_disabled()
        await page.evaluate('() => window.setDiagramFixture(' + json.dumps('```bobui\n'+json.dumps(spec)+'\n```') + ', false, true)')
        await expect(page.get_by_role('button', name='Learn more')).to_have_count(0)
        spec['kind'] = 'comparison'
        await show(spec)
        assert await page.locator('.ia-comparison article').count() == 2
        for width in [320, 390, 768, 1440]:
            await page.set_viewport_size({'width':width,'height':900})
            assert not await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'), width
        await page.screenshot(path='/tmp/intelligent-comparison-desktop.png', full_page=True)
        spec['kind'] = 'steps'
        await show(spec)
        await page.get_by_role('checkbox', name='Overview', exact=True).check()
        assert await page.get_by_role('progressbar').get_attribute('value') == '1'
        await page.get_by_role('button', name='Reset', exact=True).click()
        assert not await page.get_by_role('checkbox', name='Overview', exact=True).is_checked()
        await show({'kind':'split','title':'Synthetic bill split','total':120,'people':4,'tip':10,'unit':'EUR'})
        assert '33.00' in await page.locator('output').inner_text()
        await page.get_by_label('People',exact=True).fill('0')
        assert 'Enter valid' in await page.locator('output').inner_text()
        await page.get_by_label('People',exact=True).fill('2')
        assert '66.00' in await page.locator('output').inner_text()
        await page.get_by_role('button',name='Reset values').click()
        assert '33.00' in await page.locator('output').inner_text()
        await page.set_viewport_size({'width':320,'height':750})
        assert not await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
        await page.screenshot(path='/tmp/intelligent-calculator-mobile.png',full_page=True)
        await show({'kind':'unknown','title':'Invalid test'})
        await page.get_by_text('Interactive answer unavailable · View original content').click()
        assert 'unknown' in await page.locator('.intelligent-answer pre').inner_text()
        await show({'kind':'explore','title':'Escaping test','items':[{'title':'Literal text','body':'<img src=x onerror=alert(1)>'}]})
        assert await page.locator('.intelligent-answer img').count() == 0
        assert '<img' in await page.get_by_role('tabpanel').inner_text()
        await page.evaluate('() => window.setDiagramFixture("```bobui\\n{", true)')
        await page.get_by_role('status').filter(has_text='Building an interactive answer').wait_for()
        assert not errors, errors
        print('PASS: tabs and keyboard access, streaming state preservation, comparisons, checklists, calculator validation/reset, 4 viewport sizes, escaping, pending and invalid fallback; no browser errors')
        await browser.close()

asyncio.run(main())
