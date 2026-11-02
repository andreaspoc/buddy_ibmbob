import { uiMotion } from '../lib/motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { SCRIPT_ERROR_REPORTER, repairHtmlForRender } from '../lib/htmlRenderRepair';

// Keep the current document visible while its replacement loads and executes.
// Finish loading before accepting the latest queued snapshot.
const bridge = `<script>(()=>{
  const positions = {};
  const revealedCharts = new WeakSet();
  let visible = false;
  let live = false;
  window.BobPreviewLive = true;
  function revealCharts(replay = false) {
    if (!visible || live || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.BuddyCarbonCharts && document.querySelector('[data-bob-carbon-chart]')) {
      parent.postMessage({type:'buddy-preview-chart-motion'}, '*');
      if (replay) window.BuddyCarbonCharts.replayVisible();
    }
    if (window.echarts?.getInstanceByDom) for (const element of document.querySelectorAll('div,section,figure')) {
      const chart = window.echarts.getInstanceByDom(element);
      if (!chart || (!replay && revealedCharts.has(chart))) continue;
      revealedCharts.add(chart);
      parent.postMessage({type:'buddy-preview-chart-motion'}, '*');
      const option = chart.getOption();
      option.animation = true;
      option.animationDuration = ${uiMotion.chartEnter};
      option.animationDurationUpdate = ${uiMotion.chartUpdate};
      option.animationEasing = 'cubicOut';
      option.animationEasingUpdate = 'cubicOut';
      option.series?.forEach(series => {
        series.animation = true;
        series.animationDuration = ${uiMotion.chartEnter};
        series.animationDurationUpdate = ${uiMotion.chartUpdate};
      });
      chart.clear(); chart.setOption(option);
    }
    if (window.Chart) for (const element of document.querySelectorAll('canvas')) {
      const chart = window.Chart.getChart?.(element) || Object.values(window.Chart.instances || {}).find(chart => chart.canvas === element);
      if (!chart || (!replay && revealedCharts.has(chart))) continue;
      revealedCharts.add(chart);
      parent.postMessage({type:'buddy-preview-chart-motion'}, '*');
      if (!window.BobDashboard) chart.options.animation = {duration:${uiMotion.chartEnter}, easing:'easeOutCubic'};
      chart.reset(); chart.update();
    }
  }
  document.addEventListener('bob:carbon-ready', () => revealCharts(true));
  let chartFrame = 0;
  new MutationObserver(() => {
    if (!visible || live || chartFrame) return;
    chartFrame = requestAnimationFrame(() => { chartFrame = 0; revealCharts(); });
  }).observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['width','height','_echarts_instance_']});
  let scheduled = false;
  document.addEventListener('scroll', event => {
    const node = event.target;
    if (node instanceof HTMLElement && node.id) positions[node.id] = [node.scrollLeft, node.scrollTop];
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      parent.postMessage({type:'buddy-preview-position', x:scrollX, y:scrollY, positions}, '*');
    });
  }, true);
  addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data?.type === 'buddy-preview-visible') {
      const returning = !visible || live;
      visible = event.data.visible !== false; live = event.data.live;
      window.BobPreviewLive = !visible || live;
      if (visible && !live) revealCharts(returning); return;
    }
    if (event.data?.type === 'buddy-preview-replay') { revealCharts(true); return; }
    if (event.data?.type !== 'buddy-preview-restore') return;
    const state = event.data.state;
    scrollTo({left:state.x, top:state.y, behavior:'instant'});
    for (const [id, position] of Object.entries(state.positions)) {
      const node = document.getElementById(id);
      if (node) node.scrollTo({left:position[0], top:position[1], behavior:'instant'});
    }
    parent.postMessage({type:'buddy-preview-restored'}, '*');
  });
})();</script>`;
const stableMotion = '<style>body,main,header,.slide,[data-bob-reveal],[data-bob-entrance]{animation:none!important}*{scroll-behavior:auto!important}</style><script>window.BobPreviewLive=true;document.getAnimations().forEach(animation=>animation.cancel());</script>';

export function ArtifactPreview({ html, live = false }: { html: string; live?: boolean }) {
  const [documents, setDocuments] = useState<[string, string]>(['', '']);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState<number | null>(null);
  const [hasCharts, setHasCharts] = useState(false);
  const frames = useRef<Array<HTMLIFrameElement | null>>([]);
  const container = useRef<HTMLDivElement>(null);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const position = useRef({ x: 0, y: 0, positions: {} });
  const state = useRef({ active, loading });
  state.current = { active, loading };
  // Install the bridge before generated scripts: an unfinished script in a
  // streamed snapshot would otherwise swallow the appended bridge as source.
  const policyEnd = html.startsWith('<meta http-equiv="Content-Security-Policy"') ? html.indexOf('>') + 1 : 0;
  // A finished page reports scripts that still cannot run; a streamed snapshot is unfinished by design.
  const page = useMemo(() => repairHtmlForRender(html.slice(policyEnd)), [html, policyEnd]);
  const document = html ? html.slice(0, policyEnd) + bridge + (live ? '' : SCRIPT_ERROR_REPORTER) + page + (live ? stableMotion : '') : '';
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Frames use srcDoc (opaque origin); verify source window instead of origin.
      const { active, loading } = state.current;
      if (event.source === frames.current[active]?.contentWindow && event.data?.type === 'buddy-preview-chart-motion') setHasCharts(true);
      if (event.source === frames.current[active]?.contentWindow && event.data?.type === 'buddy-preview-position') {
        position.current = { x: event.data.x, y: event.data.y, positions: event.data.positions };
      }
      if (loading !== null && event.source === frames.current[loading]?.contentWindow && event.data?.type === 'buddy-preview-restored') {
        clearTimeout(restoreTimer.current);
        setActive(loading); setLoading(null);
      }
    };
    window.addEventListener('message', receive); // NOSONAR: source window is verified above
    return () => { window.removeEventListener('message', receive); clearTimeout(restoreTimer.current); };
  }, []);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const notify = (visible: boolean) => {
      frames.current[active]?.contentWindow?.postMessage({ type: 'buddy-preview-visible', visible: visible && !window.document.hidden, live }, '*'); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
      frames.current[1 - active]?.contentWindow?.postMessage({ type: 'buddy-preview-visible', visible: false, live: true }, '*'); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
    };
    const observer = new IntersectionObserver(entries => notify(Boolean(entries[0]?.isIntersecting)), {threshold: .01});
    const visibility = () => notify(host.getClientRects().length > 0);
    observer.observe(host);
    window.document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => { observer.disconnect(); window.document.removeEventListener('visibilitychange', visibility); };
  }, [active, live]);
  useEffect(() => {
    if (loading !== null || !document || documents[active] === document) return;
    const next = 1 - active;
    setDocuments(previous => next === 0 ? [document, previous[1]] : [previous[0], document]);
    setLoading(next);
  }, [document, active, loading, documents]);
  useEffect(() => {
    if (loading === null) return;
    // A slow external library must not block every subsequent snapshot. Keep
    // displaying partial HTML, then let the latest queued document catch up.
    const timer = setTimeout(() => {
      if (state.current.loading !== loading) return;
      frames.current[loading]?.contentWindow?.postMessage({ type: 'buddy-preview-restore', state: position.current }, '*'); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
      setActive(loading); setLoading(null);
    }, 2000);
    return () => clearTimeout(timer);
  }, [loading]);
  return <div ref={container} className="artifact-preview-stack" style={{ position: 'relative' }}>
    {hasCharts && <div className="artifact-preview-controls" style={{ position: 'absolute', top: 12, right: 12, zIndex: 2 }}>
      <button type="button" disabled={live || !documents[active]} onClick={() => frames.current[active]?.contentWindow?.postMessage({ type: 'buddy-preview-replay' }, '*')}> {/* NOSONAR: srcDoc iframe has opaque origin, '*' is required */}
        {t('Replay chart animations')}
      </button>
    </div>}
    {documents.map((document, index) => <iframe
      key={index}
      ref={node => { frames.current[index] = node; }}
      title={t('Artifact preview')}
      sandbox="allow-scripts"
      srcDoc={document}
      className="artifact-preview"
      aria-hidden={index !== active}
      tabIndex={index === active ? 0 : -1}
      style={index === active ? undefined : { visibility: 'hidden', position: 'absolute', inset: 0, pointerEvents: 'none' }}
      onLoad={() => {
        if (loading === index) {
          frames.current[index]?.contentWindow?.postMessage({ type: 'buddy-preview-restore', state: position.current }, '*'); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
          clearTimeout(restoreTimer.current);
          // Documents with their own restrictive CSP may disable the bridge.
          // They must still become visible when loading has completed.
          restoreTimer.current = setTimeout(() => {
            if (state.current.loading === index) { setActive(index); setLoading(null); }
          }, 250);
        }
      }}
    />)}
  </div>;
}
