/** Let editable controls receive typing without invoking a deck's global shortcuts. */
export function protectPresentationTyping(win: Window) {
  const guard = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    if (target?.nodeType !== 1) return;
    if (target.closest('input, textarea, select, button') || (target as HTMLElement).isContentEditable) {
      // Keep the browser's default text insertion and caret movement.
      event.stopImmediatePropagation();
    }
  };
  win.addEventListener('keydown', guard, true);
  return () => win.removeEventListener('keydown', guard, true);
}

/** Only slide contents can be removed through the object editor. */
export function removablePresentationElement(element: Element | null): boolean {
  return !!element && !!element.closest('.slide, [data-slide]') && !element.matches('.slide, [data-slide]')
    && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName);
}
