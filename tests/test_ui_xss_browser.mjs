import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Install Playwright normally, or point CARBON_PLAYWRIGHT_MODULE at its ESM entry.
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const req=createRequire(root+'/web/package.json');
const ts=req('typescript');
const {marked}=await import(root+'/web/node_modules/marked/lib/marked.esm.js');
const markdownSource=readFileSync(root+'/web/src/components/MarkdownView.tsx','utf8');
const loopSource=markdownSource.slice(markdownSource.indexOf("for (const link of renderRoot.querySelectorAll('a'))"),markdownSource.indexOf('    if (citationSources.size'));
const loop=ts.transpileModule(loopSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const mapSource=readFileSync(root+'/web/src/components/MapRenderer.ts','utf8');
const start=mapSource.indexOf('/** Marker colors enter SVG markup');
const pinFunction=ts.transpileModule(mapSource.slice(start,mapSource.indexOf('\nfunction createUserLocationIcon',start)),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
const page=await browser.newPage();
await page.route('**/*',route=>route.abort());
await page.setContent('<html><body><h1>Isolated OWASP UI checks</h1></body></html>');
await page.addScriptTag({path:root+'/web/node_modules/dompurify/dist/purify.js'});
await page.addScriptTag({path:root+'/web/node_modules/leaflet/dist/leaflet.js'});
const results=[];
for(const extension of ['csv','pptx']){
 const payload=`[&lt;img src=x onerror="window.auditXss=(window.auditXss||0)+1"&gt;](report.${extension})`;
 const html=marked.parse(payload);
 const result=await page.evaluate(async ({html,loop,extension})=>{
  window.auditXss=0;
  const renderRoot=document.createElement('div');
  renderRoot.innerHTML=DOMPurify.sanitize(html,{ADD_TAGS:['foreignObject'],ADD_ATTR:['target','rel']});
  document.body.append(renderRoot);
  await new Promise(r=>setTimeout(r,50));
  const before={executions:window.auditXss,images:renderRoot.querySelectorAll('img').length};
  new Function('renderRoot',`const targetSession='audit'; const readOnly=false; const citationSources=new Map(); ${loop}`)(renderRoot);
  await new Promise(r=>setTimeout(r,100));
  const after={executions:window.auditXss,images:renderRoot.querySelectorAll('img').length};
  const passed=before.executions===0 && before.images===0 && after.executions===0 && after.images===0;
  renderRoot.remove();
  return {check:`markdown-${extension}-badge`,before,after,passed};
 },{html,loop,extension});
 results.push(result);
}
const map=await page.evaluate(async (pinFunction)=>{
 window.auditMapXss=0;
 const create=new Function('THEME','PIN_PALETTE',pinFunction+';return createPinIcon;')({font:'sans-serif'},['#0f62fe']);
 const color='"/></linearGradient></defs></svg><img src=x onerror="window.auditMapXss=(window.auditMapXss||0)+1"><svg x="';
 const icon=create(L,0,color,false);
 const element=icon.createIcon();document.body.append(element);
 await new Promise(r=>setTimeout(r,100));
 const result={check:'map-pin-color',executions:window.auditMapXss,images:element.querySelectorAll('img').length,passed:window.auditMapXss===0 && element.querySelectorAll('img').length===0};
 element.remove();return result;
},pinFunction);
results.push(map);

const legacyChart=readFileSync(root+'/frontend/chart.js','utf8').replace(/export /g,'');
const chartResult=await page.evaluate(async source=>{
 window.auditLegacyXss=0;
 const render=new Function(source+';return renderChartToDOM;')();
 const text='<img src=x onerror="window.auditLegacyXss++">';
 const element=render({type:'bar',labels:[text],datasets:[{label:text,data:[5],color:'#0f62fe'}]});
 document.body.append(element);
 for(const node of element.querySelectorAll('svg rect'))node.dispatchEvent(new MouseEvent('mouseenter',{clientX:30,clientY:30}));
 await new Promise(r=>setTimeout(r,100));
 const tooltip=element.querySelector('.chart-interactive-tooltip');
 const result={check:'legacy-chart-tooltip',text:tooltip.textContent,passed:tooltip.textContent.includes(text)&&!tooltip.querySelector('img')&&window.auditLegacyXss===0};
 element.remove();return result;
},legacyChart);
results.push(chartResult);
const legacySource=readFileSync(root+'/app/static/app.js','utf8');
const msSource=legacySource.slice(legacySource.indexOf('async function loadMicrosoftStatus()'),legacySource.indexOf('\nasync function ',legacySource.indexOf('async function loadMicrosoftStatus()')+1));
results.push(await page.evaluate(async source=>{
 window.auditLegacyXss=0;
 const text='<img src=x onerror="window.auditLegacyXss++">';
 const container=document.createElement('div');container.id='ms-status-box';document.body.append(container);
 const load=new Function('byId','fetch','loadMcps',source+';return loadMicrosoftStatus;')(id=>document.getElementById(id),async()=>({ok:true,json:async()=>({connected:true,name:text,account:text})}),()=>{});
 await load();await new Promise(r=>setTimeout(r,100));
 const result={check:'legacy-microsoft-status',passed:container.textContent.includes(text)&&container.querySelector('strong').textContent===text&&!container.querySelector('img')&&window.auditLegacyXss===0};
 container.remove();return result;
},msSource));
results.push(await page.evaluate(pinFunction=>{
 const funcs=new Function('PIN_PALETTE',pinFunction+';return {safeMapColor,safeMapUrl};')(['#0f62fe']);
 return {check:'map-color-url-validation',passed:funcs.safeMapColor('#ab12EF','#0f62fe')==='#ab12EF'&&funcs.safeMapColor('red;bad','#0f62fe')==='#0f62fe'&&funcs.safeMapUrl('javascript:alert(1)','fallback')==='fallback'&&funcs.safeMapUrl('data:text/html,bad','fallback')==='fallback'&&funcs.safeMapUrl('https://example.com/directions','fallback')==='https://example.com/directions'};
},pinFunction));


const securitySource=readFileSync(root+'/web/src/lib/presentationSecurity.ts','utf8');
const securityRuntime=ts.transpileModule(securitySource.replace("import DOMPurify from 'dompurify';",'').replace(/export /g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
results.push(await page.evaluate(async source=>{
 window.auditEditorXss=0;
 const sanitize=new Function(source+';return sanitizeEditablePresentation;')();
 const attack=`<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"></head><body><h1>Editable title</h1><script>parent.auditEditorXss++;</script><img src=x onerror="parent.auditEditorXss++"><a href="javascript:parent.auditEditorXss++">Unsafe navigation</a><iframe srcdoc="bad"></iframe><span data-bob-preserved-script='"<script>bad()</script>"'>Forged marker</span></body></html>`;
 const frame=document.createElement('iframe');
 frame.setAttribute('sandbox','allow-same-origin');
 const loaded=new Promise((resolve,reject)=>{frame.onload=resolve;setTimeout(()=>reject(new Error('Sanitized presentation iframe did not load')),3000);});
 frame.srcdoc=sanitize(attack);document.body.append(frame);
 await loaded;await new Promise(r=>setTimeout(r,100));
 const doc=frame.contentDocument;
 const policy=doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
 const hasHandler=Array.from(doc.querySelectorAll('*')).some(element=>Array.from(element.attributes).some(attribute=>/^on/i.test(attribute.name)));
 const h1=doc.querySelector('h1');h1.textContent='Edited safely';
 const passed=window.auditEditorXss===0&&h1.textContent==='Edited safely'&&!doc.querySelector('script,iframe,base,meta[http-equiv="refresh"],a[href]')&&!hasHandler&&policy.includes("script-src 'none'")&&policy.includes("connect-src 'none'");
 const result={check:'editable-presentation-sanitized-iframe',executions:window.auditEditorXss,passed};
 frame.remove();return result;
},securityRuntime));

const report={date:new Date().toISOString(),headless:true,browser:browser.version(),scope:'Isolated harness using actual DOMPurify and marked, actual Markdown link loop, map pin function, Leaflet DivIcon, legacy renderers, and sanitized editable iframe. No live app account or end-to-end component mount.',requests:'All external requests blocked',results};
writeFileSync(process.env.OWASP_UI_RESULTS || join(tmpdir(),'owasp-ui-regression-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
} finally { await browser.close(); }
