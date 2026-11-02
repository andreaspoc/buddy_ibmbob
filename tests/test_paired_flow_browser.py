"""Compact in-chat paths: synthetic nodes only, real renderer and export."""
import asyncio
import json
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1000,'height':900}, accept_downloads=True)
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto('http://127.0.0.1:3012/structured_diagram_fixture.html')
        await page.wait_for_function('typeof window.setDiagramFixture === "function"')
        header={'type':'diagram','id':'SyntheticPairedFlow','kind':'flow','layout':'layered','title':'Synthetic six-stage flow','direction':'TB','motion':'none'}
        records=[header]+[{'type':'node','id':f'Step{i}','label':f'Synthetic stage {i+1}','shape':'rounded','tone':'blue'} for i in range(6)]+[{'type':'edge','id':f'Link{i}','source':f'Step{i}','target':f'Step{i+1}','label':f'Continue to stage {i+2}'} for i in range(5)]
        source='```bobdiagram\n'+'\n'.join(json.dumps(r) for r in records)+'\n```'
        await page.evaluate('source => window.setDiagramFixture(source,false,false,true)',source)
        for width in [1440,1000,768,640,390,320]:
            await page.set_viewport_size({'width':width,'height':900})
            await page.wait_for_function("document.querySelectorAll('.react-flow__node').length === 6 && document.querySelectorAll('.react-flow__edge').length === 5")
            await page.wait_for_timeout(700)
            bounds=await page.locator('.react-flow__node').evaluate_all('(nodes)=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})')
            canvas=await page.locator('.structured-flow-canvas').bounding_box()
            rows={}
            for b in bounds: rows.setdefault(round(b['y']),[]).append(b)
            if width>=640:
                assert sorted(len(row) for row in rows.values())==[2,2,2],(width,rows)
                assert bounds[1]['x']>bounds[0]['x'] and bounds[3]['x']<bounds[2]['x'],'Arrows retain alternating reading order'
                assert canvas['height']<650,(width,canvas)
            else:
                assert len(rows)==6,'Phones retain readable single-column cards'
            center=(min(b['x'] for b in bounds)+max(b['x']+b['w'] for b in bounds))/2
            assert abs(center-(canvas['x']+canvas['width']/2))<24,(width,center,canvas)
            assert all(b['x']>=canvas['x']-1 and b['x']+b['w']<=canvas['x']+canvas['width']+1 for b in bounds),(width,bounds,canvas)
            assert not await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
            if width==1000: await page.screenshot(path='/tmp/paired-flow-desktop.png',full_page=True)
        await page.set_viewport_size({'width':1000,'height':900})
        await page.wait_for_timeout(700)
        async with page.expect_download() as pending:
            await page.get_by_role('button',name='JSON',exact=True).click()
        download=await pending.value
        path=await download.path()
        saved=json.loads(open(path).read())
        assert saved['direction']=='TB' and len(saved['nodes'])==6 and len(saved['edges'])==5,'Source graph is unchanged'
        assert not errors,errors
        print('PASS: six nodes in three paired rows at four desktop/tablet widths, centered layout, mobile readability, complete edges and unchanged JSON source; no browser errors')
        await browser.close()

asyncio.run(main())
