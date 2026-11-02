// Synthetic presentation state; no model or operational data requests.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PresentationPreviewPanel } from '../src/mods/PresentationPreviewPanel';
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
document.documentElement.dataset.designSystem = 'carbon';
document.documentElement.dataset.uiTheme = 'copilotkit';
document.documentElement.style.setProperty('--ui-scale', '.85');
function Fixture() {
  const populated = new URLSearchParams(location.search).has('populated');
  const [closed, setClosed] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const pages = populated ? [
    { name: 'Synthetic overview', path: 'synthetic-overview.html', size: 400, is_presentation: true },
    { name: 'Synthetic roadmap', path: 'synthetic-roadmap.html', size: 400, is_presentation: true },
  ] : [];
  return <div className="shell" style={{ height: '100vh', width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
    <output data-testid="refresh-count" style={{ fontSize: 14 }}>Refreshes: {refreshes}</output>
    {closed ? <p>Studio closed</p> : <div style={{ flex: 1, minHeight: 0 }}><PresentationPreviewPanel
      sessionId="studio-synthetic" pages={pages} files={[]} messages={[]} activeMode="presentation" isStreaming={false}
      onClose={() => setClosed(true)} onRefreshPages={() => setRefreshes(count => count + 1)}
      onOpenFullscreen={() => setExpanded(value => !value)} isExpanded={expanded}
    /></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
