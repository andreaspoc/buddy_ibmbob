import { t } from "../lib/i18n";
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { sourcePopupPosition } from '../lib/sourcePreview';

interface PreviewData { filename: string; exact: boolean; message?: string; passages: {location: string; text: string}[] }
interface ActiveCitation {
  url: string; sourceUrl: string; label: string; kind: string; quote?: string; retrieved?: string;
  left: number; top?: number; bottom?: number; width: number; maxHeight: number;
}
export function CitationPreview({ rootRef, contentKey, sessionId, selector = 'a[data-source-url]:not(.research-citation-trigger), a[data-citation-preview]' }: {
  rootRef: RefObject<HTMLDivElement | null>; contentKey: string; sessionId?: string; selector?: string;
}) {
  const [active, setActive] = useState<ActiveCitation | null>(null);
  const [result, setResult] = useState<{url: string; data: PreviewData | null; error: string} | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAnchor = useRef<HTMLAnchorElement | null>(null);
  const popupId = useId();
  const cache = useRef(new Map<string, PreviewData>());
  const keepOpen = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
  const hide = () => {keepOpen();activeAnchor.current?.removeAttribute('aria-describedby');activeAnchor.current = null;setActive(null);};
  const hideSoon = () => {keepOpen();hideTimer.current = setTimeout(hide, 220);};
  useEffect(() => {cache.current.clear();hide();}, [sessionId]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    function show(event: Event) {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(selector) : null;
      if (!anchor || !root?.contains(anchor) || anchor.getAttribute('aria-disabled') === 'true') return;
      keepOpen();
      if (anchor === activeAnchor.current) return;
      activeAnchor.current?.removeAttribute('aria-describedby');
      activeAnchor.current = anchor;
      anchor.setAttribute('aria-describedby', popupId);
      setActive({url: anchor.dataset.citationPreview || '', sourceUrl: anchor.dataset.sourceUrl || anchor.href,
        label: anchor.dataset.sourceTitle || anchor.getAttribute('aria-label') || anchor.textContent || 'Source',
        kind: anchor.dataset.sourceKind || 'document', quote: anchor.dataset.sourceQuote, retrieved: anchor.dataset.sourceRetrieved,
        ...sourcePopupPosition(anchor.getBoundingClientRect(), {width: window.innerWidth, height: window.innerHeight})});
    }
    function leave(event: Event) {
      if (!(event.target instanceof Element) || !event.target.closest(selector)) return;
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (related instanceof Node && (activeAnchor.current?.contains(related) || popupRef.current?.contains(related))) return;
      hideSoon();
    }
    const keydown = (event: KeyboardEvent) => {if (event.key === 'Escape') hide();};
    const scroll = (event: Event) => {if (!(event.target instanceof Node && popupRef.current?.contains(event.target))) hide();};
    root.addEventListener('pointerover', show);root.addEventListener('focusin', show);
    root.addEventListener('pointerout', leave);root.addEventListener('focusout', leave);
    window.addEventListener('keydown', keydown);window.addEventListener('scroll', scroll, true);window.addEventListener('resize', hide);
    return () => {keepOpen();activeAnchor.current?.removeAttribute('aria-describedby');
      root.removeEventListener('pointerover', show);root.removeEventListener('focusin', show);
      root.removeEventListener('pointerout', leave);root.removeEventListener('focusout', leave);
      window.removeEventListener('keydown', keydown);window.removeEventListener('scroll', scroll, true);window.removeEventListener('resize', hide);};
  }, [rootRef, sessionId, popupId, selector]);
  useEffect(() => {
    const anchor = activeAnchor.current;
    if (!anchor) return;
    if (!anchor.isConnected) {hide(); return;}
    setActive(previous => {
      if (!previous) return previous;
      const sourceUrl = anchor.dataset.sourceUrl || anchor.href;
      const url = anchor.dataset.citationPreview || '';
      const label = anchor.dataset.sourceTitle || anchor.getAttribute('aria-label') || anchor.textContent || 'Source';
      return sourceUrl === previous.sourceUrl && url === previous.url && label === previous.label ? previous : {
        ...previous, sourceUrl, url, label, kind: anchor.dataset.sourceKind || 'document', quote: anchor.dataset.sourceQuote, retrieved: anchor.dataset.sourceRetrieved,
      };
    });
  }, [contentKey]);
  const previewUrl = active?.url;
  useEffect(() => {
    if (!previewUrl) return;
    // Passage requests are always same-origin knowledge endpoints; web links show
    // supplied metadata without requesting arbitrary external URLs.
    const url = new URL(previewUrl, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/(?:sessions\/[^/]+\/)?knowledge\/[a-f0-9-]{36}\/preview$/.test(url.pathname)) return;
    const cached = cache.current.get(previewUrl);
    if (cached) {setResult({url:previewUrl, data:cached, error:''});return;}
    const controller = new AbortController();
    void fetch(previewUrl, {signal:controller.signal, cache:'no-store'}).then(async response => {
      if (!response.ok) throw new Error(response.status === 404 ? 'This source passage is no longer available.' : 'Could not load the source passage.');
      const data = await response.json();
      if (!data || typeof data.filename !== 'string' || !Array.isArray(data.passages)) throw new Error('This source returned an invalid preview.');
      return {...data, passages: data.passages.filter((passage: PreviewData['passages'][number]) => typeof passage?.text === 'string') } as PreviewData;
    }).then(data => {if (!controller.signal.aborted) {
      if (cache.current.size >= 100) cache.current.delete(cache.current.keys().next().value!);
      cache.current.set(previewUrl,data);setResult({url:previewUrl,data,error:''});
    }}).catch(error => {if (!controller.signal.aborted) setResult({url:previewUrl,data:null,error:error instanceof Error ? error.message : 'Could not load source.'});});
    return () => controller.abort();
  }, [previewUrl, sessionId]);
  if (!active) return null;
  const data = result?.url === active.url ? result.data : null;
  const error = result?.url === active.url ? result.error : '';
  return createPortal(<div ref={popupRef} id={popupId} role="tooltip" className="citation-preview"
    style={{left:active.left,top:active.top,bottom:active.bottom,width:active.width,maxHeight:active.maxHeight}}
    onPointerEnter={keepOpen} onPointerLeave={hideSoon} onFocus={keepOpen} onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) hideSoon();}}>
    <div className="citation-preview-heading"><span className="citation-preview-kicker">{active.kind === 'web' ? t("Web source") : data?.exact === false ? t("Source preview unavailable") : t("Document source")}</span><strong>{data?.filename || active.label}</strong></div>
    {active.url ? error ? <p role="status">{t(error)}</p> : !data ? <p role="status">{t("Loading source passage…")}</p> : <>
      {!data.exact && <p className="citation-preview-note">{data.message}</p>}
      {data.passages.map((passage,index) => <div className="citation-preview-passage" key={index}><span>{passage.location}</span><p>{passage.text}</p></div>)}
    </> : active.quote ? <p className="citation-preview-note">{active.quote}</p> : null}
    {active.retrieved && <p className="citation-preview-note">{t("Retrieved")}{active.retrieved}</p>}
    <a className="citation-preview-destination" href={active.sourceUrl} target="_blank" rel="noopener noreferrer">{active.sourceUrl}</a>
    <a href={active.sourceUrl} target="_blank" rel="noopener noreferrer">{active.kind === 'web' ? t("Open source ↗") : t("Download original document ↗")}</a>
  </div>, document.body);
}
