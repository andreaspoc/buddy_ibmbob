// Actual Carbon renderer in generated HTML; fixture values are explicitly synthetic.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || '/tmp/carbon-browser/node_modules/playwright/index.mjs');
execFileSync('python3',['tests/carbon_dashboard_fixture.py','--output','/tmp/carbon-dashboard-offline.html']);
const html=readFileSync('/tmp/carbon-dashboard-offline.html','utf8');
assert(html.includes('data-buddy-carbon-embedded'));
assert(!html.includes('src="/static/carbon-charts.bundle.js"'));
assert(!html.includes('href="/static/carbon-charts.css"'));
const browser=await chromium.launch({args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[],network=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route(/^https?:/,route=>{network.push(route.request().url());return route.abort();});
 await page.goto('file:///tmp/carbon-dashboard-offline.html');
 await page.evaluate(()=>window.carbonReady);
 await page.waitForFunction(()=>document.querySelector('#carbon-bar .bar') && document.querySelector('#carbon-line path.line') && document.querySelector('#carbon-pie svg'));
 assert.equal(await page.evaluate(()=>window.BuddyCarbonCharts.version),'1.27.22');
 const initial=await page.evaluate(()=>window.carbonReplays);
 await page.getByRole('button',{name:'Other view',exact:true}).click();
 await page.waitForTimeout(100);
 await page.getByRole('button',{name:'Chart view',exact:true}).click();
 await page.waitForFunction(count=>window.carbonReplays>count,initial);
 const second=await page.evaluate(()=>window.carbonReplays);
 await page.getByRole('button',{name:'Other view',exact:true}).click();await page.waitForTimeout(100);
 await page.getByRole('button',{name:'Chart view',exact:true}).click();
 await page.waitForFunction(count=>window.carbonReplays>count,second);
 await page.getByRole('button',{name:'Filter supplied values',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.barHandle.chart.model.getData()[0].value),9);
 for(const width of [1440,768,390,320]){
  await page.setViewportSize({width,height:900});await page.waitForTimeout(120);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`offline dashboard overflow ${width}`);
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>window.barHandle.chart.model.getOptions().animations===false);
 const beforeReduced=await page.evaluate(()=>window.carbonReplays);
 await page.getByRole('button',{name:'Replay charts',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.carbonReplays),beforeReduced);
 await page.screenshot({path:'/tmp/carbon-dashboard-export-phone.png',fullPage:true});
 assert.deepEqual(network,[],'offline document must not fetch libraries/fonts');
 assert.deepEqual(errors,[]);
 console.log('PASS: actual Carbon bar/line/pie, generated offline export, no network, repeated tabs, filter update, responsive, reduced motion');
}finally{await browser.close();}
