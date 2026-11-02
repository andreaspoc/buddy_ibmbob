const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
const fs=require('fs'),path=require('path');
const fixturePath=path.join(__dirname,'../web/mermaid-check.html');
fs.writeFileSync(fixturePath,fs.readFileSync(path.join(__dirname,'mermaid_fixture.html')));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
const page=await browser.newPage({viewport:{width:1700,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:3001/mermaid-check.html');
await page.locator('.mermaid-diagram svg').waitFor();
const result=await page.locator('.mermaid-diagram svg').evaluate(svg=>({text:[...svg.querySelectorAll('text')].map(e=>e.textContent).join(' | '),foreignObjects:svg.querySelectorAll('foreignObject').length,labels:[...svg.querySelectorAll('.nodeLabel')].map(e=>e.textContent),textNodes:svg.querySelectorAll('text').length}));
console.log(JSON.stringify({...result,errors}));
await page.screenshot({path:'/tmp/bob-mermaid-check.png'});
{
for(const label of ['DataStage','Watson Studio','Catalogs','Data Lineage','IBM Knowledge Catalog','Models']) if(!result.text.includes(label))throw Error('Missing diagram label '+label);
if(result.textNodes!==15)throw Error('Some node, cluster, or edge labels are missing');
if(result.text.includes('\\n'))throw Error('Escaped newline rendered literally');
if(result.foreignObjects)throw Error('HTML labels remain');
if(errors.length)throw Error(errors.join('\n'));
}
await page.setViewportSize({width:390,height:844});
await page.reload();
await page.locator('.mermaid-diagram svg').waitFor();
await page.getByRole('button',{name:'Actual size'}).click();
await page.getByRole('button',{name:'Fit to width'}).click();
if(!await page.locator('.mermaid-diagram.fitted').count())throw Error('Diagram fit failed');
console.log('Visible labels, line breaks, and mobile fit checks passed');
} finally {fs.rmSync(fixturePath,{force:true});await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
