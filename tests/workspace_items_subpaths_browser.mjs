// Synthetic UI fixtures only; backend, accounts, and model services are never contacted.
const { chromium } = await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage();page.setDefaultTimeout(10000);
let signedIn=false, sso=true, localLogin=true, authFailure=false, acceptLogin=false, errors=[]; const requests=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');localStorage.setItem('bob-ui-language','en');});
await page.route('**/*',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path==='/' || path.startsWith('/app/') || path.startsWith('/notes') || path.startsWith('/projects') || path.startsWith('/src/') || path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/assets/') || /\.(svg|png|ico|woff2)$/.test(path)) return route.continue();
 let data=[];
 if(path==='/auth/status' && authFailure) return route.fulfill({status:503,json:{detail:'Synthetic unavailable auth status'}});
 if(path==='/auth/status') data={user:signedIn?{username:'fixture-user',is_admin:true}:null,local_login_enabled:localLogin,keycloak_configured:sso};
 else if(path==='/auth/login'||path==='/auth/register'){requests.push([path,route.request().postDataJSON()]);return route.fulfill(acceptLogin ? {json:{username:'synthetic-user',is_admin:false}} : {status:401,json:{detail:'Synthetic credential error'}});}
 else if(path==='/personalization/tutorials') data={disabled:true};
 else if(path==='/api/apps') data={apps:[{id:'projects',name:'Projects',kind:'installed',launch:{kind:'projects'}}]};
 else if(path==='/api/notes') data={items:[{id:1,title:'Synthetic route note',body:'Synthetic note content.',color:'butter',collection:'',tags:[],sources:[],favorite:false}],next_before_id:null};
 else if(path.startsWith('/api/notes/')) data={items:[]};
 else if(path.startsWith('/api/projects')) data={can_manage:true,projects:[{id:'fixture-project',name:'Synthetic route project',description:'Test only',status:'active',priority:'normal',due_date:null,start_date:null,milestone:'',revision:1}],people:[],assignments:[],dependencies:[],work_items:[],impact:{items:[]}};
 else if(path==='/api/office/files'||path==='/api/office/folders') data={items:[]};
 else if(path==='/api/office/chat-capabilities') data={version:1};
 else if(path==='/access/me') data={user:{username:'fixture-user',is_admin:true},libraries:[],audiences:[],administrator:true};
 else if(path.endsWith('/capabilities')) data={web_search:false};
 return route.fulfill({json:data});
});
const url=process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3177';
try {
 signedIn=true;await page.setViewportSize({width:1440,height:1000});
 await page.goto(url+'/notes/1');
 await page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Edit your note',exact:true})}).waitFor();
 assert.equal(await page.locator('.notes-editor input').first().inputValue(),'Synthetic route note');
 await page.getByRole('button',{name:'Close note editor',exact:true}).click();
 await page.waitForURL('**/notes');
 await page.goBack();
 await page.getByRole('heading',{name:'Edit your note',exact:true}).waitFor();
 await page.goto(url+'/projects/view/fixture-project');
 await page.locator('.projects-breadcrumb').getByText('Synthetic route project',{exact:true}).waitFor();
 await page.reload();
 await page.locator('.projects-breadcrumb').getByText('Synthetic route project',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Back to portfolio',exact:true}).click();
 await page.waitForURL('**/projects/tabs/portfolio');
 await page.goBack();
 await page.locator('.projects-breadcrumb').getByText('Synthetic route project',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS note and project item subpaths, direct load, refresh and Back');
} finally {await browser.close();}
