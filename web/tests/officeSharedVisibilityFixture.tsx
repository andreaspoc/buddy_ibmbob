// Synthetic library fixture. The browser regression intercepts every Office API request.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeSuite } from '../src/components/OfficeSuite';
import { AppDialog } from '../src/components/AppDialog';
import '../src/styles.css';
createRoot(document.getElementById('root')!).render(<><OfficeSuite onClose={() => {}} /><AppDialog /></>);
