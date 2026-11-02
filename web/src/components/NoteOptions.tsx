import { Toolbar } from './Toolbar';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../lib/i18n';
export type NoteOption = { label: string; run: () => void; disabled?: boolean; danger?: boolean };
export function NoteOptions({ title, actions }: { title: string; actions: NoteOption[] }) {
  useLanguage();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { menu.current?.hidePopover(); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const element = menu.current, anchor = trigger.current.getBoundingClientRect();
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(anchor.right - box.width - 24, innerWidth - box.width - 8)) / scale}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - box.height - 8)) / scale}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) menu.current?.hidePopover(); };
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [open]);
  return <><button ref={trigger} type="button" className="note-options-trigger" aria-label={t('Options for {0}', [title])} aria-haspopup="menu" aria-expanded={open} aria-controls={id} popoverTarget={id} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); if (!open) trigger.current?.click(); else menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); } }}><span aria-hidden="true">•••</span><span>{t('Options')}</span></button>
    <Toolbar menu ref={menu} id={id} popover="auto" className="note-options-menu" role="menu" aria-label={t('Note options')} onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))} onKeyDown={event => {
      event.stopPropagation();
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab') close();
    }}><div className="note-options-title">{title}</div>{actions.map(action => <button type="button" role="menuitem" key={action.label} className={action.danger ? 'is-danger' : undefined} disabled={action.disabled} onClick={() => { close(); action.run(); }}>{action.label}</button>)}</Toolbar>
  </>;
}
