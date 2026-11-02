import { IntelligentAnswer } from './IntelligentAnswer';
import { createToolbarElement } from './Toolbar';
import { splitIntelligentMarkdown, type IntelligentPart } from '../lib/intelligentUi';
import { t } from "../lib/i18n";
import { createMermaidPanel } from '../lib/mermaidPanel';
import { createInteractiveTable } from '../lib/interactiveTable';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StructuredDiagram } from './StructuredDiagram';
import { splitDiagramMarkdown, type DiagramPart } from '../lib/structuredDiagram';
import { reconcileMarkdownNode } from '../lib/reconcileMarkdown';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { renderChartToDOM } from './ChartRenderer';
import { renderMapToDOM } from './MapRenderer';
import { sourceMetadata, attachSourceMetadata, type SourceMetadata } from '../lib/sourcePreview';
import { CitationPreview } from './CitationPreview';
import { GeneratedCodePreview } from './GeneratedCodePreview';
import { streamMarkdown } from '../lib/streamMarkdown';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  suppressErrorRendering: true,
  // SVG text survives sanitization; HTML labels inside foreignObject lose their children.
  htmlLabels: false,
  flowchart: { htmlLabels: false },
});

marked.setOptions({
  gfm: true,
  breaks: true,
});

interface MarkdownViewProps {
  compactDiagrams?: boolean;
  consolidatedSources?: boolean;
  onPrompt?: (prompt: string) => void;
  readOnly?: boolean;
  content: string;
  isStreaming?: boolean;
  sessionId?: string;
  messageId?: string;
}


export const MarkdownView = React.memo(({ content, isStreaming, sessionId, messageId, readOnly = false, onPrompt, compactDiagrams = false, consolidatedSources = false }: MarkdownViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const streamedBlocks = useRef<Array<{ markup: string; node: Node }>>([]);
  const mermaidPanels = useRef<Array<{ panel: HTMLElement; dispose: () => void }>>([]);
  const [diagramMounts, setDiagramMounts] = useState<Array<{ part: Extract<DiagramPart, {type: 'diagram'}>; host: HTMLElement }>>([]);

  const [uiMounts, setUiMounts] = useState<Array<{ part: Extract<IntelligentPart, { type: 'ui' }>; host: HTMLElement }>>([]);

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    // Render markdown to HTML
    // Keep one Markdown document so reference links, citations and charts retain
    // their existing semantics. Diagram islands are owned by React portals.
    const uiParts = splitIntelligentMarkdown(content, Boolean(isStreaming));
    const withUi = uiParts.map(part => part.type === 'text' ? part.text :
      `\n\n<div class="intelligent-answer-host" data-intelligent-answer="${part.key}"></div>\n\n`).join('');
    const parts = splitDiagramMarkdown(withUi, Boolean(isStreaming));
    const markdown = parts.map(part => part.type === 'markdown' ? part.text :
      `\n\n<div class="structured-diagram-host" data-structured-diagram="${part.key}"></div>\n\n`).join('');
    const rawHtml = marked.parse(isStreaming ? streamMarkdown(markdown) : markdown);
    const safeHtml = DOMPurify.sanitize(rawHtml as string, {
      ADD_TAGS: ['foreignObject'],
      ADD_ATTR: ['target', 'rel'],
    });
    // Decorate fresh Markdown before comparing blocks. Reprocessing mounted
    // citation markers loses their original labels, URLs and supporting quotes.
    const renderRoot = document.createElement('div');
    renderRoot.innerHTML = safeHtml;

    // Resolve links: external links open in new tab, relative links download from session workspace
    const targetSession = sessionId || 'legacy';
    const citationSources = new Map<string, SourceMetadata & { number: number; label: string }>();
    for (const link of renderRoot.querySelectorAll('a')) {
      const rawHref = link.getAttribute('href');
      if (!rawHref) continue;

      let sourceUrl: URL | null = null;
      try { sourceUrl = new URL(rawHref, window.location.origin); } catch { /* Leave malformed links to the existing sanitizer. */ }
      const knowledgeSource = sourceUrl && sourceUrl.origin === window.location.origin && /^\/(?:sessions\/(?:legacy|[a-f0-9]{32})\/)?knowledge\/[a-f0-9-]{36}\/file$/.test(sourceUrl.pathname);
      const businessSource = sourceUrl?.protocol === 'https:' && (sourceUrl.hostname.endsWith('.sharepoint.com')
        || (sourceUrl.hostname === 'teams.microsoft.com' && sourceUrl.pathname.startsWith('/l/')));
      if (sourceUrl && (knowledgeSource || businessSource)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const sourceKey = knowledgeSource ? sourceUrl.pathname : sourceUrl.href;
        let source = citationSources.get(sourceKey);
        if (!source) {
          source = { ...sourceMetadata(link, knowledgeSource ? 'document' : 'web'), number: citationSources.size + 1, label: link.textContent || 'Document source' };
          citationSources.set(sourceKey, source);
        }
        const metadata = sourceMetadata(link, knowledgeSource ? 'document' : 'web');
        attachSourceMetadata(link, metadata);
        link.classList.add('citation-marker');
        link.setAttribute('aria-label', `Source ${source.number}: ${link.textContent || source.label}`);
        link.textContent = `[${source.number}]`;
        if (sourceUrl.hash === '#stream-pending') {
          link.removeAttribute('href');
          delete link.dataset.sourceUrl;
          link.setAttribute('aria-label', `Source ${source.number}, citation being generated`);
          link.setAttribute('aria-disabled', 'true');
          continue;
        }
        if (businessSource) {link.removeAttribute('title'); continue;}
        const supportingQuote = link.getAttribute('title');
        if (supportingQuote) {
          sourceUrl.searchParams.set('quote', supportingQuote);
          link.removeAttribute('title');
        }
        link.dataset.citationPreview = sourceUrl.pathname.replace(/\/file$/, '/preview') + sourceUrl.search;
        if (!source.preview) source.preview = link.dataset.citationPreview;
        continue;
      }

      if (sourceUrl && ['http:', 'https:'].includes(sourceUrl.protocol) && sourceUrl.origin !== window.location.origin) {
        attachSourceMetadata(link, sourceMetadata(link, 'web'));
        link.removeAttribute('title');
        (link as HTMLAnchorElement).target = '_blank';
        (link as HTMLAnchorElement).rel = 'noopener noreferrer';
        continue;
      }

      if (!rawHref.startsWith('#') && !rawHref.startsWith('javascript:')) {
        if (readOnly) {
          link.removeAttribute('href');
          link.setAttribute('aria-disabled', 'true');
          link.setAttribute('title', 'Private files are not included in shared conversations.');
          continue;
        }
        const cleanPath = rawHref.replace(/^\.\//, '');
        (link as HTMLAnchorElement).href = `/sessions/${encodeURIComponent(targetSession)}/file?path=${encodeURIComponent(cleanPath)}`;
        (link as HTMLAnchorElement).target = '_blank';
        (link as HTMLAnchorElement).rel = 'noopener noreferrer';
        (link as HTMLAnchorElement).setAttribute('download', cleanPath.split('/').pop() || cleanPath);

        if (/\.(pptx|ppt|bobdeck)$/i.test(cleanPath)) {
          link.classList.add('file-download-badge', 'presentation-badge');
          link.setAttribute('title', `Click to download ${cleanPath}`);
          if (!link.textContent?.includes('📊') && !link.textContent?.includes('📥')) {
            const label = document.createElement('strong');
            label.textContent = `Download ${link.textContent}`;
            link.replaceChildren(document.createTextNode('📊 '), label);
          }
        } else if (/\.(xlsx|xls|csv)$/i.test(cleanPath)) {
          link.classList.add('file-download-badge', 'sheet-badge');
          link.setAttribute('title', `Click to download ${cleanPath}`);
          if (!link.textContent?.includes('📈') && !link.textContent?.includes('📥')) {
            const label = document.createElement('strong');
            label.textContent = `Download ${link.textContent}`;
            link.replaceChildren(document.createTextNode('📈 '), label);
          }
        } else {
          link.classList.add('file-download-badge');
        }
      } else {
        link.removeAttribute('href');
      }
    }

    if (citationSources.size && !isStreaming && !consolidatedSources) {
      const sources = document.createElement('details');
      sources.className = 'answer-sources';
      const summary = document.createElement('summary');
      summary.textContent = `Sources · ${citationSources.size} ${citationSources.size === 1 ? 'document' : 'documents'}`;
      sources.append(summary);
      const list = document.createElement('ul');
      for (const source of citationSources.values()) {
        const item = document.createElement('li');
        const download = document.createElement('a');
        download.href = source.url;
        attachSourceMetadata(download, source);
        download.target = '_blank';
        download.rel = 'noopener noreferrer';
        download.textContent = `[${source.number}] ${source.label.split(',').reduce<{ parts: string[]; done: boolean }>((state, part) => { if (!state.done && state.parts.length && /^\s*(?:page \d+|text)/i.test(part)) state.done = true; if (!state.done) state.parts.push(part); return state; }, { parts: [], done: false }).parts.join(',')}`;
        item.append(download);
        list.append(item);
      }
      sources.append(list);
      renderRoot.append(sources);
    }

    if (readOnly) {
      for (const link of renderRoot.querySelectorAll('a[href]')) {
        try {
          const url = new URL(link.getAttribute('href') || '', window.location.origin);
          if (url.origin !== window.location.origin || !/^\/(?:sessions|projects|workspace)\//.test(url.pathname)) continue;
        } catch { /* Malformed links must not break a shared message. */ }
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
      }
    }

    // Resolve workspace relative images (e.g. matplotlib / python charts saved to disk)
    for (const img of renderRoot.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src && !/^https?:\/\//i.test(src) && !src.startsWith('data:')) {
        if (readOnly) {
          img.removeAttribute('src');
          img.alt = 'Private image not included in shared conversation';
          continue;
        }
        const cleanPath = src.replace(/^\.\//, '');
        const targetSession = sessionId || 'legacy';
        img.src = `/sessions/${encodeURIComponent(targetSession)}/file?path=${encodeURIComponent(cleanPath)}`;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '10px';
        img.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.08)';
        img.style.margin = '10px 0';
      }
    }

    if (isStreaming) {
      const lastBlock = renderRoot.lastElementChild;
      const tails = lastBlock?.querySelectorAll('p, li, code, td, th');
      const tail = tails?.length ? tails[tails.length - 1] : lastBlock;
      if (!tail?.matches('.structured-diagram-host')) tail?.setAttribute('data-stream-tail', '');
    }

    // Render interactive charts (```chart or ```bobchart)
    // When streaming, render as soon as the chart code block is closed and the next paragraph or block has started.
    const chartCodes = renderRoot.querySelectorAll('pre > code.language-chart, pre > code.language-bobchart');
    chartCodes.forEach((code) => {
      const pre = code.parentElement;
      if (!pre) return;

      if (isStreaming) {
        // While streaming, wait until the chart block is finished and subsequent content (e.g. next paragraph) has started
        const hasNextSibling = Boolean(
          pre.nextElementSibling ||
          (pre.parentElement && pre.parentElement !== renderRoot && pre.parentElement.nextElementSibling) ||
          pre !== renderRoot.lastElementChild
        );
        if (!hasNextSibling) {
          return;
        }
      }

      try {
        const spec = JSON.parse(code.textContent || '{}');
        const chartElement = renderChartToDOM(spec);
        chartElement.setAttribute('data-chart-spec', code.textContent || '');
        pre.replaceWith(chartElement);
      } catch {
        // Leave code block as-is if invalid JSON or incomplete
      }
    });

    // Render interactive maps (```map, ```bobmap, or ```geojson)
    const mapCodes = renderRoot.querySelectorAll('pre > code.language-map, pre > code.language-bobmap, pre > code.language-geojson');
    mapCodes.forEach((code) => {
      const pre = code.parentElement;
      if (!pre) return;

      if (isStreaming) {
        const hasNextSibling = Boolean(
          pre.nextElementSibling ||
          (pre.parentElement && pre.parentElement !== renderRoot && pre.parentElement.nextElementSibling) ||
          pre !== renderRoot.lastElementChild
        );
        if (!hasNextSibling) {
          return;
        }
      }

      try {
        const spec = JSON.parse(code.textContent || '{}');
        const mapElement = renderMapToDOM(spec);
        mapElement.setAttribute('data-map-spec', code.textContent || '');
        pre.replaceWith(mapElement);
      } catch {
        // Leave code block as-is if invalid JSON or incomplete
      }
    });

    // Render Mermaid diagrams
    const mermaidCodes = isStreaming ? [] : renderRoot.querySelectorAll('pre > code.language-mermaid');
    mermaidCodes.forEach(code => {
      const pre = code.parentElement;
      if (!pre) return;
      // Reconcile lightweight hosts first. Starting asynchronous Mermaid work
      // in the detached render tree discards it when an existing panel survives.
      const host = document.createElement('div');
      host.className = 'mermaid-panel';
      host.dataset.mermaidSource = code.textContent || '';
      host.dataset.mermaidSession = sessionId || '';
      pre.replaceWith(host);
    });

    // Transform tables into Interactive Data Grid & Chart cards
    if (!isStreaming) {
      const tables = renderRoot.querySelectorAll('table:not(.it-grid-table)');
      tables.forEach(table => {
        const interactiveEl = createInteractiveTable(table as HTMLTableElement);
        if (interactiveEl !== table) {
          table.replaceWith(interactiveEl);
        }
      });
    }

    // Transform code blocks into IDE-style Code Subwindows
    const codeBlocks = isStreaming ? [] : renderRoot.querySelectorAll('pre > code:not(.language-mermaid):not(.language-chart):not(.language-bobchart):not(.language-map):not(.language-bobmap):not(.language-geojson)');
    codeBlocks.forEach((code, idx) => {
      const pre = code.parentElement;
      if (!pre) return;
      if (pre.parentElement?.classList.contains('code-subwindow-body')) return;

      const langMatch = code.className.match(/language-([a-z0-9_-]+)/i);
      const rawLang = langMatch ? langMatch[1] : '';
      const displayTitle = rawLang === 'bobdeck'
        ? 'presentation.bobdeck'
        : rawLang
        ? rawLang.toUpperCase()
        : 'CODE';

      const isLatest = isStreaming && idx === codeBlocks.length - 1;
      const rawText = code.textContent || '';

      const subwindow = document.createElement('div');
      subwindow.className = `code-subwindow ${isLatest ? 'is-streaming' : ''}`;

      const header = createToolbarElement('code-subwindow-header');

      const left = document.createElement('div');
      left.className = 'code-subwindow-left';

      const dots = document.createElement('div');
      dots.className = 'code-subwindow-dots';
      dots.innerHTML = '<span class="code-dot red"></span><span class="code-dot yellow"></span><span class="code-dot green"></span>';

      const title = document.createElement('span');
      title.className = 'code-subwindow-title';
      title.textContent = displayTitle;

      left.append(dots, title);

      if (isLatest) {
        const liveBadge = document.createElement('span');
        liveBadge.className = 'code-subwindow-live-badge';
        liveBadge.innerHTML = '<span class="pulse-dot"></span> Live Code Stream';
        left.append(liveBadge);
      }

      const actions = document.createElement('div');
      actions.className = 'code-subwindow-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-subwindow-btn';
      copyBtn.textContent = t('Copy');
      copyBtn.setAttribute('aria-live', 'polite');
      let copyReset: ReturnType<typeof setTimeout> | undefined;
      copyBtn.addEventListener('click', async () => {
        clearTimeout(copyReset);
        try {
          await navigator.clipboard.writeText(rawText);
          copyBtn.dataset.copyState = 'copied';
          copyBtn.textContent = `✓ ${t('Copied')}`;
          copyReset = setTimeout(() => { if (copyBtn.isConnected) { copyBtn.dataset.copyState = 'idle'; copyBtn.textContent = t('Copy'); } }, 2200);
        } catch {
          copyBtn.dataset.copyState = 'error';
          copyBtn.textContent = t('Could not copy. Please try again.');
        }
      });

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'code-subwindow-btn';
      toggleBtn.textContent = 'Collapse';
      toggleBtn.addEventListener('click', () => {
        const isCollapsed = subwindow.classList.toggle('collapsed');
        toggleBtn.textContent = isCollapsed ? 'Expand' : 'Collapse';
      });

      actions.append(copyBtn, toggleBtn);
      header.append(left, actions);

      const body = document.createElement('div');
      body.className = 'code-subwindow-body';
      pre.replaceWith(subwindow);
      body.append(pre);
      subwindow.append(header, body);

      if (isLatest) {
        body.scrollTop = body.scrollHeight;
      }
    });
    {
      const previous = streamedBlocks.current;
      const next = Array.from(renderRoot.childNodes).map((node, index) => {
        const markup = node instanceof Element ? node.outerHTML : node.textContent || '';
        const old = previous[index];
        return old && old.markup === markup && old.node.parentNode === containerRef.current
          ? old : { markup, node };
      });
      next.forEach((block, index) => {
        const current = containerRef.current!.childNodes[index];
        if (current === block.node) return;
        if (current) block.node = reconcileMarkdownNode(current, block.node);
        else {
          containerRef.current!.appendChild(block.node);
        }
      });
      while (containerRef.current.childNodes.length > next.length) containerRef.current.lastChild?.remove();
      streamedBlocks.current = next;
    }
    for (const host of containerRef.current.querySelectorAll<HTMLElement>('.mermaid-panel[data-mermaid-source]')) {
      if (mermaidPanels.current.some(entry => entry.panel === host)) continue;
      mermaidPanels.current.push(createMermaidPanel(host, host.dataset.mermaidSource || '', sessionId));
    }
    mermaidPanels.current = mermaidPanels.current.filter(entry => {
      if (containerRef.current!.contains(entry.panel)) return true;
      entry.dispose();
      return false;
    });
    // Panel creation replaces its placeholder; retain the actual mounted node.
    streamedBlocks.current.forEach((block, index) => { block.node = containerRef.current!.childNodes[index]; });
    setUiMounts(uiParts.flatMap(part => {
      if (part.type !== 'ui') return [];
      const host = containerRef.current?.querySelector<HTMLElement>(`[data-intelligent-answer="${part.key}"]`);
      return host ? [{ part, host }] : [];
    }));
    setDiagramMounts(parts.flatMap(part => {
      if (part.type !== 'diagram') return [];
      const host = containerRef.current?.querySelector<HTMLElement>(`[data-structured-diagram="${part.key}"]`);
      return host ? [{ part, host }] : [];
    }));
  }, [content, isStreaming, sessionId, consolidatedSources, readOnly]);

  useLayoutEffect(() => () => {
    mermaidPanels.current.forEach(entry => entry.dispose());
    mermaidPanels.current = [];
    streamedBlocks.current = [];
  }, []);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const artifact = (target: EventTarget | null) => {
      const link = target instanceof Element ? target.closest('a') : null;
      if (!link || !root.contains(link)) return null;
      try {
        const url = new URL(link.href,window.location.origin);
        if (url.origin !== window.location.origin || !/^\/sessions\/[^/]+\/file$/.test(url.pathname)) return null;
        const path = url.searchParams.get('path');
        if (!path || !/\.(?:html?|bobdeck)$/i.test(path)) return null;
        return {path,sessionId:url.pathname.split('/')[2]};
      } catch { return null; }
    };
    const open = (detail: {path:string;sessionId:string}) => window.dispatchEvent(new CustomEvent('buddy-open-artifact',{detail}));
    const hover = (event: Event) => { if(timer)clearTimeout(timer);const detail=artifact(event.target);if(detail)timer=setTimeout(()=>open(detail),450); };
    const leave = () => {if(timer)clearTimeout(timer);};
    const click = (event: MouseEvent) => {const detail=artifact(event.target);if(detail && !event.ctrlKey && !event.metaKey && !event.shiftKey){event.preventDefault();leave();open(detail);} };
    root.addEventListener('mouseover',hover);root.addEventListener('mouseout',leave);root.addEventListener('click',click);
    return () => {leave();root.removeEventListener('mouseover',hover);root.removeEventListener('mouseout',leave);root.removeEventListener('click',click);};
  }, [content,isStreaming,sessionId]);

  return <><div ref={containerRef} className={`markdown-body${isStreaming ? t(" is-streaming") : ''}`} aria-busy={Boolean(isStreaming)} />
    {uiMounts.map(({ part, host }) => createPortal(<IntelligentAnswer key={part.source} spec={part.spec} source={part.source} pending={part.pending} sessionId={sessionId} identity={`${messageId || 'document'}:${part.key}`} readOnly={readOnly} onPrompt={readOnly ? undefined : onPrompt} disabled={Boolean(isStreaming)} />, host, `${sessionId || 'legacy'}:${part.key}`))}
    {diagramMounts.map(({part, host}) => createPortal(
      <StructuredDiagram compact={compactDiagrams} spec={part.spec} source={part.source} streaming={Boolean(isStreaming && !part.complete)} error={part.error} sessionId={sessionId} />, host, `${sessionId || 'legacy'}:${part.key}`))}
    {!readOnly && <GeneratedCodePreview rootRef={containerRef} contentKey={content} isStreaming={isStreaming} sessionId={sessionId} />}
    {!readOnly && <CitationPreview rootRef={containerRef} contentKey={content} sessionId={sessionId} />}</>;
});
