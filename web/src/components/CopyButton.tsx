import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { AnswerActionLabel } from './AnswerActionLabel';

export function CopyButton({ text, label = 'Copy', className = '', title, compact = false }: { text: string; label?: string; className?: string; title?: string; compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const mounted = useRef(true);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(reset.current); }; }, []);
  const copy = async () => {
    clearTimeout(reset.current); setState('copying');
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setState('copied');
      reset.current = setTimeout(() => setState('idle'), 2200);
    } catch { if (mounted.current) setState('error'); }
  };
  return <><button type="button" className={className} title={title} data-copy-state={state} disabled={state === 'copying'} onClick={event => { event.stopPropagation(); void copy(); }} aria-live="polite">
    {compact ? <AnswerActionLabel icon={state === 'copied' ? 'check' : 'copy'} label={t(state === 'copied' ? 'Copied' : label)} /> : state === 'copied' ? `✓ ${t('Copied')}` : t(label)}
  </button>{state === 'error' && <span className="copy-error" role="alert">{t('Could not copy. Please try again.')}</span>}</>;
}
