// Synthetic UI fixture: no real editor, documents or model requests.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeAssistant } from '../src/components/OfficeAssistant';
import { AppDialog } from '../src/components/AppDialog';
import type { OfficeBridge } from '../src/lib/officeBridge';
import '../src/styles.css';
const bridge: OfficeBridge = {
  ready: true,
  context: async () => ({ kind: 'word', text: 'Synthetic document', selection: '' }),
  apply: async () => ({ ok: true }),
};
createRoot(document.getElementById('root')!).render(<><OfficeAssistant fileId="synthetic-only" extension="docx" bridge={bridge} onBusy={() => {}} onApplied={() => {}} /><AppDialog /></>);
