import { useEffect, useRef } from 'react';
import type { ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { LearningAssistant } from './LearningAssistant';
import { animateInterface, uiMotion } from '../lib/motion';

type Props = ComponentProps<typeof LearningAssistant> & { open: boolean; onOpenChange: (open: boolean) => void };

export function FloatingLearningAssistant({ open, onOpenChange, ...props }: Props) {
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !panel.current) return;
    const animation = animateInterface(panel.current, [
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: uiMotion.enter, easing: uiMotion.entrance });
    panel.current.querySelector('textarea')?.focus({ preventScroll: true });
    return () => animation.cancel();
  }, [open]);
  const minimize = () => { onOpenChange(false); launcher.current?.focus({ preventScroll: true }); };
  return createPortal(<div className="learning-floating-chat">
    <div ref={panel} id="learning-coach-chat" className="learning-floating-chat-panel" role="region" aria-label="Learning Coach chat" hidden={!open} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); minimize(); }
    }}>
      <LearningAssistant {...props} title="Learning Coach" onClose={minimize} />
    </div>
    <button ref={launcher} type="button" className="learning-floating-chat-launcher" aria-label={open ? 'Minimize Learning Coach chat' : 'Open Learning Coach chat'} aria-expanded={open} aria-controls="learning-coach-chat" onClick={() => open ? minimize() : onOpenChange(true)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z" /><path d="M8 8h8M8 12h5" /></svg>
      <span>Ask Coach</span>
    </button>
  </div>, document.body);
}
