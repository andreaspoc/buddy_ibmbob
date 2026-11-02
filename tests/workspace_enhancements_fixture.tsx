// Explicitly synthetic UI fixture; no operational data.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceHub } from '../web/src/components/WorkspaceHub';
import { ChatView } from '../web/src/components/ChatView';
import { ArtifactVersionCompare } from '../web/src/components/ArtifactVersionCompare';
import '../web/src/styles.css';
import '../web/src/workspaceEnhancements.css';
import '../web/src/intelligenceWorkspace.css';
function Fixture() {
  const [focused, setFocused] = useState(false);
  const [view, setView] = useState('chat');
  const [project, setProject] = useState('');
  const [mode, setMode] = useState('agent');
  const [agent, setAgent] = useState('');
  const [empty, setEmpty] = useState(false);
  return <div className={`shell ${focused ? 'workspace-focus-mode' : ''}`}>
    <aside className="sidebar">Synthetic navigation</aside><main className="main">
    <WorkspaceHub username="synthetic-ui-fixture" focused={focused} onToggleFocus={() => setFocused(value => !value)}
      actions={[{id:'notes',label:'Notes',run:()=>setView('notes')},{id:'new',label:'New conversation',run:()=>{setEmpty(true);setView('chat');}}]}
      recent={[{id:'conversation:fixture',label:'Synthetic conversation',kind:'Conversation',run:()=>{setEmpty(false);setView('chat');}}]} />
    {view === 'notes' ? <p role="status">Synthetic notes opened</p> : <div className="chat-layout-split"><div className="chat-layout-main"><ChatView
      sessionId="synthetic-fixture" messages={empty ? [] : [{id:'prompt',role:'user',content:'Synthetic first prompt'},{id:'answer',role:'assistant',content:'Synthetic response with [Report](/files/report.md)'},{id:'prompt2',role:'user',content:'Synthetic second prompt'}]}
      isStreaming={false} activeMode={mode} activeAgent={agent} modes={[{slug:'agent',name:'Buddy',description:''}]} skills={[]} agents={[{slug:'reviewer',name:'Synthetic reviewer',endpoint:'/synthetic'}]}
      projects={[{id:'example',name:'Synthetic project'}]} projectId={project} onSelectProject={setProject} onChangeMode={setMode} onChangeAgent={setAgent}
      configuredTools={['Synthetic connection']} onManageTools={()=>setView('notes')}
      templates={[]} selectedTemplateId="" slideCount={5} onSlideCountChange={()=>{}} onSendMessage={async()=>{}} onUploadFile={async()=>null as any}
      onOpenTemplateModal={()=>{}} onGenerateDeckFromMessage={()=>{}} isPanelActive={false} onTogglePanel={()=>{}}
    /></div></div>}
    {new URLSearchParams(location.search).has('compare') && <ArtifactVersionCompare base="/synthetic/artifacts" path="report.md" revision={{id:'fixture-revision',created:'2026-01-01T00:00:00Z'}} current={'Heading\nNew content'} dirty={true} disabled={false} onRestore={()=>setView('notes')} onClose={()=>{}} />}
    </main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
