import { brandText } from './brand';
import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { OfficeBridge, OfficeContext, OfficePlan } from './officeBridge';

function documentIn(host: HTMLElement | null): Document | null {
  try { return host?.querySelector('iframe')?.contentDocument || null; } catch { return null; }
}
function textNodes(doc: Document): Text[] {
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, 4);
  let next: Node | null;
  while ((next = walker.nextNode())) {
    const element = next.parentElement;
    if (!element || element.closest('script,style,head,nav,button,form,[role="toolbar"],[id^="bob-"]')) continue;
    if (!(next.textContent || '').trim()) continue;
    nodes.push(next as Text);
  }
  return nodes;
}
export function useOfficeHtmlBridge(host: RefObject<HTMLDivElement | null>, fileId: string, readOnly = false): OfficeBridge {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const timer = window.setInterval(() => setReady(!!documentIn(host.current)?.body), 250);
    return () => window.clearInterval(timer);
  }, [host, fileId]);
  const context = useCallback(async (): Promise<OfficeContext> => {
    const doc = documentIn(host.current);
    if (!doc?.body) throw new Error('The presentation is still opening.');
    const nodes = textNodes(doc);
    const html_nodes: Array<{index: number; text: string; tag: string}> = [];
    let budget = 30000;
    for (let offset = 0; offset < Math.min(nodes.length, 2000) && html_nodes.length < 200; offset++) {
      const text = nodes[offset].textContent || '';
      if (text.length > 4000 || text.length > budget) continue;
      html_nodes.push({ index: offset + 1, text, tag: nodes[offset].parentElement?.tagName.toLowerCase() || 'span' });
      budget -= text.length;
    }
    const fullText = nodes.map(node => node.textContent).join('\n');
    return { kind: 'html', text: fullText.slice(0, 30000), truncated: fullText.length > 30000 || html_nodes.length < nodes.length,
      selection: (doc.getSelection()?.toString() || '').slice(0, 12000), html_nodes,
      html_fingerprint: doc.documentElement.outerHTML };
  }, [host]);
  const apply = useCallback(async (plan: OfficePlan, expected: OfficeContext) => {
    if (readOnly) throw new Error('This presentation is read only.');
    const doc = documentIn(host.current);
    if (!doc?.body || plan.kind !== 'html' || !Array.isArray(plan.actions)) throw new Error('Invalid HTML edit plan.');
    if (expected.html_fingerprint !== doc.documentElement.outerHTML) throw new Error(brandText('The presentation changed. Ask Buddy to prepare the edits again.'));
    const nodes = textNodes(doc);
    const editable = new Map((Array.isArray(expected.html_nodes) ? expected.html_nodes : []).map((node: {index: number; text: string}) => [node.index, node.text]));
    const edits: Array<{ node: Text; text: string }> = [];
    const used = new Set<number>();
    for (const action of plan.actions) {
      const index = action.index;
      if (action.type !== 'html_update_text' || typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > 2000 || index > nodes.length || used.has(index)
          || typeof action.text !== 'string' || action.text.length > 4000 || typeof action.old_text !== 'string'
          || !editable.has(index) || editable.get(index) !== action.old_text || nodes[index - 1].textContent !== action.old_text) {
        throw new Error(brandText('The HTML edit could not be applied safely. Ask Buddy to prepare it again.'));
      }
      used.add(index); edits.push({ node: nodes[index - 1], text: action.text });
    }
    for (const edit of edits) edit.node.textContent = edit.text;
    if (edits.length) doc.dispatchEvent(new Event('buddy-html-edited'));
    return { ok: true, applied: edits.length };
  }, [host, readOnly]);
  return { ready, context, apply };
}
