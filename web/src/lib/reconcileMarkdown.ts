/** Patch ordinary Markdown in place so growing lists keep their DOM and layout. */
export function reconcileMarkdownNode(current: Node, next: Node): Node {
  if (current.isEqualNode(next)) return current;
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
    current.parentNode?.replaceChild(next, current);
    return next;
  }
  if (current instanceof Element && next instanceof Element) {
    if (current.matches('.intelligent-answer-host') && next.matches('.intelligent-answer-host') &&
        current.getAttribute('data-intelligent-answer') === next.getAttribute('data-intelligent-answer')) return current;
    // React owns diagram descendants; Markdown only owns the stable host.
    if (current.matches('.structured-diagram-host') && next.matches('.structured-diagram-host') &&
        current.getAttribute('data-structured-diagram') === next.getAttribute('data-structured-diagram')) return current;
    // If both nodes are interactive-chart-card with the same spec, preserve mounted widget
    if (current.matches('.interactive-chart-card') && next.matches('.interactive-chart-card')) {
      const curSpec = current.getAttribute('data-chart-spec');
      const nextSpec = next.getAttribute('data-chart-spec');
      if (curSpec && curSpec === nextSpec) {
        return current;
      }
    }
    // If both nodes are mermaid-panel with same source, preserve mounted widget
    if (current.matches('.mermaid-panel') && next.matches('.mermaid-panel')) {
      const curSrc = current.getAttribute('data-mermaid-source');
      const nextSrc = next.getAttribute('data-mermaid-source');
      if (curSrc && curSrc === nextSrc &&
          current.getAttribute('data-mermaid-session') === next.getAttribute('data-mermaid-session')) {
        return current;
      }
    }
    // If both nodes are code-subwindow with same content, preserve mounted widget
    if (current.matches('.code-subwindow') && next.matches('.code-subwindow')) {
      if (current.textContent === next.textContent) {
        return current;
      }
    }

    // Widgets own listeners and state. Adopt the fresh widget when its source
    // changes rather than patching text underneath stale event handlers.
    const widgets = '.code-subwindow, .mermaid-panel, .interactive-chart-card, .interactive-table-panel';
    if (current.matches(widgets) || next.matches(widgets) ||
        current.querySelector(widgets) || next.querySelector(widgets)) {
      current.parentNode?.replaceChild(next, current);
      return next;
    }
    for (const attribute of Array.from(current.attributes)) {
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) {
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    const children = Array.from(next.childNodes);
    children.forEach((child, index) => {
      const existing = current.childNodes[index];
      if (existing) reconcileMarkdownNode(existing, child);
      else current.appendChild(child);
    });
    while (current.childNodes.length > children.length) current.lastChild?.remove();
  } else {
    current.nodeValue = next.nodeValue;
  }
  return current;
}
