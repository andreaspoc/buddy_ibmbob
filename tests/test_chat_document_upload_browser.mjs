// Synthetic HTTP fixtures only; no backend or model services are contacted.
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/workflows/capabilities', r => r.fulfill({json:{}}));
let mode = 'ready', reads = 0, retried = false, release;
await page.route('**/sessions/*/documents/**', async route => {
 const url = route.request().url();
 if (url.includes('/prepare?')) { retried = true; return route.fulfill({json:{status:'queued'}}); }
 reads++;
 if(mode === 'delayed' && url.includes('/first/')) { await new Promise(resolve => release = resolve); return route.fulfill({json:{status:'ready'}}).catch(()=>{}); }
 if(mode === 'transient' && reads <= 2) return route.fulfill({status:503,json:{}});
 if(mode === 'unauthorized') return route.fulfill({status:401,json:{}});
 return route.fulfill({json:{status: mode === 'failed' && !retried ? 'failed' : reads === 1 ? 'queued' : 'ready', error:mode === 'failed' && !retried ? 'Synthetic PDF could not be read.' : null}});
});
const upload = async name => page.locator('input[type=file]').setInputFiles({name,mimeType:'application/octet-stream',buffer:Buffer.from('Synthetic test fixture')});
const send = () => page.getByTitle('Send message', {exact:true});
const base = process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
await page.goto(base + '/tests/chat-document-upload.html');
for(const name of ['fixture.pdf','fixture.docx']) {
 reads=0; await upload(name); await page.getByText('Preparing document…',{exact:true}).first().waitFor(); assert(await send().isDisabled());
 await page.getByText('Ready',{exact:true}).first().waitFor(); await send().click(); assert((await page.locator('output').textContent()).includes(`[Attached document: ${name}]`));
}
mode='transient'; reads=0; await upload('transient.pdf'); await page.getByText('Could not check document preparation. Retrying automatically…',{exact:true}).waitFor(); assert(await send().isDisabled());
await page.getByText('Ready',{exact:true}).first().waitFor({timeout:15000}); assert(reads>=3); await send().click();
mode='failed'; reads=0; await upload('failed.docx'); await page.getByRole('alert').filter({hasText:'Synthetic PDF could not be read.'}).waitFor(); assert(await send().isDisabled());
const stableReads=reads; await page.waitForTimeout(1800); assert.equal(reads,stableReads); await page.getByRole('button',{name:'Retry preparation',exact:true}).click(); await page.getByText('Ready',{exact:true}).first().waitFor(); assert(retried); await send().click();
mode='unauthorized'; reads=0; await upload('auth.pdf'); await page.getByText('Document access could not be verified.',{exact:false}).waitFor(); await page.waitForTimeout(1800); assert.equal(reads,1); assert(await send().isDisabled()); await page.getByRole('button',{name:'Remove attached file',exact:true}).click();
mode='delayed'; reads=0; await upload('same.pdf'); await page.waitForFunction(()=>document.querySelector('.attached-chip-name')?.textContent==='same.pdf'); while(!release) await page.waitForTimeout(20);
await page.getByRole('button',{name:'Switch session',exact:true}).click(); assert.equal(await page.locator('.attached-chip').count(),0); mode='failed'; retried=false; await upload('same.pdf'); await page.getByRole('alert').filter({hasText:'Synthetic PDF could not be read.'}).waitFor(); release(); await page.waitForTimeout(300); assert(await send().isDisabled()); assert.equal(await page.locator('.attached-chip-name').textContent(),'same.pdf');
// Exercise App.tsx adoption of a freshly created conversation before upload.
const app = await browser.newPage();
let created = false, uploadCount = 0, appReads = 0;
app.on('pageerror', e => errors.push(String(e)));
await app.addInitScript(() => { sessionStorage.setItem('buddy-approval-guide:fixture-user','seen'); localStorage.setItem('bob-ui-language','en'); });
await app.route('**/*', async route => {
 const path = new URL(route.request().url()).pathname;
 if(path === '/' || path.startsWith('/src/') || path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/assets/') || /\.(svg|png|ico|woff2)$/.test(path)) return route.continue();
 let data=[];
 if(path === '/auth/status') data={user:{username:'fixture-user',is_admin:true},local_login_enabled:true,keycloak_configured:false};
 else if(path === '/personalization/tutorials') data={disabled:true};
 else if(path === '/api/apps') data={apps:[]};
 else if(path === '/api/office/files' || path === '/api/office/folders') data={items:[]};
 else if(path === '/api/office/chat-capabilities') data={version:1};
 else if(path === '/access/me') data={user:{username:'fixture-user',is_admin:true},libraries:[],audiences:[],administrator:true};
 else if(path.endsWith('/capabilities')) data={web_search:false};
 else if(path === '/sessions' && route.request().method()==='POST') { created=true; data={id:'adopted'}; }
 else if(path === '/sessions') data=created ? [{id:'adopted',name:'Synthetic conversation'}] : [];
 else if(path === '/sessions/adopted/upload') { uploadCount++; data={session_id:'adopted',filename:'adopt.pdf',path:'adopt.pdf',size:32,is_spreadsheet:false,document:{path:'adopt.pdf',status:'queued'}}; }
 else if(path === '/sessions/adopted/documents/preview') { appReads++; data={status:appReads===1?'queued':'ready'}; }
 return route.fulfill({json:data});
});
await app.goto(base); await app.locator('#prompt-input').waitFor();
await app.locator('input[type=file]').setInputFiles({name:'adopt.pdf',mimeType:'application/pdf',buffer:Buffer.from('Synthetic fixture')});
await app.locator('.attached-chip-name').filter({hasText:'adopt.pdf'}).waitFor();
await app.getByText('Ready',{exact:true}).first().waitFor();
assert(created); assert.equal(uploadCount,1); assert(appReads>=2); assert(await app.getByTitle('Send message',{exact:true}).isEnabled());
assert.deepEqual(errors,[]); console.log('PASS composer PDF/DOCX readiness, transient recovery, terminal failure retry, authorization polling stop, stale same-file session response, and App new-conversation adoption.'); await browser.close();
