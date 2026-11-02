import { Toolbar } from './Toolbar';
import { navigateOffice } from '../lib/officeUrl';
import DOMPurify from 'dompurify';
import { ShareToPeople, type PeopleShareItem } from './ShareToPeople';
import { t, getLanguage, getLocale } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import { CitationPreview } from './CitationPreview';
import { MarkdownView } from './MarkdownView';
import { renderChartToDOM, type ChartSpec } from './ChartRenderer';

export interface ReportSource { id?: string; title?: string; url?: string; text?: string; excerpt?: string; fetched_at?: string; truncated?: boolean }
function safeUrl(value?: string) { if (/^\/knowledge\/[a-f0-9-]{36}\/file$/i.test(value || '')) return value!; try { const url = new URL(value || ''); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; } }

function relevantPassage(claim: string, source: ReportSource): string | null {
  if (source.excerpt) return source.excerpt;
  const ignored = new Set(['this','that','with','from','have','their','which','about','these','source','sources','report','there','other']);
  const terms = new Set((claim.toLowerCase().match(/[\p{L}\p{N}€]+/gu) || []).filter(word => word.length >= 4 && !ignored.has(word)));
  if (terms.size < 3) return null;
  let best: string | null = null, score = 0;
  for (const sentence of (source.text || '').split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.length < 40 || sentence.length > 600) continue;
    const words = new Set(sentence.toLowerCase().match(/[\p{L}\p{N}€]+/gu) || []);
    const overlap = [...terms].filter(term => words.has(term)).length;
    if (overlap >= 3 && overlap / terms.size >= 0.35 && overlap > score) { best = sentence; score = overlap; }
  }
  return best;
}

export function ResearchReport({ title, content, sources, visuals = [], sessionId, canSaveToOffice = false }: { title:string; content:string; sources:ReportSource[]; visuals?: Array<{path:string;url:string;title:string;captured_at:string;source_id?:string}>; sessionId:string; canSaveToOffice?:boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFiles, setSavedFiles] = useState<Partial<Record<'pdf' | 'html', {id:string;name:string}>>>({});
  const [savingFormat, setSavingFormat] = useState<'pdf' | 'html'>('pdf');
  useEffect(() => { setSavedFiles({}); }, [sessionId, content, includeEvidence]);
  const [error, setError] = useState('');
  const [shareItem, setShareItem] = useState<PeopleShareItem | null>(null);
  useEffect(() => {
    const body = root.current?.querySelector('.research-report-body');
    if (!body) return;
    const byId = new Map(sources.filter(s => s.id).map(s => [s.id!, s]));
    for (const trigger of body.querySelectorAll<HTMLAnchorElement>('a.research-citation-trigger')) {
      const source = byId.get((trigger.textContent || '').replace(/[\[\]]/g, ''));
      const url = safeUrl(source?.url);
      if (!source || !url) {
        trigger.parentElement?.replaceWith(document.createTextNode(trigger.textContent || ''));
        continue;
      }
      trigger.href=url; trigger.dataset.sourceKind=url.startsWith('/knowledge/') ? 'knowledge' : 'web'; trigger.dataset.sourceUrl=url; trigger.dataset.sourceTitle=source.title || url;
      trigger.dataset.sourceQuote=relevantPassage(trigger.closest('p,li')?.textContent || '',source) || '';
      trigger.dataset.sourceRetrieved=source.fetched_at || '';
      trigger.setAttribute('aria-label',`Source ${source.id}: ${source.title || url}`);
    }
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest('a,pre,code,.research-citation') && /\[S\d+\]/.test(node.data)) nodes.push(node);
    }
    for (const node of nodes) {
      const parts = node.data.split(/(\[S\d+\])/g);
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        const source = byId.get(part.slice(1,-1));
        const url = safeUrl(source?.url);
        if (!source || !url) { fragment.append(document.createTextNode(part)); continue; }
        const wrapper = document.createElement('span'); wrapper.className='research-citation';
        const trigger = document.createElement('a'); trigger.textContent=part; trigger.className='research-citation-trigger';
        trigger.href=url; trigger.target='_blank'; trigger.rel='noopener noreferrer';
        trigger.setAttribute('aria-label',`Source ${source.id}: ${source.title || url}`);
        trigger.dataset.sourceTitle=source.title || url; trigger.dataset.sourceUrl=url; trigger.dataset.sourceKind=url.startsWith('/knowledge/') ? 'knowledge' : 'web';
        const passage=relevantPassage(node.data, source);
        if (passage) trigger.dataset.sourceQuote=passage;
        if (source.fetched_at) trigger.dataset.sourceRetrieved=source.fetched_at;
        wrapper.append(trigger); fragment.append(wrapper);
      }
      node.replaceWith(fragment);
    }
  }, [content, sources, sessionId]);

  async function preparePrintFrame() {
    if (!root.current) throw new Error('Report is not available.');
    const frame=document.createElement('iframe'); frame.className='research-print-frame'; frame.title=t('Research report PDF preview'); document.body.append(frame);
    try {
      const doc=frame.contentDocument;
      if(!doc) throw new Error('Could not open print preview');
      doc.open(); doc.write('<html><head><meta charset="utf-8"></head><body class="research-print-document"></body></html>'); doc.close(); doc.title=title; doc.documentElement.lang=getLanguage();
      for(const sheet of document.querySelectorAll('link[rel="stylesheet"],style')) doc.head.append(sheet.cloneNode(true));
      const clone=root.current.cloneNode(true) as HTMLElement;
      // Rebuild charts for paper with every series visible, even if a legend or
      // maximized dialog changed the interactive view. Keep SVGs as vectors.
      clone.querySelectorAll<HTMLElement>('.interactive-chart-card[data-chart-spec]').forEach(chart => {
        try { chart.replaceWith(renderChartToDOM(JSON.parse(chart.dataset.chartSpec || '{}') as ChartSpec)); }
        catch { /* Preserve the displayed chart if its saved specification is unavailable. */ }
      });
      clone.querySelectorAll<SVGElement>('.interactive-chart-card svg').forEach(svg => {
        svg.style.minWidth='0'; svg.style.maxWidth='100%'; svg.style.width='100%'; svg.style.height='auto';
        if (svg.parentElement) { svg.parentElement.style.overflow='visible'; svg.parentElement.style.display='block'; }
      });
      clone.querySelectorAll('.research-source-card,.research-report-print-controls,.mermaid-actions,.mermaid-editor,.mermaid-source,.chart-maximize-button,.chart-maximized-dialog,.chart-interactive-tooltip,.it-toolbar,.it-sort-indicator,.code-preview-actions,.citation-preview-popover,[role="dialog"]').forEach(el => el.remove());
      clone.querySelectorAll('.research-citation').forEach(el => { const id=el.textContent?.replace(/[\[\]]/g,'');const source=sources.find(s => s.id===id);const url=safeUrl(source?.url);if(url){const link=doc.createElement('a');link.href=url;link.textContent=el.textContent;el.replaceWith(link);} });
      const canvases=root.current.querySelectorAll('canvas'); clone.querySelectorAll('canvas').forEach((canvas,i) => { const img=doc.createElement('img');img.src=canvases[i].toDataURL('image/png');img.alt=canvases[i].getAttribute('aria-label') || 'Report visualization';img.style.width='100%';canvas.replaceWith(img); });
      if (!includeEvidence) {
        clone.querySelectorAll('.research-evidence-text').forEach(el => el.remove());
        clone.querySelectorAll('[data-source-quote]').forEach(el => el.removeAttribute('data-source-quote'));
      }
      clone.querySelectorAll('details').forEach(el => el.open=true);
      doc.body.append(clone);
      await Promise.all(Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map(el => new Promise<void>(resolve => { const link=el as HTMLLinkElement;if(link.sheet){resolve();return;}link.onload=()=>resolve();link.onerror=()=>resolve();setTimeout(resolve,3000); })));
      await doc.fonts.ready;
      await Promise.all(Array.from(doc.images).map(img=>img.decode()));
      // Allow the print document to lay out after fonts and images finish loading.
      await new Promise<void>(resolve => frame.contentWindow?.requestAnimationFrame(() => resolve()));
      return frame;
    } catch(e) { frame.remove(); throw e; }
  }
  async function printReport() {
    setPrinting(true); setError('');
    try {
      const frame = await preparePrintFrame();
      frame.contentWindow?.focus(); frame.contentWindow?.print();
      window.setTimeout(() => frame.remove(), 60000);
    } catch(e) { setError((e as Error).message); } finally { setPrinting(false); }
  }
  async function saveToOffice(format: 'pdf' | 'html') {
    if (saving || printing) return;
    setSaving(true); setSavingFormat(format); setError('');
    let frame: HTMLIFrameElement | undefined;
    try {
      frame = await preparePrintFrame();
      const doc = frame.contentDocument!;
      // Make the print snapshot self-contained. The server renderer cannot access
      // authenticated assets or make network requests.
      for (const sheet of Array.from(doc.styleSheets)) {
        if (sheet.ownerNode?.nodeName !== 'LINK') continue;
        const style = doc.createElement('style');
        style.textContent = Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n');
        sheet.ownerNode.parentNode?.replaceChild(style, sheet.ownerNode);
      }
      for (const img of Array.from(doc.images)) {
        if (img.src.startsWith('data:image/')) continue;
        const url = new URL(img.src, window.location.href);
        if (url.origin !== window.location.origin) throw new Error('A report image could not be included. Download it and add it as an attachment first.');
        const response = await fetch(url.href);
        if (!response.ok) throw new Error('Could not load a report image. Please retry.');
        const blob = await response.blob();
        img.src = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Could not prepare a report image.')); reader.readAsDataURL(blob);
        });
        img.removeAttribute('srcset');
      }
      const html = DOMPurify.sanitize(doc.documentElement.outerHTML, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script','iframe','object','embed','link','base','meta','form','input','button'] }); // NOSONAR: WHOLE_DOCUMENT and style tag required to export a full HTML research report document
      const response = await fetch(`/research/${encodeURIComponent(sessionId)}/office`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, format, ui_language: getLanguage() }),
      });
      if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not save the report to Office Suite. Please retry.');
      setSavedFiles(current => ({...current, [format]: {id: result.id, name: result.name}}));
    } catch(e) { setError((e as Error).message); }
    finally { frame?.remove(); setSaving(false); }
  }
  return <div className="research-report-renderer" ref={root}>
    {shareItem && <ShareToPeople item={shareItem} onClose={() => setShareItem(null)} />}
    <Toolbar className="research-report-print-controls"><button type="button" onClick={() => { const body = root.current?.querySelector<HTMLElement>('.research-report-body'); if (body) setShareItem({kind:'text',title:title.slice(0,200) || 'Research report',body:body.innerText}); }} title={t("Share the report text only; source evidence and attachments are excluded")}>{t("Share to people")}</button><button disabled={printing || saving} onClick={() => void printReport()}>{printing ? t("Preparing PDF…") : t("Export PDF")}</button><label><input type="checkbox" checked={includeEvidence} disabled={printing || saving} onChange={e => setIncludeEvidence(e.target.checked)} /> {t("Include collected evidence in PDF")}</label>{canSaveToOffice && (['pdf', 'html'] as const).map(format => <button className="office-desktop-action" key={format} type="button" disabled={saving || printing || !!savedFiles[format]} onClick={() => void saveToOffice(format)}>{t(saving && savingFormat === format ? (format === 'pdf' ? 'Saving PDF to Office Suite…' : 'Saving HTML to Office Suite…') : savedFiles[format] ? (format === 'pdf' ? 'PDF saved to Office Suite' : 'HTML saved to Office Suite') : (format === 'pdf' ? 'Save PDF to Office Suite' : 'Save HTML to Office Suite'))}</button>)}{Object.entries(savedFiles).map(([format, file]) => file && <span className="office-desktop-action" key={format} role="status">{file.name} <button type="button" onClick={() => navigateOffice(`/office/files/${file.id}`)}>{t('Open in Office Suite')} · {format.toUpperCase()}</button></span>)}<small>{t("Choose Save as PDF in the print dialog.")}</small>{error && <p role="alert">{t(error)}</p>}</Toolbar>
    <h1 className="research-document-title">{title}</h1>
    <div className="research-report-body"><MarkdownView content={content} sessionId={sessionId} /></div>
    {visuals.length > 0 && <section className="research-visuals"><h2>{t("Source screenshots")}</h2>{visuals.map(image => <figure key={image.path}><img src={`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(image.path)}`} alt={t("Screenshot of {0}", [image.title || image.url])} /><figcaption>{image.source_id} · {image.title || t("Source page")} {t("· Captured")}{new Date(image.captured_at).toLocaleString(getLocale())}<br />{safeUrl(image.url) && <a href={safeUrl(image.url)!} target="_blank" rel="noopener noreferrer">{image.url}</a>}<br /><small>{t("Viewport capture; the page may have changed since retrieval.")}</small></figcaption></figure>)}</section>}
    {sources.length > 0 && <section className="research-source-appendix"><h2>{t("Sources")}</h2>{sources.map((source,i)=><article key={source.id || i}><h3>{source.id || `Source ${i+1}`} · {source.title || t("Source")}</h3>{safeUrl(source.url) && <a className="research-appendix-source" data-source-title={source.title || source.url} data-source-url={safeUrl(source.url)!} data-source-kind={source.url?.startsWith('/knowledge/') ? 'knowledge' : 'web'} data-source-quote={source.excerpt} data-source-retrieved={source.fetched_at} href={safeUrl(source.url)!} target="_blank" rel="noopener noreferrer">{source.url}</a>}<small>{source.fetched_at ? `Retrieved ${new Date(source.fetched_at).toLocaleString(getLocale())}` : t("Retrieval date unavailable")}</small><details className="research-evidence-text"><summary>{t("Collected text")}</summary><p>{source.text || source.excerpt || t("No collected text available.")}</p></details></article>)}</section>}
    <CitationPreview rootRef={root} contentKey={content} sessionId={sessionId} selector="a.research-citation-trigger, a.research-appendix-source" />
  </div>;
}
