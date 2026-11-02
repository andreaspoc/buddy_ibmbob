import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationDocumentViewer } from '../web/src/components/ConversationDocumentViewer';
function Fixture() {
  const [path, setPath] = useState('synthetic-notes.md');
  const [answer, setAnswer] = useState('');
  const [closed, setClosed] = useState(false);
  return <main style={{ maxWidth: 1000, margin: 'auto' }}><nav><button onClick={() => setPath('synthetic.pdf')}>PDF fixture</button><button onClick={() => setPath('pending.docx')}>Pending fixture</button><button onClick={() => setPath('broken.docx')}>Failed fixture</button></nav>{!closed && <ConversationDocumentViewer sessionId="fixture-session" path={path} onClose={() => setClosed(true)} onAsk={setAnswer} />}<output>{answer}</output></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
