import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatView} from '../web/src/components/ChatView';
import type {ChatMessage} from '../web/src/types';
import '../web/src/styles.css';
function Fixture() {
  const [messages,setMessages] = useState<ChatMessage[]>([]);
  const [streaming,setStreaming] = useState(false);
  (window as any).renderQuiz=(content:string,active=false,request="Create an interactive quiz on my uploaded document.")=>flushSync(()=>{setStreaming(active);setMessages([{id:'source',role:'user',content:request},{id:'quiz',role:'assistant',content,isStreaming:active}]);});
  (window as any).renderReview=(content:string,active=false)=>flushSync(()=>{setStreaming(active);setMessages(previous=>[...previous.filter(message=>message.id!=='review'),{id:'review',role:'assistant',content,isStreaming:active}]);});
  (window as any).failGrading=()=>flushSync(()=>setMessages(previous=>[...previous,{id:'failed',role:'assistant',content:'Could not grade this attempt.',statusText:'Error: temporary failure',isStreaming:false}]));
  const submit = (prompt:string) => {
    (window as any).submissionCount=((window as any).submissionCount||0)+1;
    (window as any).submittedPrompt=prompt;
    setMessages(previous=>[...previous,{id:`submitted-${(window as any).submissionCount}`,role:'user',content:prompt,displayPrompt:'Submitted test answers'}]);
  };
  return <div style={{height:'90vh',display:'flex',flexDirection:'column'}}><ChatView messages={messages} sessionId="synthetic-quiz" isStreaming={streaming} activeMode="agent" slideCount={8} onSlideCountChange={()=>{}} activeAgent="" modes={[]} skills={[]} agents={[]} templates={[]} selectedTemplateId="" onSendMessage={submit} onUploadFile={async()=>({path:'fixture.txt'})} onStop={()=>{}} onOpenTemplateModal={()=>{}} /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
