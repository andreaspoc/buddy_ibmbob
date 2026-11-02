/* Synthetic UI fixture; API writes are intercepted by the browser test. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CopyButton } from '../web/src/components/CopyButton';
import { SaveToOfficeButton } from '../web/src/components/SaveToOfficeButton';
import { NotesToOfficeButton, OfficeToNoteButton } from '../web/src/components/NotesOfficeTransfer';
import { TasksView } from '../web/src/components/TasksView';
import { ChatView } from '../web/src/components/ChatView';
import { NoteChatReferences } from '../web/src/components/NoteChatReferences';
import { OfficeChatReferences } from '../web/src/components/OfficeChatReferences';
import { OfficeSuite } from '../web/src/components/OfficeSuite';
import { InstalledApps } from '../web/src/components/InstalledApps';
import { startInterfaceMotion } from '../web/src/lib/interfaceMotion';
import { startWorkspaceUpdates } from '../web/src/lib/workspaceUpdates';
import type { TaskItem } from '../web/src/types';
import '../web/src/styles.css';
import '../web/src/answerFrames.css';
import '../web/src/interfaceMotion.css';
import '../web/src/carbonFoundation.scss';

document.documentElement.dataset.designSystem = 'carbon';
document.documentElement.style.setProperty('--preferred-ui-scale', '1');
startInterfaceMotion(); startWorkspaceUpdates();
const task: TaskItem = { id: 'fixture-task', session_id: 'fixture-session', kind: 'chat', title: 'Synthetic task', mode: 'agent', status: 'running', progress: 'Working…', created_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:00Z' };
function Fixture() {
  const [panel, setPanel] = useState(false), [complete, setComplete] = useState(false);
  const [section, setSection] = useState('actions'), [opened, setOpened] = useState('');
  const [selected, setSelected] = useState('');
  const [apps, setApps] = useState(false);
  return <main data-active-view={section} style={{ padding: 28, maxWidth: 1200, margin: 'auto' }}>
    <h1>Synthetic motion fixture</h1>
    <button className="workspace-notes-tab" style={{ position: 'fixed', top: 10, right: 10 }} type="button" onClick={() => setApps(true)}>Apps</button>
    {apps && <InstalledApps apps={[]} loaded error={false} desktop onOpen={() => {}} onRefresh={() => {}} onClose={() => setApps(false)} />}
    <nav>{['actions','tasks','upload','office'].map(value => <button key={value} onClick={() => setSection(value)}>{value}</button>)}</nav>
    {section === 'actions' && <section>
      <CopyButton text="Synthetic clipboard content" label="Copy answer" />
      <button onClick={() => setPanel(true)}>Open motion panel</button>
      {panel && <div className="feature-dialog" role="dialog" aria-label="Synthetic panel"><h2>Panel</h2><button onClick={() => setPanel(false)}>Close motion panel</button></div>}
      <SaveToOfficeButton sessionId="fixture-session" path="fixture.docx" />
      <NotesToOfficeButton ids={[1,2]} />
      <OfficeToNoteButton fileId="fixture-file" />
      <NoteChatReferences selected={[]} onChange={() => {}} disabled={false} />
      <OfficeChatReferences selected={[]} onChange={() => {}} disabled={false} />
    </section>}
    {section === 'tasks' && <><button onClick={() => setComplete(true)}>Finish synthetic task</button><TasksView tasks={[{...task,status: complete ? 'completed' : 'running'}]} selectedId={selected} onSelect={setSelected} error="" onOpenConversation={setOpened} onStop={async () => {}} onEnableNotifications={() => {}} /><p role="status" data-opened>{opened}</p></>}
    {section === 'office' && <OfficeSuite onClose={() => setSection('actions')} />}
    {section === 'upload' && <ChatView messages={[]} sessionId="fixture-session" isStreaming={false} activeMode="agent" activeAgent="" modes={[]} skills={[]} agents={[]} slideCount={5} onSlideCountChange={() => {}} templates={[]} selectedTemplateId="" onSendMessage={() => {}} onApprovalDecision={async () => {}} onUploadFile={file => new Promise((resolve, reject) => {
      (window as any).finishFixtureUpload = () => resolve({ filename: file.name, path: file.name, size: file.size, session_id: 'fixture-session', is_spreadsheet: false });
      (window as any).failFixtureUpload = () => reject(new Error('Synthetic upload failure'));
    })} onStop={() => {}} onOpenTemplateModal={() => {}} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
