"""Real ECharts dashboard entrance and replay inside the sandboxed preview."""
import asyncio
import os
from playwright.async_api import async_playwright

HTML = '''<!doctype html><html><head><style>body{margin:0}#chart{height:360px;width:100%}</style>
<script src="https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js"></script></head>
<body><h1>Synthetic animation fixture</h1><div id="chart"></div><script>
window.chart=echarts.init(document.getElementById('chart'),null,{renderer:'svg'});
chart.setOption({animation:false,xAxis:{type:'category',data:['A','B','C']},yAxis:{},dataZoom:[{start:20,end:80}],series:[{id:'observed',type:'bar',data:[10,20,30]}]});
window.replays=0;const clear=chart.clear.bind(chart);chart.clear=()=>{window.replays++;clear();};
</script></body></html>'''

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(reduced_motion='no-preference')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        saved = False
        async def respond(route):
            if '/source?' in route.request.url:
                if saved:
                    await route.fulfill(json={'path':'dashboard.html','content':HTML,'kind':'html','sha256':'saved','live':False})
                else:
                    await route.fulfill(status=404,json={'detail':'Preparing fixture'})
            else:
                await route.fulfill(json=[])
        await page.route('**/sessions/synthetic-live-dashboard/artifacts**', respond)
        await page.goto(os.getenv('LIVE_ARTIFACT_FIXTURE_URL','http://127.0.0.1:3002/live_artifact_fixture.html'))
        await page.wait_for_function('typeof window.updateLiveArtifact === "function"')
        await page.evaluate('(html)=>updateLiveArtifact(html)',HTML)
        frame = page.frame_locator('iframe[title="Artifact preview"]:not([aria-hidden="true"])')
        await frame.locator('#chart svg').wait_for(timeout=20000)
        print('Live chart loaded',flush=True)
        assert await page.get_by_role('button',name='Replay chart animations').count() == 0
        saved = True
        await page.evaluate('(html)=>updateLiveArtifact(html,false)',HTML)
        replay = page.get_by_role('button',name='Replay chart animations')
        await replay.wait_for()
        print('Completed chart and replay control visible',flush=True)
        await page.wait_for_function('!document.querySelector(".artifact-preview-controls button").disabled')
        await frame.locator('body').evaluate('()=>new Promise(resolve=>{const check=()=>window.replays>0?resolve():setTimeout(check,20);check();})')
        assert await frame.locator('body').evaluate('()=>chart.getOption().animation') is True
        assert await frame.locator('body').evaluate('()=>chart.getOption().series[0].data') == [10,20,30]
        assert await frame.locator('body').evaluate('()=>chart.getOption().dataZoom[0].start') == 20
        before = await frame.locator('body').evaluate('()=>window.replays')
        await replay.click()
        await frame.locator('body').evaluate('(_,before)=>new Promise(resolve=>{const check=()=>window.replays>before?resolve():setTimeout(check,20);check();})',before)
        assert await frame.locator('body').evaluate('()=>!chart.getZr().animation.isFinished()'), 'Replay did not start a chart animation'
        assert await frame.locator('body').evaluate('()=>chart.getOption().series[0].data') == [10,20,30]
        await page.emulate_media(reduced_motion='reduce')
        before = await frame.locator('body').evaluate('()=>window.replays')
        await replay.click()
        await page.wait_for_timeout(100)
        assert await frame.locator('body').evaluate('()=>window.replays') == before
        assert not errors, errors
        await browser.close()
        print('PASS: real chart entrance on visibility, replay animation, unchanged data and zoom, reduced-motion preference')

asyncio.run(asyncio.wait_for(main(), timeout=60))
