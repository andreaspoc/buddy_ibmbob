import { Toolbar } from './Toolbar';
import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../lib/i18n';

export function WorkspaceTools({ children, label = 'Tools', ariaLabel = 'Workspace tools', icon = 'tools', align = 'end' }: {
  children: ReactNode; label?: string; ariaLabel?: string; icon?: 'buddy' | 'tools' | 'settings'; align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [placement, setPlacement] = useState({ left: 12, top: 60, width: 320, maxHeight: 500 });
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
      const topEdge = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? innerWidth;
      const viewportHeight = viewport?.height ?? innerHeight;
      const width = Math.min(340 * scale, viewportWidth - 24);
      const left = Math.max(leftEdge, Math.min(align === 'start' ? anchor.left : anchor.right - width, leftEdge + viewportWidth - 24 - width));
      const top = Math.max(topEdge + 12, anchor.bottom + 8);
      setPlacement({ left: left / scale, top: top / scale, width: width / scale, maxHeight: Math.max(0, topEdge + viewportHeight - top - 12) / scale });
    };
    position();
    panel.current?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')?.focus();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div className={`workspace-tools workspace-menu-${icon}`} ref={root} onBlur={event => {
    if (!root.current?.contains(event.relatedTarget as Node) && !panel.current?.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (event.key === 'ArrowDown' && !open && event.target === trigger.current) { event.preventDefault(); setOpen(true); }
  }}>
    <button type="button" ref={trigger} className="workspace-menu-trigger" aria-label={t(ariaLabel)} title={t(label)} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <svg className="workspace-menu-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon === 'buddy' ? <><path d="M5 4h14v11H9l-4 4V4Z" /><path d="M9 8h6M9 11h4" /></> : icon === 'settings' ? <><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="2" /></> : <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>}
      </svg>
      <span className="workspace-menu-label">{t(label)}</span><span className="workspace-menu-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(<Toolbar menu id={panelId} ref={panel} className={`workspace-tools-panel workspace-panel-${icon}`} role="dialog" aria-label={t(ariaLabel)} style={placement} onClick={event => {
      const button = (event.target as HTMLElement).closest('button:not(:disabled)');
      if (button && !button.closest('[data-keep-open]')) { setOpen(false); trigger.current?.focus(); }
    }}><Toolbar className="workspace-panel-heading">{t(label)}</Toolbar>{children}</Toolbar>, document.body)}
  </div>;
}
