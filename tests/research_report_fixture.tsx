import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationSharing} from '../web/src/components/ConversationSharing';
import {ResearchReport} from '../web/src/components/ResearchReport';
import '../web/src/styles.css';
const content = 'Synthetic chart data for export verification.\n\n```bobchart\n' + JSON.stringify({type:'line',title:'Synthetic dense chart',labels:Array.from({length:40},(_,i)=>`Category ${i}`),datasets:[{label:'Series A',data:Array.from({length:40},(_,i)=>i)},{label:'Series B',data:Array.from({length:40},(_,i)=>i+1)}]}) + '\n```';
createRoot(document.getElementById('root')!).render(<><ConversationSharing sessionId="synthetic-research-session" /><ResearchReport title="Synthetic PDF verification" content={content} sources={[]} sessionId="synthetic-research-session" /></>);
