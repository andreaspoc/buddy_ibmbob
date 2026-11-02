import { applyAppearance } from './lib/appearance';
import { loadBrand } from './lib/brand';
import { parseWorkspaceUrl } from './lib/workspaceUrl';
import { isNotesPath, isProjectsPath } from './lib/conversationUrl';
import { GlobalTheme } from '@carbon/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './answerFrames.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { trackVisibleViewport } from './lib/viewport'
import { installPersonalDataReview } from './lib/personalDataReview'
import './mobile.css'
import './components/AuthModal.css'
import './tutorialTheme.css'
import './interfaceMotion.css'
import './brandLight.css'
import './workspaceRefinement.css'
import './visualPolish.css'
import './mainSidebarTheme.css'
import './components/Toolbar.css'
import './chatControls.css'
import './copilotKitTheme.css'
import './shellChrome.css'
import './workspaceFinish.css'
import './menuFinish.css'
import './memberChatFinish.css'
import './referencePicker.css'
import './components/NotesLibraryFilters.css'
import './components/OfficeAssistantFinish.css'
import './carbonFoundation.scss'
import { startInterfaceMotion } from './lib/interfaceMotion'
import { startWorkspaceUpdates } from './lib/workspaceUpdates'
import { applyDesignTheme } from './lib/designTheme'
import { trackInputModality } from './lib/inputModality'

// Restore a validated local screen before React initializes its view state.
const signInNext = new URLSearchParams(window.location.search).get('next');
if (signInNext && (parseWorkspaceUrl(signInNext) || isNotesPath(signInNext) || isProjectsPath(signInNext))) {
  const destination = new URL(window.location.href);
  destination.pathname = signInNext;
  destination.searchParams.delete('next');
  window.history.replaceState(window.history.state, '', destination);
}

document.documentElement.dataset.designSystem = 'carbon'
applyDesignTheme()

const stopTrackingViewport = trackVisibleViewport()
const stopInterfaceMotion = startInterfaceMotion()
const stopWorkspaceUpdates = startWorkspaceUpdates()
const stopInputModality = trackInputModality()
if (import.meta.hot) import.meta.hot.dispose(() => { stopTrackingViewport(); stopInterfaceMotion(); stopWorkspaceUpdates(); stopInputModality(); })

installPersonalDataReview();
// The name and logo must be known before the first render, because t() applies them.
void loadBrand().finally(() => {
  applyAppearance();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalTheme theme="white">
      <ErrorBoundary name="Application">
        <App />
      </ErrorBoundary>
    </GlobalTheme>
  </StrictMode>,
);
});
