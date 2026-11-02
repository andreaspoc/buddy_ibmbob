const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
const page=await browser.newPage({viewport:{width:1400,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let requests=[];
await page.route('http://127.0.0.1:3001/**',async route=>{
const pathname=new URL(route.request().url()).pathname;let data;
if(pathname==='/auth/status')data={setup_required:false,user:{username:'qauser',is_admin:false}};
else if(pathname==='/auth/microsoft/status')data={configured:false,connected:false};
else if(pathname==='/sessions')data=route.request().method()==='POST'?{id:'b'.repeat(32),title:'New conversation'}:[{id:'a'.repeat(32),title:'Cloud migration',updated:new Date().toISOString()}];
else if(pathname==='/presentation/templates')data=[{id:'purple-starter',title:'Test template',metadata:{brand:'Company A'},theme:{},fonts:{heading:'Arial',body:'Arial'},colors:{}}];
else if(pathname==='/chat/stream'){
requests.push(route.request().postDataJSON());
await route.fulfill({status:200,contentType:'text/event-stream',body:'{"type":"done","duration_ms":1}\n'});return;
}
else if(['/projects','/skills','/modes','/agents','/mcps','/workspace/pages','/knowledge','/tasks'].includes(pathname)||pathname.includes('/files')||pathname.includes('/history'))data=[];
else{await route.continue();return;}
await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
await page.goto('http://127.0.0.1:3001/');
await page.getByRole('button',{name:'Executive Deck',exact:true}).click();
await page.getByLabel('Number of slides').selectOption('12');
await page.getByRole('button',{name:/PowerPoint \(.pptx\)/}).click();
await page.locator('.template-picker-card').waitFor();
if(requests.length)throw Error('PowerPoint started before template confirmation');
await page.getByRole('button',{name:/Test template/}).click();
await page.waitForFunction(()=>!document.querySelector('textarea')?.disabled);
if(requests[0]?.slide_count!==12||requests[0]?.presentation_format!=='pptx')throw Error('PowerPoint count missing: '+JSON.stringify(requests));
await page.getByRole('button',{name:'Executive Deck',exact:true}).click();
await page.locator('.format-choice-card').getByLabel('Number of slides').selectOption('7');
await page.getByRole('button',{name:/Interactive Web/}).click();
await page.locator('.template-picker-card').waitFor();
if(requests.length!==1)throw Error('HTML started before template confirmation');
await page.getByRole('button',{name:/Test template/}).click();
await page.waitForTimeout(200);
if(requests[1]?.slide_count!==7||requests[1]?.presentation_format!=='html')throw Error('HTML count missing: '+JSON.stringify(requests));
await page.locator('textarea').fill('Create a 9-slide PowerPoint presentation about cloud migration');
await page.locator('textarea').press('Enter');
await page.locator('.template-picker-card').waitFor();
if(await page.locator('.template-picker-card').getByLabel('Number of slides').inputValue()!=='9')throw Error('Explicit prompt count not preselected');
await page.locator('.template-picker-card').getByLabel('Number of slides').selectOption('10');
await page.getByRole('button',{name:/Test template/}).click();
await page.waitForTimeout(200);
if(requests[2]?.slide_count!==10)throw Error('Template count missing');
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'Executive Deck',exact:true}).click();
await page.locator('.format-choice-card').getByLabel('Number of slides').selectOption('1');
await page.screenshot({path:'/tmp/bob-slide-count-mobile.png'});
if(errors.length)throw Error(errors.join('\n'));
console.log('PowerPoint, HTML, explicit prompt count, template override, and mobile selector checks passed');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
