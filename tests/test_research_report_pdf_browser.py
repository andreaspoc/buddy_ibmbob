"""Verify synthetic Carbon chart data survives static PDF preparation."""
import asyncio
import os
import json
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.route('**/sessions/synthetic-research-session/export?format=json', lambda route: route.fulfill(content_type='application/json', body=json.dumps({'title':'Synthetic analysis export','messages':[{'role':'assistant','content':'```bobchart\n' + json.dumps({'type':'bar','title':'Synthetic analysis chart','labels':['A','B'],'data':[10,20]}) + '\n```'}]})))
        await page.goto(os.getenv('RESEARCH_PDF_FIXTURE_URL', 'http://127.0.0.1:3002/research_report_fixture.html'))
        await page.locator('.interactive-chart-card svg').wait_for()
        await page.get_by_role('button', name='Series A', exact=True).click()
        assert await page.locator('.interactive-chart-card svg circle').count() == 40
        await page.evaluate("window.pdfPrinted = false; const observer = new MutationObserver(() => {const f=document.querySelector('.research-print-frame');if(f && !f.dataset.stubbed){f.dataset.stubbed='true';f.contentWindow.print=()=>window.pdfPrinted=true;}});observer.observe(document.body,{childList:true});")
        await page.get_by_role('button', name='Export PDF', exact=True).click()
        await page.wait_for_function('window.pdfPrinted === true')
        frame = page.frame_locator('.research-print-frame')
        assert await frame.locator('.interactive-chart-card svg circle').count() == 80, 'All series must be included in PDF'
        assert await frame.locator('.chart-maximize-button,.chart-maximized-dialog,.chart-interactive-tooltip').count() == 0
        assert await frame.locator('.interactive-chart-card svg').evaluate("node => node.style.minWidth === '0px' && node.style.maxWidth === '100%'")
        await page.emulate_media(media='print')
        print_content = await frame.locator('html').evaluate('node => node.outerHTML')
        print_page = await browser.new_page()
        await print_page.set_content(print_content)
        await print_page.emulate_media(media='print')
        await print_page.pdf(path='/tmp/research-carbon-chart.pdf', format='A4', print_background=True)
        assert await print_page.locator('.interactive-chart-card svg').evaluate('node => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1'), 'Printed chart must fit page width'
        await print_page.close()
        await page.emulate_media(media='screen')
        assert not errors, errors
        await page.get_by_role('button', name='PDF preview', exact=True).click()
        await page.locator('.conversation-pdf-preview .interactive-chart-card svg').wait_for()
        assert await page.locator('.conversation-pdf-preview .research-document-title').inner_text() == 'Synthetic analysis export'
        assert await page.locator('.conversation-pdf-preview .research-source-appendix').count() == 0
        assert await page.locator('.conversation-pdf-preview .interactive-chart-card svg rect').count() == 2
        print('PASS: Carbon chart PDF contains all series, static vectors, no dialogs/tooltips, and paper sizing')
        await browser.close()

asyncio.run(main())
