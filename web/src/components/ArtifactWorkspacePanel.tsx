import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../lib/i18n';

export function ArtifactWorkspacePanel({ children }: { children: ReactNode }) {
  const touch = matchMedia('(any-pointer: coarse)').matches;
  const defaults = { width: 48, height: touch ? 35 : 58 };
  const panel = useRef<HTMLElement>(null);
  const [size, setSize] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('buddy-artifact-size') || '{}');
      return { width: Number.isFinite(saved.width) ? Math.max(25, Math.min(70, saved.width)) : defaults.width,
        height: Number.isFinite(saved.height) ? Math.max(25, Math.min(75, saved.height)) : defaults.height };
    } catch { return defaults; }
  });
  const [stacked, setStacked] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const layout = panel.current?.parentElement;
    if (!layout) return;
    const observer = new ResizeObserver(() => setStacked(layout.clientWidth <= 900));
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const layout = panel.current?.parentElement;
    if (!layout) return;
    layout.style.setProperty('--artifact-width', `${size.width}%`);
    layout.style.setProperty('--artifact-height', `${size.height}%`);
    try { localStorage.setItem('buddy-artifact-size', JSON.stringify(size)); } catch { /* Optional storage. */ }
  }, [size]);
  useEffect(() => {
    const layout = panel.current?.parentElement;
    layout?.classList.toggle('artifact-resizing', dragging);
    return () => layout?.classList.remove('artifact-resizing');
  }, [dragging]);
  const resize = (value: number) => {
    const layout = panel.current?.parentElement;
    if (!layout) return;
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const chatReserve = touch ? Math.min(220 / scale, layout.clientHeight * .7) : 180;
    const maximum = stacked ? Math.min(75, Math.max(25, (layout.clientHeight - chatReserve) / layout.clientHeight * 100))
      : Math.min(70, (layout.clientWidth - 320) / layout.clientWidth * 100);
    const next = Math.max(25, Math.min(maximum, value));
    setSize(previous => ({ ...previous, [stacked ? 'height' : 'width']: next }));
  };
  return <aside ref={panel} className="artifact-workspace-panel" aria-label={t('Artifact editor')}>
    <div className="artifact-resize-handle" role="separator" tabIndex={0}
      aria-label={t('Resize artifact panel')} aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-valuemin={25} aria-valuemax={stacked ? 75 : 70} aria-valuenow={Math.round(stacked ? size.height : size.width)}
      title={t('Drag to resize. Double-click to reset.')}
      onDoubleClick={() => setSize(defaults)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = panel.current?.parentElement?.getBoundingClientRect();
        if (bounds) resize(stacked ? (event.clientY - bounds.top) / bounds.height * 100 : (bounds.right - event.clientX) / bounds.width * 100);
      }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
      onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
      onKeyDown={event => {
        const current = stacked ? size.height : size.width;
        const increase = stacked ? 'ArrowDown' : 'ArrowLeft';
        const decrease = stacked ? 'ArrowUp' : 'ArrowRight';
        if ([increase, decrease, 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          resize(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : current + (event.key === increase ? 5 : -5));
        }
      }}><span aria-hidden="true" /></div>
    {children}
  </aside>;
}
