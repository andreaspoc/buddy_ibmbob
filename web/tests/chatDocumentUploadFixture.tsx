/* Synthetic upload responses; no operational documents or services. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '../src/components/ChatView';
import '../src/styles.css';
function Fixture() {
  const [sessionId, setSessionId] = useState('first');
  const [sent, setSent] = useState('');
  return <><button onClick={() => setSessionId(value => value === 'first' ? 'second' : 'first')}>Switch session</button><output>{sent}</output><main style={{ height: 800 }}><ChatView messages={[]} sessionId={sessionId} isStreaming={false} activeMode="agent" activeAgent="" modes={[]} skills={[]} agents={[]} slideCount={5} onSlideCountChange={() => {}} templates={[]} selectedTemplateId="" onSendMessage={setSent} onApprovalDecision={async () => {}} onUploadFile={async file => ({ filename: file.name, path: file.name, size: file.size, session_id: sessionId, is_spreadsheet: false, document: { path: file.name, status: 'queued' } })} onStop={() => {}} onOpenTemplateModal={() => {}} /></main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
