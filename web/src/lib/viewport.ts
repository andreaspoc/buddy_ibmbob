// iOS keeps the layout viewport tall when its software keyboard opens.
export function trackVisibleViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame: number | null = null;
  const update = () => {
    frame = null;
    // Preserve native pinch zoom instead of reflowing during a gesture.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport?.height ?? window.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    const input = document.activeElement;
    const rect = input instanceof HTMLElement && input.matches('input, textarea, select') ? input.getBoundingClientRect() : null;
    root.style.setProperty('--visible-height', `${height}px`);
    root.style.setProperty('--visible-top', `${top}px`);
    if (rect && matchMedia('(any-pointer: coarse)').matches && (rect.top < top || rect.bottom > top + height)) {
      input?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
  update();
  window.addEventListener('resize', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    root.style.removeProperty('--visible-height');
    root.style.removeProperty('--visible-top');
  };
}
