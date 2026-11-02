import { brandText } from '../lib/brand';
import { assistantNamePayload } from '../lib/appearance';
import { useEffect, useId, useRef, useState } from 'react';
import { useLearningLanguage } from '../learningLanguage';
import { MarkdownView } from './MarkdownView';
import './LearningAssistant.css';

type DraftLink = { id: string; title: string; status: string; version: number; is_creator: boolean };
type ChatMessage = { role: 'user' | 'assistant'; content: string; quiz?: DraftLink };
export type LearningSource = { id: string; title: string; kind?: 'document' | 'lesson' };

export function LearningAssistant({ folderId, quizId, bookId, lessonId, sources = [], canCreate, onQuizCreated, onReviewDraft, title = brandText('Buddy'), onClose }: {
  folderId: string; quizId?: string; bookId?: string; lessonId?: string; sources?: LearningSource[]; canCreate: boolean;
  title?: string; onClose?: () => void;
  onQuizCreated?: () => void; onReviewDraft: (id: string) => Promise<void>;
}) {
  const { language, t } = useLearningLanguage();
  const thinkingText = title === 'Buddy' ? t('Buddy is thinking…') : `${title} is thinking…`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const source = selectedSource ?? lessonId ?? bookId ?? '';
  const composerId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState('');
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'instant' }); }, [messages, busy]);
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); const text = message.trim(); if (!text || busy) return;
    const history = messages.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 6000) }));
    setMessages(items => [...items, { role: 'user', content: text }]); setMessage(''); setError(''); setBusy(true);
    const controller = new AbortController(); abort.current = controller;
    const activeSourceObj = sources.find(s => s.id === source);
    const isLesson = activeSourceObj ? activeSourceObj.kind === 'lesson' : (source === lessonId && !bookId);
    const sourcePayload = source ? (isLesson ? { lesson_id: source } : { book_id: source }) : {};
    try {
      const response = await fetch(`/api/learning/folders/${folderId}/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Learning-Language': language },
        signal: controller.signal,
        body: JSON.stringify({ message: text, language, history, ...assistantNamePayload(), ...(quizId ? { quiz_id: quizId } : {}), ...sourcePayload })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : brandText('Buddy could not complete this request. Please retry.'));
      setMessages(items => [...items, { role: 'assistant', content: result.reply, ...(result.quiz ? { quiz: result.quiz } : {}) }]);
      if (result.quiz) onQuizCreated?.();
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : brandText('Buddy could not complete this request. Please retry.')); }
    finally { if (abort.current === controller) { abort.current = null; setBusy(false); } }
  };
  const review = async (id: string) => { setReviewing(id); setError(''); try { await onReviewDraft(id); } catch (error) { setError(error instanceof Error ? error.message : 'Unable to open the draft.'); } finally { setReviewing(''); } };

  const hasDocs = sources.some(s => s.kind === 'document' || !s.kind);
  const hasLessons = sources.some(s => s.kind === 'lesson');
  const showGrouped = hasDocs && hasLessons;

  return <aside className="learning-assistant" aria-label={title === 'Buddy' ? t('Buddy assistant') : `${title} assistant`}><header><span className="learning-assistant-avatar" aria-hidden="true">{title === 'Learning Coach' ? <svg viewBox="0 0 24 24"><path d="m2 8 10-5 10 5-10 5L2 8Zm4 3v6c4 3 8 3 12 0v-6M22 8v9" /></svg> : 'B'}</span><div><strong>{title}</strong><small>{title === 'Buddy' ? t('Ask Buddy') : `Ask ${title}`} · {language}</small></div><span className="learning-assistant-private">{canCreate ? t('Private drafts') : t('Learning help')}</span>{onClose && <button type="button" className="learning-assistant-close" aria-label={`Minimize ${title} chat`} onClick={onClose}>×</button>}</header>
    <div className="learning-assistant-log" ref={log} role="log" aria-live="polite">{!messages.length && <div className="learning-assistant-intro"><h3>{t('How can I help?')}</h3><p>{t(canCreate ? 'Ask me to draft a quiz, improve a saved draft, or create a translated private copy. You review and approve every new quiz.' : 'Ask about quiz instructions or how to use your learning space. You can view your own results after submitting.')}</p>{quizId && <p>{t('Buddy uses the saved quiz. Save your draft first to include recent edits.')}</p>}</div>}{messages.map((item, index) => <article key={index} className={`learning-assistant-message is-${item.role}`}><strong>{item.role === 'user' ? t('You') : title}</strong>{item.role === 'assistant' ? <div dir="auto" className="learning-assistant-markdown"><MarkdownView content={item.content} readOnly /></div> : <p dir="auto">{item.content}</p>}{item.quiz && <div className="learning-assistant-draft"><span>{t('Private draft created')}</span><strong>{item.quiz.title}</strong><button type="button" disabled={!!reviewing || busy} onClick={() => void review(item.quiz!.id)}>{reviewing === item.quiz.id ? t('Opening…') : t('Review draft')}</button></div>}</article>)}{busy && <p className="learning-assistant-thinking" role="status">{thinkingText}</p>}</div>
    {error && <p className="learning-alert" role="alert">{error}</p>}<form onSubmit={event => void send(event)} className="learning-assistant-composer">{canCreate && sources.length > 0 && <label>{t('Source material')}<select aria-label={t('Source material')} disabled={busy} value={source} onChange={event => setSelectedSource(event.target.value)}><option value="">{t('No source selected')}</option>{showGrouped ? (<><optgroup label={t('Documents')}>{sources.filter(s => s.kind === 'document' || !s.kind).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</optgroup><optgroup label={t('Interactive Lessons')}>{sources.filter(s => s.kind === 'lesson').map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</optgroup></>) : sources.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}<label className="learning-sr-only" htmlFor={`learning-assistant-message-${composerId}`}>{title === 'Buddy' ? t('Message Buddy') : `Message ${title}`}</label><textarea id={`learning-assistant-message-${composerId}`} aria-label={title === 'Buddy' ? t('Message Buddy') : `Message ${title}`} maxLength={6000} rows={3} disabled={busy} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        event.preventDefault();
        if (!event.repeat && !busy && message.trim()) event.currentTarget.form?.requestSubmit();
      }
    }} placeholder={t(canCreate ? 'Describe the quiz or changes you need…' : 'Ask about your learning space…')} /><div><small>{language}</small><button type="submit" className="learning-primary" disabled={busy || !message.trim()}>{busy ? thinkingText : title === 'Buddy' ? t('Send to Buddy') : `Send to ${title}`}</button></div></form>
  </aside>;
}
