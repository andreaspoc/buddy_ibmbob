const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs'),path=require('path');
(async()=>{
const fixturePath=path.join(__dirname,'../web/mermaid-editor-check.html');
fs.writeFileSync(fixturePath,fs.readFileSync(path.join(__dirname,'mermaid_editor_fixture.html')));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
const page=await browser.newPage({viewport:{width:1400,height:1000}});
let saved=null;
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/sessions/mermaid-qa/file?**',route=>route.fulfill({status:saved?200:404,body:saved||''}));
await page.route('**/sessions/mermaid-qa/file',async route=>{
 saved=route.request().postDataJSON().content;
 await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
});
await page.goto('http://127.0.0.1:3001/mermaid-editor-check.html');
await page.locator('.mermaid-diagram svg').waitFor();
await page.getByRole('button',{name:'Maximize',exact:true}).click();
await page.locator('.mermaid-panel.maximized').waitFor();
await page.getByRole('button',{name:'Restore',exact:true}).click();
await page.locator('.mermaid-panel.maximized').waitFor({state:'hidden'});
await page.getByRole('button',{name:'Edit code',exact:true}).click();
const input=page.getByLabel('Mermaid code');
const original=await input.inputValue();
const updated=original.replace('DataStage','Updated DataStage').replace('lineage" --> IKC','lineage" --> CAT');
await input.fill(updated);
await page.getByRole('button',{name:'Apply',exact:true}).click();
await page.getByText('Preview updated. Save to keep these changes.',{exact:true}).waitFor();
if(!(await page.locator('.mermaid-diagram svg').textContent()).replace(/\s/g,'').includes('UpdatedDataStage'))throw Error('Edit not rendered');
await input.fill('graph TB\n A[broken');
await page.getByRole('button',{name:'Apply',exact:true}).click();
await page.getByRole('alert').waitFor();
if(!(await page.locator('.mermaid-diagram svg').textContent()).replace(/\s/g,'').includes('UpdatedDataStage'))throw Error('Invalid source erased diagram');
await input.fill(updated);
await page.getByRole('button',{name:'Save',exact:true}).click();
await page.getByText('Diagram saved.',{exact:true}).waitFor();
if(saved!==updated)throw Error('Saved code differs');
await page.reload();
await page.locator('.mermaid-diagram svg').waitFor();
if(!(await page.locator('.mermaid-diagram svg').textContent()).replace(/\s/g,'').includes('UpdatedDataStage'))throw Error('Saved edit not restored');
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'Maximize',exact:true}).click();
await page.locator('.mermaid-panel.maximized').waitFor();
await page.screenshot({path:'/tmp/bob-mermaid-editor-mobile.png'});
await page.getByRole('button',{name:'Restore',exact:true}).click();
if(errors.length)throw Error(errors.join('\n'));
console.log('Mermaid maximize/restore, source edits, invalid syntax, save/reopen, and mobile checks passed');
}finally{fs.rmSync(fixturePath,{force:true});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
