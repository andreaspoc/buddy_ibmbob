import 'leaflet/dist/leaflet.css';
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
import {createRoot} from 'react-dom/client';
import {ClarificationCard} from '../src/components/ClarificationCard';
import {IntelligentAnswer} from '../src/components/IntelligentAnswer';

// Synthetic content only; no API calls or real user data.
createRoot(document.getElementById('root')!).render(
  <main className="shell" style={{display: 'block', height: 'auto', padding: 16, maxWidth: 1000}}>
    <IntelligentAnswer source="synthetic typography fixture" pending={false} spec={{kind: 'explore', title: 'Synthetic dashboard', description: 'Readable description of supplied information.', items: Array.from({length: 6}, (_, i) => ({title: `Topic ${i + 1}`, body: 'Synthetic explanatory text to verify reading sizes and wrapping at narrow widths.', facts: [{label: 'Source', value: 'Synthetic fixture'}]}))}} />
    <ClarificationCard questions={[{question: 'Which audience should the report address?', context: 'Choose an option or provide your own response.', options: ['Readers who need a detailed explanation of the findings', 'Readers who prefer a brief overview']}]} disabled={false} answered={false} onReply={() => {}} />
    <div className="next-question-suggestions"><button type="button">Compare the supplied options</button><button type="button">Explain the next step</button></div>
  </main>
);
