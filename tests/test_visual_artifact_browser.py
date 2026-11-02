"""Real ECharts CDN smoke; all chart values here are synthetic test fixtures."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright


async def main():
    source = Path('app/visual_artifact_runtime.js').read_text()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1280, 'height': 800})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.emulate_media(reduced_motion='reduce')
        await page.set_content('''<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>*{box-sizing:border-box}body{margin:16px;font-family:system-ui}#chart{width:100%;height:360px}</style></head>
        <body><h1>Synthetic visual test</h1><button id="filter">Filter synthetic points</button>
        <div id="chart" aria-label="Synthetic scatter chart"></div><p>Source: synthetic test fixture, not operational data.</p></body></html>''')
        await page.add_script_tag(content=source)
        await page.evaluate('''async () => {
            window.handle = await BobVisuals.echarts(document.querySelector('#chart'), {
                animation:true, tooltip:{trigger:'item'}, xAxis:{}, yAxis:{},
                dataZoom:[{type:'inside'},{type:'slider'}],
                series:[{id:'fixture',type:'scatter',data:[[1,2],[2,4],[3,6]]}]
            });
            document.querySelector('#filter').onclick=()=>handle.update({series:[{id:'fixture',data:[[2,4]]}]});
        }''')
        assert await page.locator('#chart svg').count() == 1
        assert await page.evaluate('handle.chart.getOption().animation') is False
        assert await page.evaluate('handle.chart.getOption().series[0].animation') is False
        await page.get_by_role('button', name='Filter synthetic points').focus()
        await page.keyboard.press('Enter')
        assert await page.evaluate('handle.chart.getOption().series[0].data.length') == 1
        for width in (390, 1024, 320):
            await page.set_viewport_size({'width': width, 'height': 800})
            await page.wait_for_function('Math.abs(handle.chart.getWidth()-document.querySelector("#chart").clientWidth)<2')
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await page.emulate_media(reduced_motion='no-preference')
        await page.wait_for_function('handle.chart.getOption().animation === true && handle.chart.getOption().series[0].animation === true')
        await page.evaluate("handle.chart.dispatchAction({type:'dataZoom',start:20,end:80})")
        assert await page.evaluate('handle.chart.getOption().dataZoom[0].start') == 20
        await page.screenshot(path='/tmp/visual-artifact-mobile.png', full_page=True)
        await page.evaluate("document.querySelector('#chart').remove()")
        await page.wait_for_function('handle.chart.isDisposed()')
        assert not errors, errors
        offline = await browser.new_page()
        await offline.route('https://cdn.jsdelivr.net/**', lambda route: route.abort())
        await offline.set_content('<div id="chart" style="height:300px"></div><p id="source">Synthetic source table remains available.</p>')
        await offline.add_script_tag(content=source)
        await offline.evaluate('BobVisuals.echarts(document.querySelector("#chart"), {}).catch(() => {})')
        assert 'unavailable' in await offline.locator('#chart').inner_text()
        assert await offline.locator('#source').is_visible()
        assert await offline.locator('#chart').get_attribute('aria-busy') is None
        await browser.close()
        print('PASS: real ECharts CDN render, keyboard filter, responsive desktop/mobile sizing, reduced-motion toggle, zoom, disposal, offline fallback; synthetic fixtures only')


asyncio.run(main())
