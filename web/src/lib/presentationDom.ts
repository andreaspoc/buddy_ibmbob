/** Patch a presentation without navigating its frame or replacing unchanged nodes.
 * Self-contained so the same function can run inside the sandboxed live frame. */
export function syncPresentationDocument(doc: Document, html: string) {
  const incoming = new DOMParser().parseFromString(html, 'text/html');
  const win = doc.defaultView;
  const scroll = Array.from(doc.querySelectorAll('*')).filter(el => el.scrollTop || el.scrollLeft)
    .map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }));
  const top = win?.scrollY || 0;
  const left = win?.scrollX || 0;
  const scripts: HTMLScriptElement[] = [];
  function patch(current: Node, next: Node) {
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      const replacement = doc.importNode(next, true);
      current.parentNode?.replaceChild(replacement, current);
      collect(replacement);
      return;
    }
    if (current.nodeType === 3 || current.nodeType === 8) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (current.nodeType !== 1 || next.nodeType !== 1) return;
    const currentElement = current as Element;
    const nextElement = next as Element;
    // Existing scripts and canvas instances belong to the running document.
    if (currentElement.tagName === 'SCRIPT') return;
    for (const attr of Array.from(currentElement.attributes)) {
      if (!nextElement.hasAttribute(attr.name) && !(currentElement.tagName === 'CANVAS' && ['width', 'height', 'style'].includes(attr.name))) currentElement.removeAttribute(attr.name);
    }
    for (const attr of Array.from(nextElement.attributes)) {
      if (currentElement.getAttribute(attr.name) !== attr.value) currentElement.setAttribute(attr.name, attr.value);
    }
    if (currentElement.tagName !== 'CANVAS') children(currentElement, nextElement);
  }
  function collect(node: Node) {
    if (node.nodeType === 1 && (node as Element).tagName === 'SCRIPT') scripts.push(node as HTMLScriptElement);
    if (node.nodeType === 1) scripts.push(...Array.from((node as Element).querySelectorAll<HTMLScriptElement>('script')));
  }
  function children(current: Element, next: Element) {
    let cursor: ChildNode | null = current.firstChild;
    const kept = new Set<Node>();
    for (const child of Array.from(next.childNodes)) {
      const id = child.nodeType === 1 ? (child as Element).id : '';
      const script = child.nodeName === 'SCRIPT';
      const match = script ? Array.from(current.children).find(el => el.tagName === 'SCRIPT' && el.getAttribute('src') === (child as Element).getAttribute('src') && el.textContent === child.textContent) : id ? Array.from(current.children).find(el => el.id === id && el.tagName === (child as Element).tagName) : cursor;
      if (match && !kept.has(match) && match.nodeType === child.nodeType && match.nodeName === child.nodeName) {
        if (match !== cursor) current.insertBefore(match, cursor);
        patch(match, child);
        kept.add(match);
        cursor = match.nextSibling;
      } else {
        const added = doc.importNode(child, true);
        current.insertBefore(added, cursor);
        collect(added);
        kept.add(added);
      }
    }
    for (const child of Array.from(current.childNodes)) {
      const runtimeHelper = child.nodeType === 1 && ['bob-nav-fix-style', 'bob-autofit-script', 'bob-object-edit-style', 'bob-deck-edit-style', 'bob-floating-toolbar'].includes((child as Element).id);
      if (!kept.has(child) && !runtimeHelper) child.remove();
    }
  }
  patch(doc.documentElement, incoming.documentElement);
  // Execute newly introduced scripts once. Unchanged scripts are never restarted.
  const runtime = doc as Document & { bobScriptQueue?: Promise<void> };
  for (const inert of scripts) {
    runtime.bobScriptQueue = (runtime.bobScriptQueue || Promise.resolve()).then(() => new Promise<void>(resolve => {
      if (!inert.isConnected) { resolve(); return; }
      const executable = doc.createElement('script');
      for (const attr of Array.from(inert.attributes)) executable.setAttribute(attr.name, attr.value);
      executable.textContent = inert.textContent;
      if (executable.src) {
        executable.async = false;
        executable.onload = () => resolve();
        executable.onerror = () => resolve();
      }
      inert.replaceWith(executable);
      if (!executable.src) resolve();
    }));
  }
  for (const entry of scroll) if (entry.el.isConnected) {entry.el.scrollTop = entry.top; entry.el.scrollLeft = entry.left;}
  if (win && (win.scrollX !== left || win.scrollY !== top)) win.scrollTo(left, top);
}
