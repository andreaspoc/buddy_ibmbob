import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ClarificationCard} from '../web/src/components/ClarificationCard';
import '../web/src/styles.css';
function Fixture() {
 const [reply,setReply]=useState('');
 const questions=[{question:'Which audience should this detailed report address?',context:'Synthetic browser fixture: choose a target audience.',options:['Executives with an exceptionally long explanation about their priorities and strategic decision making','Engineering teams','x'.repeat(180)]},{question:'How much detail should the report contain?',options:['Brief overview','Detailed analysis']}];
 return <main style={{padding:12,maxWidth:800,boxSizing:'border-box'}}><ClarificationCard questions={questions} disabled={false} answered={Boolean(reply)} onReply={text=>{(window as any).replyCount=((window as any).replyCount||0)+1;setReply(text)}}/><ClarificationCard questions={[{question:'Second independent form?',options:['Independent option','Another option']}]} disabled={false} answered={false} onReply={()=>{}}/><output>{reply}</output></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
