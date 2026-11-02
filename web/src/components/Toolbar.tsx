import { createElement, forwardRef, type HTMLAttributes } from 'react';

type ToolbarTag = 'div' | 'header' | 'nav' | 'section';
type ToolbarProps = HTMLAttributes<HTMLElement> & {
  as?: ToolbarTag;
  embedded?: boolean;
  menu?: boolean;
};

function toolbarClasses(className = '', embedded = false, menu = false): string {
  return `buddy-toolbar${embedded ? ' buddy-toolbar-embedded' : ''}${menu ? ' buddy-toolbar-menu' : ''}${className ? ` ${className}` : ''}`;
}

/** Shared Data Grid chrome. Keep each caller's semantics and control handlers. */
export const Toolbar = forwardRef<HTMLElement, ToolbarProps>(function Toolbar(
  { as = 'div', embedded = false, menu = false, className, children, ...props }, ref,
) {
  return createElement(as, { ...props, ref, className: toolbarClasses(className, embedded, menu) }, children);
});

/** Same toolbar for imperative Markdown/chart renderers; no nested React roots. */
export function createToolbarElement(className: string, as: ToolbarTag = 'div'): HTMLElement {
  const element = document.createElement(as);
  element.className = toolbarClasses(className);
  return element;
}
