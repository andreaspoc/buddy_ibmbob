// Synthetic book, notes and accounts only; all API requests are intercepted.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const notes=[];const progress=[];
try {
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.route('**/api/learning/**',async route=>{
 const path=new URL(route.request().url()).pathname.replace('/api/learning','');
 const method=route.request().method();let data={};
 if(path==='/me')data={username:'synthetic-reader',is_admin:false};
 else if(path==='/folders')data={items:[{id:'folder1',name:'Synthetic library'}]};
 else if(path==='/folders/folder1/contents')data={books:[{id:'book1',title:'Synthetic book'}],quizzes:[]};
 else if(path==='/books/book1')data={id:'book1',title:'Synthetic book',chapters:[{id:'chapter1',title:'Chapter one'},{id:'chapter2',title:'Chapter two'}],progress:progress.at(-1)||{}};
 else if(path.includes('/chapters/')) return route.fulfill({contentType:'text/html',body:'<html><body><main><h1>Synthetic chapter</h1>'+Array.from({length:60},(_,i)=>`<p>Passage ${i}: Synthetic reading material for checking pagination, wrapping, and page turns. This is test content only.</p>`).join('')+'<script>window.bad=true</script></main></body></html>'});
 else if(path==='/books/book1/notes'&&method==='GET')data={items:notes};
 else if(path==='/books/book1/notes'&&method==='POST'){data={...route.request().postDataJSON(),id:'note1'};notes.unshift(data);}
 else if(path==='/books/book1/progress'){progress.push(route.request().postDataJSON());data={saved:true};}
 else if(path==='/books/book1/notes/note1'&&method==='DELETE'){notes.length=0;data={deleted:true};}
 else if(path.includes('assistant')) data={};
 else throw Error('Unexpected '+method+' '+path);
 return route.fulfill({json:data});
});
await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177')+'/learning');
await page.getByRole('button',{name:'Read Synthetic book',exact:true}).click();
await page.locator('.learning-book-columns p').first().waitFor();
await page.waitForFunction(()=>/Page 1 \/ ([2-9]|\d{2,})/.test(document.querySelector('.learning-page-badge').textContent));
console.log('INITIAL',await page.locator('.learning-page-badge').textContent());
await page.getByRole('button',{name:'Next page',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.learning-page-badge').textContent.includes('Page 2 /'));
assert.equal(progress.at(-1).page,1);
await page.getByRole('button',{name:'Notes palette',exact:true}).click();
await page.getByRole('button',{name:'purple note',exact:true}).click();
await page.getByLabel('New note',{exact:true}).fill('Synthetic private reading note');
await page.getByRole('button',{name:'Save note',exact:true}).click();
await page.getByText('Synthetic private reading note',{exact:true}).waitFor();
assert.equal(notes[0].color,'purple');assert.equal(notes[0].page,1);
await page.screenshot({path:'/tmp/learning-reader-desktop.png'});
assert.equal(await page.evaluate(()=>window.bad),undefined);
assert.ok(page.url().includes('/learning/folders/folder1/books/book1'));
await page.reload();
await page.locator('.learning-book-columns p').first().waitFor();
await page.getByRole('button',{name:'Notes palette',exact:true}).click();
await page.getByText('Synthetic private reading note',{exact:true}).waitFor();
await page.getByRole('button',{name:'Delete note',exact:true}).click();
await page.getByText('No notes yet.',{exact:true}).waitFor();
assert.equal(notes.length,0);
console.log('PASS pagination, persisted page, private colored notes, inert content, direct links and reload');
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'Close notes palette',exact:true}).click();
assert.ok(await page.locator('.learning-book-pages').evaluate(el=>el.clientWidth>0&&el.clientHeight>0));
await page.screenshot({path:'/tmp/learning-reader-mobile.png'});
console.log('PASS mobile pagination',await page.locator('.learning-page-badge').textContent());
} finally{await browser.close();}
