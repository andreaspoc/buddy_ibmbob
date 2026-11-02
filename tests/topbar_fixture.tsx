import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceTools } from '../web/src/components/WorkspaceTools';
import { Topbar } from '../web/src/components/Topbar';
import '../web/src/styles.css';

// Explicitly synthetic values exercise every header control and long usage labels.
createRoot(document.getElementById('root')!).render(<div className="shell"><main className="main"><Topbar
  activeModeName="User groups & administrators" sessionTokens={12345678} sessionCost={123.456}
  usageScope="task" onToggleSidebar={() => {}}
  navigation={<nav className="workspace-navigation" aria-label="Synthetic navigation fixture">
    <WorkspaceTools label="Buddy" ariaLabel="Buddy menu" icon="buddy"><button>Synthetic Buddy action</button></WorkspaceTools>
    <WorkspaceTools label="Tools" ariaLabel="Workspace tools" icon="tools"><button>Synthetic tool action</button></WorkspaceTools>
    <WorkspaceTools label="Settings" ariaLabel="Settings menu" icon="settings"><button>Synthetic settings action</button></WorkspaceTools>
  </nav>}
/></main></div>);
