import { Checkmark, Copy, CurrencyDollar, Flag, Fork, Information, Notebook, PresentationFile, Share, TrashCan, VolumeUp } from '@carbon/icons-react';
import './AnswerActions.css';
import { useEffect, useRef, useState } from 'react';

const icons = { copy: Copy, check: Checkmark, delete: TrashCan, share: Share, notes: Notebook, branch: Fork, read: VolumeUp, report: Flag, deck: PresentationFile, details: Information, usage: CurrencyDollar };
export type AnswerActionIcon = keyof typeof icons;

/** The button keeps a full accessible name while its visual label appears
 * on hover/focus. Real Carbon icons replace emoji and repeated text buttons. */
export function AnswerActionLabel({ icon, label }: { icon: AnswerActionIcon; label: string }) {
  const Icon = icons[icon];
  const tooltip = useRef<HTMLSpanElement>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const trigger = tooltip.current?.parentElement;
    if (!trigger) return;
    const reset = () => setDismissed(false);
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setDismissed(true); };
    trigger.addEventListener('pointerenter', reset);
    trigger.addEventListener('focus', reset);
    document.addEventListener('keydown', dismiss);
    return () => { trigger.removeEventListener('pointerenter', reset); trigger.removeEventListener('focus', reset); document.removeEventListener('keydown', dismiss); };
  }, []);
  return <><Icon size={16} aria-hidden="true" /><span className="sr-only">{label}</span><span ref={tooltip} className="answer-action-tooltip" data-dismissed={dismissed || undefined} aria-hidden="true">{label}</span></>;
}
