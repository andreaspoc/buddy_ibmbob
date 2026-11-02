import { installPersonalDataReview } from './lib/personalDataReview';
import { GlobalTheme } from '@carbon/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './answerFrames.css';
import './mobile.css';
import './brandLight.css';
import './workspaceRefinement.css';
import './visualPolish.css';
import './mainSidebarTheme.css';
import './components/Toolbar.css';
import './chatControls.css';
import './copilotKitTheme.css';
import './shellChrome.css';
import './workspaceFinish.css';
import './carbonFoundation.scss';
import { applyDesignTheme } from './lib/designTheme';
import { LearningLanguageProvider } from './learningLanguage';
import LearningWorkspace from './components/LearningWorkspace';

document.documentElement.dataset.designSystem = 'carbon';
applyDesignTheme();

installPersonalDataReview();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalTheme theme="white">
      <LearningLanguageProvider>
        <LearningWorkspace />
      </LearningLanguageProvider>
    </GlobalTheme>
  </StrictMode>
);
