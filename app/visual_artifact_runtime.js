/* Carbon Charts for new dashboards; the ECharts entry point supports saved legacy artifacts. */
(() => {
  if (window.BobVisuals?.carbon) return;
  const mounted = new Map();
  const pending = new WeakMap();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let loading;
  function load() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const finish = (error) => {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve(window.echarts);
      };
      const timer = setTimeout(() => finish(new Error('Chart library loading timed out.')), 15000);
      script.src = 'https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js';
      script.integrity = 'sha384-C2iskrW/uPW46KzOjrvJIQo4YkV8lkD+QS0CrDN18IIPIpT/g2USu8bTP3nvmIAD';
      script.crossOrigin = 'anonymous';
      script.onload = () => finish(window.echarts ? null : new Error('Chart library is unavailable.'));
      script.onerror = () => finish(new Error('Chart library could not load.'));
      document.head.appendChild(script);
    }).catch(error => { loading = undefined; throw error; });
    return loading;
  }
  async function echarts(element, option) {
    if (!(element instanceof HTMLElement)) throw new Error('A chart container is required.');
    mounted.get(element)?.dispose();
    const token = {};
    pending.set(element, token);
    element.textContent = 'Loading interactive chart…';
    element.setAttribute('aria-busy', 'true');
    try {
      const library = await load();
      if (pending.get(element) !== token || !element.isConnected) return null;
      element.textContent = '';
      const chart = library.init(element, null, {renderer: 'svg'});
      let disposed = false;
      let frame = 0;
      let animation = option.animation !== false;
      const seriesAnimation = new Map();
      const update = next => {
        if (disposed) return;
        if ('animation' in next) animation = next.animation !== false;
        const series = next.series && (Array.isArray(next.series) ? next.series : [next.series]);
        series?.forEach((s, index) => {
          const key = s.id ?? index;
          if ('animation' in s || !seriesAnimation.has(key)) seriesAnimation.set(key, s.animation !== false);
        });
        chart.setOption({...next, animation: animation && !motion.matches,
          ...(series ? {series: series.map((s, index) => ({...s,
            animation: !motion.matches && animation && seriesAnimation.get(s.id ?? index)}))} : {})});
      };
      const resize = () => {
        if (frame || disposed) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!disposed && element.clientWidth && element.clientHeight) chart.resize();
        });
      };
      const observer = new ResizeObserver(resize);
      const motionChanged = () => chart.setOption({animation: animation && !motion.matches,
        series: chart.getOption().series.map((s, index) => ({id: s.id,
          animation: !motion.matches && animation && (seriesAnimation.get(s.id ?? index) ?? seriesAnimation.get(index) ?? true)}))});
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        motion.removeEventListener('change', motionChanged);
        chart.dispose();
        mounted.delete(element);
      };
      const handle = {chart, update, dispose};
      mounted.set(element, handle);
      observer.observe(element);
      motion.addEventListener('change', motionChanged);
      update({aria: {enabled: true}, animationDuration: 1400, animationEasing: 'cubicOut',
        animationDurationUpdate: 700, animationEasingUpdate: 'cubicOut', ...option});
      return handle;
    } catch (error) {
      if (pending.get(element) === token) {
        mounted.get(element)?.dispose();
        element.textContent = 'Interactive chart unavailable. Refer to the source data or retry when connected.';
        element.setAttribute('role', 'status');
      }
      throw error;
    } finally {
      if (pending.get(element) === token) element.removeAttribute('aria-busy');
    }
  }
  let carbonLoading;
  function carbonAssets() {
    if (window.BuddyCarbonCharts && document.querySelector('style#buddy-carbon-css,style[data-bob-carbon-charts]')) return Promise.resolve(window.BuddyCarbonCharts);
    if (carbonLoading) return carbonLoading;
    const resource = (selector, tag, url, ready) => new Promise((resolve, reject) => {
      let node = document.querySelector(selector);
      if (ready(node)) { resolve(); return; }
      const fresh = !node;
      if (!node) {
        node = document.createElement(tag);
        node.setAttribute('data-bob-carbon-charts', '');
        if (tag === 'script') node.src = url;
        else { node.rel = 'stylesheet'; node.href = url; }
      }
      const finish = error => {
        clearTimeout(timer);
        node.removeEventListener('load', loaded);
        node.removeEventListener('error', failed);
        if (error) { node.remove(); reject(error); } else resolve();
      };
      const loaded = () => finish(ready(node) ? null : new Error('Carbon Charts asset is unavailable.'));
      const failed = () => finish(new Error('Carbon Charts asset could not load.'));
      const timer = setTimeout(() => finish(new Error('Carbon Charts asset loading timed out.')), 15000);
      node.addEventListener('load', loaded, {once: true});
      node.addEventListener('error', failed, {once: true});
      if (fresh) document.head.appendChild(node);
    });
    carbonLoading = Promise.all([
      resource('script#buddy-carbon-js,script[data-bob-carbon-charts]', 'script', '/static/carbon-charts.bundle.js', () => Boolean(window.BuddyCarbonCharts)),
      document.querySelector('style#buddy-carbon-css,style[data-bob-carbon-charts]') ? Promise.resolve() : resource('link#buddy-carbon-css,link[data-bob-carbon-charts]', 'link', '/static/carbon-charts.css', node => Boolean(node?.sheet))
    ]).then(() => window.BuddyCarbonCharts).catch(error => { carbonLoading = undefined; throw error; });
    return carbonLoading;
  }
  async function carbon(element, spec) {
    if (!(element instanceof HTMLElement)) throw new Error('A chart container is required.');
    mounted.get(element)?.dispose();
    const token = {};
    pending.set(element, token);
    element.textContent = 'Loading Carbon chart…';
    element.setAttribute('aria-busy', 'true');
    try {
      const library = await carbonAssets();
      if (pending.get(element) !== token || !element.isConnected) return null;
      element.textContent = '';
      const chartHandle = await library.create(element, spec);
      const handle = {...chartHandle, dispose() {
        chartHandle.dispose();
        if (mounted.get(element) === handle) mounted.delete(element);
      }};
      mounted.set(element, handle);
      return handle;
    } catch (error) {
      if (pending.get(element) === token) {
        mounted.get(element)?.dispose();
        element.textContent = 'Carbon chart unavailable: ' + (error instanceof Error ? error.message : String(error));
        element.setAttribute('role', 'status');
      }
      throw error;
    } finally {
      if (pending.get(element) === token) element.removeAttribute('aria-busy');
    }
  }
  new MutationObserver(() => {
    for (const [element, handle] of mounted) if (!element.isConnected) handle.dispose();
  }).observe(document.documentElement, {childList: true, subtree: true});
  window.addEventListener('pagehide', event => {
    if (!event.persisted) for (const handle of mounted.values()) handle.dispose();
  });
  window.BobVisuals = {...window.BobVisuals, echarts, carbon, replayVisible: () => window.BuddyCarbonCharts?.replayVisible()};
})();
