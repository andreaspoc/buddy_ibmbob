"""Full flows fit their answer card width and use normal page scrolling."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

def flow(count=12):
    records=[{'type':'diagram','id':'AutoHeightSynthetic','kind':'flow','title':'Synthetic vertical flow','direction':'TB'}]
    for i in range(count):
        records.append({'type':'node','id':f'Step{i}','label':f'Synthetic stage {i+1}','shape':'rounded'})
        if i: records.append({'type':'edge','id':f'Edge{i}','source':f'Step{i-1}','target':f'Step{i}'})
    return '```bobdiagram\n'+'\n'.join(json.dumps(record) for record in records)+'\n```'

async def main():
    async with async_playwright() as runtime:
        browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
        errors=[]
        page.on('pageerror',lambda error: errors.append(str(error)))
        await page.goto(os.getenv('STRUCTURED_DIAGRAM_FIXTURE_URL','http://127.0.0.1:3002/structured_diagram_fixture.html'))
        await page.wait_for_function('typeof window.setDiagramFixture === "function"')
        await page.evaluate('(text)=>setDiagramFixture(text,false)',flow())
        for width in (1280,768,390,320):
            await page.set_viewport_size({'width':width,'height':900})
            await page.wait_for_function('''() => {
                const panel=document.querySelector('.structured-flow-scroll');
                const nodes=[...document.querySelectorAll('main .react-flow__node-diagram')];
                if(!panel || nodes.length!==12)return false;
                const r=panel.getBoundingClientRect();
                return r.height>700 && panel.scrollHeight<=panel.clientHeight+2 && panel.scrollWidth<=panel.clientWidth+2 && nodes.every(node=>{
                    const n=node.getBoundingClientRect();
                    return n.height>=35 && n.left>=r.left-2 && n.right<=r.right+2 && n.top>=r.top-2 && n.bottom<=r.bottom+2;
                });
            }''')
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
        # Wheel input over the diagram scrolls the page rather than zooming it.
        await page.evaluate('window.scrollTo(0,0)')
        viewport=await page.locator('.react-flow__viewport').get_attribute('style')
        box=await page.locator('.structured-flow-scroll').bounding_box()
        await page.mouse.move(box['x']+box['width']/2, min(500,box['y']+120))
        await page.mouse.wheel(0,400)
        await page.wait_for_function('scrollY>100')
        assert await page.locator('.react-flow__viewport').get_attribute('style')==viewport
        old_height=await page.locator('.structured-flow-scroll').evaluate('node=>node.clientHeight')
        await page.evaluate('(text)=>setDiagramFixture(text,true)',flow(16)[:-3])
        await page.wait_for_function('(old)=>document.querySelectorAll("main .react-flow__node-diagram").length===16 && document.querySelector(".structured-flow-scroll").clientHeight>old',arg=old_height)
        await page.screenshot(path='/tmp/diagram-autoheight-mobile.png',full_page=True)
        # Mermaid stays natural-height too and does not magnify a narrow chain.
        source='```mermaid\nflowchart TD\n'+'\n'.join(f'N{i}["Synthetic {i}"] --> N{i+1}["Synthetic {i+1}"]' for i in range(12))+'\n```'
        await page.evaluate('(text)=>setDiagramFixture(text,false)',source)
        await page.locator('.mermaid-panel svg').wait_for()
        for width in (1280,390,320):
            await page.set_viewport_size({'width':width,'height':900})
            assert await page.locator('.mermaid-diagram').evaluate('''panel=>{
                const svg=panel.querySelector('svg'),r=svg.getBoundingClientRect(),p=panel.getBoundingClientRect();
                return r.width<=p.width+2 && r.height>700 && r.width<=svg.viewBox.baseVal.width+2 && panel.scrollHeight<=panel.clientHeight+2;
            }''')
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors,errors
        await browser.close()
        print('PASS: full vertical flows fit desktop/tablet/phone widths without inner scrolling, grow during streaming, preserve readable nodes; Mermaid natural height')

asyncio.run(main())
