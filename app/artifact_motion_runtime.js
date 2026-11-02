/* Native, opt-in motion for exported dashboards. Layout stays in place. */
(() => {
  if (window.BobMotion) return;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const seen = new WeakSet();
  const visibility = new WeakMap();
  const animations = new Set();
  const activeReveals = new WeakMap();
  const reveal = (element, replay = false) => {
    if (!replay && seen.has(element)) return;
    seen.add(element);
    if (preference.matches || window.BobPreviewLive || !element.animate) return;
    activeReveals.get(element)?.cancel();
    const animation = element.animate([
      {opacity: 0.65, transform: 'translateY(12px)'},
      {opacity: 1, transform: 'translateY(0)'}
    ], {duration: 360, easing: 'cubic-bezier(.2,0,.38,.9)'});
    activeReveals.set(element, animation);
    animations.add(animation);
    animation.finished.catch(() => {}).finally(() => animations.delete(animation));
  };
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const wasVisible = visibility.get(entry.target);
      visibility.set(entry.target, entry.isIntersecting);
      if (entry.isIntersecting && !wasVisible) reveal(entry.target, seen.has(entry.target));
    }
  }, {threshold: 0.08}) : null;
  function replay(root = document) {
    if (root instanceof HTMLElement && root.matches('[data-bob-reveal]') && root.getClientRects().length) reveal(root, true);
    for (const element of root.querySelectorAll('[data-bob-reveal]')) if (element.getClientRects().length) reveal(element, true);
  }
  document.addEventListener('bob:chart-activate', event => replay(event.detail?.element || document));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) replay(); });
  window.addEventListener('pageshow', event => { if (event.persisted) replay(); });
  function scan(root = document) {
    for (const element of root.querySelectorAll('[data-bob-reveal]')) {
      if (!seen.has(element)) observer ? observer.observe(element) : reveal(element);
    }
  }
  preference.addEventListener('change', () => {
    if (preference.matches) for (const animation of animations) animation.cancel();
  });
  const style = document.createElement('style');
  style.textContent = '@media(prefers-reduced-motion:no-preference){[data-bob-interactive]{transition:transform 180ms ease,box-shadow 180ms ease,background-color 180ms ease}[data-bob-interactive]:active{transform:translateY(0) scale(.99)}}@media(hover:hover) and (prefers-reduced-motion:no-preference){[data-bob-interactive]:hover{transform:translateY(-2px);box-shadow:0 8px 24px #5a2b851a}}';
  document.head.appendChild(style);
  const changes = new MutationObserver(() => scan());
  changes.observe(document.documentElement, {childList: true, subtree: true});
  scan();
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { observer?.disconnect(); changes.disconnect(); for (const animation of animations) animation.cancel(); }
  });
  window.BobMotion = {scan, replay};
})();
