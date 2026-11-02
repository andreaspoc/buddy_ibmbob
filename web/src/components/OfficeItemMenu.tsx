import { Toolbar } from './Toolbar';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../lib/i18n';

export type OfficeMenuAction = { label: string; run: () => void; danger?: boolean; disabled?: boolean };
export type OfficeMenuPosition = { x: number; y: number; returnFocus: HTMLElement | null };

export function OfficeItemMenu({ position, actions, onClose }: { position: OfficeMenuPosition; actions: OfficeMenuAction[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { position.returnFocus?.focus(); onClose(); };
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - box.width - 8)) / scale}px`;
    element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - box.height - 8)) / scale}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [position]);
  useEffect(() => {
    const dismiss = (event: Event) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const hide = () => onClose();
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true); };
  }, [onClose]);
  return createPortal(<Toolbar menu ref={menu} className="office-item-menu" role="menu" aria-label={t('Actions')} style={{ left: position.x, top: position.y }} onKeyDown={event => {
    event.stopPropagation();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); }
  }}>{actions.map(action => <button type="button" role="menuitem" key={action.label} className={action.danger ? 'danger' : ''} disabled={action.disabled} onClick={() => { close(); action.run(); }}>{action.label}</button>)}</Toolbar>, document.body);
}
