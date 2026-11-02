// Synthetic guidance states; no backend or model requests.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnswerContext } from '../src/components/AnswerContext';
import '../src/components/AnswerActions.css';
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
 const [answer,setAnswer]=useState<ChatMessage>({id:'progress',role:'assistant',content:'',isStreaming:true,deliveryState:'running',statusText:'Searching the knowledge base…',workLog:[{text:'Searching the knowledge base…',state:'running',timestamp:1}]});
 React.useEffect(()=>{(window as any).setActivityFixture=setAnswer;},[]);
 return <main className="shell" style={{display:'block',height:'auto',padding:16}}><div className="message assistant"><div className="msg-actions"><AnswerContext compact answer={answer} /></div></div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
