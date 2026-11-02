import { brandText } from './brand';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { OfficeBridge, OfficeContext, OfficePlan } from './officeBridge';
import { repairHtmlForRender } from './htmlRenderRepair';
type Patch = { index: number; old_text: string; text: string };
const START = '<!--bob-office-patches:start-->';
const END = '<!--bob-office-patches:end-->';
function unpack(source: string = ''): { original: string; patches: Patch[] } {
  if (!source) return { original: '', patches: [] };
  const start = source.lastIndexOf(START), end = source.indexOf(END, start);
  if (start < 0 || end < 0) return { original: source, patches: [] };
  const block = source.slice(start, end);
  const data = block.match(/<script type="application\/json" id="bob-office-patches">([\s\S]*?)<\/script>/);
  let patches: Patch[] = [];
  try { const parsed: unknown = JSON.parse(data?.[1] || '[]'); if (Array.isArray(parsed)) patches = parsed.filter(item => item && Number.isInteger(item.index) && item.index > 0 && item.index <= 2000 && typeof item.old_text === 'string' && typeof item.text === 'string' && item.old_text.length <= 4000 && item.text.length <= 4000).slice(0, 2000); } catch { /* Invalid metadata is inert. */ }
  return { original: source.slice(0, start) + source.slice(end + END.length), patches };
}
function editableNodes(doc: Document): Text[] {
  const nodes: Text[] = [];
  if (!doc.body) return nodes;
  const walker = doc.createTreeWalker(doc.body, 4); let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement && !node.parentElement.closest('script,style,head,nav,button,form,[role="toolbar"],[id^="bob-"]') && (node.textContent || '').trim()) nodes.push(node as Text);
  }
  return nodes;
}
// Self-contained functions below run in an opaque-origin iframe.
function replay(patches: Patch[], nodesFor: typeof editableNodes) {
  const apply = () => {
    const nodes = nodesFor(document);
    for (const patch of patches) {
      const direct = nodes[patch.index - 1];
      if (direct?.textContent === patch.text) continue;
      const matches = nodes.filter(node => node.textContent === patch.old_text);
      const target = direct?.textContent === patch.old_text ? direct : matches.length === 1 ? matches[0] : null;
      if (target && target.textContent !== patch.text) target.textContent = patch.text;
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('load', apply);
}
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function savedSource(original: string, patches: Patch[]): string {
  if (!patches.length) return original;
  return original + START + '<script type="application/json" id="bob-office-patches">' + json(patches) + '</script><script>(' + replay.toString() + ')(' + json(patches) + ',' + editableNodes.toString() + ');</script>' + END;
}
function runtime(channel: string, initial: Patch[], nodesFor: typeof editableNodes, replayEdits: typeof replay) {
  const patches = initial.map(item => ({ ...item }));
  replayEdits(patches, nodesFor);
  const send = (type: string, value?: unknown, id?: string, error?: string) => parent.postMessage({ bridge: 'bob-html-runtime', channel, type, value, id, error }, '*'); // NOSONAR: parent origin is unknown inside injected iframe script, '*' is required
  const snapshot = () => {
    const nodes = nodesFor(document); let budget = 30000;
    const html_nodes: Array<{index: number; text: string; tag: string}> = [];
    for (let i = 0; i < Math.min(nodes.length, 2000) && html_nodes.length < 200; i++) {
      const text = nodes[i].textContent || '';
      if (text.length > 4000 || text.length > budget) continue;
      html_nodes.push({ index: i + 1, text, tag: nodes[i].parentElement?.tagName.toLowerCase() || 'span' }); budget -= text.length;
    }
    const fullText = nodes.map(node => node.textContent).join('\n');
    return { kind: 'html', text: fullText.slice(0, 30000), truncated: fullText.length > 30000 || html_nodes.length < nodes.length, selection: (document.getSelection()?.toString() || '').slice(0, 12000), html_nodes, html_fingerprint: document.documentElement.outerHTML };
  };
  const record = (index: number, before: string, text: string) => {
    const existing = patches.find(patch => patch.index === index && patch.text === before);
    if (!existing && patches.length >= 2000) throw new Error('This presentation has reached its text edit limit.');
    if (existing) existing.text = text; else patches.push({ index, old_text: before, text });
  };
  let editing = false;
  const originals = new Map<Element, {index: number; text: string}>();
  document.addEventListener('input', () => {
    if (!editing) return;
    for (const [node, before] of originals) {
      const text = node.textContent || '';
      if (text !== before.text) {
        try {
          if (text.length > 4000) throw new Error('Text edits must be 4000 characters or fewer.');
          record(before.index, before.text, text); before.text = text;
        } catch (reason) { node.textContent = before.text; send('warning', reason instanceof Error ? reason.message : String(reason)); }
      }
    }
    send('changed');
  });
  window.addEventListener('message', event => { // NOSONAR: source is verified against parent on the next line
    const data = event.data;
    if (event.source !== parent || data?.bridge !== 'bob-html-runtime' || data.channel !== channel || typeof data.id !== 'string') return;
    try {
      let result: unknown;
      if (data.command === 'hello') result = true;
      else if (data.command === 'context') result = snapshot();
      else if (data.command === 'source') result = patches;
      else if (data.command === 'editing') {
        editing = data.value === true;
        const nodes = nodesFor(document);
        for (let i = 0; i < Math.min(nodes.length, 2000); i++) {
          const node = nodes[i], element = node.parentElement;
          if (!element || element.childNodes.length !== 1 || element.firstChild !== node || (node.textContent || '').length > 4000) continue;
          if (editing) { originals.set(element, { index: i + 1, text: node.textContent || '' }); element.setAttribute('contenteditable', 'plaintext-only'); }
          else element.removeAttribute('contenteditable');
        }
        if (!editing) originals.clear();
        result = true;
      } else if (data.command === 'apply') {
        const { plan, expectedContext } = data.value;
        if (plan?.kind !== 'html' || !Array.isArray(plan.actions) || expectedContext?.html_fingerprint !== document.documentElement.outerHTML) throw new Error(brandText('The presentation changed. Ask Buddy to prepare edits again.'));
        const nodes = nodesFor(document), used = new Set<number>();
        const edits: Array<{ node: Text; index: number; before: string; text: string }> = [];
        for (const action of plan.actions) {
          const i = action.index, expected = expectedContext.html_nodes?.find((node: {index: number}) => node.index === i);
          if (action.type !== 'html_update_text' || !Number.isInteger(i) || i < 1 || i > 2000 || used.has(i) || typeof action.text !== 'string' || action.text.length > 4000 || !expected || expected.text !== action.old_text || nodes[i - 1]?.textContent !== action.old_text) throw new Error('The HTML edit could not be applied safely.');
          used.add(i); edits.push({ node: nodes[i - 1], index: i, before: action.old_text, text: action.text });
        }
        const newPatches = edits.filter(edit => !patches.some(patch => patch.index === edit.index && patch.text === edit.before)).length;
        if (patches.length + newPatches > 2000) throw new Error('This presentation has reached its text edit limit.');
        for (const edit of edits) {
          record(edit.index, edit.before, edit.text); edit.node.textContent = edit.text;
          const tracked = edit.node.parentElement && originals.get(edit.node.parentElement);
          if (tracked) tracked.text = edit.text;
        }
        if (edits.length) send('changed'); result = { ok: true, applied: edits.length };
      } else throw new Error('Unknown presentation command');
      send('result', result, data.id);
    } catch (reason) { send('result', undefined, data.id, reason instanceof Error ? reason.message : String(reason)); }
  });
  window.addEventListener('error', event => {
    const target = event.target;
    const message = target && target !== window ? 'A presentation resource could not load.' : (event.message || 'A presentation script failed.');
    send('warning', message.slice(0, 300));
  }, true);
  window.addEventListener('unhandledrejection', event => send('warning', String(event.reason instanceof Error ? event.reason.message : event.reason || 'A presentation script failed.').slice(0, 300)));
  const ready = () => send('ready');
  if (document.readyState !== 'loading') ready(); else document.addEventListener('DOMContentLoaded', ready, { once: true });
  window.addEventListener('load', ready);
}
export function buildOfficeHtmlRuntime(source: string, channel: string): string {
  const { original: saved, patches } = unpack(source);
  const original = repairHtmlForRender(saved);
  const script = '<script id="bob-office-runtime">(' + runtime.toString() + ')(' + json(channel) + ',' + json(patches) + ',' + editableNodes.toString() + ',' + replay.toString() + ');</script>';
  const head = original.match(/<head(?:\s[^>]*)?>/i);
  if (head?.index !== undefined) return original.slice(0, head.index + head[0].length) + script + original.slice(head.index + head[0].length);
  const html = original.match(/<html(?:\s[^>]*)?>/i);
  const pos = html?.index !== undefined ? html.index + html[0].length : (original.match(/^\s*<!doctype[^>]*>/i)?.[0].length || 0);
  return original.slice(0, pos) + script + original.slice(pos);
}
export function useOfficeHtmlRuntime(frame: RefObject<HTMLIFrameElement | null>, fileId: string, source: string, onChanged?: () => void): OfficeBridge & { runtimeSource: string; runtimeError: string; saveSource(): Promise<string>; setEditing(value: boolean): Promise<void> } {
  const channel = useMemo(() => crypto.randomUUID(), [fileId, source]);
  const runtimeSource = useMemo(() => buildOfficeHtmlRuntime(source, channel), [source, channel]);
  const [ready, setReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const pending = useRef(new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>());
  const changed = useRef(onChanged); changed.current = onChanged;
  useEffect(() => {
    setReady(false); setRuntimeError('');
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || data?.bridge !== 'bob-html-runtime' || data.channel !== channel) return;
      if (data.type === 'warning') { setRuntimeError(String(data.value || 'A presentation script failed.').slice(0, 300)); return; }
      if (data.type === 'ready') { setReady(true); return; }
      if (data.type === 'changed') { changed.current?.(); return; }
      if (data.type !== 'result') return;
      if (data.id === 'hello') { setReady(true); return; }
      const entry = pending.current.get(data.id); if (!entry) return;
      pending.current.delete(data.id); window.clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(String(data.error))); else entry.resolve(data.value);
    };
    window.addEventListener('message', receive); // NOSONAR: source window is verified above
    const hello = window.setInterval(() => frame.current?.contentWindow?.postMessage({ bridge: 'bob-html-runtime', channel, id: 'hello', command: 'hello' }, '*'), 1000); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
    return () => { window.clearInterval(hello); cleanup(); };
    function cleanup() { window.removeEventListener('message', receive); for (const item of pending.current.values()) { window.clearTimeout(item.timer); item.reject(new Error('The presentation changed. Please retry.')); } pending.current.clear(); };
  }, [frame, channel]);
  const call = useCallback(<T,>(command: string, value?: unknown): Promise<T> => {
    if (!frame.current?.contentWindow) return Promise.reject(new Error('The presentation is still opening.'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => { pending.current.delete(id); reject(new Error('The presentation did not respond. Please retry.')); }, 15000);
      pending.current.set(id, { resolve: value => resolve(value as T), reject, timer });
      frame.current!.contentWindow!.postMessage({ bridge: 'bob-html-runtime', channel, id, command, value }, '*'); // NOSONAR: srcDoc iframe has opaque origin, '*' is required
    });
  }, [frame, channel]);
  return { ready, runtimeSource, runtimeError, context: useCallback(() => call<OfficeContext>('context'), [call]),
    apply: useCallback((plan: OfficePlan, expectedContext: OfficeContext) => call('apply', { plan, expectedContext }), [call]),
    saveSource: useCallback(async () => savedSource(unpack(source).original, await call<Patch[]>('source')), [source, call]),
    setEditing: useCallback(async value => { await call('editing', value); }, [call]) };
}
