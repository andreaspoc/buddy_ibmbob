import { Toolbar } from './Toolbar';
import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';
import type { SharedConversationLink } from '../lib/conversationUrl';
import type { ChatMessage } from '../types';
import { ChatView } from './ChatView';
import './SharedConversationView.css';

type Snapshot = { session_id: string; title: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> };
const noop = () => {};

export function SharedConversationView({ link, onClose }: { link: SharedConversationLink; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null); setError('');
    const path = link.sessionId ? `${link.sessionId}/${link.token}` : link.token;
    void fetch(`/api/shared/${path}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again to view this shared conversation.' : response.status === 404 ? 'This share link is unavailable or has been revoked.' : 'Could not load shared conversation.');
      const data: Snapshot = await response.json();
      if (!controller.signal.aborted) {
        setSnapshot(data);
        if (!link.sessionId) {
          const url = new URL(window.location.href);
          url.pathname = `/shared/${data.session_id}/${link.token}`;
          window.history.replaceState(window.history.state, '', url);
        }
      }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [link.sessionId, link.token]);
  const messages: ChatMessage[] = snapshot?.messages.map((message, index) => ({ ...message, id: `shared-${index}` })) || [];
  return <section className="shared-conversation-view" aria-label={t('Shared conversation')}>
    <Toolbar as="header" className="shared-conversation-header">
      <div><span className="feature-eyebrow">{t('Shared conversation · Read only')}</span><h1>{snapshot?.title || t('Shared conversation')}</h1>{snapshot && <small>{t('Conversation ID: {0}', [snapshot.session_id])}</small>}</div>
      <button type="button" onClick={onClose}>{t('Back to my conversations')}</button>
    </Toolbar>
    {error ? <p role="alert">{t(error)}</p> : !snapshot ? <p role="status">{t('Loading shared conversation…')}</p> : !messages.length ? <p>{t('No messages were saved in this shared conversation.')}</p> :
      <ChatView readOnly messages={messages} isStreaming={false} activeMode="agent" activeAgent="" modes={[]} skills={[]} agents={[]} templates={[]} selectedTemplateId="" slideCount={5}
        onSlideCountChange={noop} onSendMessage={noop} onApprovalDecision={async () => {}} onUploadFile={async () => { throw new Error('Shared conversations are read only.'); }} onStop={noop} onOpenTemplateModal={noop} />}
  </section>;
}
