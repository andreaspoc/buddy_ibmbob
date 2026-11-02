// Synthetic visual fixture: no editor, account, document or model connection.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeAssistant } from '../src/components/OfficeAssistant';
import type { OfficeBridge } from '../src/lib/officeBridge';
import '../src/components/OfficeSuite.css'
import '../src/components/OfficeSuiteTheme.scss'
import '../src/styles.css'
import '../src/answerFrames.css'
import '../src/mobile.css'
import '../src/components/AuthModal.css'
import '../src/tutorialTheme.css'
import '../src/interfaceMotion.css'
import '../src/brandLight.css'
import '../src/workspaceRefinement.css'
import '../src/visualPolish.css'
import '../src/mainSidebarTheme.css'
import '../src/components/Toolbar.css'
import '../src/chatControls.css'
import '../src/copilotKitTheme.css'
import '../src/shellChrome.css'
import '../src/workspaceFinish.css'
import '../src/menuFinish.css'
import '../src/memberChatFinish.css'
import '../src/referencePicker.css'
import '../src/components/NotesLibraryFilters.css'
import '../src/components/OfficeAssistantFinish.css'
import '../src/carbonFoundation.scss'
document.documentElement.dataset.designSystem = 'carbon';
document.documentElement.dataset.uiTheme = 'copilotkit';
const extension = new URLSearchParams(location.search).get('extension') || 'docx';
const bridge: OfficeBridge = {
  ready: true,
  context: async () => extension === 'xlsx'
    ? {kind:'cell',text:'Synthetic workbook preview',selection:'[["Open"]]',sheet:'Data',range:'B2:B8',values:[['Open']],workbook:[{name:'Other',values:[['Unrelated synthetic content']]}],editor_capabilities:['set_validation','sort_range','filter_range']}
    : extension === 'pptx'
    ? {kind:'slide',text:'Synthetic presentation',selection:'Selected label',slide_count:2,current_slide:1,slide_width:254,slide_height:142,editor_capabilities:['replace_slide_text','add_slide_chart','slide_object'],slide_shapes:[{slide_index:1,shape_index:1,text:'Selected label',selected:true},{slide_index:2,shape_index:1,text:'Unrelated synthetic slide',selected:false}]}
    : { kind: extension === 'pdf' ? 'pdf' : ['html','htm'].includes(extension) ? 'html' : 'word', text: 'Synthetic preview only', selection: '' },
  apply: async plan => { (window as any).officeAppliedPlan = plan; return { ok: true }; },
};
createRoot(document.getElementById('root')!).render(<div className="office-suite buddy-surface" style={{ width: 'min(390px, 100vw)', height: '100dvh', margin: 'auto' }}><div className="office-editor-workspace"><div className="office-bob-panel"><OfficeAssistant fileId={`synthetic-${extension}`} extension={extension} bridge={bridge} onBusy={() => {}} onApplied={() => {}} /></div></div></div>);
