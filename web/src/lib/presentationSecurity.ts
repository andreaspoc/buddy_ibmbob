import DOMPurify from 'dompurify';

/** The editable document is accessible to the app, so it must never run supplied code. */
export function sanitizeEditablePresentation(html: string): string {
  const source = new DOMParser().parseFromString(html, 'text/html');
  source.querySelectorAll('[data-bob-preserved-script], [data-bob-preserved-attributes]').forEach(element => {
    element.removeAttribute('data-bob-preserved-script');
    element.removeAttribute('data-bob-preserved-attributes');
  });
  source.querySelectorAll('script').forEach(script => {
    const marker = source.createElement('span');
    marker.hidden = true;
    marker.setAttribute('data-bob-preserved-script', JSON.stringify(script.outerHTML));
    script.replaceWith(marker);
  });
  source.querySelectorAll('*').forEach(element => {
    const attributes = Array.from(element.attributes)
      .filter(attribute => /^on/i.test(attribute.name) || attribute.name === 'href')
      .map(attribute => [attribute.name, attribute.value]);
    if (attributes.length) element.setAttribute('data-bob-preserved-attributes', JSON.stringify(attributes));
  });
  const clean = DOMPurify.sanitize(source.documentElement.outerHTML, { // NOSONAR: WHOLE_DOCUMENT and style tag are required to sanitize a full HTML presentation document
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'form'],
    FORBID_ATTR: ['srcdoc', 'autofocus', 'formaction', 'action'],
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  // Disable links as well: navigation must not replace the editable sandbox document.
  doc.querySelectorAll('[href], [xlink\\:href]').forEach(element => {
    if (element.tagName.toLowerCase() !== 'link') {
      element.removeAttribute('href');
      element.removeAttribute('xlink:href');
    }
  });
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  doc.head.prepend(policy);
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

export const EDITABLE_PRESENTATION_SANDBOX = 'allow-same-origin';
// Opaque origin: presentation scripts have no app DOM, cookies, or local storage access.
export const LIVE_PRESENTATION_SANDBOX = 'allow-scripts';

/** Embed a presentation blob in an opaque-origin frame when opening a new tab. */
export function sandboxedPresentationPage(blobUrl: string): string {
  const src = blobUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Presentation</title>' +
    '<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style></head><body>' +
    `<iframe title="Presentation" sandbox="${LIVE_PRESENTATION_SANDBOX}" src="${src}"></iframe></body></html>`;
}

/** Only serialize restored code; never insert this output into an app-origin document. */
export function restorePresentationSource(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(element => element.remove());
  doc.querySelectorAll('[data-bob-preserved-script]').forEach(marker => {
    const source = JSON.parse(marker.getAttribute('data-bob-preserved-script') || '""');
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const script = parsed.querySelector('script');
    if (script) marker.replaceWith(doc.importNode(script, true));
    else marker.remove();
  });
  doc.querySelectorAll('[data-bob-preserved-attributes]').forEach(element => {
    const attributes: [string, string][] = JSON.parse(element.getAttribute('data-bob-preserved-attributes') || '[]');
    for (const [name, value] of attributes) element.setAttribute(name, value);
    element.removeAttribute('data-bob-preserved-attributes');
  });
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/** Accept only bounded PNG bytes. Never accept HTML/SVG or URLs from a live frame. */
export function validPresentationSnapshot(value: unknown): value is { index: number; png: string } {
  if (!value || typeof value !== 'object') return false;
  const item = value as { index?: unknown; png?: unknown };
  if (Object.keys(value).length !== 2 || !(Number.isInteger(item.index) && (item.index as number) >= 0 && (item.index as number) < 20
    && typeof item.png === 'string' && item.png.length < 1_000_000
    && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(item.png))) return false;
  try {
    const header = atob((item.png as string).slice('data:image/png;base64,'.length).slice(0, 44));
    if (header.slice(12, 16) !== 'IHDR') return false;
    const dimension = (offset: number) => ((header.charCodeAt(offset) * 0x1000000) + (header.charCodeAt(offset + 1) << 16) + (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3));
    const width = dimension(16), height = dimension(20);
    return width > 0 && height > 0 && width <= 4096 && height <= 4096;
  } catch { return false; }
}

/** Trusted raster-only bridge runs entirely inside the opaque presentation frame. */
export function livePresentationSource(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const bridge = doc.createElement('script');
  bridge.textContent = `(${function () {
    window.addEventListener('load', () => {
      setTimeout(() => {
        let total = 0;
        const images: { index: number; png: string }[] = [];
        document.querySelectorAll('canvas').forEach((canvas, index) => {
          if (index >= 20 || canvas.width > 4096 || canvas.height > 4096) return;
          try {
            const png = canvas.toDataURL('image/png');
            total += png.length;
            if (png.length < 1_000_000 && total < 4_000_000) images.push({ index, png });
          } catch { /* Cross-origin canvas images remain isolated. */ }
        });
        parent.postMessage({ type: 'buddy-presentation-raster', images }, '*'); // NOSONAR: parent origin is unknown inside injected iframe script, '*' is required
      }, 500);
    }, { once: true });
  }.toString()})();`;
  doc.body.append(bridge);
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
