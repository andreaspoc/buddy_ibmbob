// Synthetic guidance states; no backend or model requests.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '../src/components/ChatView';
import type { ChatMessage } from '../src/types';
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
 const [streaming,setStreaming]=useState(true),[fail,setFail]=useState(false);
 const [notes,setNotes]=useState([{id:'original',text:'Use a concise answer.',status:'received'}]);
 const messages:ChatMessage[]=[{id:'answer',role:'assistant',content:'Preparing the answer…',isStreaming:streaming,guidance:notes}];
 return <><button onClick={()=>setFail(!fail)}>Toggle guidance error</button><button onClick={()=>setNotes(n=>n.map(x=>({...x,status:'applied'})))}>Mark guidance applied</button><div className="shell"><main className="main"><ChatView messages={messages} sessionId="guidance-fixture" isStreaming={streaming} canGuideResponse activeMode="agent" activeAgent="" modes={[]} skills={[]} agents={[]} slideCount={5} onSlideCountChange={()=>{}} templates={[]} selectedTemplateId="" onSendMessage={()=>{}} onApprovalDecision={async()=>{}} onStop={()=>setStreaming(false)} onOpenTemplateModal={()=>{}} onGuideResponse={async text=>{await new Promise(resolve=>setTimeout(resolve,700));if(fail)throw new Error('Synthetic guidance failure. Please retry.');setNotes(n=>[...n,{id:String(n.length),text,status:'received'}]);}} /></main></div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
