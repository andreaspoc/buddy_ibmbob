// Synthetic UI fixtures only: no real decision data, provider calls or deployments.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'decisions-buddy/dist');
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs');
const server = createServer(async (req,res) => {
  try {
    const pathname = new URL(req.url,'http://fixture').pathname;
    const relative = pathname.replace(/^\/decisions\/?/,'') || 'index.html';
    const filename = path.resolve(dist, relative);
    if (!filename.startsWith(dist + path.sep)) { res.writeHead(404).end(); return; }
    const content = await readFile(filename);
    res.writeHead(200, {'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html'}).end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});page.setDefaultTimeout(10000);
const nodes=Array.from({length:12},(_,i)=>({id:`synthetic-${i}`,name:`Synthetic node ${i+1}`,type:i===0?'inputNode':i===11?'outputNode':'expressionNode',position:{x:(i%6)*1700-3000,y:Math.floor(i/6)*1800-900},content:i>0&&i<11?{expressions:[{key:`v${i}`,value:`${i}`}]}:{}}));
const model={id:'synthetic-wide-flow',name:'Synthetic fit regression',owner:'fixture-admin',version:1,status:'draft',defaultInput:{value:1},graph:{nodes,edges:nodes.slice(1).map((n,i)=>({id:`edge-${i}`,sourceId:nodes[i].id,targetId:n.id}))}};
await page.route('**/api/decisions/**', async route=>{
  const pathname=new URL(route.request().url()).pathname;
  let data={};
  if(pathname.endsWith('/me'))data={username:'fixture-admin',displayName:'Synthetic administrator',isAdmin:true};
  else if(pathname==='/api/decisions/models')data=[{id:model.id,name:model.name,version:1}];
  else if(pathname===`/api/decisions/models/${model.id}`)data=model;
  else if(pathname.endsWith('/audit-logs'))data=[];
  else if(pathname.endsWith('/cp4d/status') || pathname.endsWith('/admin/integrations'))data={providers:{}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
});
await page.routeWebSocket('**/api/decisions/ws',()=>{});
const flow=page.locator('.react-flow');
async function geometry(){return flow.evaluate(element=>{const box=element.getBoundingClientRect();return{width:box.width,height:box.height,transform:element.querySelector('.react-flow__viewport')?.style.transform,nodes:[...element.querySelectorAll('.react-flow__node')].map(node=>{const r=node.getBoundingClientRect();return{id:node.getAttribute('data-id'),left:r.left-box.left,right:r.right-box.left,top:r.top-box.top,bottom:r.bottom-box.top,width:r.width,height:r.height};})};});}
async function expectFit(label){
  const deadline=Date.now()+10000;
  let result;
  while(Date.now()<deadline){result=await geometry();if(result.width>0&&result.height>0&&result.nodes.length===nodes.length&&result.nodes.every(n=>n.width>0&&n.left>=-2&&n.top>=-2&&n.right<=result.width+2&&n.bottom<=result.height+2))return result;await page.waitForTimeout(80);}
  assert.fail(`${label}: nodes outside visible canvas: ${JSON.stringify(result)}`);
}
try{
  await page.goto(`${url}/decisions/`);
  await page.getByRole('heading',{name:model.name,exact:true}).waitFor();
  await page.getByRole('tab',{name:/Visual editor/}).click();
  const initial=await expectFit('opening visual editor');
  await flow.scrollIntoViewIfNeeded();const viewport=await flow.boundingBox();
  await page.mouse.move(viewport.x+30,viewport.y+30);await page.mouse.down();await page.mouse.move(viewport.x+150,viewport.y+100,{steps:8});await page.mouse.up();
  const panned=await geometry();assert.notEqual(panned.transform,initial.transform,'manual pan should alter transform');
  await page.mouse.move(viewport.x+viewport.width/2,viewport.y+viewport.height/2);
  await page.mouse.wheel(0,-1600);
  await page.waitForTimeout(300);
  const zoomed=await geometry();assert.notEqual(zoomed.transform,initial.transform,'manual zoom should alter transform');
  await page.getByRole('tab',{name:/Simulator/}).click();
  await page.getByRole('tab',{name:/Visual editor/}).click();
  const returned=await expectFit('return to visual editor');assert.notEqual(returned.transform,zoomed.transform,'returning should refit manual zoom');
  await page.getByRole('button',{name:'Collapse navigation',exact:true}).click();
  const expanded=await expectFit('sidebar collapsed');
  assert.ok(expanded.width>returned.width,'collapsing sidebar should resize graph container');
  await page.getByRole('button',{name:'Expand navigation',exact:true}).click();
  const narrowed=await expectFit('sidebar expanded');assert.ok(narrowed.width<expanded.width);
  await page.setViewportSize({width:390,height:844});
  await expectFit('mobile container resize');
  if(process.env.CARBON_SCREENSHOT_DIR){await mkdir(process.env.CARBON_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.CARBON_SCREENSHOT_DIR,'decisions-fit-mobile-synthetic.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});await expectFit('desktop restored');await page.screenshot({path:path.join(process.env.CARBON_SCREENSHOT_DIR,'decisions-fit-desktop-synthetic.png'),fullPage:true});}
  assert.deepEqual(errors,[]);
  console.log('Decisions flow fitting passed: 12 widely spaced synthetic nodes fit on open, after manual zoom/tab return, sidebar collapse/expand, and mobile resize. No live decision execution.');
}catch(error){await page.screenshot({path:'/tmp/decisions-fit-failure.png',fullPage:true}); console.error(await page.locator('[role=tab]').allTextContents());throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
