// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const flow = vi.hoisted(() => ({ props: null as any, instance: null as any, initialized: true, fitView: null as any }));

const { mockReactFlowModule } = vi.hoisted(() => ({
  mockReactFlowModule: () => ({
    ReactFlow: (props: any) => {
      flow.props = props;
      React.useEffect(() => { props.onInit?.(flow.instance); }, []);
      return (
        <div data-testid="flow" onDrop={props.onDrop} onDragOver={props.onDragOver}>
          {props.nodes?.map((node: any) => <span key={node.id} data-testid={`node-${node.id}`}>{node.data.summary}</span>)}
          {props.children}
        </div>
      );
    },
    Background: () => null,
    Controls: () => null,
    useNodesInitialized: () => flow.initialized,
    useReactFlow: () => ({ fitView: flow.fitView }),
    applyNodeChanges: (changes: any[], current: any[]) => current.filter(node => !changes.some(change => change.type === 'remove' && change.id === node.id)),
    applyEdgeChanges: (changes: any[], current: any[]) => current.filter(edge => !changes.some(change => change.type === 'remove' && change.id === edge.id)),
    addEdge: (params: any, current: any[]) => [...current, { ...params }],
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    useUpdateNodeInternals: () => vi.fn(),
  }),
}));

vi.mock('../../../decisions-buddy/node_modules/@xyflow/react/dist/esm/index.mjs', mockReactFlowModule);
vi.mock('@xyflow/react', mockReactFlowModule);
vi.mock('../../../decisions-buddy/node_modules/@xyflow/react/dist/style.css', () => ({}));
vi.mock('@xyflow/react/dist/style.css', () => ({}));
vi.mock('../../../decisions-buddy/src/components/AddWatsonxBoxModal.jsx', () => ({
  default: ({ isOpen, existingNode, onClose, onUpdateModel, model }: any) => (isOpen ? (
    <div data-testid="watsonx-box" data-editing={existingNode?.id ?? ''}>
      <button onClick={onClose}>close box</button>
      <button onClick={() => onUpdateModel({ ...model, name: 'From box' })}>apply box</button>
    </div>
  ) : null),
}));

// @ts-expect-error plain JS JSX component outside web tsconfig
import VisualGraphEditor from '../../../decisions-buddy/src/components/canvas/VisualGraphEditor.jsx';

const table = { hitPolicy: 'first', inputs: [{ id: 'in_1', field: 'age', name: 'Age' }], outputs: [{ id: 'out_1', field: 'score' }],
  rules: [{ _id: 'r1', _description: 'One', in_1: '1', out_1: '2' }, { _id: 'r2', in_1: '2' }] };

function model(overrides: Record<string, any> = {}) {
  return { id: 'm', name: 'M', version: 1, graph: {
    nodes: [
      { id: 'in', name: 'In', type: 'inputNode', position: { x: 0, y: 0 } },
      { id: 'dt', name: 'Table', type: 'decisionTableNode', position: { x: 100, y: 0 }, content: table },
      { id: 'sw', type: 'switchNode', content: { statements: [{ id: 's1', condition: 'a' }, { id: 's2' }] } },
      { id: 'ex', name: 'Expr', type: 'expressionNode', position: { x: 300, y: 0 }, content: { expressions: [{ key: 'k', value: 'v' }, { key: 'k2', value: 'v2' }] } },
      { id: 'fn', name: 'Fn', type: 'functionNode', position: { x: 400, y: 0 }, content: {} },
      { id: 'ai', name: 'AI', type: 'watsonxAiNode', position: { x: 500, y: 0 }, content: {} },
      { id: 'ib', name: 'Infer', type: 'inferenceNode', position: { x: 600, y: 0 }, content: {} },
      { id: 'out', name: 'Out', type: 'outputNode', position: { x: 700, y: 0 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'in', targetId: 'dt' },
      { id: 'e2', sourceId: 'dt', targetId: 'sw' },
      { id: 'e3', sourceId: 'sw', targetId: 'ex', sourceHandle: 's1' },
      { id: 'e4', sourceId: 'sw', targetId: 'out', sourceHandle: 's2', targetHandle: 't' },
    ],
    vocabulary: [],
  }, ...overrides };
}

describe('VisualGraphEditor behaviour', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onSaveGraph: any;
  const setter = (proto: any) => Object.getOwnPropertyDescriptor(proto, 'value')!.set!;

  const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === label) as HTMLButtonElement;
  const click = (label: string) => act(async () => { button(label).click(); });
  const type = (selector: string, value: string) => act(async () => {
    const input = document.querySelector(selector) as HTMLInputElement;
    setter(window.HTMLInputElement.prototype).call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const choose = (selector: string, value: string) => act(async () => {
    const input = document.querySelector(selector) as HTMLSelectElement;
    setter(window.HTMLSelectElement.prototype).call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const render = (props: Record<string, any> = {}) => act(async () => {
    root.render(<VisualGraphEditor model={model()} editable onSaveGraph={onSaveGraph} {...props} />);
  });
  const canvasNode = (id: string) => flow.props.nodes.find((node: any) => node.id === id);
  const edit = (id: string) => act(async () => { canvasNode(id).data.onEdit(id); });
  const lastGraph = () => onSaveGraph.mock.calls.at(-1)[0].graph;
  const savedNode = (id: string) => lastGraph().nodes.find((node: any) => node.id === id);
  const paletteItem = (label: string) => document.querySelector(`[title^="Drag or click to add ${label} ("]`) as HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    flow.props = null;
    flow.initialized = true;
    flow.fitView = vi.fn();
    flow.instance = { fitView: vi.fn(), screenToFlowPosition: vi.fn(({ x, y }: any) => ({ x: x + 1, y: y + 1 })) };
    onSaveGraph = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('canvas mapping', () => {
    it('derives summaries, fallback names and positions', async () => {
      await render();
      expect(canvasNode('dt').data.summary).toBe('2 Rules (first)');
      expect(canvasNode('fn').data.summary).toContain('Unsupported');
      expect(canvasNode('sw').data.name).toBe('sw');
      expect(canvasNode('sw').position).toEqual({ x: 580, y: 150 });
      expect(canvasNode('fn').data.onEdit).toBeUndefined();
      expect(canvasNode('fn').data.onDelete).toBeTypeOf('function');
    });

    it('summarises a table without rules or policy', async () => {
      const source = model();
      source.graph.nodes[1] = { id: 'dt', name: 'Table', type: 'decisionTableNode' } as any;
      await render({ model: source });
      expect(canvasNode('dt').data.summary).toBe('0 Rules (first)');
    });

    it('renders nothing on the canvas for a model without graph', async () => {
      await render({ model: { id: 'x' } });
      expect(flow.props.nodes).toEqual([]);
      expect(button('Auto Layout').disabled).toBe(true);
    });

    it('hides edit and delete callbacks in read-only mode', async () => {
      await render({ editable: false });
      expect(canvasNode('dt').data.onEdit).toBeUndefined();
      expect(canvasNode('dt').data.onDelete).toBeUndefined();
    });

    it('replaces the canvas after an external graph update and refits', async () => {
      vi.useFakeTimers();
      await render();
      flow.instance.fitView.mockClear();
      const next = model();
      next.graph = { nodes: [{ id: 'only', type: 'inputNode' }], edges: [] } as any;
      await render({ model: next });
      expect(flow.props.nodes.map((node: any) => node.id)).toEqual(['only']);
      await act(async () => { vi.advanceTimersByTime(60); });
      expect(flow.instance.fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 250 }));
    });

    it('does not reset when the parent echoes its own published graph', async () => {
      await render();
      await act(async () => { flow.props.onNodesChange([{ type: 'remove', id: 'fn' }]); });
      const echoed = onSaveGraph.mock.calls.at(-1)[0];
      await render({ model: echoed });
      expect(flow.props.nodes.some((node: any) => node.id === 'fn')).toBe(false);
    });

    it('preserves handles when exporting edges', async () => {
      await render();
      await act(async () => { flow.props.onEdgesChange([{ type: 'remove', id: 'e1' }]); });
      const edge = lastGraph().edges.find((item: any) => item.id === 'e4');
      expect(edge).toMatchObject({ sourceId: 'sw', targetId: 'out', sourceHandle: 's2', targetHandle: 't' });
    });
  });

  describe('fit behaviour', () => {
    function animationFrames() {
      vi.stubGlobal('requestAnimationFrame', (run: any) => { run(); return 1; });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
    }

    it.each([[false, 250], [true, 0]])('fits a visible flow, reduced motion %s', async (reduced, duration) => {
      vi.useFakeTimers();
      animationFrames();
      window.matchMedia = vi.fn().mockReturnValue({ matches: reduced });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 200 } as DOMRect);
      await render();
      await act(async () => { vi.advanceTimersByTime(30); });
      expect(flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ duration }));
    });

    it.each([[{ width: 0, height: 100 }], [{ width: 100, height: 0 }]])('skips hidden flow %j', async rect => {
      vi.useFakeTimers();
      animationFrames();
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
      await render();
      await act(async () => { vi.advanceTimersByTime(30); });
      expect(flow.fitView).not.toHaveBeenCalled();
    });

    it('does nothing while inactive or not initialized', async () => {
      vi.useFakeTimers();
      animationFrames();
      await render({ active: false });
      flow.initialized = false;
      await render({ active: true });
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(flow.fitView).not.toHaveBeenCalled();
    });

    it.each(['Zoom to Flow', 'Reset view'])('%s fits through the instance', async label => {
      await render();
      flow.instance.fitView.mockClear();
      await click(label);
      expect(flow.instance.fitView).toHaveBeenCalledTimes(1);
    });

    it('zoom is inert before initialisation', async () => {
      const instance = flow.instance;
      flow.instance = null;
      await render();
      await click('Zoom to Flow');
      expect(instance.fitView).not.toHaveBeenCalled();
    });
  });

  describe('flow permissions', () => {
    it('read-only mode only permits selection and dimensions', async () => {
      await render({ editable: false });
      await act(async () => {
        flow.props.onNodesChange([{ type: 'remove', id: 'dt' }, { type: 'select', id: 'dt' }]);
        flow.props.onEdgesChange([{ type: 'remove', id: 'e1' }, { type: 'select', id: 'e1' }]);
        flow.props.onConnect({ source: 'in', target: 'out' });
      });
      expect(flow.props.nodes).toHaveLength(8);
      expect(flow.props.edges).toHaveLength(4);
      expect(onSaveGraph).not.toHaveBeenCalled();
    });

    it('selection-only changes do not publish in edit mode', async () => {
      await render();
      await act(async () => {
        flow.props.onNodesChange([{ type: 'select', id: 'dt' }]);
        flow.props.onEdgesChange([{ type: 'select', id: 'e1' }]);
      });
      expect(onSaveGraph).not.toHaveBeenCalled();
    });

    it('connecting nodes publishes a new edge', async () => {
      await render();
      await act(async () => { flow.props.onConnect({ source: 'in', target: 'out', sourceHandle: 'h' }); });
      expect(lastGraph().edges.at(-1)).toMatchObject({ sourceId: 'in', targetId: 'out', sourceHandle: 'h' });
    });

    it('deleting a node removes its edges', async () => {
      await render();
      await act(async () => { canvasNode('dt').data.onDelete('dt'); });
      expect(lastGraph().nodes.some((node: any) => node.id === 'dt')).toBe(false);
      expect(flow.props.edges.map((edge: any) => edge.id)).toEqual(['e3', 'e4']);
    });

    it('run in read-only mode evaluates without saving', async () => {
      const onEvaluate = vi.fn();
      await render({ editable: false, onEvaluate });
      await click('Run saved decision');
      expect(onEvaluate).toHaveBeenCalledTimes(1);
      expect(onSaveGraph).not.toHaveBeenCalled();
    });

    it('shows busy label and result panel', async () => {
      const onShowResults = vi.fn();
      await render({ isBusy: true, evaluationResult: { result: { a: 1 } }, onShowResults });
      expect(button('Working…').disabled).toBe(true);
      await click('View input and execution trace');
      expect(onShowResults).toHaveBeenCalled();
      expect(host.textContent).toContain('Decision result');
    });
  });

  describe('palette', () => {
    const newest = () => lastGraph().nodes.at(-1);
    it.each([
      ['Input Data', 'inputNode', 'Request Input'],
      ['Decision Table', 'decisionTableNode', 'Decision Table'],
      ['Expression', 'expressionNode', 'Expression Calc'],
      ['Switch Router', 'switchNode', 'Switch Router'],
      ['watsonx.ai', 'watsonxAiNode', 'watsonx.ai Reasoning'],
      ['watsonx ML', 'watsonxMlNode', 'watsonx ML Scorer'],
      ['Output Verdict', 'outputNode', 'Response Output'],
      ['Business Rule', 'actionRuleNode', null],
      ['Fact Inference', 'inferenceNode', null],
      ['Parallel Fork', 'forkNode', null],
      ['Parallel Join', 'joinNode', null],
    ])('clicking %s appends a %s', async (label, nodeType, name) => {
      await render();
      const item = paletteItem(label);
      expect(item).not.toBeNull();
      await act(async () => { item.click(); });
      expect(newest().type).toBe(nodeType);
      if (name) expect(newest().name).toBe(name);
      expect(newest().position.x).toBeGreaterThan(700);
    });

    it('adds a connecting edge from the last node unless it is an output or the new node is an input', async () => {
      const source = model();
      source.graph = { nodes: [{ id: 'a', type: 'expressionNode', position: { x: 1, y: 2 } }], edges: [] } as any;
      await render({ model: source });
      await act(async () => { paletteItem('Decision Table').click(); });
      const newNode = lastGraph().nodes.at(-1);
      expect(flow.props.edges.at(-1)).toMatchObject({ source: 'a', target: newNode.id });
      const count = flow.props.edges.length;
      await act(async () => { paletteItem('Input Data').click(); });
      expect(flow.props.edges).toHaveLength(count);
    });

    it('starts at a default position on an empty canvas', async () => {
      const source = model();
      source.graph = { nodes: [], edges: [] } as any;
      await render({ model: source });
      await act(async () => { paletteItem('Input Data').click(); });
      expect(flow.props.nodes).toHaveLength(1);
      expect(flow.props.edges).toHaveLength(0);
    });

    it.each([['Enter', 1], [' ', 1], ['x', 0]])('keyboard %j adds %i nodes', async (key, added) => {
      await render();
      await act(async () => { paletteItem('Expression').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
      expect(flow.props.nodes).toHaveLength(8 + (added as number));
    });

    it('is inert when read-only', async () => {
      await render({ editable: false });
      await act(async () => {
        paletteItem('Expression').click();
        paletteItem('Expression').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(flow.props.nodes).toHaveLength(8);
    });

    it('drag start records the node type', async () => {
      await render();
      const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
      const event = new Event('dragstart', { bubbles: true }) as any;
      event.dataTransfer = dataTransfer;
      await act(async () => { paletteItem('Switch Router').dispatchEvent(event); });
      expect(dataTransfer.setData).toHaveBeenCalledWith('application/reactflow-nodetype', 'switchNode');
      expect(dataTransfer.effectAllowed).toBe('move');
    });
  });

  describe('drop onto canvas', () => {
    async function drop(nodeType: string) {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as any;
      event.dataTransfer = { getData: () => nodeType };
      event.clientX = 10;
      event.clientY = 20;
      await act(async () => { document.querySelector('[data-testid="flow"]')!.dispatchEvent(event); });
      return event;
    }

    it.each([
      ['inputNode', 'Request Input'], ['decisionTableNode', 'Decision Table'], ['expressionNode', 'Expression Calc'],
      ['watsonxAiNode', 'watsonx.ai Reasoning'], ['watsonxMlNode', 'watsonx ML Scorer'], ['switchNode', 'Switch Router'],
      ['outputNode', 'Response Output'],
    ])('creates %s with its defaults', async (nodeType, name) => {
      await render();
      await drop(nodeType);
      const node = lastGraph().nodes.at(-1);
      expect(node).toMatchObject({ type: nodeType, name, position: { x: 11, y: 21 } });
    });

    it('uses modern defaults for modern nodes', async () => {
      await render();
      await drop('forkNode');
      expect(lastGraph().nodes.at(-1).type).toBe('forkNode');
      expect(lastGraph().nodes.at(-1).name).not.toBe('New Node');
    });

    it.each([['functionNode'], ['']])('refuses node type %j', async nodeType => {
      await render();
      await drop(nodeType);
      expect(onSaveGraph).not.toHaveBeenCalled();
    });

    it('computes position from bounds before initialisation', async () => {
      flow.instance = null;
      await render();
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 2, top: 5, width: 1, height: 1 } as DOMRect);
      await drop('inputNode');
      expect(lastGraph().nodes.at(-1).position).toEqual({ x: 8, y: 15 });
    });

    it('a dropped node can then be edited and deleted', async () => {
      await render();
      await drop('expressionNode');
      const id = flow.props.nodes.at(-1).id;
      await edit(id);
      expect(document.body.textContent).toContain('Configure expressionNode');
      await act(async () => { canvasNode(id).data.onDelete(id); });
      expect(canvasNode(id)).toBeUndefined();
    });

    it('read-only drop is refused', async () => {
      await render({ editable: false });
      await drop('inputNode');
      expect(flow.props.nodes).toHaveLength(8);
    });
  });

  describe('auto layout', () => {
    it('orders connected nodes by depth', async () => {
      await render();
      await click('Auto Layout');
      const position = (id: string) => savedNode(id).position.x;
      expect(position('in')).toBeLessThan(position('dt'));
      expect(position('dt')).toBeLessThan(position('sw'));
      expect(position('sw')).toBeLessThan(position('ex'));
    });

    it('handles cycles and dangling edges without dropping nodes', async () => {
      const source = model();
      source.graph = { nodes: [{ id: 'a', type: 'expressionNode' }, { id: 'b', type: 'expressionNode' }],
        edges: [{ id: 'x', sourceId: 'a', targetId: 'b' }, { id: 'y', sourceId: 'b', targetId: 'a' }, { id: 'z', sourceId: 'ghost', targetId: 'gone' }] } as any;
      await render({ model: source });
      await click('Auto Layout');
      expect(flow.props.nodes.map((node: any) => node.id)).toEqual(['a', 'b']);
      expect(flow.props.nodes.every((node: any) => Number.isFinite(node.position.x))).toBe(true);
    });
  });

  describe('decision table modal', () => {
    it('adds input and output columns, edits and deletes rules', async () => {
      await render();
      await edit('dt');
      await type('#new-col-field', 'city');
      await click('Add Column');
      await type('#new-col-field', 'bonus');
      await type('#new-col-name', 'Bonus');
      await choose('#new-col-type', 'output');
      await click('Add Column');
      await click('Add Rule Row');
      const cells = document.querySelectorAll('.cds--modal.is-visible table input');
      await act(async () => {
        const first = cells[0] as HTMLInputElement;
        setter(window.HTMLInputElement.prototype).call(first, 'Renamed rule');
        first.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click('Save Node Rules');
      const content = savedNode('dt').content;
      expect(content.inputs.map((column: any) => column.name)).toEqual(['Age', 'city']);
      expect(content.outputs.map((column: any) => column.name ?? column.field)).toEqual(['score', 'Bonus']);
      expect(content.rules).toHaveLength(3);
      expect(content.rules[0]._description).toBe('Renamed rule');
      expect(content.rules[2]._description).toBe('Rule 3');
      const inputColumn = content.inputs[1].id, outputColumn = content.outputs[1].id;
      expect(content.rules[0][inputColumn]).toBe('-');
      expect(content.rules[0][outputColumn]).toBe('0');
    });

    it('ignores a column without a field and can cancel', async () => {
      await render();
      await edit('dt');
      await click('Add Column');
      expect(document.body.textContent).not.toContain('col_');
      await click('Cancel');
      expect(onSaveGraph).not.toHaveBeenCalled();
    });

    it('deletes a rule row and updates input and output cells', async () => {
      await render();
      await edit('dt');
      const rows = () => document.querySelectorAll('.cds--modal.is-visible tbody tr');
      const firstRowInputs = () => rows()[0].querySelectorAll('input');
      await act(async () => {
        for (const [index, value] of [[1, 'in-cell'], [2, 'out-cell']] as const) {
          const input = firstRowInputs()[index] as HTMLInputElement;
          setter(window.HTMLInputElement.prototype).call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      const removal = rows()[1].querySelector('button') as HTMLButtonElement;
      await act(async () => { removal.click(); });
      expect(rows()).toHaveLength(1);
      await click('Save Node Rules');
      expect(savedNode('dt').content.rules).toEqual([expect.objectContaining({ in_1: 'in-cell', out_1: 'out-cell' })]);
      expect(canvasNode('dt').data.summary).toBe('1 Rules (first)');
    });

    it('uses starter columns for an empty table node', async () => {
      const source = model();
      source.graph.nodes[1] = { id: 'dt', name: 'Table', type: 'decisionTableNode', position: { x: 1, y: 1 } } as any;
      await render({ model: source });
      await edit('dt');
      await click('Save Node Rules');
      expect(savedNode('dt').content.inputs[0].field).toBe('customer.tier');
      expect(savedNode('dt').content.rules[0]._description).toBe('Default Rule');
    });

    it('renames a node', async () => {
      await render();
      await edit('dt');
      await type('#modal-node-name', 'Renamed');
      await click('Save Node Rules');
      expect(savedNode('dt').name).toBe('Renamed');
    });
  });

  describe('switch modal', () => {
    const conditions = () => Array.from(document.querySelectorAll<HTMLInputElement>('[id^="branch-condition-"]')).map(input => input.value);

    it('adds, edits, reorders and removes branches; removed branch edges disappear', async () => {
      await render();
      await edit('sw');
      expect(conditions()).toEqual(['a', '']);
      await type('#branch-condition-1', 'b');
      await click('Move branch 2 up');
      expect(conditions()).toEqual(['b', 'a']);
      await click('Add branch');
      expect(conditions()).toHaveLength(3);
      await click('Remove branch 3');
      await click('Remove branch 1');
      await click('Save Node Rules');
      expect(savedNode('sw').content.statements.map((item: any) => item.id)).toEqual(['s1']);
      expect(flow.props.edges.map((edge: any) => edge.id)).toEqual(['e1', 'e2', 'e3']);
      expect(canvasNode('sw').data.summary).toBe('1 Branches');
    });

    it.each([
      ['duplicate', [{ id: 's', condition: '' }, { id: 's', condition: '' }]],
      ['blank', [{ id: '  ', condition: '' }]],
    ])('refuses %s identifiers', async (_label, statements) => {
      const source = model();
      source.graph.nodes[2] = { id: 'sw', type: 'switchNode', content: { statements } } as any;
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await render({ model: source });
      await edit('sw');
      await click('Save Node Rules');
      expect(document.body.textContent).toContain('Branch identifiers must be unique and nonempty.');
      expect(onSaveGraph).not.toHaveBeenCalled();
    });
  });

  describe('expression modal', () => {
    it('adds and deletes calculations, ignoring incomplete input', async () => {
      await render();
      await edit('ex');
      await click('Add Formula');
      await type('#new-exp-key', 'total');
      await click('Add Formula');
      await type('#new-exp-val', 'a + b');
      await click('Add Formula');
      const row = Array.from(document.querySelectorAll('code')).find(element => element.textContent === 'k')!.parentElement!;
      await act(async () => { (row.querySelector('button') as HTMLElement).click(); });
      await click('Save Node Rules');
      expect(savedNode('ex').content.expressions).toEqual([{ key: 'k2', value: 'v2' }, { key: 'total', value: 'a + b' }]);
      expect(canvasNode('ex').data.summary).toBe('2 Expressions');
    });
  });

  describe('modern nodes and watsonx', () => {
    it('shows a save error for invalid modern content', async () => {
      const source = model();
      source.graph.nodes[6] = { id: 'ib', name: 'Infer', type: 'inferenceNode', content: { rules: [], maxCycles: 0, conflictResolution: 'priority' } } as any;
      await render({ model: source });
      await edit('ib');
      await click('Save Node Rules');
      expect(document.body.textContent).toContain('Firing limit must be 1–500.');
      expect(onSaveGraph).not.toHaveBeenCalled();
    });

    it('saves valid modern content with its default summary', async () => {
      await render();
      await edit('ib');
      await click('Save Node Rules');
      expect(canvasNode('ib').data.summary).toBe('Fact Inference');
      expect(savedNode('ib').content.maxCycles).toBe(50);
    });

    it('opens the watsonx box for existing nodes and applies updates', async () => {
      await render();
      await edit('ai');
      const box = document.querySelector('[data-testid="watsonx-box"]') as HTMLElement;
      expect(box.dataset.editing).toBe('ai');
      await click('apply box');
      expect(onSaveGraph.mock.calls.at(-1)[0].name).toBe('From box');
      await click('close box');
      expect(document.querySelector('[data-testid="watsonx-box"]')).toBeNull();
    });

    it('new watsonx node opened after creation uses canvas values', async () => {
      await render();
      await act(async () => { paletteItem('watsonx.ai').click(); });
      const id = flow.props.nodes.at(-1).id;
      await edit(id);
      expect((document.querySelector('[data-testid="watsonx-box"]') as HTMLElement).dataset.editing).toBe(id);
    });

    it('opens an empty watsonx box from the toolbar', async () => {
      await render();
      await click('+ watsonx Box');
      expect((document.querySelector('[data-testid="watsonx-box"]') as HTMLElement).dataset.editing).toBe('');
    });

    it('function nodes cannot be edited even through a stale handler', async () => {
      await render();
      const stale = canvasNode('dt').data.onEdit;
      await act(async () => { stale('fn'); });
      expect(document.querySelector('.cds--modal.is-visible')).toBeNull();
      await act(async () => { stale('missing'); });
      expect(document.querySelector('.cds--modal.is-visible')).toBeNull();
    });
  });
});
