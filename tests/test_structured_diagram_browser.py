"""Actual MarkdownView streaming verification; all diagram records are synthetic."""
import asyncio
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET
from playwright.async_api import async_playwright

def record(**value):
    return json.dumps(value)+'\n'

async def main():
    async with async_playwright() as runtime:
        browser=await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1000,'height':900},accept_downloads=True)
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.goto(os.getenv('STRUCTURED_DIAGRAM_FIXTURE_URL','http://127.0.0.1:3002/structured_diagram_fixture.html'))
        await page.wait_for_function('typeof window.setDiagramFixture === "function"')
        async def stream(content,active=True):
            await page.evaluate('([text,active])=>window.setDiagramFixture(text,active)',[content,active])
        source='Introductory text [Synthetic guide][guide].\n\n```bobdiagram\n'
        await stream(source)
        await page.locator('.structured-diagram').wait_for()
        assert 'bobdiagram' not in await page.locator('main').inner_text()
        source+=record(type='diagram',id='SyntheticFlow',kind='flow',title='Synthetic streaming flow',direction='LR')
        source+=record(type='node',id='Start',label='Synthetic start',shape='rounded',tone='blue')
        await stream(source)
        node=page.locator('.react-flow__node[data-id="Start"]')
        await node.wait_for()
        await node.evaluate('node=>window.originalDiagramNode=node')
        assert await page.locator('[aria-busy="true"]').count()>0
        assert await page.locator('.structured-node').evaluate('el=>getComputedStyle(el).animationName')=='diagram-surface-float'
        await page.get_by_role('button',name='Pause motion',exact=True).click()
        assert await page.locator('.structured-node').evaluate('el=>getComputedStyle(el).animationName')=='none'
        await page.get_by_role('button',name='Resume motion',exact=True).click()
        await page.wait_for_timeout(350)
        anchor=page.locator('.structured-node-anchor .react-flow__handle.source').first
        before=await anchor.bounding_box()
        surface=page.locator('.structured-node').first
        float_before=await surface.evaluate('el=>getComputedStyle(el).transform')
        await page.wait_for_timeout(300)
        after=await anchor.bounding_box()
        assert abs(before['x']-after['x'])<0.1 and abs(before['y']-after['y'])<0.1,'Floating surfaces must keep connection anchors fixed'
        assert float_before!=await surface.evaluate('el=>getComputedStyle(el).transform'),'Floating motion must change the visual surface'
        source+=record(type='edge',id='Connection',source='Start',target='End',label='Synthetic connection',tone='teal',animated=True)
        await stream(source)
        assert await page.locator('.react-flow__edge').count()==0
        source+=record(type='node',id='End',label='Synthetic end',shape='diamond')
        await stream(source)
        await page.locator('.react-flow__edge').wait_for()
        assert await node.evaluate('node=>getComputedStyle(node).animationName')=='diagram-message-in'
        await page.wait_for_function("() => { const edge = document.querySelector('.react-flow__edge'); return edge && getComputedStyle(edge).animationName === 'diagram-message-in'; }")
        await page.wait_for_function('''()=>{
          const panel=document.querySelector('.structured-flow-canvas').getBoundingClientRect();
          return [...document.querySelectorAll('.react-flow__node')].every(node=>{const r=node.getBoundingClientRect();return r.left>=panel.left-2&&r.right<=panel.right+2&&r.top>=panel.top-2&&r.bottom<=panel.bottom+2});
        }''')
        assert await node.evaluate('node=>node === window.originalDiagramNode')
        assert await page.locator('.structured-node').first.evaluate('el=>getComputedStyle(el).backgroundColor')=='rgb(234, 243, 255)'
        connector=page.locator('.react-flow__edge-path').first
        await page.wait_for_function("() => {const el=document.querySelector('.react-flow__edge-path');return el && getComputedStyle(el).animationName==='diagram-transfer-flow';}")
        await page.get_by_role('button',name='Pause motion',exact=True).click()
        await page.wait_for_function("() => {const el=document.querySelector('.react-flow__edge-path');return el && getComputedStyle(el).animationName==='none';}")
        assert await page.locator('.structured-node').first.evaluate('el=>getComputedStyle(el).animationName')=='none'
        await page.get_by_role('button',name='Resume motion',exact=True).click()
        await page.emulate_media(reduced_motion='reduce')
        await page.wait_for_function("() => {const el=document.querySelector('.react-flow__edge-path');return el && getComputedStyle(el).animationName==='none';}")
        assert await page.locator('.structured-node').first.evaluate('el=>getComputedStyle(el).animationName')=='none'
        await page.emulate_media(reduced_motion='no-preference')
        assert '"type"' not in await page.locator('main').inner_text()
        # Ordinary prose arriving after a finished fence must preserve viewport/node identity.
        source+='```\n\nContinuing prose.\n\n[guide]: https://example.org/synthetic-guide\n'
        await stream(source)
        await page.get_by_role('button',name='Zoom in',exact=True).click()
        await page.wait_for_timeout(350)
        transform=await page.locator('.react-flow__viewport').get_attribute('style')
        await stream(source+' Additional words are still streaming.')
        assert await node.evaluate('node=>node === window.originalDiagramNode')
        assert transform==await page.locator('.react-flow__viewport').get_attribute('style')
        await stream(source,False)
        assert await page.get_by_role('link',name='Synthetic guide',exact=True).get_attribute('href')=='https://example.org/synthetic-guide'
        for width in (1000,390,320):
            await page.set_viewport_size({'width':width,'height':900})
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Overflow at {width}px'
        await page.wait_for_function('''()=>{const a=document.querySelector('.react-flow__node[data-id="Start"]').getBoundingClientRect();const b=document.querySelector('.react-flow__node[data-id="End"]').getBoundingClientRect();return b.top>a.bottom && Math.abs(a.left-b.left)<2;}''')
        await page.get_by_role('button',name='Fit',exact=True).click()
        await page.wait_for_timeout(350)
        await page.screenshot(path='/tmp/structured-diagram-320.png',full_page=True)
        for label,suffix in [('SVG','.svg'),('JSON','.json')]:
            async with page.expect_download() as pending:
                await page.get_by_role('button',name=label,exact=True).click()
            download=await pending.value
            path=Path('/tmp/synthetic-diagram-export'+suffix)
            await download.save_as(str(path))
            if suffix=='.svg':
                root=ET.fromstring(path.read_text())
                assert root.tag.endswith('svg')
                assert 'Synthetic start' in path.read_text()
                assert '#eaf3ff' in path.read_text() and '#228574' in path.read_text()
            else:
                spec=json.loads(path.read_text())
                assert len(spec['nodes'])==2 and len(spec['edges'])==1
        saves=[]
        async def save_route(route):
            saves.append({'url':route.request.url,'body':route.request.post_data_json})
            await route.fulfill(status=200,content_type='application/json',body='{}')
        await page.route('**/sessions/synthetic-diagram-session/file',save_route)
        await page.get_by_role('button',name='Save',exact=True).click()
        await page.get_by_text('Diagram saved.',exact=True).wait_for()
        assert len(saves)==1 and '/sessions/synthetic-diagram-session/file' in saves[0]['url']
        assert len(json.loads(saves[0]['body']['content'])['nodes'])==2
        # User-selected viewport also survives newly arriving nodes.
        await stream(source,True)
        await page.get_by_role('button',name='Zoom in',exact=True).click()
        await page.wait_for_timeout(350)
        transform=await page.locator('.react-flow__viewport').get_attribute('style')
        third=source.replace('```\n\nContinuing prose.',record(type='node',id='Extra',label='Synthetic extra',shape='ellipse')+'```\n\nContinuing prose.')
        await stream(third,True)
        await page.locator('.react-flow__node[data-id="Extra"]').wait_for()
        await page.wait_for_timeout(350)
        assert transform==await page.locator('.react-flow__viewport').get_attribute('style')
        # Later malformed data leaves previously validated nodes visible.
        malformed=source.replace('```\n\nContinuing prose.','{bad record}\n```')
        await stream(malformed,False)
        await node.wait_for()
        await page.get_by_text('Invalid JSON record.',exact=False).wait_for()
        # Long chains wrap to rows where cards fit, keeping native routed arrows.
        long_flow='```bobdiagram\n'+record(type='diagram',id='LongSyntheticFlow',kind='flow',title='Synthetic twelve-stage flow',direction='LR')
        for index in range(12):
            long_flow+=record(type='node',id=f'Step{index}',label=f'Synthetic stage {index+1}',shape='rounded',tone='blue')
            if index:
                long_flow+=record(type='edge',id=f'Link{index}',source=f'Step{index-1}',target=f'Step{index}',label=f'Continue {index}',tone='teal')
        long_flow+='```'
        for width in (1280,1000,768,640,390,320):
            await page.set_viewport_size({'width':width,'height':900})
            await stream(long_flow,False)
            await page.wait_for_function("document.querySelectorAll('.react-flow__node').length === 12 && document.querySelectorAll('.react-flow__edge').length === 11")
            await page.wait_for_timeout(600)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Long flow page overflow at {width}'
            first=page.locator('.react-flow__node[data-id="Step0"]')
            second=page.locator('.react-flow__node[data-id="Step1"]')
            a,b=await first.bounding_box(),await second.bounding_box()
            assert a['width']>=95,f'Tiny labels at {width}: {a}'
            scroller=page.locator('.structured-flow-scroll')
            assert await scroller.evaluate('el=>el.scrollWidth <= el.clientWidth + 2'),f'Wrapped graph must fit width at {width}'
            if width >= 640:
                assert abs(a['y']-b['y'])<2 and b['x']>a['x']+a['width'],f'Missing first row at {width}: {a}, {b}'
                rects=await page.locator('.react-flow__node').evaluate_all('nodes=>nodes.map(n=>n.getBoundingClientRect().y)')
                assert max(rects)-min(rects)>150,'Remaining steps must continue on later rows'
                assert await page.locator('.react-flow__edge-path').evaluate_all("paths=>paths.some(p=>(p.getAttribute('d').match(/Q/g)||[]).length>=4)"),'Wrapped row connectors must retain native bends'
            else:
                assert b['y']>a['y']+a['height'],'Phones must keep natural-size single columns'
            assert await page.locator('.diagram-moving-particle').count()==11,'Moving arrows are enabled by default'
            particle=page.locator('.diagram-moving-particle').first
            before=await particle.evaluate('el=>[el.getCTM().e,el.getCTM().f]')
            await page.wait_for_timeout(200)
            after=await particle.evaluate('el=>[el.getCTM().e,el.getCTM().f]')
            assert before!=after,'Particles must actually travel along arrows'
            # The complete flow now occupies normal page height, with no inner scroll.
            assert await scroller.evaluate('el=>el.scrollHeight<=el.clientHeight+2')
            assert await page.get_by_role('button',name='Readable view',exact=True).count()==0
            await page.get_by_role('button',name='Fit',exact=True).click()
            await page.wait_for_timeout(350)
            await page.screenshot(path=f'/tmp/structured-wrapped-flow-{width}.png',full_page=True)
            last=await page.locator('.react-flow__node[data-id="Step11"]').bounding_box()
            panel=await scroller.bounding_box()
            assert last['y']>=panel['y'] and last['y']+last['height']<=panel['y']+panel['height']+2,'Last stage must be visible in the full-height card'
        # Window height alone must not shrink the complete inline flow.
        natural_height=await page.locator('.structured-flow-scroll').evaluate('el=>el.offsetHeight')
        await page.set_viewport_size({'width':320,'height':500})
        await page.wait_for_timeout(200)
        assert abs(await page.locator('.structured-flow-scroll').evaluate('el=>el.offsetHeight')-natural_height)<2
        await page.set_viewport_size({'width':320,'height':900})
        # Branches, merges and cycles preserve every node and connection.
        branched='```bobdiagram\n'+record(type='diagram',id='BranchedSynthetic',kind='flow',title='Synthetic branching flow',direction='LR')
        for index in range(8):
            branched+=record(type='node',id=f'Branch{index}',label=f'Synthetic branch {index+1}',shape='diamond' if index==1 else 'rounded')
        pairs=[(0,1),(1,2),(1,3),(2,4),(3,4),(4,5),(5,6),(5,7),(7,1)]
        for index,(start,end) in enumerate(pairs):
            branched+=record(type='edge',id=f'Route{index}',source=f'Branch{start}',target=f'Branch{end}',label=f'Route {index+1}')
        await stream(branched+'```',False)
        await page.wait_for_function("document.querySelectorAll('.react-flow__node').length === 8 && document.querySelectorAll('.react-flow__edge').length === 9")
        await page.wait_for_timeout(350)
        assert await page.locator('.react-flow__node').evaluate_all('''nodes=>{
            const panel=document.querySelector('.structured-flow-scroll').getBoundingClientRect();
            return nodes.every(node=>{const r=node.getBoundingClientRect();return r.left>=panel.left-2 && r.right<=panel.right+2 && r.top>=panel.top-2 && r.bottom<=panel.bottom+2;});
        }''')
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        # Sequence messages appear while the response is still streaming.
        sequence='```bobdiagram\n'+record(type='diagram',id='SyntheticSequence',kind='sequence',title='Synthetic sequence',direction='LR')
        sequence+=record(type='node',id='Client',label='Synthetic client',shape='rectangle')+record(type='node',id='Server',label='Synthetic server',shape='rectangle')
        await stream(sequence)
        svg=page.locator('.structured-diagram svg').first
        await svg.wait_for()
        sequence+=record(type='edge',id='Request',source='Client',target='Server',label='Synthetic request',tone='blue',animated=True)
        await stream(sequence)
        await page.get_by_text('Synthetic request',exact=True).wait_for()
        sequence+=record(type='edge',id='Response',source='Server',target='Client',label='Synthetic response')
        await stream(sequence)
        await page.get_by_text('Synthetic response',exact=True).wait_for()
        assert await page.locator('.sequence-message').count()==2
        picker=page.get_by_role('combobox',name='Explore sequence messages')
        await picker.select_option('Request')
        assert await page.locator('.sequence-message').first.get_attribute('aria-pressed')=='true'
        await page.wait_for_function("getComputedStyle(document.querySelectorAll('.sequence-message')[1]).opacity === '0.25'")
        # Later prose must preserve the reader's selected message.
        await stream(sequence+'```\n\nAdditional explanation.',False)
        assert await picker.input_value()=='Request'
        await page.locator('.sequence-message').nth(1).focus()
        await page.keyboard.press('Enter')
        assert await picker.input_value()=='Response'
        await picker.select_option('')
        assert await page.locator('.sequence-message').first.evaluate('el=>getComputedStyle(el).opacity')=='1'
        assert await page.locator('.sequence-participant-float').first.evaluate('el=>getComputedStyle(el).animationName')=='diagram-surface-float'
        assert await page.locator('.diagram-transfer').evaluate('el=>getComputedStyle(el).animationName')=='diagram-transfer-flow'
        await page.get_by_role('button',name='Pause motion',exact=True).click()
        assert await page.locator('.diagram-transfer').evaluate('el=>getComputedStyle(el).animationName')=='none'
        await page.get_by_role('button',name='Resume motion',exact=True).click()
        await page.emulate_media(reduced_motion='reduce')
        assert await page.locator('.sequence-message').first.evaluate('node=>getComputedStyle(node).animationName')=='none'
        assert await svg.evaluate('node=>getComputedStyle(node).transitionDuration')=='0s'
        assert await page.locator('.sequence-participant-float').first.evaluate('el=>getComputedStyle(el).animationName')=='none'
        await page.get_by_role('button',name='Enable motion',exact=True).click()
        assert await page.locator('.sequence-participant-float').first.evaluate('el=>getComputedStyle(el).animationName')=='diagram-surface-float'
        assert await page.locator('.diagram-transfer').evaluate('el=>getComputedStyle(el).animationName')=='diagram-transfer-flow'
        await page.get_by_role('button',name='Pause motion',exact=True).click()
        assert await page.locator('.sequence-participant-float').first.evaluate('el=>getComputedStyle(el).animationName')=='none'
        await page.emulate_media(reduced_motion='no-preference')
        await page.get_by_role('button',name='Resume motion',exact=True).click()
        await stream(sequence+'```',False)
        many='```bobdiagram\n'+record(type='diagram',id='ManySyntheticParticipants',kind='sequence',title='Synthetic many-participant sequence',direction='LR')
        for index in range(9):
            many+=record(type='node',id=f'Participant{index}',label=f'Participant {index+1}',shape='rectangle')
        many+=record(type='edge',id='Across',source='Participant0',target='Participant8',label='Synthetic cross-participant message')+'```'
        await stream(many,False)
        await page.locator('.structured-sequence').wait_for()
        assert await page.locator('.structured-sequence').evaluate('el=>el.viewBox.baseVal.width')>=1700
        assert await page.locator('.structured-sequence-scroll').evaluate('el=>el.scrollWidth<=el.clientWidth+2')
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        # Existing numeric tables and charts remain independent of diagram routing.
        data='\n\n| Category | Amount |\n| --- | --- |\n| Synthetic A | 12 |\n| Synthetic B | 24 |\n'
        for kind in ('bar','pie'):
            data+='\n```bobchart\n'+json.dumps({'type':kind,'title':'Synthetic '+kind,'labels':['Synthetic A','Synthetic B'],'data':[12,24]})+'\n```\n'
        await stream(source+data,False)
        await page.locator('.interactive-chart-card').first.wait_for()
        assert await page.locator('.interactive-chart-card').count()==2
        assert await page.locator('.interactive-chart-card svg').count()==2
        assert await page.locator('table').count()==1
        assert 'Synthetic B' in await page.locator('table').inner_text()
        await page.wait_for_function('document.querySelectorAll(".structured-diagram .react-flow__node").length === 2')
        # Legacy content continues to render after finishing.
        await stream('```mermaid\nflowchart LR\n A["Synthetic legacy"] --> B["End"]\n```',False)
        await page.locator('.mermaid-panel svg').wait_for()
        # Saved canonical diagrams open in the actual ArtifactEditor visual viewer.
        canonical={'id':'SavedSynthetic','kind':'flow','title':'Saved synthetic diagram','direction':'LR','nodes':[{'id':'One','label':'Saved synthetic node','shape':'rounded'}],'edges':[]}
        async def artifact_route(route):
            url=route.request.url
            if '/source?' in url:
                body={'path':'flow1.diagram.json','kind':'json','content':json.dumps(canonical),'sha256':'synthetic-version'}
            elif '/history?' in url:
                body=[]
            else:
                body=[{'path':'flow1.diagram.json','kind':'json'}]
            await route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
        await page.route('**/sessions/synthetic-diagram-session/artifacts**',artifact_route)
        await page.evaluate('window.showDiagramArtifact()')
        await page.locator('.structured-node[aria-label="Saved synthetic node"]').wait_for()
        await page.get_by_role('tab',name='Code',exact=True).click()
        canonical['nodes'][0]['label']='Edited synthetic node'
        await page.get_by_role('textbox',name='Artifact source',exact=True).fill(json.dumps(canonical))
        await page.get_by_role('tab',name='Visual viewer',exact=True).click()
        await page.locator('.structured-node[aria-label="Edited synthetic node"]').wait_for()
        await page.get_by_role('tab',name='Code',exact=True).click()
        await page.get_by_role('textbox',name='Artifact source',exact=True).fill('{invalid diagram')
        await page.get_by_role('tab',name='Visual viewer',exact=True).click()
        await page.get_by_text('Invalid JSON record.',exact=False).wait_for()
        assert not errors,errors
        await browser.close()
        print('PASS: streaming nodes/edges, deferred references, stable DOM and viewport, mobile width, malformed records, sequence streaming, wrapped rows at desktop/tablet widths, readable phone layouts, traveling particles, motion opt-in, fixed zoom controls, branches/cycles and legacy Mermaid')

asyncio.run(main())
