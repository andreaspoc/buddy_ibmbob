// Real CRUD components with synthetic in-memory API records only.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
let skills=[],deletions=0,busyDelete=false;
await page.route('**/skills{,/**}',async route=>{
 const url=new URL(route.request().url()),method=route.request().method();
 if(url.pathname==='/skills' && method==='GET')return route.fulfill({json:skills.map(({name,description})=>({name,description}))});
 if(url.pathname==='/skills' && method==='POST'){
  const value=route.request().postDataJSON();
  if(skills.some(skill=>skill.name===value.name))return route.fulfill({status:409,json:{detail:'Skill already exists'}});
  skills.push(value);return route.fulfill({status:201,json:value});
 }
 const name=decodeURIComponent(url.pathname.split('/').pop()),skill=skills.find(skill=>skill.name===name);
 if(!skill)return route.fulfill({status:404,json:{detail:'Skill not found'}});
 if(method==='GET')return route.fulfill({json:skill});
 if(method==='PUT'){Object.assign(skill,route.request().postDataJSON());return route.fulfill({json:skill});}
 if(method==='DELETE'){
  deletions++;
  if(busyDelete)return route.fulfill({status:409,json:{detail:'Wait for your active tasks to finish before deleting a skill'}});
  skills=skills.filter(skill=>skill.name!==name);return route.fulfill({json:{ok:true}});
 }
 return route.abort();
});
try{
 await page.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/skills-manager.html');
 await page.getByRole('button',{name:'Add skill',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Add a skill'});
 await dialog.getByLabel('Skill name',{exact:true}).fill('Support Buddy');
 await dialog.getByLabel('Description',{exact:true}).fill('Help with supplied support requests.');
 await dialog.getByLabel('Instructions',{exact:true}).fill('Summarize supplied requests and ask for missing context.');
 await dialog.getByRole('button',{name:'Save skill',exact:true}).click();
 await page.getByRole('heading',{name:'Manage skills',exact:true}).waitFor();
 assert.equal(skills[0].name,'support-buddy');
 await page.getByRole('button',{name:'Edit skill Support Buddy'}).click();
 await page.getByLabel('Instructions',{exact:true}).fill('Updated synthetic support instructions.');
 await page.getByRole('button',{name:'Save skill',exact:true}).click();
 await page.getByRole('heading',{name:'Manage skills',exact:true}).waitFor();
 assert.equal(skills[0].instructions,'Updated synthetic support instructions.');
 await page.getByRole('button',{name:'Delete skill Support Buddy'}).click();
 await page.getByRole('button',{name:'Keep skill',exact:true}).click();
 assert.equal(deletions,0);
 for(const width of [1440,768,390,320]){
  await page.setViewportSize({width,height:1000});
  assert(await page.locator('.skills-manager').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`manager overflow ${width}`);
 }
 await page.getByRole('button',{name:'Delete skill Support Buddy'}).click();
 busyDelete=true;
 await page.getByRole('button',{name:'Delete skill',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Wait for your active tasks'}).waitFor();
 assert.equal(skills.length,1);
 busyDelete=false;
 await page.getByRole('button',{name:'Delete skill',exact:true}).click();
 await page.getByRole('heading',{name:'Manage skills',exact:true}).waitFor();
 assert.equal(skills.length,0);
 assert.equal(await page.getByRole('button',{name:'Delete skill Support Buddy'}).count(),0);
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.getByRole('button',{name:'Manage skills',exact:true}).click();
 await page.getByText('No skills are available. Add a skill to get started.').waitFor();
 assert.equal(await page.locator('.skill-picker-card').count(),0);
 await page.screenshot({path:'/tmp/skills-manager-phone.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: UI add/edit/cancel/delete, busy-task failure/retry, catalog refresh, friendly names/IDs, 4 widths, native dialog keyboard');
}finally{await browser.close();}
