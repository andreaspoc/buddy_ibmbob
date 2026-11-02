// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildOfficeHtmlRuntime, useOfficeHtmlRuntime } from '../../src/lib/officeHtmlRuntime';

/*
 * The in-frame runtime is serialised with Function#toString and only ever runs inside the sandboxed
 * iframe. We capture the real function objects at the moment they are serialised and execute them
 * against the jsdom document, which is the same global surface (document/window/parent) they get in the frame.
 */
type Patch = { index: number; old_text: string; text: string };
const captured: Record<string, any> = {};
beforeAll(() => {
  const originalToString = Function.prototype.toString;
  const spy = vi.spyOn(Function.prototype, 'toString').mockImplementation(function capture(this: any) {
    if (['runtime', 'replay', 'editableNodes'].includes(this.name)) captured[this.name] = this;
    return originalToString.call(this);
  });
  buildOfficeHtmlRuntime('<p>seed</p>', 'seed');
  spy.mockRestore();
});

const cleanups: Array<() => void> = [];
let channelCounter = 0;
let posted: ReturnType<typeof vi.spyOn>;

function trackListeners(target: Window | Document) {
  const add = target.addEventListener.bind(target) as any;
  const remove = target.removeEventListener.bind(target) as any;
  const spy = vi.spyOn(target, 'addEventListener').mockImplementation(((type: string, fn: any, opts: any) => {
    add(type, fn, opts);
    cleanups.push(() => remove(type, fn, opts));
  }) as any);
  cleanups.push(() => spy.mockRestore());
}

function start(html: string, patches: Patch[] = []) {
  document.body.innerHTML = html;
  const channel = `chan-${++channelCounter}`;
  captured.runtime(channel, patches, captured.editableNodes, captured.replay);
  return channel;
}
function send(channel: string, command: string, value?: unknown, id = 'req', source: unknown = window) {
  const event = new Event('message');
  Object.defineProperties(event, {
    data: { value: { bridge: 'bob-html-runtime', channel, command, id, value } },
    source: { value: source },
  });
  window.dispatchEvent(event);
}
const messages = (channel: string, type?: string) => posted.mock.calls
  .map((c: any[]) => c[0])
  .filter((m: any) => m?.bridge === 'bob-html-runtime' && m.channel === channel && (!type || m.type === type));
const lastResult = (channel: string) => messages(channel, 'result').at(-1);
function ask(channel: string, command: string, value?: unknown) {
  send(channel, command, value);
  return lastResult(channel);
}

beforeEach(() => {
  posted = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  trackListeners(window);
  trackListeners(document);
  const RealObserver = window.MutationObserver;
  class TrackedObserver extends RealObserver {
    constructor(cb: MutationCallback) { super(cb); cleanups.push(() => this.disconnect()); }
  }
  vi.stubGlobal('MutationObserver', TrackedObserver);
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('in-frame patch replay', () => {
  it('replays a saved edit by position when the original text is still there', () => {
    start('<p>Alpha</p><p>Beta</p>', [{ index: 2, old_text: 'Beta', text: 'Gamma' }]);
    expect(document.querySelectorAll('p')[1].textContent).toBe('Gamma');
  });
  it('falls back to a unique text match when positions have shifted', () => {
    start('<p>Intro</p><p>Added</p><p>Beta</p>', [{ index: 2, old_text: 'Beta', text: 'Gamma' }]);
    expect(document.querySelectorAll('p')[2].textContent).toBe('Gamma');
    expect(document.querySelectorAll('p')[1].textContent).toBe('Added');
  });
  it('leaves ambiguous matches untouched rather than editing the wrong node', () => {
    start('<p>Other</p><p>Fork</p><p>Same</p><p>Same</p>', [{ index: 2, old_text: 'Same', text: 'Changed' }]);
    expect(Array.from(document.querySelectorAll('p')).map(p => p.textContent)).toEqual(['Other', 'Fork', 'Same', 'Same']);
  });
  it('is idempotent when the patch was already applied', () => {
    start('<p>Done</p>', [{ index: 1, old_text: 'Before', text: 'Done' }]);
    expect(document.querySelector('p')!.textContent).toBe('Done');
  });
  it('re-applies when a deck script re-renders text later', async () => {
    start('<p>Slide</p>', [{ index: 1, old_text: 'Slide', text: 'Patched' }]);
    document.querySelector('p')!.textContent = 'Slide';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('p')!.textContent).toBe('Patched');
  });
  it('re-applies on window load', () => {
    start('<p>Slide</p>', [{ index: 1, old_text: 'Slide', text: 'Patched' }]);
    document.querySelector('p')!.textContent = 'Slide';
    window.dispatchEvent(new Event('load'));
    expect(document.querySelector('p')!.textContent).toBe('Patched');
  });
});

describe('in-frame context command', () => {
  it('reports only editable text, skipping scripts, chrome and bob-owned nodes', () => {
    const ch = start('<h1>Title</h1><nav>Menu</nav><button>Go</button><form><label>F</label></form><div role="toolbar">T</div><div id="bob-x">Hidden</div><style>.a{}</style><p>   </p><p>Body</p>');
    const { value } = ask(ch, 'context');
    expect(value.kind).toBe('html');
    expect(value.html_nodes).toEqual([{ index: 1, text: 'Title', tag: 'h1' }, { index: 2, text: 'Body', tag: 'p' }]);
    expect(value.text).toBe('Title\nBody');
    expect(value.truncated).toBe(false);
    expect(value.html_fingerprint).toBe(document.documentElement.outerHTML);
  });
  it('omits oversized nodes and flags the context as truncated', () => {
    const ch = start(`<p>${'x'.repeat(4001)}</p><p>short</p>`);
    const { value } = ask(ch, 'context');
    expect(value.html_nodes).toEqual([{ index: 2, text: 'short', tag: 'p' }]);
    expect(value.truncated).toBe(true);
  });
  it('enforces the 30k budget across nodes and truncates the full text', () => {
    const para = `<p>${'y'.repeat(4000)}</p>`;
    const ch = start(para.repeat(9));
    const { value } = ask(ch, 'context');
    expect(value.html_nodes).toHaveLength(7);
    expect(value.text).toHaveLength(30000);
    expect(value.truncated).toBe(true);
  });
  it('caps context at 200 nodes', () => {
    const ch = start('<p>n</p>'.repeat(205));
    const { value } = ask(ch, 'context');
    expect(value.html_nodes).toHaveLength(200);
    expect(value.truncated).toBe(true);
  });
  it('includes the current selection', () => {
    const ch = start('<p>Pick me</p>');
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(ask(ch, 'context').value.selection).toBe('Pick me');
    document.getSelection()!.removeAllRanges();
  });
});

describe('in-frame protocol', () => {
  it('answers hello and returns the current patches for source', () => {
    const patches = [{ index: 1, old_text: 'A', text: 'B' }];
    const ch = start('<p>A</p>', patches);
    expect(ask(ch, 'hello').value).toBe(true);
    expect(ask(ch, 'source').value).toEqual(patches);
  });
  it('reports unknown commands as an error result', () => {
    const ch = start('<p>A</p>');
    expect(ask(ch, 'explode').error).toBe('Unknown presentation command');
  });
  it.each([
    ['a foreign source', (ch: string) => send(ch, 'hello', undefined, 'req', {})],
    ['a different channel', () => send('someone-else', 'hello')],
    ['a non-string id', (ch: string) => send(ch, 'hello', undefined, 7 as unknown as string)],
  ])('ignores messages from %s', (_name, fire) => {
    const ch = start('<p>A</p>');
    fire(ch);
    expect(messages(ch, 'result')).toHaveLength(0);
  });
  it('announces ready immediately and again on load', () => {
    const ch = start('<p>A</p>');
    expect(messages(ch, 'ready')).toHaveLength(1);
    window.dispatchEvent(new Event('load'));
    expect(messages(ch, 'ready')).toHaveLength(2);
  });
  it('waits for DOMContentLoaded while the document is loading', () => {
    const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const ch = start('<p>A</p>');
    expect(messages(ch, 'ready')).toHaveLength(0);
    state.mockRestore();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(messages(ch, 'ready')).toHaveLength(1);
  });
});

describe('in-frame direct editing', () => {
  function typeInto(el: Element, text: string) {
    el.textContent = text;
    document.dispatchEvent(new Event('input'));
  }
  it('marks only single-text-node elements editable and clears on exit', () => {
    const ch = start('<p>Solo</p><div>Mixed <b>bold</b></div>');
    expect(ask(ch, 'editing', true).value).toBe(true);
    expect(document.querySelector('p')!.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(document.querySelector('b')!.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(document.querySelector('div')!.hasAttribute('contenteditable')).toBe(false);
    ask(ch, 'editing', false);
    expect(document.querySelector('[contenteditable]')).toBeNull();
  });
  it('skips oversized nodes when enabling editing', () => {
    const ch = start(`<p>${'z'.repeat(4001)}</p>`);
    ask(ch, 'editing', true);
    expect(document.querySelector('p')!.hasAttribute('contenteditable')).toBe(false);
  });
  it('records typed edits as a single patch per node and notifies the host', () => {
    const ch = start('<p>Old</p>');
    ask(ch, 'editing', true);
    const p = document.querySelector('p')!;
    typeInto(p, 'New');
    typeInto(p, 'Newer');
    expect(messages(ch, 'changed').length).toBe(2);
    expect(ask(ch, 'source').value).toEqual([{ index: 1, old_text: 'Old', text: 'Newer' }]);
  });
  it('ignores input while editing is off', () => {
    const ch = start('<p>Old</p>');
    typeInto(document.querySelector('p')!, 'New');
    expect(messages(ch, 'changed')).toHaveLength(0);
    expect(ask(ch, 'source').value).toEqual([]);
  });
  it('reverts text over the 4000 character limit and warns', () => {
    const ch = start('<p>Old</p>');
    ask(ch, 'editing', true);
    const p = document.querySelector('p')!;
    typeInto(p, 'q'.repeat(4001));
    expect(p.textContent).toBe('Old');
    expect(messages(ch, 'warning')[0].value).toBe('Text edits must be 4000 characters or fewer.');
  });
  it('reverts a new edit once the patch limit is reached', () => {
    const full = Array.from({ length: 2000 }, (_, i) => ({ index: i + 5, old_text: `none-${i}`, text: `gone-${i}` }));
    const ch = start('<p>Old</p>', full);
    ask(ch, 'editing', true);
    const p = document.querySelector('p')!;
    typeInto(p, 'New');
    expect(p.textContent).toBe('Old');
    expect(messages(ch, 'warning')[0].value).toBe('This presentation has reached its text edit limit.');
  });
});

describe('in-frame apply command', () => {
  const plan = (actions: unknown[], kind = 'html') => ({ kind, actions });
  const contextFor = (ch: string) => ask(ch, 'context').value;

  it('applies matching edits, notifies, and folds them into existing patches', () => {
    const ch = start('<p>One</p><p>Two</p>', [{ index: 1, old_text: 'Zero', text: 'One' }]);
    const context = contextFor(ch);
    const res = ask(ch, 'apply', {
      plan: plan([
        { type: 'html_update_text', index: 1, old_text: 'One', text: 'Uno' },
        { type: 'html_update_text', index: 2, old_text: 'Two', text: 'Dos' },
      ]),
      expectedContext: context,
    });
    expect(res.value).toEqual({ ok: true, applied: 2 });
    expect(Array.from(document.querySelectorAll('p')).map(p => p.textContent)).toEqual(['Uno', 'Dos']);
    expect(messages(ch, 'changed')).toHaveLength(1);
    expect(ask(ch, 'source').value).toEqual([
      { index: 1, old_text: 'Zero', text: 'Uno' },
      { index: 2, old_text: 'Two', text: 'Dos' },
    ]);
  });
  it('does not announce a change for an empty plan', () => {
    const ch = start('<p>One</p>');
    const res = ask(ch, 'apply', { plan: plan([]), expectedContext: contextFor(ch) });
    expect(res.value).toEqual({ ok: true, applied: 0 });
    expect(messages(ch, 'changed')).toHaveLength(0);
  });
  it('keeps a tracked inline edit in sync so a later keystroke stacks on the plan edit', () => {
    const ch = start('<p>One</p>');
    ask(ch, 'editing', true);
    ask(ch, 'apply', { plan: plan([{ type: 'html_update_text', index: 1, old_text: 'One', text: 'Uno' }]), expectedContext: contextFor(ch) });
    const p = document.querySelector('p')!;
    p.textContent = 'Eins';
    document.dispatchEvent(new Event('input'));
    expect(ask(ch, 'source').value).toEqual([{ index: 1, old_text: 'One', text: 'Eins' }]);
  });
  it.each([
    ['wrong plan kind', () => plan([], 'word')],
    ['non-array actions', () => ({ kind: 'html', actions: 'nope' })],
  ])('rejects %s as a changed presentation', (_n, build) => {
    const ch = start('<p>One</p>');
    expect(ask(ch, 'apply', { plan: build(), expectedContext: contextFor(ch) }).error).toMatch(/presentation changed/);
  });
  it('rejects when the document moved on since the context was read', () => {
    const ch = start('<p>One</p>');
    const context = contextFor(ch);
    document.querySelector('p')!.setAttribute('data-x', '1');
    expect(ask(ch, 'apply', { plan: plan([]), expectedContext: context }).error).toMatch(/presentation changed/);
  });
  const ok = { type: 'html_update_text', index: 1, old_text: 'One', text: 'Uno' };
  it.each([
    ['unknown action type', [{ ...ok, type: 'delete' }]],
    ['non-integer index', [{ ...ok, index: 1.5 }]],
    ['index below range', [{ ...ok, index: 0 }]],
    ['index above range', [{ ...ok, index: 2001 }]],
    ['duplicate index', [ok, ok]],
    ['non-string text', [{ ...ok, text: 5 }]],
    ['oversized text', [{ ...ok, text: 'x'.repeat(4001) }]],
    ['index absent from context', [{ ...ok, index: 2 }]],
    ['stale old_text', [{ ...ok, old_text: 'Other' }]],
  ])('refuses unsafe edit: %s, leaving the document alone', (_n, actions) => {
    const ch = start('<p>One</p>');
    const res = ask(ch, 'apply', { plan: plan(actions), expectedContext: contextFor(ch) });
    expect(res.error).toBe('The HTML edit could not be applied safely.');
    expect(document.querySelector('p')!.textContent).toBe('One');
  });
  it('refuses a plan that would exceed the patch limit', () => {
    const full = Array.from({ length: 2000 }, (_, i) => ({ index: i + 5, old_text: `none-${i}`, text: `gone-${i}` }));
    const ch = start('<p>One</p>', full);
    expect(ask(ch, 'apply', { plan: plan([ok]), expectedContext: contextFor(ch) }).error).toMatch(/text edit limit/);
  });
});

describe('in-frame failure reporting', () => {
  // Vitest's `window` global is a proxy of jsdom's, so script-level errors need their target pinned to it.
  function scriptError(message?: string) {
    const ev = errorEvent(message);
    Object.defineProperty(ev, 'target', { value: window });
    return ev;
  }
  function errorEvent(message?: string) {
    const ev = new Event('error');
    if (message !== undefined) Object.defineProperty(ev, 'message', { value: message });
    return ev;
  }
  it('reports script errors with their message, capped at 300 characters', () => {
    const ch = start('<p>A</p>');
    window.dispatchEvent(scriptError('m'.repeat(400)));
    expect(messages(ch, 'warning')[0].value).toBe('m'.repeat(300));
  });
  it('uses a generic message when the script error has none', () => {
    const ch = start('<p>A</p>');
    window.dispatchEvent(scriptError());
    expect(messages(ch, 'warning')[0].value).toBe('A presentation script failed.');
  });
  it('reports failed resources without leaking element details', () => {
    const ch = start('<img id="broken" alt="x" />');
    document.getElementById('broken')!.dispatchEvent(errorEvent());
    expect(messages(ch, 'warning')[0].value).toBe('A presentation resource could not load.');
  });
  it.each([
    ['an Error reason', new Error('promise boom'), 'promise boom'],
    ['a string reason', 'plain boom', 'plain boom'],
    ['no reason', undefined, 'A presentation script failed.'],
  ])('reports unhandled rejections with %s', (_n, reason, expected) => {
    const ch = start('<p>A</p>');
    const ev = new Event('unhandledrejection');
    Object.defineProperty(ev, 'reason', { value: reason });
    window.dispatchEvent(ev);
    expect(messages(ch, 'warning')[0].value).toBe(expected);
  });
});

describe('useOfficeHtmlRuntime host hook', () => {
  type HookResult = ReturnType<typeof useOfficeHtmlRuntime>;
  let host: HTMLDivElement;
  let root: Root;
  let result: HookResult;
  let frameWindow: { postMessage: ReturnType<typeof vi.fn> };
  const onChanged = vi.fn();

  function Harness({ source, attach = true }: { source: string; attach?: boolean }) {
    const frame = useRef<any>(attach ? { contentWindow: frameWindow } : { contentWindow: null });
    result = useOfficeHtmlRuntime(frame, 'file-1', source, onChanged);
    return <output>{result.runtimeError}</output>;
  }
  const render = (source = '<p>Doc</p>', attach = true) => act(() => { root.render(<Harness source={source} attach={attach} />); });
  function deliver(data: Record<string, unknown>, source: unknown = frameWindow) {
    const channel = currentChannel();
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value: { bridge: 'bob-html-runtime', channel, ...data } },
      source: { value: source },
    });
    act(() => { window.dispatchEvent(event); });
  }
  const currentChannel = () => result.runtimeSource.match(/\)\("([^"]+)",\[/)?.[1];
  const lastRequest = () => frameWindow.postMessage.mock.calls.at(-1)![0];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    posted.mockRestore();
    frameWindow = { postMessage: vi.fn() };
    onChanged.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('becomes ready on a ready message and on the hello handshake reply', () => {
    render();
    expect(result.ready).toBe(false);
    deliver({ type: 'ready' });
    expect(result.ready).toBe(true);
    render('<p>Changed</p>');
    expect(result.ready).toBe(false);
    act(() => { vi.advanceTimersByTime(1000); });
    const hello = lastRequest();
    expect(hello.command).toBe('hello');
    deliver({ type: 'result', id: 'hello', channel: hello.channel });
    expect(result.ready).toBe(true);
  });
  it('surfaces runtime warnings, capped, with a default', () => {
    render();
    deliver({ type: 'warning', channel: currentChannel(), value: 'w'.repeat(350) });
    expect(host.textContent).toBe('w'.repeat(300));
    deliver({ type: 'warning', channel: currentChannel() });
    expect(host.textContent).toBe('A presentation script failed.');
  });
  it('notifies changes and drops messages from other frames or channels', () => {
    render();
    const channel = currentChannel();
    deliver({ type: 'changed', channel });
    expect(onChanged).toHaveBeenCalledTimes(1);
    deliver({ type: 'changed', channel }, {});
    deliver({ type: 'changed', channel: 'other' });
    deliver({ type: 'mystery', channel });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it('resolves context calls and ignores unmatched result ids', async () => {
    render();
    const pending = result.context();
    const req = lastRequest();
    expect(req.command).toBe('context');
    deliver({ type: 'result', id: 'unknown', channel: req.channel, value: 'nope' });
    deliver({ type: 'result', id: req.id, channel: req.channel, value: { kind: 'html', text: 'T' } });
    await expect(pending).resolves.toEqual({ kind: 'html', text: 'T' });
  });
  it('rejects apply with the error reported by the frame', async () => {
    render();
    const pending = result.apply({ kind: 'html', actions: [] } as any, { kind: 'html' } as any);
    const req = lastRequest();
    expect(req.value.plan.kind).toBe('html');
    deliver({ type: 'result', id: req.id, channel: req.channel, error: 'nope' });
    await expect(pending).rejects.toThrow('nope');
  });
  it('times out a silent frame after 15 seconds', async () => {
    render();
    const pending = result.setEditing(true);
    const assertion = expect(pending).rejects.toThrow('did not respond');
    act(() => { vi.advanceTimersByTime(15000); });
    await assertion;
  });
  it('rejects immediately while the frame has no window', async () => {
    render('<p>Doc</p>', false);
    await expect(result.context()).rejects.toThrow('still opening');
  });
  it('rejects outstanding calls when unmounted', async () => {
    render();
    const pending = result.context();
    const assertion = expect(pending).rejects.toThrow('presentation changed');
    act(() => root.render(<div />));
    await assertion;
  });
  async function saveWith(patches: Patch[], source = '<p>Doc</p>') {
    render(source);
    const saving = result.saveSource();
    const req = lastRequest();
    expect(req.command).toBe('source');
    deliver({ type: 'result', id: req.id, channel: req.channel, value: patches });
    return saving;
  }
  it('saves unchanged source verbatim when there are no patches', async () => {
    await expect(saveWith([])).resolves.toBe('<p>Doc</p>');
  });
  it('saves patches as an inert, script-safe trailer that a later load unpacks', async () => {
    const saved = await saveWith([{ index: 1, old_text: 'Doc', text: '</script><b>\u2028\u2029' }]);
    expect(saved.startsWith('<p>Doc</p><!--bob-office-patches:start-->')).toBe(true);
    expect(saved).toContain('\\u003c/script>\\u003cb>\\u2028\\u2029');
    expect(saved.endsWith('<!--bob-office-patches:end-->')).toBe(true);
    const rebuilt = buildOfficeHtmlRuntime(saved, 'again');
    expect(rebuilt).not.toContain('bob-office-patches:start');
    expect(rebuilt.startsWith('<script id="bob-office-runtime">')).toBe(true);
    expect(rebuilt).toContain('\\u003c/script>');
  });
  it('replaces rather than stacks an earlier trailer on save', async () => {
    const first = await saveWith([{ index: 1, old_text: 'Doc', text: 'A' }]);
    const second = await saveWith([{ index: 1, old_text: 'Doc', text: 'B' }], first);
    expect(second.match(/patches:start/g)).toHaveLength(1);
    expect(second).toContain('"text":"B"');
  });
});

describe('patch metadata unpacking', () => {
  const trailer = (body: string) => `<p>Doc</p><!--bob-office-patches:start--><script type="application/json" id="bob-office-patches">${body}</script><!--bob-office-patches:end-->`;
  const patchesIn = (html: string) => {
    const match = /,(\[.*?\]),function editableNodes/s.exec(buildOfficeHtmlRuntime(html, 'c'));
    return JSON.parse(match?.[1] ?? 'null');
  };
  const good = { index: 1, old_text: 'a', text: 'b' };
  it.each([
    ['malformed JSON', '{oops', []],
    ['non-array metadata', '{"index":1}', []],
    ['valid entries', JSON.stringify([good]), [good]],
    ['filters invalid entries', JSON.stringify([null, { ...good, index: 0 }, { ...good, index: 2001 }, { ...good, index: 1.5 }, { ...good, old_text: 5 }, { ...good, text: 5 }, { ...good, old_text: 'x'.repeat(4001) }, { ...good, text: 'x'.repeat(4001) }, good]), [good]],
    ['empty metadata', '', []],
  ])('handles %s', (_n, body, expected) => {
    expect(patchesIn(trailer(body))).toEqual(expected);
  });
  it('treats a start marker with no end marker as document content', () => {
    const html = '<p>Doc</p><!--bob-office-patches:start-->';
    expect(buildOfficeHtmlRuntime(html, 'c')).toContain(html);
  });
  it('builds a runtime for empty source', () => {
    expect(buildOfficeHtmlRuntime('', 'c').startsWith('<script id="bob-office-runtime">')).toBe(true);
  });
  it('injects after the doctype when there is no html or head tag', () => {
    expect(buildOfficeHtmlRuntime('<!doctype html><p>x</p>', 'c').startsWith('<!doctype html><script id="bob-office-runtime">')).toBe(true);
  });
  it('injects right after head attributes', () => {
    expect(buildOfficeHtmlRuntime('<html><head lang="en"><title>t</title></head></html>', 'c')).toMatch(/^<html><head lang="en"><script id="bob-office-runtime">/);
  });
});
