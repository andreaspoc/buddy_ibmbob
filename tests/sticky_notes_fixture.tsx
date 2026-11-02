import React from 'react';
import {createRoot} from 'react-dom/client';
import {StickyNotes, NotesWorkspace} from '../web/src/components/StickyNotes';
import '../web/src/styles.css';
import '../web/src/answerFrames.css';
const notes = [{title:'Review the proposal',body:'Synthetic test content.\n\n- Check the scope\n- Agree next steps\n\n[Source](https://example.com)',color:'butter' as const},{title:'Questions to revisit',body:'Synthetic fixture for testing the notes interface.',color:'lavender' as const}];
createRoot(document.getElementById('root')!).render(location.search.includes('board') ? <NotesWorkspace onBack={()=>{location.href=location.pathname;}}/> : <main style={{padding:24,maxWidth:900,margin:'auto'}}><button className="workspace-notes-tab" style={{position:'fixed',top:8,right:12}} type="button">Notes</button><StickyNotes notes={notes} sessionId="fixture-session" messageId="fixture-message" /></main>);
