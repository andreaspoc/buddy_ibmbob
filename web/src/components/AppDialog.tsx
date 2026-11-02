import { t } from '../lib/i18n';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button, InlineNotification } from '@carbon/react';
import './Notifications.css';

type Tone = 'info' | 'success' | 'error';
interface Request { message: string; resolve: (accepted: boolean) => void }
interface Notice extends Request { id: number; tone: Tone }
const queue: Request[] = [];
let notices: Notice[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => queue[0] || null;
const noticeSnapshot = () => notices;
export const appConfirm = (message: string): Promise<boolean> => new Promise(resolve => {
  queue.push({ message, resolve }); notify();
});
function dismiss(id: number) {
  const item = notices.find(value => value.id === id);
  notices = notices.filter(value => value.id !== id);
  item?.resolve(true); notify();
}
/** Routine feedback is nonmodal; errors remain until dismissed. */
export const appAlert = (message: string, tone: Tone = /could not|cannot|failed|failure|error|unavailable/i.test(message) ? 'error' : 'info'): Promise<boolean> => {
  const existing = notices.find(item => item.message === message);
  if (existing) return Promise.resolve(true);
  return new Promise(resolve => {
    if (notices.length >= 4) dismiss(notices[0].id);
    notices = [...notices, { id: ++nextId, message, tone, resolve }]; notify();
  });
};
function FeedbackNotice({ notice }: { notice: Notice }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const remaining = useRef(8000);
  const started = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);
  function pause() { clearTimeout(timer.current); if (started.current) remaining.current = Math.max(0, remaining.current - (Date.now() - started.current)); started.current = 0; }
  function resume() {
    if (notice.tone === 'error' || hovered.current || focused.current || document.hidden) return;
    clearTimeout(timer.current); started.current = Date.now();
    timer.current = setTimeout(() => dismiss(notice.id), remaining.current);
  }
  useEffect(() => {
    resume();
    const visibility = () => document.hidden ? pause() : resume();
    document.addEventListener('visibilitychange', visibility);
    return () => { pause(); document.removeEventListener('visibilitychange', visibility); };
  }, [notice.id]); // A notice keeps its remaining reading time across hover/focus.
  return <InlineNotification className={`feedback-notice feedback-notice--${notice.tone}`} kind={notice.tone}
    role={notice.tone === 'error' ? 'alert' : 'status'} lowContrast
    title={t(notice.tone === 'error' ? 'Action needed' : notice.tone === 'success' ? 'Done' : 'Notice')}
    subtitle={t(notice.message)} aria-label={t('Dismiss notification')}
    onCloseButtonClick={() => dismiss(notice.id)}
    onMouseEnter={() => { hovered.current = true; pause(); }} onMouseLeave={() => { hovered.current = false; resume(); }}
    onFocus={() => { focused.current = true; pause(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { focused.current = false; resume(); } }} />;
}
export function AppDialog() {
  const active = useSyncExternalStore(subscribe, snapshot);
  const feedback = useSyncExternalStore(subscribe, noticeSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const region = useRef<HTMLElement>(null);
  const [feedbackHost, setFeedbackHost] = useState<HTMLElement>(document.body);
  useEffect(() => {
    // A body-level popover is still inert while a native modal is open.
    // Keep notifications inside the active modal so dismissal remains usable.
    function syncHost() {
      const focusedModal = document.activeElement?.closest<HTMLDialogElement>('dialog:modal');
      const modals = document.querySelectorAll<HTMLDialogElement>('dialog:modal');
      setFeedbackHost(focusedModal || modals.item(modals.length - 1) || document.body);
    }
    syncHost();
    const observer = new MutationObserver(syncHost);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Keep feedback visible when an action originates inside a native dialog.
    const element = region.current;
    if (!element?.showPopover) return;
    element.hidePopover();
    if (feedback.length) element.showPopover();
  }, [feedback, feedbackHost]);
  useEffect(() => {
    if (active && !dialog.current?.open) dialog.current?.showModal();
    if (!active && dialog.current?.open) dialog.current.close();
  }, [active]);
  function finish(accepted: boolean) {
    dialog.current?.close(); queue.shift()?.resolve(accepted); notify();
  }
  return <>
    {createPortal(<section ref={region} popover="manual" className="feedback-region" aria-label={t('Notifications')}>{feedback.map(notice => <FeedbackNotice key={notice.id} notice={notice} />)}</section>, feedbackHost)}
    <dialog ref={dialog} className="app-dialog" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"
      onCancel={event => { event.preventDefault(); finish(false); }}>
      {active && <><div className="eyebrow">{t('BUDDY')}</div><h2 id="app-dialog-title">{t('Confirm action')}</h2>
        <p id="app-dialog-message">{t(active.message)}</p><div className="app-dialog-actions">
          <Button type="button" kind="secondary" size="md" autoFocus onClick={() => finish(false)}>{t('Cancel')}</Button>
          <Button type="button" kind="primary" size="md" className="app-dialog-primary" onClick={() => finish(true)}>{t('Confirm')}</Button>
        </div></>}
    </dialog>
  </>;
}
