import { themeCssValue } from '../lib/themeColor';
import { useEffect, useRef, useState } from 'react';
import { t, getLocale } from '../lib/i18n';
import { groupMissedCalls, type MissedCall } from '../lib/missedCalls';
import './MissedCallPin.css';


export function MissedCallPin({onConversation}: {onConversation?: (id: string) => void}) {
  const [items, setItems] = useState<MissedCall[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string[]>([]);
  const rail = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({before: false, after: false});
  const [error, setError] = useState('');
  const [cursorTooltip, setCursorTooltip] = useState<{ title: string; x: number; y: number } | null>(null);
  const removed = useRef(new Set<string>());
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (document.hidden || running) return;
      running = true;
      const version = revision.current;
      try {
        const response = await fetch('/notifications', {signal: controller.signal});
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!controller.signal.aborted && version === revision.current) {
          const next = data.filter((item: MissedCall & {kind: string; read_at: string | null}) => (item.kind === 'missed_call' || item.kind === 'reminder') && !item.read_at && !removed.current.has(item.id));
          setColors(previous => Object.fromEntries(groupMissedCalls(next, previous).map(group => [group.key, group.color])));
          setItems(next);
        }
      } catch { /* Keep pinned notes during a temporary connection failure. */ }
      finally { running = false; }
    };
    void load();
    const timer = window.setInterval(load, 10000);
    document.addEventListener('visibilitychange', load);
    window.addEventListener('community-call-ended', load);
    window.addEventListener('buddy-reminders-changed', load);
    window.addEventListener('focus', load);
    return () => {controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', load); window.removeEventListener('community-call-ended', load); window.removeEventListener('buddy-reminders-changed', load); window.removeEventListener('focus', load);};
  }, []);
  const groups = groupMissedCalls(items, colors);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const measure = () => setOverflow({before: element.scrollLeft > 2, after: element.scrollLeft + element.clientWidth < element.scrollWidth - 2});
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener('scroll', measure, {passive: true});
    measure();
    return () => {observer.disconnect(); element.removeEventListener('scroll', measure);};
  }, [items]);
  const remove = async (key: string, calls: MissedCall[]) => {
    setPending(previous => [...previous, key]); setError('');
    const results = await Promise.all(calls.map(async item => {
      try {
        const response = await fetch('/notifications/read', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: item.id})});
        if (!response.ok) return false;
        removed.current.add(item.id); return true;
      } catch {return false;}
    }));
    revision.current++;
    setItems(previous => previous.filter(item => !removed.current.has(item.id)));
    if (results.some(success => !success)) setError('Could not remove some notes. Please try again.');
    setPending(previous => previous.filter(value => value !== key));
  };
  const scroll = (direction: number) => rail.current?.scrollBy({left: direction * rail.current.clientWidth * .8, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  if (!groups.length) return null;
  const overflowing = overflow.before || overflow.after;
  return <div className="missed-call-pin-slot" aria-label={t('Pinned reminders and missed calls')}>
    {overflowing && <button type="button" className="missed-call-rail-arrow" disabled={!overflow.before} aria-label={t('Previous pinned notes')} onClick={() => scroll(-1)}>‹</button>}
    <div ref={rail} className="missed-call-pin-rail" tabIndex={0} aria-label={t('Pinned notes')}>
      {groups.map(group => <section key={group.key} className="missed-call-pin" data-color={group.color} data-reminder={group.latest.kind === 'reminder'} aria-label={group.latest.title}>
        {group.latest.kind === 'reminder' && <span className="toolbar-reminder-plane" aria-hidden="true">➤</span>}
        <span className="missed-call-pin-head" aria-hidden="true" />
        <button
          type="button"
          className="missed-call-pin-open"
          onMouseEnter={(e) => setCursorTooltip({ title: group.latest.title, x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => setCursorTooltip({ title: group.latest.title, x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setCursorTooltip(null)}
          onClick={() => group.latest.kind === 'reminder' ? group.latest.session_id && onConversation?.(group.latest.session_id) : window.dispatchEvent(new CustomEvent('community-open-room', {detail: {roomId: group.latest.room_id, kind: 'direct'}}))}
        >
          <strong>{group.latest.title}</strong>
          <span className="missed-call-pin-detail">{group.latest.kind === 'reminder' && <span>{t('Reminder')} · </span>}{group.calls.length > 1 && <span>{t('{0} missed calls', [String(group.calls.length)])} · </span>}<time dateTime={group.latest.occurred_at}>{new Date(group.latest.occurred_at).toLocaleString(getLocale(), {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</time></span>
        </button>
        <button type="button" className="missed-call-pin-remove" disabled={pending.includes(group.key)} aria-label={t('Remove note: {0}', [group.latest.title])} title={t('Remove pinned note')} onClick={() => void remove(group.key, group.calls)}>×</button>
      </section>)}
    </div>
    {cursorTooltip && (
      <div
        className="missed-call-cursor-tooltip"
        style={{
          position: 'fixed',
          left: `${Math.min(cursorTooltip.x + 12, typeof window !== 'undefined' ? window.innerWidth - 330 : 0)}px`,
          top: `${cursorTooltip.y + 16}px`,
          pointerEvents: 'none',
          zIndex: 99999,
          maxWidth: '320px',
          padding: '8px 12px',
          borderRadius: '8px',
          background: '#1a1625',
          color: '#ffffff',
          fontSize: '13px',
          lineHeight: '18px',
          fontWeight: '500',
          border: `1px solid ${themeCssValue('#9469be')}`,
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
          wordBreak: 'break-word',
        }}
      >
        {cursorTooltip.title}
      </div>
    )}
    {overflowing && <div className="missed-call-rail-more"><button type="button" className="missed-call-rail-arrow" disabled={!overflow.after} aria-label={t('More pinned notes')} onClick={() => scroll(1)}>›</button><span>{groups.length}</span></div>}
    {error && <span role="alert" className="missed-call-pin-error">{t(error)}</span>}
  </div>;
}
