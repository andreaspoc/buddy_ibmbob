import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

/** Chapter HTML is inert on the server and sanitized again before entering the reader. */
export function LearningBookPages({ src, fontSize, page, onLayout, onTurn }: {
  src: string; fontSize: number; page: number;
  onLayout: (pages: number) => void; onTurn: (direction: number) => void;
}) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const start = useRef<{x: number; y: number} | null>(null);
  const layout = useRef(onLayout); layout.current = onLayout;
  useEffect(() => {
    const controller = new AbortController();
    setHtml(''); setError('');
    fetch(src, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unable to load this chapter. Reopen the book to retry.');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const clean = DOMPurify.sanitize((doc.querySelector('main') || doc.body).innerHTML, {
        USE_PROFILES: {html: true}, FORBID_TAGS: ['style','form','input','button','textarea','select','iframe'],
        FORBID_ATTR: ['style','srcset','id','name','href','target'],
      });
      if (!controller.signal.aborted) setHtml(clean);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [src]);
  useEffect(() => {
    const host = viewport.current, body = content.current;
    if (!host || !body || !html) return;
    const measure = () => {
      const size = host.clientWidth;
      body.style.columnWidth = `${size}px`;
      setWidth(size);
      layout.current(Math.max(1, Math.ceil((body.scrollWidth + 32) / (size + 32))));
    };
    const observer = new ResizeObserver(measure); observer.observe(host);
    body.addEventListener('load', measure, true);
    void document.fonts.ready.then(measure);
    measure();
    return () => { observer.disconnect(); body.removeEventListener('load', measure, true); };
  }, [html, fontSize]);
  return <div ref={viewport} className="learning-book-pages" tabIndex={0} aria-label="Book page"
    onKeyDown={event => { if (['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onTurn(['ArrowRight','PageDown'].includes(event.key) ? 1 : -1); } }}
    onTouchStart={event => { const touch=event.touches[0]; start.current={x:touch.clientX,y:touch.clientY}; }}
    onTouchEnd={event => { const touch=event.changedTouches[0], origin=start.current; start.current=null; if (origin && !window.getSelection()?.toString() && Math.abs(touch.clientX-origin.x)>60 && Math.abs(touch.clientY-origin.y)<50) onTurn(touch.clientX<origin.x ? 1 : -1); }}>
    {error ? <p role="alert">{error}</p> : !html ? <p role="status">Loading page…</p> : null}
    <div ref={content} className="learning-book-columns" style={{fontSize, transform:`translateX(-${page*(width+32)}px)`}} dangerouslySetInnerHTML={{__html:html}} />
  </div>;
}
