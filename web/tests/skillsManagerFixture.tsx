// Synthetic guidance states; no backend or model requests.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SkillPicker } from '../src/components/SkillPicker';
import { SkillsManager } from '../src/components/SkillsManager';
import * as api from '../src/api';
import type { Skill } from '../src/types';
import '../src/styles.css';
import '../src/answerFrames.css';
import '../src/mobile.css';
import '../src/components/AuthModal.css';
import '../src/tutorialTheme.css';
import '../src/interfaceMotion.css';
import '../src/brandLight.css';
import '../src/workspaceRefinement.css';
import '../src/visualPolish.css';
import '../src/mainSidebarTheme.css';
import '../src/components/Toolbar.css';
import '../src/chatControls.css';
import '../src/copilotKitTheme.css';
import '../src/shellChrome.css';
import '../src/workspaceFinish.css';
import '../src/menuFinish.css';
import '../src/memberChatFinish.css';
import '../src/referencePicker.css';
import '../src/components/NotesLibraryFilters.css';
import '../src/components/OfficeAssistantFinish.css';
import '../src/carbonFoundation.scss';
document.documentElement.dataset.designSystem='carbon';
document.documentElement.dataset.uiTheme='copilotkit';
function Fixture(){
 const [skills,setSkills]=useState<Skill[]>([]);
 const [manager,setManager]=useState<'list'|'create'|null>(null);
 React.useEffect(()=>{void api.fetchSkills().then(setSkills);},[]);
 return <main className="shell" style={{display:'block',height:'auto',padding:16}}><SkillPicker skills={skills} selected="" onSelect={()=>{}} onAdd={()=>setManager('create')} onManage={()=>setManager('list')} />{manager && <SkillsManager skills={skills} startCreate={manager==='create'} onClose={()=>setManager(null)} onChanged={async()=>setSkills(await api.fetchSkills())} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
