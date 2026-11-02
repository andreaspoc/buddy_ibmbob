import { t } from "../lib/i18n";
import { useRef, useState } from 'react';
import { ResearchReport } from './ResearchReport';
import { safeHref } from '../lib/safeHref';

export function ConversationSharing({ sessionId }: { sessionId: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const requestLock = useRef(false);
  const [pdf, setPdf] = useState<{title:string;content:string} | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  async function preparePdf() {
    if (requestLock.current) return;
    requestLock.current = true;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/export?format=json`);
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not load PDF preview');
      setPdf({title: data.title || 'Conversation', content: data.messages.map((message: {role:string;content:string}) => `## ${message.role === 'user' ? t('User') : t('Assistant')}\n\n${message.content}`).join('\n\n')});
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load PDF preview'); }
    finally { requestLock.current = false; setBusy(false); }
  }
  async function share() {
    if (requestLock.current) return;
    requestLock.current = true;
    setBusy(true); setError(''); setCopied(false);
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/share`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not create share link');
      const resolved = new URL(result.url, window.location.origin).href;
      setUrl(safeHref(resolved) || '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Sharing failed'); }
    finally { requestLock.current = false; setBusy(false); }
  }
  async function revoke() {
    if (requestLock.current) return;
    requestLock.current = true;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/share`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not revoke share links');
      setUrl('');
      setCopied(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Revocation failed'); }
    finally { requestLock.current = false; setBusy(false); }
  }
  async function downloadDocument(format: 'docx' | 'pdf') {
    if (requestLock.current) return;
    requestLock.current = true;
    setBusy(true); setDownloading(true); setDownloaded(false); setError('');
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(typeof detail.detail === 'string' ? detail.detail : 'Could not download the conversation. Please retry.');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('Could not download the conversation. Please retry.');
      const disposition = response.headers.get('Content-Disposition') || '';
      let filename = `conversation.${format}`;
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const ordinary = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
      if (encoded) { try { filename = decodeURIComponent(encoded[1]); } catch { /* Keep the default filename. */ } }
      else if (ordinary) filename = ordinary[1] || ordinary[2].trim();
      filename = filename.split(/[\\/]/).pop() || `conversation.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename; document.body.appendChild(link);
      link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setDownloaded(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not download the conversation. Please retry.'); }
    finally { requestLock.current = false; setBusy(false); setDownloading(false); }
  }
  async function copyLink() {
    setError(''); setCopied(false);
    try {
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(url); setCopied(true); return; }
        catch { /* IP addresses over HTTP may require the selection fallback. */ }
      }
      linkInput.current?.focus();
      linkInput.current?.select();
      if (!document.execCommand('copy')) throw new Error('Select the link and copy it from the text field.');
      setCopied(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not copy link'); }
  }
  return <section aria-label={t("Export and share conversation")}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <a href={`/sessions/${encodeURIComponent(sessionId)}/export?format=markdown`}>{t("Download Markdown")}</a>
      <a href={`/sessions/${encodeURIComponent(sessionId)}/export?format=json`}>{t("Download JSON")}</a>
      <button type="button" disabled={busy} onClick={() => void downloadDocument('docx')}>{t("Download Word")}</button>
      <button type="button" disabled={busy} onClick={() => void downloadDocument('pdf')}>{t("Download PDF")}</button>
      <button disabled={busy} onClick={() => void preparePdf()}>{t("PDF preview")}</button>
      <button disabled={busy} onClick={share}>{t("Create share link")}</button>
      <button disabled={busy} onClick={revoke}>{t("Revoke all links")}</button>
    </div>
    {downloading && <p role="status">{t("Preparing download…")}</p>}
    {downloaded && !downloading && <p role="status">{t("Download started.")}</p>}
    <p>{t("People with an account can sign in and use this link to read the saved messages. Files, tool details and internal logs are excluded. Later messages do not update the snapshot.")}</p>
    {url && <div>
      <label>{t("Read-only link")}<input ref={linkInput} readOnly value={url} onFocus={event => event.target.select()} style={{ width: '100%' }} /></label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" disabled={busy} data-copy-state={copied ? 'copied' : 'idle'} onClick={() => void copyLink()}>{copied ? `✓ ${t('Copied')}` : t("Copy link")}</button>
        <a href={url} target="_blank" rel="noreferrer">{t("Open shared conversation")}</a>
      </div>
      {copied && <p role="status">{t("Link copied.")}</p>}
    </div>}
    {pdf && <div className="conversation-pdf-preview"><button type="button" onClick={() => setPdf(null)}>{t("Close PDF preview")}</button><ResearchReport title={pdf.title} content={pdf.content} sources={[]} sessionId={sessionId} /></div>}
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}
