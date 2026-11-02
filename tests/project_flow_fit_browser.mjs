// Synthetic graph reproduces the Project Buddy multi-lane topology.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({args:['--no-sandbox']});
const p=await b.newPage({viewport:{width:900,height:1000},reducedMotion:'reduce'});
const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto((process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183')+'/tests/diagram-fit.html');
await p.waitForFunction(()=>window.setDiagramFixture);
const records=[{type:'diagram',id:'coverage',kind:'flow',layout:'swimlane',direction:'TB',title:'Synthetic responsibility review',motion:'none'},...['Assignment','Coverage','Exception'].map(id=>({type:'lane',id,label:id})),...['Role','Allocation','Backup','Handover','DueDate','Breach','Report'].map((id,i)=>({type:'node',id,label:({Role:'Contributor\nResponsibility: Testing',Allocation:'Allocation: 0%\n(not recorded)',Backup:'No backup assigned\n(coverage gap)',Handover:'No handover plan\nrecorded',DueDate:'Due date\n(overdue)',Breach:'Tolerance breached\n±0d tolerance exceeded',Report:'Exception Report\nrequired'})[id],lane:i<2?'Assignment':i<4?'Coverage':'Exception',shape:i===2||i===5?'diamond':'rounded'})),...[['Role','Allocation'],['Role','Backup'],['Backup','Handover'],['DueDate','Breach'],['Breach','Report']].map(([source,target],i)=>({type:'edge',id:'e'+i,source,target,label:['no capacity recorded','coverage gap','no continuity plan','overdue by 1 day','triggers'][i]}))];
try {
 const source='```bobdiagram\n'+records.map(r=>JSON.stringify(r)).join('\n')+'\n```';
 for(const width of [610,390,320,900]) {
  await p.setViewportSize({width:Math.max(900,width),height:1000});
  await p.evaluate(({source,width})=>{document.querySelector('main').style.width=width+'px';window.setDiagramFixture(source,false,true,true)},{source,width});
  await p.waitForFunction(()=>{
   const panel=document.querySelector('.structured-flow-scroll');
   const nodes=[...document.querySelectorAll('.react-flow__node-diagram,.react-flow__node-lane')];
   if(!panel || nodes.length!==10)return false;
   const r=panel.getBoundingClientRect();
   return nodes.every(node=>{const n=node.getBoundingClientRect();return n.left>=r.left-2 && n.right<=r.right+2 && n.top>=r.top-2 && n.bottom<=r.bottom+2;});
  });
 }
 await p.getByRole('button',{name:'Maximize',exact:true}).click();
 await p.getByRole('dialog').waitFor();
 await p.waitForFunction(()=>document.querySelectorAll('dialog .react-flow__node-diagram').length===7);
 assert.equal(await p.getByRole('dialog').locator('.react-flow__node-diagram').count(),7);
 assert.deepEqual(errors,[]);
 console.log('PASS: initial swimlane fit, all 7 nodes and 3 lanes visible at four card widths, maximize');
} finally {await b.close();}
