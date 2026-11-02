import { Toolbar } from './Toolbar';
import { SaveToOfficeButton } from './SaveToOfficeButton';
import { useEffect, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
import { MarkdownView } from './MarkdownView';
import './ConversationDocumentViewer.css';

type DocumentPreview = { status: 'queued' | 'processing' | 'ready' | 'failed'; filename?: string; text?: string; truncated?: boolean; error?: string };
export function ConversationDocumentViewer({ sessionId, path, onClose, onAsk, disabled = false }: { sessionId: string; path: string; onClose: () => void; onAsk?: (prompt: string) => void; disabled?: boolean }) {
  useLanguage();
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [revision, setRevision] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const filename = preview?.filename || path.split('/').pop() || t('Document');
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  const fileUrl = `${base}/file?path=${encodeURIComponent(path)}`;
  useEffect(() => {
    setPreview(null); setError(''); setQuestion('');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${base}/documents/preview?path=${encodeURIComponent(path)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load this document. Try again.');
        const data: DocumentPreview = await response.json();
        if (controller.signal.aborted) return;
        setPreview(data);
        if (data.status === 'queued' || data.status === 'processing') timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load document');
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, path, revision]);
  const retry = async () => {
    setRetrying(true); setError('');
    try {
      const response = await fetch(`${base}/documents/prepare?path=${encodeURIComponent(path)}`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not prepare this document. Please try again.');
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Preparation failed'); }
    finally { setRetrying(false); }
  };
  const ask = (text: string) => {
    if (disabled || !text.trim() || preview?.status !== 'ready') return;
    onAsk?.(`[Attached document: ${JSON.stringify(path)}]\n${text.trim()}`);
  };
  return <section className="conversation-document" aria-label={t("Document preview")}>
    <Toolbar as="header" className="conversation-document-header"><div><strong>{filename}</strong><small>{t('Conversation document')}</small></div><SaveToOfficeButton key={path} sessionId={sessionId} path={path} disabled={disabled} /><a href={fileUrl} download={filename}>{t('Download original')}</a><button type="button" onClick={onClose} aria-label={t("Close document preview")}>{t('Close')}</button></Toolbar>
    {(!preview || preview.status === 'queued' || preview.status === 'processing') && !error && <p role="status">{t('Preparing document for reading… You can download the original while you wait.')}</p>}
    {(error || preview?.status === 'failed') && <div role="alert"><p>{t(error || preview?.error || 'This document could not be prepared.')}</p><button type="button" disabled={retrying} onClick={() => void retry()}>{t(retrying ? 'Retrying…' : 'Retry preparation')}</button></div>}
    {/\.pdf$/i.test(filename) && <div className="conversation-document-content"><iframe title={t("PDF preview: {0}", [filename])} src={fileUrl} sandbox="allow-same-origin" /></div>}
    {preview?.status === 'ready' && <>
      {preview.truncated && <p role="status">{t('This preview shows part of the document. Download the original for the full contents.')}</p>}
      {!/\.pdf$/i.test(filename) && <div className="conversation-document-content"><MarkdownView content={preview.text || t('No readable text was found.')} sessionId={sessionId} /></div>}
      {/\.pdf$/i.test(filename) && <details className="conversation-document-extracted"><summary>{t('Read extracted text')}</summary><MarkdownView content={preview.text || t('No readable text was found.')} sessionId={sessionId} /></details>}
      {onAsk && <form className="conversation-document-ask" onSubmit={event => { event.preventDefault(); ask(question); }}><label htmlFor="document-question">{t('Ask Bob about this document')}</label><div><input id="document-question" value={question} onChange={event => setQuestion(event.target.value)} placeholder={t("What would you like to understand?")} /><button disabled={disabled || !question.trim()} type="submit">{t('Ask Bob')}</button></div><button type="button" disabled={disabled} onClick={() => ask('Summarize this document and highlight the key findings.')}>{t('Summarize document')}</button><button type="button" disabled={disabled} onClick={() => ask('Create an interactive knowledge test based only on this document. Include 10 questions: 6 single-choice, 2 multiple-select, and 2 written-answer questions. Use a bobquiz form. Show correct answers, score, and explanations only after I submit the complete test.')}>{t('Create test from document')}</button></form>}
    </>}
  </section>;
}
