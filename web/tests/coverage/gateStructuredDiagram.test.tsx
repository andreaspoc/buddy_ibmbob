// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StructuredDiagram } from '../../src/components/StructuredDiagram';
import { layoutDiagram } from '../../src/lib/diagramLayout';
import { saveSessionFile } from '../../src/api';

const flow = vi.hoisted(() => ({
  setViewport: vi.fn(() => Promise.resolve(true)),
  latest: undefined as any,
}));

vi.mock('../../src/api', () => ({ saveSessionFile: vi.fn() }));
vi.mock('../../src/lib/diagramLayout', () => ({ layoutDiagram: vi.fn(), nodeSize: { width: 184, height: 76 } }));
// Lightweight canvas: renders the component's own node and edge types without xyflow's measuring runtime.
vi.mock('@xyflow/react', () => {
  function ReactFlow(props: any) {
    flow.latest = props;
    useEffect(() => { props.onInit?.(); }, []);
    return <div data-testid="canvas">
      {props.nodes.map((n: any) => { const Type = props.nodeTypes[n.type]; return <div key={n.id} data-node={n.id}><Type id={n.id} data={n.data} /></div>; })}
      <svg>{props.edges.map((e: any) => { const Type = props.edgeTypes[e.type]; return <g key={e.id} data-edge={e.id} data-source-handle={e.sourceHandle} data-target-handle={e.targetHandle}><Type {...e} sourceX={0} sourceY={0} targetX={200} targetY={100} sourcePosition="right" targetPosition="left" /></g>; })}</svg>
    </div>;
  }
  return {
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    getSmoothStepPath: () => ['M0,0 L200,100', 100, 50],
    getViewportForBounds: () => ({ x: 1, y: 2, zoom: 0.5 }),
    applyNodeChanges: (changes: any[], current: any[]) => current.map(node => {
      const change = changes.find(c => c.id === node.id && c.type === 'position' && c.position);
      return change ? { ...node, position: change.position } : node;
    }),
    ReactFlow,
    ReactFlowProvider: ({ children }: any) => <>{children}</>,
    Background: () => null,
    Handle: () => null,
    Controls: ({ onZoomIn }: any) => <button type="button" onClick={onZoomIn}>zoom-in</button>,
    BaseEdge: ({ path, label }: any) => <path d={path}><title>{label ? 'has-label' : ''}</title></path>,
    useReactFlow: () => ({ setViewport: flow.setViewport }),
  };
});

let host: HTMLDivElement;
let root: Root;
let downloads: Array<{ content: string; type: string; name: string }>;
let reduced: boolean;
let mediaListeners: Set<() => void>;
let resize: (entries: unknown[]) => void;

const nodes = [
  { id: 'a', label: 'Alpha <one>', shape: 'database', tone: 'blue' },
  { id: 'b', label: 'Beta', shape: 'diamond', lane: 'l1' },
  { id: 'c', label: 'Gamma', shape: 'ellipse' },
  { id: 'd', label: 'Delta with an extraordinarily long label that needs several wrapped lines to fit inside', shape: 'rectangle' },
  { id: 'e', label: 'Rounded', shape: 'rounded' },
];
const edges = [
  { id: 'e1', source: 'a', target: 'b', label: 'first & "only" step', tone: 'rose' },
  { id: 'e2', source: 'b', target: 'c', animated: false },
  { id: 'e3', source: 'c', target: 'ghost' },
];
const flowSpec = (over: object = {}) => ({ id: 'flow one', kind: 'flow', title: 'My <Flow>', nodes, edges, ...over }) as any;
const sequenceSpec = (over: object = {}) => ({
  id: 'seq', kind: 'sequence', title: 'Handshake',
  nodes: [{ id: 'x', label: 'Client', shape: 'rectangle' }, { id: 'y', label: 'Server', shape: 'rectangle' }],
  edges: [
    { id: 'm1', source: 'x', target: 'y', label: 'Hello there', animated: true },
    { id: 'm2', source: 'y', target: 'y' },
    { id: 'm3', source: 'ghost', target: 'phantom', label: 'Lost' },
  ], ...over,
}) as any;
const defaultLayout = () => ({
  algorithm: 'layered', direction: 'LR', reason: 'Because of reasons', width: 900, height: 300,
  positions: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 }, d: { x: 0, y: 200 }, e: { x: 300, y: 200 } },
  groups: [{ id: 'l1', label: 'Lane <1>', x: 280, y: -20, width: 400, height: 150, tone: 'teal' }, { id: 'l2', label: 'Plain', x: 0, y: 0, width: 10, height: 10 }],
  edges: {
    e1: { sections: [{ points: [{ x: 184, y: 38 }, { x: 240, y: 38 }, { x: 240, y: 38 }, { x: 240, y: 90 }, { x: 300, y: 90 }] }], label: { x: 200, y: 10, width: 100, height: 20 } },
    e2: { sections: [{ points: [{ x: 392, y: 76 }, { x: 392, y: 100 }, { x: 600, y: 100 }] }] },
  },
});
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
}
async function render(props: Partial<React.ComponentProps<typeof StructuredDiagram>> = {}) {
  await act(async () => { root.render(<StructuredDiagram spec={flowSpec()} source="source text" streaming={false} {...props} />); });
  await settle();
}
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await vi.advanceTimersByTimeAsync(100); }); };
const fire = (el: Element, type: string) => act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 20 })); });
function choose(el: HTMLSelectElement, value: string) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const exported = async (label: string) => {
  await click(button(label)!);
  return downloads.at(-1)!;
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  reduced = false;
  mediaListeners = new Set();
  downloads = [];
  flow.setViewport.mockClear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() { return reduced; }, media: query,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
  })) as never;
  vi.stubGlobal('ResizeObserver', class { constructor(cb: (e: unknown[]) => void) { resize = cb; } observe() { return undefined; } disconnect() { return undefined; } });
  const pending: { type: string; content: string }[] = [];
  vi.stubGlobal('Blob', class { constructor(parts: string[], options: { type: string }) { pending.push({ content: parts[0], type: options.type }); } });
  Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ ...pending.at(-1)!, name: this.download });
  });
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  Element.prototype.scrollTo = vi.fn() as never;
  vi.mocked(layoutDiagram).mockReset().mockImplementation((async () => defaultLayout()) as never);
  vi.mocked(saveSessionFile).mockReset().mockResolvedValue({ ok: true } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll('dialog').forEach(d => d.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StructuredDiagram sequence', () => {
  it('describes messages accessibly, including missing participants and unlabelled messages', async () => {
    await render({ spec: sequenceSpec() });
    const messages = Array.from(document.querySelectorAll('.sequence-message'));
    expect(messages.map(m => m.getAttribute('aria-label'))).toEqual([
      '1. Client → Server: Hello there', '2. Server → Server: Message', '3. ghost → phantom: Lost',
    ]);
    expect(document.querySelector('.diagram-transfer')).not.toBeNull();
    expect(button('Arrange')!.disabled).toBe(true);
    expect(document.querySelector('.diagram-notice')).toBeNull();
  });
  it('focuses a message by click, keyboard and picker, and clears on repeat', async () => {
    await render({ spec: sequenceSpec() });
    const messages = () => Array.from(document.querySelectorAll<SVGGElement>('.sequence-message'));
    await click(messages()[0]);
    expect(messages()[0].getAttribute('aria-pressed')).toBe('true');
    expect(messages()[1].style.opacity).toBe('0.25');
    await click(messages()[0]);
    expect(messages()[1].style.opacity).toBe('1');
    await act(async () => { messages()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(messages()[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => { messages()[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(messages()[1].getAttribute('aria-pressed')).toBe('false');
    await act(async () => { messages()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })); });
    expect(messages()[1].getAttribute('aria-pressed')).toBe('false');
    const picker = document.querySelector<HTMLSelectElement>('[aria-label="Explore sequence messages"]')!;
    expect(picker.options[2].textContent).toBe('2. y → y');
    await choose(picker, 'm3');
    expect(messages()[2].getAttribute('aria-pressed')).toBe('true');
  });
  it('wraps long participant and message labels, ellipsising beyond three lines', async () => {
    const long = 'word '.repeat(40).trim();
    await render({ spec: sequenceSpec({
      nodes: [{ id: 'x', label: `${'L'.repeat(50)} tail`, shape: 'rectangle' }, { id: 'y', label: long, shape: 'rectangle' }],
      edges: [{ id: 'm1', source: 'x', target: 'y', label: long }],
    }) });
    const participantLines = Array.from(document.querySelectorAll('.sequence-participant-float')[0].querySelectorAll('tspan')).map(t => t.textContent);
    expect(participantLines[0]).toBe('L'.repeat(22));
    const lastLine = Array.from(document.querySelectorAll('.sequence-participant-float')[1].querySelectorAll('tspan')).at(-1)!.textContent!;
    expect(lastLine.endsWith('…')).toBe(true);
  });
  it('hides the picker with no messages', async () => {
    await render({ spec: sequenceSpec({ edges: [] }) });
    expect(document.querySelector('[aria-label="Explore sequence messages"]')).toBeNull();
    expect(document.querySelector('.structured-sequence')!.getAttribute('aria-label')).toBe('Handshake');
  });
  it('uses a generic aria label when untitled', async () => {
    await render({ spec: sequenceSpec({ title: undefined }) });
    expect(document.querySelector('.structured-sequence')!.getAttribute('aria-label')).toBe('Sequence diagram');
    expect(document.querySelector('.structured-diagram')!.getAttribute('aria-label')).toBe('Diagram');
  });
  it.each([
    ['SVG', 'seq.svg', 'image/svg+xml', false],
    ['Animated SVG', 'seq.animated.svg', 'image/svg+xml', true],
    ['Animated HTML', 'seq.animated.html', 'text/html', true],
  ])('exports %s from the rendered sequence', async (label, name, type, animated) => {
    await render({ spec: sequenceSpec() });
    await click(document.querySelector('.sequence-message')!);
    const file = await exported(label);
    expect(file.name).toBe(name);
    expect(file.type).toBe(type);
    expect(file.content).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(file.content.includes('@keyframes export-transfer')).toBe(animated);
    expect(file.content.includes('diagram-transfer"')).toBe(animated);
    expect(file.content).not.toContain('opacity: 0.25');
  });
  it('titles the HTML export, escaping and defaulting', async () => {
    await render({ spec: sequenceSpec({ title: 'A<B' }) });
    expect((await exported('Animated HTML')).content).toContain('<title>A&lt;B</title>');
    await act(async () => root.render(<StructuredDiagram spec={sequenceSpec({ title: undefined, id: 'q2' })} source="" streaming={false} />));
    expect((await exported('Animated HTML')).content).toContain('<title>Diagram</title>');
  });
});

describe('StructuredDiagram flow rendering', () => {
  it('prepares, then shows nodes, swimlanes and the chosen layout', async () => {
    await act(async () => { root.render(<StructuredDiagram spec={flowSpec()} source="s" streaming={false} />); });
    expect(document.querySelector('.diagram-placeholder')!.textContent).toBe('Preparing diagram…');
    expect(button('SVG')!.disabled).toBe(true);
    await settle();
    expect(document.querySelector('[data-node="b"] .structured-node-diamond')).not.toBeNull();
    expect(document.querySelector('[data-node="lane:l1"] .structured-lane')!.textContent).toBe('Lane <1>');
    expect(document.querySelector('[data-node="lane:l2"]')).not.toBeNull();
    expect(document.querySelector('.diagram-notice')!.textContent).toBe('Layout: Layered. Because of reasons');
    expect(document.querySelector('[data-edge="e3"]')).toBeNull();
    expect(flow.setViewport).toHaveBeenCalled();
  });
  it('shows a node tooltip that follows the pointer', async () => {
    await render();
    const node = document.querySelector('[data-node="a"] .structured-node')!;
    await fire(node, 'mouseover');
    const tip = () => document.querySelector<HTMLElement>('[data-node="a"] .structured-node-tooltip');
    expect(tip()!.textContent).toBe('Alpha <one>');
    expect(tip()!.style.top).toBe('36px');
    await fire(node, 'mousemove');
    expect(tip()).not.toBeNull();
    await fire(node, 'mouseout');
    expect(tip()).toBeNull();
  });
  it('routes edges from layout points with rounded corners and moving particles', async () => {
    await render();
    const edge = document.querySelector('[data-edge="e1"]')!;
    const d = edge.querySelector('path')!.getAttribute('d')!;
    expect(d.startsWith('M')).toBe(true);
    expect(d).toContain('Q');
    expect(edge.getAttribute('data-source-handle')).toBe('source-right');
    expect(edge.getAttribute('data-target-handle')).toBe('target-left');
    expect(edge.querySelector('circle.diagram-moving-particle')).not.toBeNull();
    expect(edge.querySelector('title')!.textContent).toContain('first & "only" step');
    expect(document.querySelector('[data-edge="e2"] circle')).toBeNull();
  });
  it('falls back to a smooth path and direction-based handles when an edge has no route', async () => {
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => ({ ...defaultLayout(), direction: 'TB', edges: {} })) as never);
    await render();
    const edge = document.querySelector('[data-edge="e1"]')!;
    expect(edge.getAttribute('data-source-handle')).toBe('source-bottom');
    expect(edge.getAttribute('data-target-handle')).toBe('target-top');
    expect(edge.querySelector('path')!.getAttribute('d')).toBeTruthy();
  });
  it.each([
    ['left', { x: 0, y: 38 }, 'source-left'],
    ['top', { x: 92, y: 0 }, 'source-top'],
    ['bottom', { x: 92, y: 76 }, 'source-bottom'],
  ])('chooses the %s port nearest the route start', async (_side, point, handle) => {
    const layout = defaultLayout();
    layout.edges.e1.sections[0].points[0] = point;
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => layout) as never);
    await render();
    expect(document.querySelector('[data-edge="e1"]')!.getAttribute('data-source-handle')).toBe(handle);
  });
  it('copes with empty routes and missing positions', async () => {
    const layout: any = defaultLayout();
    layout.edges.e1 = { sections: [{ points: [] }] };
    layout.positions = { a: { x: 0, y: 0 } };
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => layout) as never);
    await render();
    expect(document.querySelector('[data-node="b"]')).not.toBeNull();
    expect(document.querySelector('[data-edge="e1"] path')!.getAttribute('d')).toBeTruthy();
  });
  it('reports layout failures', async () => {
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => { throw new Error('elk'); }) as never);
    await render();
    expect(Array.from(document.querySelectorAll('.diagram-notice')).map(n => n.textContent)).toContain('Could not arrange this diagram.');
  });
  it('shows stream state and errors, keeping the last valid spec', async () => {
    await render({ streaming: true });
    expect(document.querySelector('.diagram-stream-status')!.textContent).toBe('Drawing…');
    expect(button('Animated SVG')!.disabled).toBe(true);
    await render({ spec: undefined, error: 'Bad JSON so far', streaming: false });
    expect(document.querySelector('strong')!.textContent).toBe('My <Flow>');
    expect(Array.from(document.querySelectorAll('.diagram-notice')).map(n => n.textContent)).toContain('Bad JSON so far');
  });
  it('shows a spec-less error in the placeholder with actions disabled', async () => {
    await render({ spec: undefined, error: 'Not valid yet' });
    expect(document.querySelector('.diagram-placeholder')!.textContent).toBe('Not valid yet');
    expect(button('Maximize')!.disabled).toBe(true);
    expect(button('SVG')!.disabled).toBe(true);
  });
  it('toggles the source view', async () => {
    await render();
    await click(button('Source')!);
    expect(document.querySelector('.diagram-source')!.textContent).toBe('source text');
    await click(button('Source')!);
    expect(document.querySelector('.diagram-source')).toBeNull();
  });
  it('re-lays out on a size change, ignoring zero sizes', async () => {
    await render();
    const before = vi.mocked(layoutDiagram).mock.calls.length;
    await act(async () => { resize([{ contentRect: { width: 0 } }]); });
    await settle();
    expect(vi.mocked(layoutDiagram).mock.calls.length).toBe(before);
    await act(async () => { resize([{ contentRect: { width: 640 } }]); });
    await settle();
    expect(vi.mocked(layoutDiagram).mock.calls.at(-1)![1]).toBe(640);
  });
  it('prefers the scroller size when reading a resize', async () => {
    await render();
    const scroller = document.querySelector('.structured-flow-scroll')!;
    Object.defineProperties(scroller, { clientWidth: { value: 720, configurable: true }, clientHeight: { value: 410, configurable: true } });
    await act(async () => { resize([{ contentRect: { width: 100 } }]); });
    await settle();
    expect(vi.mocked(layoutDiagram).mock.calls.at(-1)![1]).toBe(720);
  });
  it('re-arranges on request and fits via the viewport', async () => {
    await render();
    const before = vi.mocked(layoutDiagram).mock.calls.length;
    await click(button('Arrange')!);
    await settle();
    expect(vi.mocked(layoutDiagram).mock.calls.length).toBeGreaterThan(before);
    flow.setViewport.mockClear();
    await click(button('Fit')!);
    await settle();
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect((flow.setViewport.mock.calls[0] as unknown[])[1]).toEqual({ duration: 300 });
  });
  it('picks a layout override, reporting availability', async () => {
    await render({ spec: flowSpec({ lanes: [{ id: 'l1', label: 'L' }], nodes: nodes.map(n => ({ ...n, lane: 'l1' })) }) });
    const picker = document.querySelector<HTMLSelectElement>('[aria-label="Diagram layout"]')!;
    expect(Array.from(picker.options).find(o => o.value === 'swimlane')!.disabled).toBe(false);
    expect(Array.from(picker.options).find(o => o.value === 'fixed')!.disabled).toBe(true);
    await choose(picker, 'tree');
    await settle();
    expect(vi.mocked(layoutDiagram).mock.calls.at(-1)![0].layout).toBe('tree');
    expect(picker.value).toBe('tree');
  });
  it('enables fixed positions only when every node has coordinates', async () => {
    await render({ spec: flowSpec({ nodes: nodes.map(n => ({ ...n, position: { x: 1, y: 2 } })) }) });
    const picker = document.querySelector<HTMLSelectElement>('[aria-label="Diagram layout"]')!;
    expect(Array.from(picker.options).find(o => o.value === 'fixed')!.disabled).toBe(false);
    expect(Array.from(picker.options).find(o => o.value === 'swimlane')!.disabled).toBe(true);
  });
  it('keeps dragged lane nodes inside their lane', async () => {
    await render({ spec: flowSpec() });
    await act(async () => {
      flow.latest.onNodesChange([{ id: 'b', type: 'position', position: { x: -5000, y: 9000 }, dragging: true }, { id: 'nope', type: 'position', position: { x: 1, y: 1 } }]);
    });
    const moved = flow.latest.nodes.find((n: any) => n.id === 'b');
    expect(moved.position).toEqual({ x: 304, y: 32 });
    await act(async () => { flow.latest.onNodesChange([{ id: 'c', type: 'position', position: { x: 11, y: 22 } }, { id: 'e', type: 'select', selected: true }, { id: 'd', type: 'position' }]); });
    expect(flow.latest.nodes.find((n: any) => n.id === 'c').position).toEqual({ x: 11, y: 22 });
  });
  it('stops auto-fitting once the user has navigated', async () => {
    await render();
    await act(async () => {
      flow.latest.onMoveStart(new Event('wheel'));
      flow.latest.onMoveStart(null);
      flow.latest.onNodeDragStart();
    });
    flow.setViewport.mockClear();
    await click(button('Arrange')!);
    await settle();
    expect(flow.setViewport).not.toHaveBeenCalled();
    await click(button('zoom-in')!);
    expect(button('zoom-in')).toBeDefined();
  });
  it('saves to the session and reports either outcome', async () => {
    await render({ sessionId: 's1' });
    await click(button('Save')!);
    await settle();
    const [session, name, json] = vi.mocked(saveSessionFile).mock.calls[0];
    expect([session, name]).toEqual(['s1', 'flow_one.diagram.json']);
    expect(JSON.parse(json as string).id).toBe('flow one');
    expect(Array.from(document.querySelectorAll('.diagram-notice')).map(n => n.textContent)).toContain('Diagram saved.');
    vi.mocked(saveSessionFile).mockRejectedValueOnce(new Error('no'));
    await click(button('Save')!);
    await settle();
    expect(Array.from(document.querySelectorAll('.diagram-notice')).map(n => n.textContent)).toContain('Could not save diagram.');
  });
});

describe('StructuredDiagram motion', () => {
  it('asks permission under reduced motion, follows device changes and resumes on request', async () => {
    reduced = true;
    await render();
    expect(document.querySelector('.structured-diagram')!.classList.contains('diagram-motion-paused')).toBe(true);
    expect(document.querySelector('.diagram-motion-caption')!.textContent).toContain('reduced motion');
    expect(document.querySelector('[data-edge="e1"] circle')).toBeNull();
    await click(button('Enable motion')!);
    expect(document.querySelector('.structured-diagram')!.classList.contains('diagram-motion-override')).toBe(true);
    expect(button('Enable motion')).toBeUndefined();
    expect(document.querySelector('[data-edge="e1"] circle')).not.toBeNull();
    reduced = false;
    await act(async () => { mediaListeners.forEach(fn => fn()); });
    expect(document.querySelector('.structured-diagram')!.classList.contains('diagram-motion-paused')).toBe(false);
  });
  it.each([
    ['none', 'layered', false],
    ['flow', 'tree', true],
    [undefined, 'tree', false],
  ])('motion %s on %s layout gives a moving caption: %s', async (motion, algorithm, moving) => {
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => ({ ...defaultLayout(), algorithm })) as never);
    await render({ spec: flowSpec({ motion }) });
    expect(document.body.textContent!.includes('Moving connectors show flow direction.')).toBe(moving);
  });
  it('only animates sequence messages that opt in', async () => {
    await render({ spec: sequenceSpec({ edges: [{ id: 'm1', source: 'x', target: 'y' }] }) });
    expect(document.body.textContent).not.toContain('Moving connectors');
  });
  it('animates node moves between layouts when not streaming', async () => {
    await render();
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => {
      const next = defaultLayout();
      next.positions.a = { x: 500, y: 500 };
      return next;
    }) as never);
    await render({ spec: flowSpec({ title: 'Changed' }) });
    expect(flow.latest.nodes.find((n: any) => n.id === 'a').position).toEqual({ x: 500, y: 500 });
  });
});

describe('StructuredDiagram flow export', () => {
  it('draws every shape, lane and escaped label as static SVG', async () => {
    await render();
    const file = await exported('SVG');
    expect(file.name).toBe('flow_one.svg');
    const svg = file.content;
    expect(svg).toContain('<ellipse cx="92" cy="12"');
    expect(svg).toContain('<polygon points=');
    expect(svg).toContain('rx="92" ry="38"');
    expect(svg).toContain('rx="0"');
    expect(svg).toContain('rx="12"');
    expect(svg).toContain('Lane &lt;1&gt;');
    expect(svg).toContain('Alpha &lt;one&gt;');
    expect(svg).toContain('first &amp; &quot;only&quot; step');
    expect(svg).toContain('marker id="arrow-e1"');
    expect(svg).not.toContain('export-float"');
    expect(svg).not.toContain('@keyframes');
    expect(svg).not.toContain('marker-end="url(#arrow-e3)"');
  });
  it('adds motion to animated SVG, sparing edges that opt out', async () => {
    await render();
    const { content, name } = await exported('Animated SVG');
    expect(name).toBe('flow_one.animated.svg');
    expect(content).toContain('@keyframes export-float');
    expect(content).toContain('class="export-float"');
    expect((content.match(/class="export-transfer"/g) || [])).toHaveLength(1);
    expect((content.match(/<animateMotion/g) || [])).toHaveLength(1);
  });
  it('wraps animated HTML in a document', async () => {
    await render();
    const { content, name, type } = await exported('Animated HTML');
    expect([name, type]).toEqual(['flow_one.animated.html', 'text/html']);
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('<title>My &lt;Flow&gt;</title>');
  });
  it('sizes to at least the minimum canvas with a tiny layout and no spec id', async () => {
    vi.mocked(layoutDiagram).mockImplementationOnce((async () => ({
      algorithm: 'layered', direction: 'LR', reason: 'r', width: 1, height: 1, positions: { only: { x: 0, y: 0 } }, edges: {},
    })) as never);
    await render({ spec: flowSpec({ id: undefined, nodes: [{ id: 'only', label: 'Solo', shape: 'rounded' }], edges: [] }) });
    const { content, name } = await exported('SVG');
    expect(name).toBe('diagram.svg');
    expect(content).toContain('viewBox="0 0 400 200"');
  });
  it('omits labels on edges with none', async () => {
    await render({ spec: flowSpec({ edges: [{ id: 'e2', source: 'b', target: 'c' }] }) });
    const { content } = await exported('SVG');
    expect(content).toContain('marker-end="url(#arrow-e2)"');
    expect(content).not.toContain('fill="white"');
  });
});

describe('StructuredDiagram maximised dialog', () => {
  const dialog = () => document.querySelector<HTMLDialogElement>('dialog.diagram-maximized-dialog');
  async function maximize(props: Partial<React.ComponentProps<typeof StructuredDiagram>> = {}) {
    await render(props);
    const opener = button('Maximize')!;
    opener.focus();
    await click(opener);
    await settle();
    return opener;
  }
  it('opens modally, locks scrolling and restores focus and overflow on return', async () => {
    document.body.style.overflow = 'scroll';
    const opener = await maximize();
    expect(dialog()!.hasAttribute('open')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    await click(dialog()!.querySelector('button[aria-haspopup]') ?? Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === 'Return')!);
    expect(dialog()).toBeNull();
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.activeElement).toBe(opener);
    document.body.style.overflow = '';
  });
  it('closes on backdrop click and Escape, but not on inner clicks', async () => {
    await maximize();
    await click(dialog()!.querySelector('.structured-diagram')!);
    expect(dialog()).not.toBeNull();
    await click(dialog()!);
    expect(dialog()).toBeNull();
    await click(button('Maximize')!);
    await settle();
    const cancel = new Event('cancel', { cancelable: true, bubbles: true });
    await act(async () => { dialog()!.dispatchEvent(cancel); });
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog()).toBeNull();
  });
  it('starts as an overview and offers a readable view for oversized diagrams', async () => {
    vi.mocked(layoutDiagram).mockImplementation((async () => ({ ...defaultLayout(), width: 5000, height: 3000 })) as never);
    await maximize();
    const readable = Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === 'Readable view')!;
    expect(readable.getAttribute('aria-pressed')).toBe('false');
    flow.setViewport.mockClear();
    await click(readable);
    await settle();
    expect(flow.setViewport).toHaveBeenCalledWith({ x: 20, y: 20, zoom: 1 });
    expect(dialog()!.querySelector('.diagram-reading-view')).not.toBeNull();
    expect(dialog()!.textContent).toContain('Scroll to follow the flow.');
    const fit = Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === 'Fit')!;
    await click(fit);
    await settle();
    expect(dialog()!.querySelector('.diagram-reading-view')).toBeNull();
  });
  it('opens as a fitted overview that offers the readable toggle', async () => {
    await maximize();
    expect(Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === 'Readable view')).toBeDefined();
    expect(flow.setViewport).toHaveBeenCalled();
    const resized = Array.from(dialog()!.querySelectorAll('.structured-flow-canvas'));
    expect(resized).toHaveLength(1);
  });
  it('repositions the viewport when the spec changes after choosing readable', async () => {
    vi.mocked(layoutDiagram).mockImplementation((async () => ({ ...defaultLayout(), width: 5000, height: 3000 })) as never);
    await maximize();
    const within = (text: string) => Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === text)!;
    await click(within('Readable view'));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    flow.setViewport.mockClear();
    await act(async () => { root.render(<StructuredDiagram spec={flowSpec({ id: 'flow two' })} source="s" streaming={false} />); });
    await settle();
    expect(flow.setViewport).toHaveBeenCalled();
  });
  it('keeps a sequence diagram scrollable without arrange controls in the dialog', async () => {
    await maximize({ spec: sequenceSpec() });
    expect(dialog()!.querySelector('.structured-sequence')).not.toBeNull();
    const within = (text: string) => Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === text)!;
    expect(within('Arrange').disabled).toBe(true);
    expect(within('Fit').disabled).toBe(true);
    expect(within('Readable view').disabled).toBe(true);
  });
});
