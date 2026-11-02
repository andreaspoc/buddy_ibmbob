import React, { useEffect, useRef } from 'react';
import { t, useLanguage } from '../lib/i18n';
import type { User } from '../types';
import './DecisionsWorkspace.css';

export interface DecisionsWorkspaceProps { user?: User | null; onBack: () => void }

export const DecisionsWorkspace: React.FC<DecisionsWorkspaceProps> = ({ onBack }) => {
  useLanguage();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'DECISIONS_CLOSE' || event.data?.type === 'DECISIONS_BACK') onBack();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onBack]);

  const scale = typeof window !== 'undefined'
    ? Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 0.85
    : 0.85;

  useEffect(() => {
    const target = frame.current;
    if (!target) return;
    const sendTheme = () => {
      const root = getComputedStyle(document.documentElement);
      const sidebar = document.querySelector('.shell .sidebar');
      const nav = sidebar ? getComputedStyle(sidebar) : root;
      // Application chrome only; preserve Carbon's tag/status/chart colors.
      const names = ['--workspace-canvas', '--toolbar-background', '--toolbar-border',
        '--toolbar-text', '--toolbar-control', '--toolbar-hover', '--toolbar-selected',
        '--buddy-sidebar-background', '--sidebar-card-background', '--sidebar-border',
        '--sidebar-text', '--sidebar-secondary'];
      const colors = Object.fromEntries(names.map(name => [name,
        (name.startsWith('--sidebar-') ? nav : root).getPropertyValue(name).trim()
      ]).filter(([, value]) => value && CSS.supports('color', value)));
      target.contentWindow?.postMessage({ type: 'BUDDY_CHROME_THEME', colors }, window.location.origin);
    };
    const sendScale = () => {
      const currentScale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 0.85;
      target.contentWindow?.postMessage({ type: 'SET_UI_SCALE', scale: currentScale }, window.location.origin);
      sendTheme();
    };
    target.addEventListener('load', sendScale);
    const ready = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === target.contentWindow
          && event.data?.type === 'BUDDY_CHROME_READY') sendTheme();
    };
    window.addEventListener('message', ready);
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ui-theme'] });
    window.addEventListener('resize', sendScale);
    return () => {
      observer.disconnect();
      window.removeEventListener('message', ready);
      target.removeEventListener('load', sendScale);
      window.removeEventListener('resize', sendScale);
    };
  }, []);

  return <section className="decisions-workspace buddy-surface" role="region" aria-label={t('Decisions')}>
    <div className="decisions-workspace-body"><iframe ref={frame} title={t('DecisionsBuddy Workspace')} src={`/decisions/?scale=${scale}`} className="decisions-workspace-iframe" /></div>
  </section>;
};
