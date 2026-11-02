import { Toolbar } from './Toolbar';
import { useEffect, useRef } from 'react';
import { t, useLanguage } from '../lib/i18n';
import './WorkspaceIntegration.css';
export type DocmostConfiguration = { enabled: boolean; url?: string; embed?: boolean };
export function DocmostPanel({ config, onClose }: { config: DocmostConfiguration; onClose: () => void }) {
  useLanguage();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  if (!config.enabled || !config.url) return null;
  return <div className="feature-overlay"><button type="button" className="agent-edit-backdrop" aria-label={t("Close")} onClick={onClose} /><section ref={dialog} className="docmost-panel agent-edit-dialog" role="dialog" aria-modal="true" aria-label="Docmost" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button,a[href],iframe') ?? []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><Toolbar as="header"><div><h2>Docmost</h2><p>{t('Your team knowledge base')}</p></div><a href={config.url} target="_blank" rel="noopener noreferrer">{t('Open in new tab')}</a><button type="button" onClick={onClose}>{t('Close')}</button></Toolbar>
    <p className="docmost-login-note">{t('Sign in with your Docmost account. If the embedded view is blocked, open it in a new tab.')}</p>
    {config.embed ? <iframe title={t('Docmost knowledge base')} src={config.url} referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" /> : <div className="docmost-external"><p>{t('Open your team knowledge base in Docmost.')}</p><a className="feature-primary" href={config.url} target="_blank" rel="noopener noreferrer">{t('Open Docmost')}</a></div>}
  </section></div>;
}
