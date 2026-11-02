import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MarkdownView} from '../web/src/components/MarkdownView';
import {ArtifactEditor} from '../web/src/components/ArtifactEditor';
import '../web/src/styles.css';

function Fixture() {
  const [state,setState]=useState({content:'',isStreaming:true,readOnly:false,compactDiagrams:false});
  const [artifact,setArtifact]=useState(false);
  (window as any).setDiagramFixture=(content:string,isStreaming=true,readOnly=false,compactDiagrams=false)=>setState({content,isStreaming,readOnly,compactDiagrams});
  (window as any).showDiagramArtifact=()=>setArtifact(true);
  if(artifact) return <ArtifactEditor sessionId="synthetic-diagram-session" initialPath="flow1.diagram.json" />;
  return <main style={{padding:12,width:'100%',maxWidth:960,boxSizing:'border-box'}}><MarkdownView {...state} onPrompt={prompt => { (window as any).lastInteractivePrompt = prompt; }} sessionId="synthetic-diagram-session" /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
