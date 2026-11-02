// Isolated, explicitly synthetic source responses; never writes to a real library.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {KnowledgeDocuments} from '../web/src/components/KnowledgeDocuments';
import '../web/src/styles.css';
const originalFetch = window.fetch.bind(window);
(window as any).fixtureState = {requests: 0, finishUpload: null};
window.fetch = async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  if (path === '/knowledge') {
    if (init?.method === 'POST') {
      (window as any).fixtureState.requests++;
      await new Promise(resolve => {(window as any).fixtureState.finishUpload = resolve;});
    }
    return new Response(JSON.stringify([]), {headers: {'Content-Type': 'application/json'}});
  }
  return originalFetch(input, init);
};
createRoot(document.getElementById('root')!).render(<main style={{maxWidth: 1080, margin: '24px auto', padding: '0 12px'}}><KnowledgeDocuments isAdmin isStreaming={false} hasExternalAgent={false}/></main>);
