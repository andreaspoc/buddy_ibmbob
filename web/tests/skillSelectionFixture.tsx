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
 const [session,setSession]=useState('skill-session-one');
 const [messages,setMessages]=useState<ChatMessage[]>([]);
 const [streaming,setStreaming]=useState(false);
 const [available,setAvailable]=useState(true);
 const skills=available ? [{name:'analysis-buddy',description:'Analyze supplied data and explain findings.'},{name:'writing-buddy',description:'Draft and refine written content.'},{name:'presentation-buddy',description:'Create a presentation from your brief.'}, ...['research', 'planning', 'coding', 'security'].map(name => ({name: `${name}-buddy`, description: `Synthetic ${name} skill for selection checks.`}))] : [];
 return <><div className="fixture-controls"><button onClick={()=>setSession(s=>s==='skill-session-one'?'skill-session-two':'skill-session-one')}>Switch fixture conversation</button><button onClick={()=>setStreaming(s=>!s)}>Toggle fixture busy</button><button onClick={()=>setAvailable(s=>!s)}>Toggle fixture skills</button></div>
 <div className="shell"><main className="main"><ChatView messages={messages} sessionId={session} isStreaming={streaming} voiceEnabled={false} activeMode="agent" activeAgent="" modes={[]} skills={skills} agents={[]} slideCount={5} onSlideCountChange={()=>{}} templates={[]} selectedTemplateId="" onSendMessage={(prompt,mode,format,template,skill)=>{(window as any).skillSubmissions=[...((window as any).skillSubmissions||[]),{prompt,skill}];setMessages(items=>[...items,{id:String(items.length),role:'user',content:prompt}]);}} onApprovalDecision={async()=>{}} onUploadFile={async()=>({path:'fixture.csv',filename:'fixture.csv',is_spreadsheet:true})} onStop={()=>setStreaming(false)} onOpenTemplateModal={()=>{}} /></main></div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
