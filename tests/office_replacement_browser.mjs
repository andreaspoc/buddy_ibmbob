// Synthetic stream and bridge; checks replacement review without contacting a model/editor.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({args:['--no-sandbox']});const p=await b.newPage();
const plan={version:1,kind:'word',reply:'Replacement invoice ready for review.',actions:[{type:'replace_document',blocks:[{type:'title',text:'Replacement invoice template'}]}]};
await p.route('**/api/office/assistant/files/*/draft',r=>r.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'plan',plan})+'\n'}));
try{
 await p.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/office-branding.html?extension=docx');
 await p.getByRole('textbox',{name:'Instructions for Buddy'}).fill('Replace the invoice template with a simpler version');
 await p.getByRole('button',{name:'Send to Buddy',exact:true}).click();
 const replace=p.getByRole('button',{name:'Replace document',exact:true});await replace.waitFor();
 assert.equal(await p.evaluate(()=>window.officeAppliedPlan),undefined);
 assert.equal(await p.locator('.office-assistant-replace-warning').isVisible(),true);
 await replace.click();
 await p.waitForFunction(()=>window.officeAppliedPlan?.actions[0]?.type==='replace_document');
 assert.equal(await p.getByText('Applied in the editor · Save to Office Suite to keep these changes', {exact:true}).count(),1);
 assert.equal(await p.getByRole('button',{name:'Confirm replacement',exact:true}).count(),0);
 console.log('PASS: replacement warning appears before apply, one explicit Replace document click applies the reviewed replacement');
}finally{await b.close();}
