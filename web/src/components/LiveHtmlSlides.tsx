import { t } from "../lib/i18n";
import { useEffect, useMemo, useState, useRef } from 'react';

import { syncPresentationDocument } from '../lib/presentationDom';

const LIVE_FRAME = `<!doctype html><html><head></head><body><script>window.addEventListener('message',function(event){if(event.source!==parent||event.data?.type!=='bob-slide-update')return;(${syncPresentationDocument.toString()})(document,event.data.html);var slides=Array.from(document.querySelectorAll('section.slide, article.slide, div.slide, [data-slide]')).filter(function(el){return !el.parentElement?.closest('.slide, [data-slide]');});slides.forEach(function(el,i){el.classList.toggle('active',i===event.data.index);if(i!==event.data.index)el.style.setProperty('display','none','important');else{el.style.removeProperty('display');if(getComputedStyle(el).display==='none')el.style.setProperty('display','block','important');el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');el.style.setProperty('transform','none','important');}});});</script></body></html>`;

/** Show real saved slide content while the deck is still being written. */
export function LiveHtmlSlides({ html }: { html: string }) {
  const slides = useMemo(() => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('section.slide, article.slide, div.slide, [data-slide]'))
      .filter(element => !element.parentElement?.closest('.slide, [data-slide]'))
      .map((element, index) => element.querySelector('h1,h2,h3')?.textContent?.trim() || `Slide ${index + 1}`);
  }, [html]);
  const [index, setIndex] = useState(0);
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (follow) setIndex(Math.max(0, slides.length - 1)); }, [slides.length, follow]);
  const selected = Math.min(index, Math.max(0, slides.length - 1));
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ html, index: selected });
  latest.current = { html, index: selected };
  const send = () => frame.current?.contentWindow?.postMessage({ type: 'bob-slide-update', ...latest.current }, '*'); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
  useEffect(() => {
    const task = requestAnimationFrame(send);
    return () => cancelAnimationFrame(task);
  }, [html, selected]);
  return <div className="live-html-slides">
    <div className="live-slide-controls">
      <span role="status">{slides.length ? `Slide ${selected + 1} of ${slides.length} written` : t("Writing the first slide…")}</span>
      <button type="button" disabled={selected <= 0} aria-label={t("Previous draft slide")} onClick={() => {setFollow(false);setIndex(selected - 1);}}>‹</button>
      <button type="button" disabled={selected >= slides.length - 1} aria-label={t("Next draft slide")} onClick={() => {setFollow(false);setIndex(selected + 1);}}>›</button>
      <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />{t("Follow new slides")}</label>
    </div>
    <p className="live-slide-title">{slides[selected] || t("Live draft")} {t("· Editing becomes available when Buddy finishes")}</p>
    <iframe title={t("Live presentation preview")} ref={frame} sandbox="allow-scripts" srcDoc={LIVE_FRAME} onLoad={send} />
  </div>;
}
