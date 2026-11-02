// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPreview } from '../../src/components/ArtifactPreview';

type Row = Record<string, unknown>;
const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let intersect: (entries: Array<{ isIntersecting: boolean }>) => void;
let disconnect: ReturnType<typeof vi.fn>;

const frames = () => [...host.querySelectorAll('iframe')];
const visibleFrame = () => frames().find(frame => frame.getAttribute('aria-hidden') === 'false')!;
const hiddenFrame = () => frames().find(frame => frame.getAttribute('aria-hidden') === 'true')!;
const render = (html: string, live = false) => act(async () => root.render(<ArtifactPreview html={html} live={live} />));
const load = (frame: HTMLIFrameElement) => act(async () => { frame.dispatchEvent(new Event('load')); });
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const posts = (frame: HTMLIFrameElement) => {
  const spy = vi.fn();
  (frame.contentWindow as Window).postMessage = spy as never;
  return spy;
};
const fromFrame = (frame: HTMLIFrameElement | null, data: Row, origin = 'null') => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: frame?.contentWindow ?? null }));
});
async function show(html: string, live = false) {
  await render(html, live);
  const loading = hiddenFrame();
  await load(loading);
  await advance(250);
  return loading;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('document preparation', () => {
  it('renders nothing into the frames without content', async () => {
    await render('');
    expect(frames().every(frame => !frame.getAttribute('srcdoc'))).toBe(true);
  });

  it('always isolates content: scripts only, never same-origin', async () => {
    await render('<p>Page</p>');
    for (const frame of frames()) expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('installs the bridge and error reporter before generated scripts', async () => {
    await render('<script>page()</script>');
    const source = hiddenFrame().getAttribute('srcdoc')!;
    expect(source.indexOf('BobPreviewLive')).toBeLessThan(source.indexOf('bob-render-guard'));
    expect(source.indexOf('bob-render-guard')).toBeLessThan(source.indexOf('page()'));
  });

  it('keeps a content security policy first so it still applies', async () => {
    await render(POLICY + '<p>Page</p>');
    const source = hiddenFrame().getAttribute('srcdoc')!;
    expect(source.startsWith(POLICY)).toBe(true);
    expect(source.indexOf('BobPreviewLive')).toBeGreaterThan(POLICY.length - 1);
  });

  it('repairs the known script mistake so charts can draw', async () => {
    await render("<script>el?.style.display='block';</script>");
    const source = hiddenFrame().getAttribute('srcdoc')!;
    expect(source).toContain("(el?.style ?? {}).display='block'");
    expect(source).not.toContain("el?.style.display='block'");
  });

  it('removes a warning saved in an older file', async () => {
    await render('<body><div id="bob-script-error" role="alert">Bad</div><p>Kept</p></body>');
    const source = hiddenFrame().getAttribute('srcdoc')!;
    expect(source).toContain('<p>Kept</p>');
    expect(source).not.toContain('>Bad<');
  });

  it('leaves unfinished live snapshots without error reporting and with stable motion', async () => {
    await render('<script>unfinished(', true);
    const source = hiddenFrame().getAttribute('srcdoc')!;
    expect(source).not.toContain('bob-render-guard');
    expect(source).toContain('animation:none!important');
  });

  it('does not add stable motion to a finished page', async () => {
    await render('<p>Done</p>');
    expect(hiddenFrame().getAttribute('srcdoc')).not.toContain('animation:none!important');
  });
});

describe('swapping documents without flicker', () => {
  it('keeps the old page visible until the new one has loaded and restored', async () => {
    const first = await show('<p>One</p>');
    expect(visibleFrame()).toBe(first);
    await render('<p>Two</p>');
    const second = hiddenFrame();
    expect(second.getAttribute('srcdoc')).toContain('Two');
    expect(visibleFrame()).toBe(first);
    const message = posts(second);
    await load(second);
    expect(message).toHaveBeenCalledWith({ type: 'buddy-preview-restore', state: { x: 0, y: 0, positions: {} } }, '*');
    expect(visibleFrame()).toBe(first);
    await fromFrame(second, { type: 'buddy-preview-restored' });
    expect(visibleFrame()).toBe(second);
  });

  it('still shows a page whose own policy disables the bridge', async () => {
    const first = await show('<p>One</p>');
    await render('<p>Strict</p>');
    const second = hiddenFrame();
    await load(second);
    await advance(249);
    expect(visibleFrame()).toBe(first);
    await advance(1);
    expect(visibleFrame()).toBe(second);
  });

  it('shows a slow page after two seconds so a stalled library cannot block updates', async () => {
    const first = await show('<p>One</p>');
    await render('<p>Slow</p>');
    const second = hiddenFrame();
    const message = posts(second);
    await advance(1999);
    expect(visibleFrame()).toBe(first);
    await advance(1);
    expect(visibleFrame()).toBe(second);
    expect(message).toHaveBeenCalledWith(expect.objectContaining({ type: 'buddy-preview-restore' }), '*');
  });

  it('skips only intermediate snapshots and always catches up to the latest', async () => {
    await show('<p>One</p>');
    await render('<p>Two</p>');
    const second = hiddenFrame();
    await render('<p>Three</p>');
    await render('<p>Four</p>');
    expect(second.getAttribute('srcdoc')).toContain('Two');
    await load(second);
    await advance(250);
    expect(visibleFrame()).toBe(second);
    await advance(0);
    expect(hiddenFrame().getAttribute('srcdoc')).toContain('Four');
    expect(frames().some(frame => frame.getAttribute('srcdoc')?.includes('Three'))).toBe(false);
  });

  it('does not reload for identical content', async () => {
    const first = await show('<p>Same</p>');
    await render('<p>Same</p>');
    await advance(2500);
    expect(visibleFrame()).toBe(first);
    expect(hiddenFrame().getAttribute('srcdoc') || '').not.toContain('Same');
  });

  it('ignores a load event from a frame that is not being swapped in', async () => {
    const first = await show('<p>One</p>');
    await load(first);
    await advance(300);
    expect(visibleFrame()).toBe(first);
  });

  it('hides the inactive frame from keyboard and pointer', async () => {
    const first = await show('<p>One</p>');
    expect(first.tabIndex).toBe(0);
    const other = hiddenFrame();
    expect(other.tabIndex).toBe(-1);
    expect(other.style.visibility).toBe('hidden');
    expect(other.style.pointerEvents).toBe('none');
  });
});

describe('messages from frames', () => {
  it('restores the scroll position reported by the visible frame', async () => {
    const first = await show('<p>One</p>');
    await fromFrame(first, { type: 'buddy-preview-position', x: 3, y: 40, positions: { list: [0, 9] } });
    await render('<p>Two</p>');
    const message = posts(hiddenFrame());
    await load(hiddenFrame());
    expect(message).toHaveBeenCalledWith({ type: 'buddy-preview-restore', state: { x: 3, y: 40, positions: { list: [0, 9] } } }, '*');
  });

  it('trusts only the source window, not other frames or windows', async () => {
    const first = await show('<p>One</p>');
    const other = hiddenFrame();
    await fromFrame(other, { type: 'buddy-preview-position', x: 99, y: 99, positions: {} });
    await fromFrame(null, { type: 'buddy-preview-position', x: 98, y: 98, positions: {} });
    await fromFrame(other, { type: 'buddy-preview-chart-motion' });
    await fromFrame(null, { type: 'buddy-preview-chart-motion' });
    expect(host.querySelector('button')).toBeNull();
    await render('<p>Two</p>');
    const message = posts(hiddenFrame());
    await load(hiddenFrame());
    expect(message).toHaveBeenCalledWith({ type: 'buddy-preview-restore', state: { x: 0, y: 0, positions: {} } }, '*');
    expect(visibleFrame()).toBe(first);
  });

  it('ignores a restored message from the wrong frame', async () => {
    const first = await show('<p>One</p>');
    await render('<p>Two</p>');
    await fromFrame(first, { type: 'buddy-preview-restored' });
    expect(visibleFrame()).toBe(first);
  });

  it('removes its listener when closed', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    await show('<p>One</p>');
    act(() => root.unmount());
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
    expect(disconnect).toHaveBeenCalled();
    root = createRoot(host);
  });
});

describe('replay control', () => {
  it('appears only when charts report motion, and replays the visible frame', async () => {
    const first = await show('<p>Chart</p>');
    expect(host.querySelector('button')).toBeNull();
    await fromFrame(first, { type: 'buddy-preview-chart-motion' });
    const button = host.querySelector('button')!;
    expect(button.textContent?.trim()).toBe('Replay chart animations');
    const message = posts(first);
    await act(async () => button.click());
    expect(message).toHaveBeenCalledWith({ type: 'buddy-preview-replay' }, '*');
  });

  it('is disabled while the content is still streaming', async () => {
    const first = await show('<p>Chart</p>', true);
    await fromFrame(first, { type: 'buddy-preview-chart-motion' });
    expect(host.querySelector('button')!.disabled).toBe(true);
  });
});

describe('telling frames whether they are visible', () => {
  it('reports visibility as the preview scrolls in and out of view', async () => {
    const first = await show('<p>One</p>');
    const message = posts(first);
    const other = posts(hiddenFrame());
    act(() => intersect([{ isIntersecting: false }]));
    expect(message).toHaveBeenLastCalledWith({ type: 'buddy-preview-visible', visible: false, live: false }, '*');
    act(() => intersect([{ isIntersecting: true }]));
    expect(message).toHaveBeenLastCalledWith({ type: 'buddy-preview-visible', visible: true, live: false }, '*');
    expect(other).toHaveBeenLastCalledWith({ type: 'buddy-preview-visible', visible: false, live: true }, '*');
    act(() => intersect([]));
    expect(message).toHaveBeenLastCalledWith({ type: 'buddy-preview-visible', visible: false, live: false }, '*');
  });

  it('reports hidden when the browser tab is hidden', async () => {
    const first = await show('<p>One</p>');
    const message = posts(first);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => intersect([{ isIntersecting: true }]));
    expect(message).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }), '*');
    delete (document as unknown as Row).hidden;
  });

  it('rechecks on tab changes using the real layout', async () => {
    const first = await show('<p>One</p>');
    const message = posts(first);
    const stack = host.querySelector<HTMLElement>('.artifact-preview-stack')!;
    stack.getClientRects = () => [{}] as unknown as DOMRectList;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(message).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }), '*');
    stack.getClientRects = () => [] as unknown as DOMRectList;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(message).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }), '*');
  });
});

/* The bridge runs inside the frame: execute its real source against controlled browser globals. */
describe('bridge inside the frame', () => {
  type Listener = (event: Row) => void;
  const installed: Array<() => void> = [];
  async function bridge(reduced = false) {
    await render('<p>Page</p>');
    const source = hiddenFrame().getAttribute('srcdoc')!;
    const code = source.slice(source.indexOf('<script>') + 8, source.indexOf('</script>'));
    const parent = { postMessage: vi.fn() };
    const listeners: Record<string, Listener> = {};
    const scrollTo = vi.fn();
    let mutate = () => {};
    const frameQueue: Array<() => void> = [];
    class Observer { constructor(callback: () => void) { mutate = callback; } observe() {} }
    const add = vi.spyOn(document, 'addEventListener');
    new Function('parent', 'addEventListener', 'scrollTo', 'matchMedia', 'requestAnimationFrame', 'MutationObserver', 'scrollX', 'scrollY', code)(
      parent, (type: string, listener: Listener) => { listeners[type] = listener; }, scrollTo, () => ({ matches: reduced }),
      (callback: () => void) => { frameQueue.push(callback); return frameQueue.length; }, Observer, 5, 6);
    for (const [type, listener, options] of add.mock.calls) installed.push(() => document.removeEventListener(type, listener as EventListener, options));
    add.mockRestore();
    const send = (data: Row, source2: unknown = parent) => listeners.message({ source: source2, data });
    const flush = () => { while (frameQueue.length) frameQueue.shift()!(); };
    return { parent, send, scrollTo, flush, mutate: () => mutate() };
  }
  const canvasChart = () => {
    document.body.innerHTML = '<canvas id="c"></canvas>';
    const chart = { canvas: document.getElementById('c'), options: {} as Row, reset: vi.fn(), update: vi.fn() };
    (window as unknown as Row).Chart = { getChart: () => chart };
    return chart;
  };
  afterEach(() => {
    for (const key of ['Chart', 'echarts', 'BuddyCarbonCharts', 'BobDashboard', 'BobPreviewLive']) delete (window as unknown as Row)[key];
    document.body.append(host);
    while (installed.length) installed.pop()!();
  });

  it('starts paused so nothing animates in a hidden frame', async () => {
    const { parent, flush, mutate } = await bridge();
    canvasChart();
    mutate();
    flush();
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect((window as unknown as Row).BobPreviewLive).toBe(true);
  });

  it('plays a chart once when it becomes visible and reports motion', async () => {
    const { parent, send } = await bridge();
    const chart = canvasChart();
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect((window as unknown as Row).BobPreviewLive).toBe(false);
    expect(chart.reset).toHaveBeenCalledTimes(1);
    expect(chart.update).toHaveBeenCalledTimes(1);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'buddy-preview-chart-motion' }, '*');
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(chart.reset).toHaveBeenCalledTimes(1);
  });

  it('replays again on returning after being hidden, and on request', async () => {
    const { send } = await bridge();
    const chart = canvasChart();
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    send({ type: 'buddy-preview-visible', visible: false, live: false });
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(chart.reset).toHaveBeenCalledTimes(2);
    send({ type: 'buddy-preview-replay' });
    expect(chart.reset).toHaveBeenCalledTimes(3);
  });

  it('keeps the dashboard Carbon motion, and only sets timing on other charts', async () => {
    const first = await bridge();
    const plain = canvasChart();
    first.send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(plain.options.animation).toEqual({ duration: 1400, easing: 'easeOutCubic' });
    const second = await bridge();
    const dashboard = canvasChart();
    dashboard.options.animation = { duration: 1400, easing: 'carbon' };
    (window as unknown as Row).BobDashboard = {};
    second.send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(dashboard.options.animation).toEqual({ duration: 1400, easing: 'carbon' });
    expect(dashboard.reset).toHaveBeenCalledTimes(1);
  });

  it('finds charts through the older Chart.instances list', async () => {
    const { send } = await bridge();
    const chart = canvasChart();
    (window as unknown as Row).Chart = { instances: { 0: chart } };
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(chart.reset).toHaveBeenCalledTimes(1);
  });

  it('ignores a canvas that has no chart', async () => {
    const { parent, send } = await bridge();
    canvasChart();
    (window as unknown as Row).Chart = { instances: {} };
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('does not animate for reduced motion or while streaming', async () => {
    const reduced = await bridge(true);
    const still = canvasChart();
    reduced.send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(still.reset).not.toHaveBeenCalled();
    const streaming = await bridge();
    const chart = canvasChart();
    streaming.send({ type: 'buddy-preview-visible', visible: true, live: true });
    expect(chart.reset).not.toHaveBeenCalled();
    expect((window as unknown as Row).BobPreviewLive).toBe(true);
  });

  it('plays charts added after the page became visible', async () => {
    const { send, mutate, flush } = await bridge();
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    const chart = canvasChart();
    mutate();
    mutate();
    flush();
    expect(chart.reset).toHaveBeenCalledTimes(1);
  });

  it('accepts messages only from its parent', async () => {
    const { send, scrollTo } = await bridge();
    const chart = canvasChart();
    send({ type: 'buddy-preview-visible', visible: true, live: false }, window);
    send({ type: 'buddy-preview-restore', state: { x: 1, y: 2, positions: {} } }, null);
    expect(chart.reset).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('ignores unknown messages', async () => {
    const { parent, send, scrollTo } = await bridge();
    send({ type: 'other' });
    send({});
    expect(scrollTo).not.toHaveBeenCalled();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('restores page and inner scroll, skips missing elements, and confirms', async () => {
    const { parent, send, scrollTo } = await bridge();
    document.body.innerHTML = '<div id="list"></div>';
    const list = document.getElementById('list')!;
    list.scrollTo = vi.fn() as never;
    send({ type: 'buddy-preview-restore', state: { x: 1, y: 2, positions: { list: [3, 4], gone: [5, 6] } } });
    expect(scrollTo).toHaveBeenCalledWith({ left: 1, top: 2, behavior: 'instant' });
    expect(list.scrollTo).toHaveBeenCalledWith({ left: 3, top: 4, behavior: 'instant' });
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'buddy-preview-restored' }, '*');
  });

  it('reports scroll position once per frame, including inner elements', async () => {
    const { parent, flush } = await bridge();
    document.body.innerHTML = '<div id="list"></div><div id="other"></div>';
    const list = document.getElementById('list')!;
    list.scrollTop = 7;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
    document.getElementById('other')!.dispatchEvent(new Event('scroll', { bubbles: true }));
    flush();
    const reports = parent.postMessage.mock.calls.filter(([data]) => data.type === 'buddy-preview-position');
    expect(reports).toHaveLength(1);
    expect(reports[0][0]).toMatchObject({ x: 5, y: 6, positions: { list: [0, 7], other: [0, 0] } });
    document.dispatchEvent(new Event('scroll'));
    flush();
    expect(parent.postMessage.mock.calls.filter(([data]) => data.type === 'buddy-preview-position')).toHaveLength(2);
  });

  it('replays Carbon charts when they report ready or on request', async () => {
    const { parent, send } = await bridge();
    document.body.innerHTML = '<div data-bob-carbon-chart></div>';
    const replayVisible = vi.fn();
    (window as unknown as Row).BuddyCarbonCharts = { replayVisible };
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'buddy-preview-chart-motion' }, '*');
    expect(replayVisible).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('bob:carbon-ready'));
    expect(replayVisible).toHaveBeenCalledTimes(2);
  });

  it('replays older ECharts dashboards once, with the shared timings', async () => {
    const { send } = await bridge();
    document.body.innerHTML = '<div id="e"></div><section id="none"></section>';
    const option = { series: [{}] as Row[] } as Row & { series: Row[] };
    const chart = { getOption: () => option, clear: vi.fn(), setOption: vi.fn() };
    (window as unknown as Row).echarts = { getInstanceByDom: (element: Element) => (element.id === 'e' ? chart : undefined) };
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    expect(option).toMatchObject({ animation: true, animationDuration: 1400, animationDurationUpdate: 700, animationEasing: 'cubicOut' });
    expect(option.series[0]).toMatchObject({ animation: true, animationDuration: 1400, animationDurationUpdate: 700 });
    send({ type: 'buddy-preview-visible', visible: true, live: false });
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    send({ type: 'buddy-preview-replay' });
    expect(chart.setOption).toHaveBeenCalledTimes(2);
  });
});
