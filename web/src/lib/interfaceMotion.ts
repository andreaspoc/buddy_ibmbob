import { animateInterface, uiMotion } from './motion';

const panels = 'dialog,.feature-dialog,.create-dialog,.save-office-dialog,.workspace-tools-panel,.office-reference-picker,.thinking-drawer,.shortcuts-modal,[role="dialog"],[role="menu"],.notes-workspace,.tasks-view,.office-suite,.shared-knowledge,.administration-page,.attached-chip,.member-chat-panel,.clarification-card,.intelligent-answer,.interactive-table-panel,.structured-diagram,.mermaid-panel,.quiz-card,.welcome-stage,.projects-workspace';
const views = '.notes-workspace,.tasks-view,.office-suite,.shared-knowledge,.administration-page,.chat-layout-split,.projects-workspace';
const excluded = '[data-motion-ghost],.workspace-transfer-flight,.sticky-note-flight,[data-apps-motion],.markdown-body,[contenteditable],.html-deck-stage,.generated-code-preview';

/** Batch surface entrances; never clone removed views or measure streaming tokens. */
export function startInterfaceMotion() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set<Animation>();
  const seen = new WeakSet<HTMLElement>();
  const pending = new Set<HTMLElement>();
  let frame = 0;
  const settled = () => window.dispatchEvent(new Event('workspace-motion-settled'));
  const enter = () => {
    frame = 0;
    const items = [...pending]; pending.clear();
    // Read layout together before starting compositor animations.
    const visible = items.filter(element => element.isConnected &&
      !items.some(parent => parent !== element && parent.contains(element)) &&
      !element.closest(excluded) && !seen.has(element) && element.getClientRects().length);
    for (const element of visible) {
      seen.add(element);
      if (reduced.matches) continue;
      const animation = animateInterface(element, [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: uiMotion.enter, easing: uiMotion.entrance });
      active.add(animation);
      void animation.finished.catch(() => {}).finally(() => { active.delete(animation); settled(); });
    }
  };
  const enqueue = (element: HTMLElement) => {
    pending.add(element);
    if (!frame) frame = requestAnimationFrame(enter);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest(excluded)) continue;
      if (record.type === 'attributes') {
        if (record.attributeName === 'open' && record.target instanceof HTMLElement && record.target.hasAttribute('open')) {
          seen.delete(record.target); enqueue(record.target);
        } else if (record.attributeName === 'data-active-view') {
          for (const element of document.querySelectorAll<HTMLElement>(views)) { seen.delete(element); enqueue(element); }
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || node.closest(excluded)) continue;
        if (node.matches(panels)) enqueue(node);
        for (const element of node.querySelectorAll<HTMLElement>(panels)) enqueue(element);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-active-view', 'open'] });
  return () => {
    observer.disconnect(); cancelAnimationFrame(frame); pending.clear();
    for (const animation of active) animation.cancel();
    active.clear();
  };
}
