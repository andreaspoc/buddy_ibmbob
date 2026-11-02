"""Verify guidance stays on the current running chat job."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(os.getenv('BACKGROUND_PREVIEW_URL', 'http://host.docker.internal:3001/tests/background.html'))
        await page.get_by_role('button', name='Alpha chat', exact=True).click()
        await page.get_by_role('button', name='Buddy menu', exact=True).click()
        assert await page.get_by_role('combobox', name='Assistant preset').locator('option:checked').inner_text() == 'Buddy'
        await page.keyboard.press('Escape')
        message = page.get_by_role('textbox', name='Message', exact=True)
        await message.fill('Investigate integration latency')
        await message.press('Enter')
        guide = page.get_by_role('textbox', name='Guide this response', exact=True)
        await guide.wait_for()
        assert await guide.get_attribute('placeholder') == 'Guide this response…'
        assert await page.get_by_role('button', name='Stop generation', exact=True).is_visible()
        assert await page.get_by_role('button', name='Attach CSV or Excel file', exact=True).is_disabled()
        await guide.fill('Focus on latency')
        await guide.press('Shift+Enter')
        assert '\n' in await guide.input_value()
        await guide.fill('Focus on latency')
        await page.get_by_role('button', name='Send guidance', exact=True).click()
        await page.get_by_text('Guidance sent to Buddy.', exact=True).wait_for()
        assert await guide.input_value() == ''
        assert await page.evaluate('testState.requests.length') == 1
        assert await page.evaluate('testState.guidance') == [{'jobId':'job-0','instruction':'Focus on latency'}]
        await page.evaluate('testState.failGuidance=true')
        await guide.fill('Keep the API')
        await guide.press('Enter')
        await page.get_by_role('alert').filter(has_text='Guidance rejected for test').wait_for()
        assert await guide.input_value() == 'Keep the API'
        await page.evaluate('testState.failGuidance=false')
        await guide.press('Enter')
        await page.wait_for_function('testState.guidance.length===2')
        assert await page.evaluate('testState.guidance[1].jobId') == 'job-0'
        await page.get_by_role('button', name='Beta chat', exact=True).click()
        await message.fill('Second chat request')
        await message.press('Enter')
        await guide.wait_for()
        await guide.fill('/web-search Keep this as plain guidance')
        await guide.press('Enter')
        await page.wait_for_function('testState.guidance.length===3')
        assert await page.evaluate('testState.guidance[2]') == {'jobId':'job-1','instruction':'/web-search Keep this as plain guidance'}
        assert await page.evaluate('testState.requests.length') == 2
        await page.evaluate("completeResponse(1, 'Completed guided response')")
        await page.get_by_text('Completed guided response', exact=True).wait_for()
        assert await page.get_by_role('button', name='Send guidance', exact=True).count() == 0
        assert not errors, errors
        print(json.dumps({'guidanceWhileStreaming':True,'sameJob':True,'failureRetainsInput':True,'plainText':True,'presetIBMBOB':True}))
        await browser.close()

asyncio.run(main())
