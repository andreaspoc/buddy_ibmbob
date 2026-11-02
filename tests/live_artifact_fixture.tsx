import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArtifactEditor,type Artifact} from '../web/src/components/ArtifactEditor';
import '../web/src/styles.css';
function Fixture(){
 const [live,setLive]=useState<Record<string,Artifact>>({});
 const [streaming,setStreaming]=useState(true);
 (window as any).updateLiveArtifact=(content:string,active=true)=>{setStreaming(active);setLive(previous=>({...previous,'dashboard.html':{path:'dashboard.html',kind:'html',content,sha256:String(content.length),live:active,job_id:'synthetic-job',correlation_id:'synthetic-correlation',chat_id:'synthetic-live-dashboard',assistant_message_id:'synthetic-assistant',timestamp:new Date().toISOString()}}));};
 (window as any).updateOtherArtifact=()=>setLive(previous=>({...previous,'notes.md':{path:'notes.md',kind:'markdown',content:'Other file update',sha256:'other',live:true}}));
 return <ArtifactEditor sessionId="synthetic-live-dashboard" initialPath="dashboard.html" isStreaming={streaming} liveArtifacts={live}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
