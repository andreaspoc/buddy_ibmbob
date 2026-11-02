// Synthetic UI fixture. No operational projects or identities are created.
import { createRoot } from 'react-dom/client';
import { ProjectsWorkspace } from '../src/components/ProjectsWorkspace';
import { GlobalTheme } from '@carbon/react';
import '../src/styles.css';
import '../src/brandLight.css';
import '../src/components/Toolbar.css';
import '../src/copilotKitTheme.css';
import '../src/workspaceFinish.css';
import '../src/menuFinish.css';
import '../src/carbonFoundation.scss';
document.documentElement.dataset.designSystem = 'carbon';
createRoot(document.getElementById('root')!).render(<GlobalTheme theme="white"><ProjectsWorkspace onClose={() => {}} onAskBob={async (_context, question) => { document.querySelector('output')!.textContent = question; }} /></GlobalTheme>);
