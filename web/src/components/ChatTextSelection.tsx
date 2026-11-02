import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../lib/i18n';

interface SelectionAction { text: string; rect: DOMRect; }

export function ChatTextSelection({ containerRef, sessionId, onQuote }: {
  containerRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  onQuote: (text: string) => void;
}) {
  const [selection, setSelection] = useState<SelectionAction | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let dragging = false;
    setSelection(null);
    const update = () => {
      const selected = window.getSelection();
      const container = containerRef.current;
      if (!selected || selected.isCollapsed || !selected.rangeCount || !container || !container.getClientRects().length) {
        setSelection(null); return;
      }
      const range = selected.getRangeAt(0);
      const selectable = (node: Node) => {
        const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        return element?.closest('.message .markdown-body, .message.user .bubble p');
      };
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)
        || !selectable(range.startContainer) || !selectable(range.endContainer)) {
        setSelection(null); return;
      }
      const text = selected.toString();
      const visible = (container.closest('.conversation') || container).getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.bottom > Math.max(0, visible.top) && rect.top < Math.min(window.innerHeight, visible.bottom));
      const rect = selected.anchorNode === range.startContainer && selected.anchorOffset === range.startOffset
        ? rects.at(-1) : rects[0];
      setSelection(text.trim() && rect ? { text, rect } : null);
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!dragging) timer = setTimeout(update, 80);
    };
    const down = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      dragging = true; setSelection(null);
    };
    const up = () => { dragging = false; schedule(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { clearTimeout(timer); setSelection(null); }
      else schedule();
    };
    const reposition = () => { setSelection(null); schedule(); };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('keyup', key);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('keyup', key);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [containerRef, sessionId]);

  useLayoutEffect(() => {
    if (!selection || !buttonRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const { rect } = selection;
    const below = rect.bottom + 8;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - button.width - 8)),
      top: Math.max(8, Math.min(below + button.height <= window.innerHeight - 8 ? below : rect.top - button.height - 8, window.innerHeight - button.height - 8)),
    });
  }, [selection]);

  if (!selection) return null;
  return createPortal(<button ref={buttonRef} type="button" className="chat-selection-action"
    style={position} onPointerDown={event => event.preventDefault()}
    onClick={() => { onQuote(selection.text); setSelection(null); window.getSelection()?.removeAllRanges(); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 4a8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.4Z" /></svg>
    {t('Ask about this')}
  </button>, document.body);
}
