"""Actual ArtifactEditor receives synthetic HTML before task completion."""
import asyncio,json,os
from playwright.async_api import async_playwright

async def main():
 async with async_playwright() as runtime:
  browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1000,'height':900})
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  async def missing(route):
   await route.fulfill(status=404,content_type='application/json',body=json.dumps({'detail':'Not written yet'}))
  await page.route('**/sessions/synthetic-live-dashboard/artifacts**',missing)
  await page.goto(os.getenv('LIVE_ARTIFACT_FIXTURE_URL','http://127.0.0.1:3002/live_artifact_fixture.html'))
  await page.wait_for_function('typeof window.updateLiveArtifact === "function"')
  shell='<!doctype html><html><head><style>body{background:#261344;color:#eee;font:16px sans-serif}button{background:#8b5cf6;color:white}</style></head><body><h1>Purple dashboard</h1><p>Building dashboard sections…</p></body></html>'
  await page.evaluate('(html)=>window.updateLiveArtifact(html)',shell)
  frame=page.frame_locator('iframe[title="Artifact preview"]:not([aria-hidden="true"])')
  await frame.get_by_role('heading',name='Purple dashboard').wait_for()
  assert await page.get_by_role('status').count()>0
  assert await page.get_by_role('button',name='Save',exact=True).is_disabled()
  await page.locator('.artifact-provenance > summary').first.click()
  await page.locator('.artifact-provenance').first.get_by_text('synthetic-correlation',exact=True).wait_for()
  assert await page.locator('.artifact-provenance').first.locator('time').count()==1
  assert await page.get_by_text('Not written yet',exact=True).count()==0
  # Frequent snapshots must render without waiting for the stream to settle.
  await page.evaluate("""html=>{window.liveFixtureCounter=0;window.liveFixtureTimer=setInterval(()=>{window.liveFixtureCounter++;window.updateLiveArtifact(html.replace('Building dashboard sections…','Live section '+window.liveFixtureCounter));},75)}""",shell)
  try:
   await frame.get_by_text('Live section',exact=False).wait_for(timeout=3000)
   assert await page.get_by_role('status').count()>0
  finally:
   await page.evaluate('clearInterval(window.liveFixtureTimer)')
  updated=shell.replace('<p>Building dashboard sections…</p>','<section><h2>README architecture</h2><button onclick="this.textContent=\'Expanded\'">Explore architecture</button></section>')
  await page.evaluate('(html)=>window.updateLiveArtifact(html)',updated)
  await frame.get_by_role('heading',name='README architecture').wait_for()
  # Chromium's iframe locator coordinates omit the host CSS zoom. Use the
  # frame's CSS coordinates and its displayed scale for a real pointer click.
  button = frame.get_by_role('button',name='Explore architecture')
  await button.scroll_into_view_if_needed()
  rect = await button.evaluate('el => el.getBoundingClientRect().toJSON()')
  iframe = page.locator('iframe[title="Artifact preview"]:not([aria-hidden="true"])')
  bounds = await iframe.bounding_box()
  ratio = bounds['width'] / await iframe.evaluate('el => el.offsetWidth')
  await page.mouse.click(bounds['x'] + (rect['x'] + rect['width']/2) * ratio, bounds['y'] + (rect['y'] + rect['height']/2) * ratio)
  await frame.get_by_role('button',name='Expanded').wait_for()
  assert await page.get_by_role('status').count()>0
  # Other generated files must not displace this dashboard's live state.
  await page.evaluate('window.updateOtherArtifact()')
  await page.evaluate('(html)=>window.updateLiveArtifact(html)',updated.replace('README architecture','Dashboard after another file'))
  await frame.get_by_role('heading',name='Dashboard after another file').wait_for()
  # Live replacement must preserve both the dashboard's scroll position and
  # independently scrolling diagram/detail panels, without replaying entrances.
  tall = shell.replace('</style>', '@keyframes entrance{from{transform:translateY(40px)}to{transform:translateY(0)}}h1{animation:entrance 2s}</style>').replace('</body>', '<div id="details" style="height:100px;overflow:auto"><div style="height:600px">Flow diagram detail panel</div></div><section style="height:2400px">Long dashboard section</section></body>')
  await page.evaluate('(html)=>window.updateLiveArtifact(html)',tall)
  await frame.get_by_text('Long dashboard section').wait_for()
  assert await frame.locator('h1').evaluate('el=>el.getAnimations().length') == 0
  await frame.locator('body').evaluate('()=>{window.scrollTo(0,220);document.getElementById("details").scrollTop=80;}')
  await page.wait_for_timeout(100)
  host_top = await page.evaluate('scrollY')
  await page.evaluate('(html)=>window.updateLiveArtifact(html.replace("Long dashboard section","Updated dashboard section"))',tall)
  await frame.get_by_text('Updated dashboard section').wait_for()
  assert abs(await frame.locator('body').evaluate('()=>scrollY')-220)<2, 'Dashboard position reset'
  assert abs(await frame.locator('#details').evaluate('el=>el.scrollTop')-80)<2, 'Diagram detail position reset'
  assert abs(await page.evaluate('scrollY')-host_top)<2, 'Host page moved during preview swap'
  for width in (390,320):
   await page.set_viewport_size({'width':width,'height':900})
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'Artifact controls overflow at {width}'
  await page.screenshot(path='/tmp/live-artifact-320.png',full_page=True)
  # A stalled external library must not hold all newer snapshots hostage.
  blocked=[]
  async def hold_library(route):
   blocked.append(route)
  await page.route('https://cdn.jsdelivr.net/buddy-blocked.js',hold_library)
  await page.evaluate('(html)=>window.updateLiveArtifact(html)',shell.replace('</body>','<script src="https://cdn.jsdelivr.net/buddy-blocked.js"></script></body>'))
  for _ in range(30):
   if blocked: break
   await page.wait_for_timeout(100)
  assert blocked,'Blocking library fixture did not load'
  await page.evaluate('(html)=>window.updateLiveArtifact(html)',updated.replace('README architecture','Recovered live dashboard'))
  await frame.get_by_role('heading',name='Recovered live dashboard').wait_for(timeout=6000)
  for route in blocked:
   await route.abort()
  # The final snapshot can arrive in the same render as streaming completion.
  await page.evaluate('(html)=>window.updateLiveArtifact(html,false)',updated.replace('README architecture','Final dashboard'))
  await frame.get_by_role('heading',name='Final dashboard').wait_for(timeout=5000)
  # Completion triggers persisted-file reconciliation; this fixture intentionally stays404.
  assert not errors,errors
  await browser.close()
  print('PASS: continuous snapshots, multiple files, scroll preservation, stalled script recovery, final snapshot and mobile layout')

asyncio.run(main())
