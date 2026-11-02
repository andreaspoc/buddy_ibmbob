import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Measure the actual note area, including sidebar/panel resizing and CSS zoom.
 * Recalculate when cards are added, saved, filtered or removed as well. */
export function NoteGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<number>();
  const count = Children.count(children);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = (width: number) => {
      if (width <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      setColumns(Math.max(1, Math.min(count, Math.floor((width + gap) / (280 + gap)))));
    };
    measure(element.clientWidth);
    const observer = new ResizeObserver(entries => measure(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  const list = className.split(/\s+/).includes('notes-list-view');
  return <div ref={grid} className={`sticky-notes-grid adaptive-note-grid ${className}`} style={columns ? { gridTemplateColumns: `repeat(${list ? 1 : columns}, minmax(0, 1fr))` } : undefined}>{children}</div>;
}
