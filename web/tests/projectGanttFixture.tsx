// Synthetic schedule data for UI verification only; no operational records are created.
import {createRoot} from 'react-dom/client';
import {GlobalTheme} from '@carbon/react';
import {ProjectGantt} from '../src/components/ProjectGantt';
import type {GanttProject,GanttWorkItem} from '../src/components/ProjectGantt';
import '../src/styles.css';
import '../src/brandLight.css';
import '../src/components/Toolbar.css';
import '../src/copilotKitTheme.css';
import '../src/workspaceFinish.css';
import '../src/menuFinish.css';
import '../src/components/ProjectsWorkspace.css';
import '../src/carbonFoundation.scss';
document.documentElement.dataset.designSystem='carbon';
const mode=new URLSearchParams(location.search).get('scenario') || 'mixed';
const projects:GanttProject[]=mode==='empty'?[]:[{id:'1',name:'Synthetic scheduled project',status:'active',start_date:mode==='mixed'?'2027-01-01':null,due_date:mode==='mixed'?'2027-01-10':null},{id:'2',name:'Synthetic undated project',status:'planned',start_date:null,due_date:null}];
const workItems:GanttWorkItem[]=mode!=='mixed'?[]:[{id:'10',project_id:'1',title:'Synthetic due-only task',kind:'task',status:'todo',owner_id:'fixture.alex',start_date:null,due_date:'2027-01-08'},{id:'11',project_id:'1',title:'Synthetic start-only task',kind:'task',status:'in_progress',owner_id:'fixture.alex',start_date:'2027-01-03',due_date:null},{id:'12',project_id:'1',title:'Synthetic decision',kind:'decision',status:'proposed',owner_id:null,start_date:'2027-01-04',due_date:'2027-01-05'},{id:'13',project_id:'1',title:'Synthetic release milestone',kind:'milestone',status:'todo',owner_id:null,start_date:'2027-01-01',due_date:'2027-01-09',predecessor_ids:['10']},{id:'14',project_id:'1',title:'Synthetic accepted deliverable',kind:'deliverable',status:'accepted',owner_id:null,due_date:'2020-01-08'},{id:'15',project_id:'1',title:'Synthetic applied lesson',kind:'lesson',status:'applied',owner_id:null,due_date:'2020-01-08'}];
createRoot(document.getElementById('root')!).render(<GlobalTheme theme="white"><main className="projects-workspace" style={{height:'100vh',padding:16}}><ProjectGantt projects={projects} workItems={workItems} people={[{id:'fixture.alex',name:'Fixture Alex'}]} onOpenProject={id=>{document.querySelector('output')!.textContent='project:'+id;}} onAskBob={row=>{document.querySelector('output')!.textContent=JSON.stringify(row);}} /></main></GlobalTheme>);
