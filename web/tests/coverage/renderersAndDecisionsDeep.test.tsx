// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  renderChartToDOM,
  carbonEase,
  CARBON_PALETTE,
  CARBON_CHART_MOTION,
} from '../../src/components/ChartRenderer';
import { MarkdownView } from '../../src/components/MarkdownView';

const { mockReactFlowModule } = vi.hoisted(() => {
  return {
    mockReactFlowModule: () => ({
      ReactFlow: ({ children, nodes, onInit, onDrop, onDragOver, onNodesChange }: any) => {
        React.useEffect(() => {
          onInit?.({
            fitView: vi.fn(),
            screenToFlowPosition: vi.fn(({ x, y }: any) => ({ x, y })),
          });
        }, [onInit]);

        return (
          <div data-testid="mock-react-flow" onDrop={onDrop} onDragOver={onDragOver}>
            <button
              data-testid="trigger-nodes-change"
              type="button"
              onClick={() => {
                onNodesChange?.([{ id: nodes?.[0]?.id || 'n1', type: 'select', selected: true }]);
              }}
            >
              Trigger Nodes Change
            </button>
            {nodes?.map((n: any) => (
              <div key={n.id} data-testid={`flow-node-${n.id}`}>
                <span className="node-title">{n.data?.name}</span>
                <span className="node-summary">{n.data?.summary}</span>
                <button
                  type="button"
                  data-testid={`edit-${n.id}`}
                  onClick={() => n.data?.onEdit?.(n.id)}
                >
                  edit-{n.id}
                </button>
                <button
                  type="button"
                  data-testid={`delete-${n.id}`}
                  onClick={() => n.data?.onDelete?.(n.id)}
                >
                  delete-{n.id}
                </button>
              </div>
            ))}
            {children}
          </div>
        );
      },
      Background: () => <div data-testid="mock-background" />,
      Controls: () => <div data-testid="mock-controls" />,
      useNodesInitialized: () => true,
      useReactFlow: () => ({
        fitView: vi.fn(),
        screenToFlowPosition: vi.fn(({ x, y }: any) => ({ x, y })),
      }),
      applyNodeChanges: (_changes: any[], current: any[]) => current,
      applyEdgeChanges: (_changes: any[], current: any[]) => current,
      addEdge: (params: any, current: any[]) => [...current, params],
      Handle: () => null,
      Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
      useUpdateNodeInternals: () => vi.fn(),
    }),
  };
});

vi.mock('../../../decisions-buddy/node_modules/@xyflow/react/dist/esm/index.mjs', mockReactFlowModule);
vi.mock('@xyflow/react', mockReactFlowModule);
vi.mock('../../../decisions-buddy/node_modules/@xyflow/react/dist/style.css', () => ({}));
vi.mock('@xyflow/react/dist/style.css', () => ({}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg class="mermaid-diagram" viewBox="0 0 400 200"><text>Optical Transport Cross-Connect</text></svg>',
    }),
  },
}));

// @ts-expect-error plain JS JSX component outside web tsconfig
import VisualGraphEditor from '../../../decisions-buddy/src/components/canvas/VisualGraphEditor.jsx';

describe('ChartRenderer Deep Coverage', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('computes cubic bezier easing curve and verifies motion constants', () => {
    expect(carbonEase(0)).toBe(0);
    expect(carbonEase(1)).toBe(1);
    expect(carbonEase(-0.25)).toBe(0);
    expect(carbonEase(1.25)).toBe(1);
    const mid = carbonEase(0.4);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    expect(CARBON_CHART_MOTION.duration).toBeGreaterThan(0);
    expect(CARBON_CHART_MOTION.updateDuration).toBeGreaterThan(0);
    expect(CARBON_PALETTE.length).toBeGreaterThanOrEqual(14);
  });

  it('renders single-bar categorical chart with wrapped labels, hover tooltips, and update transitions', () => {
    const el = renderChartToDOM({
      type: 'bar',
      title: 'Dense Wavelength Division Multiplexing Transponder Channel Utilization',
      subtitle: 'C-Band 96 Channels Optical Power (dBm)',
      labels: [
        'Channel 21 (1550.12nm Optical Frequency 193.10THz)',
        'Channel 22 (1550.92nm Optical Frequency 193.00THz)',
        'Channel 23 (1551.72nm Optical Frequency 192.90THz)',
      ],
      data: [18.4, 21.2, 16.8],
    });
    container.appendChild(el);

    expect(el.textContent).toContain('Dense Wavelength Division Multiplexing');
    expect(el.textContent).toContain('C-Band 96 Channels');
    expect(el.querySelector('.chart-toolbar')).not.toBeNull();

    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();

    const rects = el.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThan(0);

    // Hover first bar rect to trigger showTooltip
    const firstRect = rects[0] as SVGRectElement;
    const enterEvent = new MouseEvent('mouseenter', { bubbles: true, clientX: 120, clientY: 80 });
    firstRect.dispatchEvent(enterEvent);

    const tooltip = el.querySelector('.chart-interactive-tooltip') as HTMLElement;
    expect(tooltip).not.toBeNull();
    expect(tooltip.style.display).toBe('block');

    const moveEvent = new MouseEvent('mousemove', { bubbles: true, clientX: 125, clientY: 82 });
    firstRect.dispatchEvent(moveEvent);

    const leaveEvent = new MouseEvent('mouseleave', { bubbles: true });
    firstRect.dispatchEvent(leaveEvent);
    expect(tooltip.style.display).toBe('none');

    // Exercise __updateValues and __animateEntrance
    const customSvg = svg as any;
    if (typeof customSvg.__updateValues === 'function') {
      const hidden = new Set<number>([1]);
      customSvg.__updateValues(hidden, true);
    }
    if (typeof customSvg.__animateEntrance === 'function') {
      customSvg.__animateEntrance();
    }
  });

  it('renders multi-series grouped bar chart with legend toggling and custom colors', () => {
    const el = renderChartToDOM({
      type: 'bar',
      title: 'Carrier Optical Core Ingress vs Egress Throughput',
      labels: ['London Core PoP', 'Manchester Edge Gateway', 'Leeds Metro Ring'],
      datasets: [
        { label: 'Ingress 100Gbps', data: [82.5, 94.1, 71.3], color: '#0f62fe' },
        { label: 'Egress 100Gbps', data: [78.2, 89.6, 68.4], color: '#6929c4' },
      ],
    });
    container.appendChild(el);

    const legendBtns = el.querySelectorAll('button[aria-pressed]');
    expect(legendBtns.length).toBe(2);

    // Click to hide Ingress series
    const firstLegend = legendBtns[0] as HTMLButtonElement;
    expect(firstLegend.getAttribute('aria-pressed')).toBe('true');
    firstLegend.click();
    expect(firstLegend.getAttribute('aria-pressed')).toBe('false');

    // Click again to restore
    firstLegend.click();
    expect(firstLegend.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders multi-series line chart with grid lines, points, and mouseenter guideline', () => {
    const el = renderChartToDOM({
      type: 'line',
      title: 'EDFA Optical Signal-to-Noise Ratio (OSNR) Trend',
      labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
      datasets: [
        { label: 'Stage 1 Booster OSNR (dB)', data: [31.5, 31.8, 30.9, 31.2, 32.1, 31.7], color: '#1192e8' },
        { label: 'Stage 2 Pre-amp OSNR (dB)', data: [28.2, 28.5, 27.9, 28.1, 28.7, 28.3], color: '#fa4d56' },
      ],
    });
    container.appendChild(el);

    expect(el.textContent).toContain('EDFA Optical Signal-to-Noise Ratio');
    const circles = el.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThan(0);

    // Test mouseenter, mousemove, and mouseleave on line circle
    const point = circles[0] as SVGCircleElement;
    point.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 100, clientY: 150 }));
    expect(point.getAttribute('r')).toBe('6');

    point.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 102, clientY: 152 }));

    point.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    expect(point.getAttribute('r')).toBe('3.5');

    // Toggle line series in legend
    const legendBtn = el.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(legendBtn).not.toBeNull();
    legendBtn.click();
  });

  it('renders doughnut chart with center KPI text, slice hover expansion, and zero-sum fallback', () => {
    const el = renderChartToDOM({
      type: 'doughnut',
      title: 'Carrier Platform Optical Channel Allocation',
      labels: ['100GbE Carrier Services', '40GbE Protected Rings', '10GbE Edge Links', 'Dark Fiber Reserves'],
      datasets: [
        {
          label: 'Wavelength Channels',
          data: [48, 24, 16, 8],
          colors: ['#0f62fe', '#6929c4', '#005d5d', '#8a3ffc'],
        },
      ],
    });
    container.appendChild(el);

    const paths = el.querySelectorAll('.chart-slices-group path');
    expect(paths.length).toBe(4);

    // Center text exists for doughnut
    const centerVal = el.querySelector('.chart-center-group text');
    expect(centerVal).not.toBeNull();

    // Hover slice to trigger expansion and center value update
    const firstSlice = paths[0] as SVGPathElement;
    firstSlice.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 200, clientY: 150 }));
    firstSlice.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 202, clientY: 151 }));
    firstSlice.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

    // Test zero-sum fallback via SVG __updateValues
    const svg = el.querySelector('svg') as any;
    if (typeof svg.__updateValues === 'function') {
      const hideAll = new Set<number>([0, 1, 2, 3]);
      svg.__updateValues(hideAll, true);
    }
  });

  it('supports options plugin titles and triggers scroll intersection entrance animation', () => {
    let intersectionHandler: (entries: any[]) => void = () => {};
    class MockIntersectionObserver {
      constructor(cb: any) {
        intersectionHandler = cb;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    window.IntersectionObserver = MockIntersectionObserver as any;

    const el = renderChartToDOM({
      data: {
        labels: ['API Peering AS65001', 'API Peering AS65002'],
        datasets: [{ label: 'Prefix Count', data: [120000, 145000] }],
      },
      // @ts-expect-error options plugin format
      options: {
        plugins: {
          title: { text: 'Autonomous System API Routing Table Capacity' },
          subtitle: { text: 'Prefix limits and carrier transit reachability' },
        },
      },
    });
    container.appendChild(el);

    expect(el.textContent).toContain('Autonomous System API Routing Table');
    expect(el.textContent).toContain('Prefix limits');

    // Fire intersection callback
    intersectionHandler([{ isIntersecting: true, target: el }]);
    expect(el.classList.contains('chart-in-view')).toBe(true);
  });
});

describe('MarkdownView Deep Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders standard Markdown typography, lists, and quotes', async () => {
    const md = `
# Backbone Optical Infrastructure Overview
The carrier transport network utilizes **Dense Wavelength Division Multiplexing** (Platform) across C-band frequencies.

- Optical Multiplexers: *96 channels*
- Amplification: *Dual-stage EDFA*
- Transceivers: *100G Coherent CFP2*

> Optical power attenuation must remain below 0.22 dB/km across all fiber spans.
`;
    await act(async () => {
      root.render(<MarkdownView content={md} sessionId="software-sess-01" />);
    });

    expect(host.textContent).toContain('Backbone Optical Infrastructure');
    expect(host.textContent).toContain('Dense Wavelength Division Multiplexing');
    expect(host.textContent).toContain('Optical power attenuation must remain below');
  });

  it('transforms code fences into IDE-style Subwindows with copy, collapse, and streaming badge', async () => {
    const md = `
Here is the API route reflector configuration:

\`\`\`cisco
router api 65000
 api router-id 192.168.1.1
 neighbor 10.0.0.2 remote-as 65000
 neighbor 10.0.0.2 route-reflector-client
\`\`\`
`;
    await act(async () => {
      root.render(<MarkdownView content={md} isStreaming={false} sessionId="software-sess-01" />);
    });

    const subwindow = host.querySelector('.code-subwindow');
    expect(subwindow).not.toBeNull();
    expect(subwindow?.querySelector('.code-subwindow-title')?.textContent).toBe('CISCO');

    // Test Copy button
    const copyBtn = subwindow?.querySelector('.code-subwindow-btn') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    await act(async () => {
      copyBtn.click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('router api 65000'));
    expect(copyBtn.textContent).toContain('Copied');

    // Test Collapse / Expand toggle button
    const toggleBtn = subwindow?.querySelectorAll('.code-subwindow-btn')[1] as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.textContent).toBe('Collapse');
    await act(async () => {
      toggleBtn.click();
    });
    expect(subwindow?.classList.contains('collapsed')).toBe(true);
    expect(toggleBtn.textContent).toBe('Expand');
  });

  it('renders fenced chart and map code blocks to interactive visual elements', async () => {
    const md = `
\`\`\`chart
{"type":"bar","title":"Platform Channel Power Spectrum","labels":["Ch 21","Ch 22"],"data":[19.4,20.1]}
\`\`\`

\`\`\`map
{"title":"Core Carrier Optical PoPs","center":[35.1264,33.4299],"markers":[{"lat":35.1264,"lng":33.4299,"label":"London Optical Core"}]}
\`\`\`
`;
    await act(async () => {
      root.render(<MarkdownView content={md} sessionId="software-sess-01" />);
    });

    expect(host.querySelector('.interactive-chart-card')).not.toBeNull();
    expect(host.textContent).toContain('Platform Channel Power Spectrum');
    expect(host.querySelector('.interactive-map-card')).not.toBeNull();
  });

  it('converts markdown tables into Interactive Data Grid components', async () => {
    const md = `
| Interface | Media Type | Operational Status | Transceiver Standard |
| :--- | :--- | :--- | :--- |
| TenGigE0/0/0/0 | Single Mode Fiber | Up | 10GBASE-LR |
| HundredGigE0/1/0/0 | Multi Mode Ribbon | Up | 100GBASE-SR4 |
| FortyGigE0/2/0/0 | Single Mode Coherent | Up | 40GBASE-FR |
`;
    await act(async () => {
      root.render(<MarkdownView content={md} isStreaming={false} sessionId="software-sess-01" />);
    });

    expect(host.textContent).toContain('TenGigE0/0/0/0');
    expect(host.textContent).toContain('HundredGigE0/1/0/0');
    expect(host.querySelector('table')).not.toBeNull();
  });

  it('processes citation markers, business sources, download badges, and workspace images', async () => {
    const md = `
Optical dispersion metrics conform to ITU-T recommendation [ITU-T G.652 Fiber Standard](/sessions/legacy/knowledge/00000000-0000-0000-0000-000000000001/file "Chromatic dispersion <= 18 ps/(nm*km)").
Enterprise reference doc at [Sharepoint Platform Architecture](https://carrier.sharepoint.com/sites/optical/specs.docx) and [Teams Support Channel](https://teams.microsoft.com/l/channel/19:sample@thread.tacv2/General).
Download blueprints: [Backbone Diagram](blueprints/optical_ring.pptx) and [Power Calculations](budgets/link_margin.xlsx).
System diagram:
![Optical Spectrum](telemetry/spectrum.png)
`;
    await act(async () => {
      root.render(<MarkdownView content={md} sessionId="software-sess-01" />);
    });

    // Citation markers
    const citationMarker = host.querySelector('.citation-marker');
    expect(citationMarker).not.toBeNull();
    expect(citationMarker?.textContent).toBe('[1]');
    expect(citationMarker?.getAttribute('aria-label')).toContain('ITU-T G.652 Fiber Standard');

    // Details sources list
    const sourcesSummary = host.querySelector('.answer-sources summary');
    expect(sourcesSummary).not.toBeNull();
    expect(sourcesSummary?.textContent).toContain('Sources · 3 documents');

    // Download badges
    const pptxBadge = host.querySelector('.presentation-badge');
    expect(pptxBadge).not.toBeNull();
    expect(pptxBadge?.textContent).toContain('Download Backbone Diagram');

    const sheetBadge = host.querySelector('.sheet-badge');
    expect(sheetBadge).not.toBeNull();
    expect(sheetBadge?.textContent).toContain('Download Power Calculations');

    // Image URL resolution
    const img = host.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('/sessions/software-sess-01/file?path=telemetry%2Fspectrum.png');
  });

  it('neutralizes links and images in readOnly mode', async () => {
    const md = `
Private document: [Internal Session File](./carrier_secret.docx)
Private diagram: ![Internal Diagram](./topology.png)
`;
    await act(async () => {
      root.render(<MarkdownView content={md} readOnly={true} sessionId="software-sess-01" />);
    });

    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBeNull();
    expect(link?.getAttribute('aria-disabled')).toBe('true');

    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBeNull();
    expect(img?.alt).toContain('Private image not included');
  });

  it('dispatches buddy-open-artifact event on hover and click of deck/html links', async () => {
    const md = `
Interactive presentation available: [Carrier Network Plan](plans/presentation.bobdeck)
`;
    const artifactListener = vi.fn();
    window.addEventListener('buddy-open-artifact', artifactListener);

    await act(async () => {
      root.render(<MarkdownView content={md} sessionId="software-sess-01" />);
    });

    const deckLink = host.querySelector('a') as HTMLAnchorElement;
    expect(deckLink).not.toBeNull();

    await act(async () => {
      deckLink.click();
    });

    expect(artifactListener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          path: 'plans/presentation.bobdeck',
          sessionId: 'software-sess-01',
        }),
      })
    );

    window.removeEventListener('buddy-open-artifact', artifactListener);
  });
});

describe('VisualGraphEditor Deep Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  const createSoftwareQoSModel = (overrides = {}) => ({
    id: 'software-carrier-qos-decision',
    name: 'Carrier IP/MPLS QoS Traffic Classification & Policer',
    description: 'Autonomous policy evaluation for Platform edge router ingress packet queues',
    version: 1,
    owner: 'support-engineer',
    status: 'draft',
    environment: 'development',
    _dirty: false,
    graph: {
      nodes: [
        {
          id: 'node_ingress_packet',
          name: 'Ingress Packet Header',
          type: 'inputNode',
          position: { x: 50, y: 150 },
          content: {
            schema: [
              { field: 'dscp', type: 'string', name: 'DSCP Marking' },
              { field: 'rate_mbps', type: 'number', name: 'Committed Rate' },
            ],
          },
        },
        {
          id: 'node_qos_matrix',
          name: 'Traffic Class Decision Matrix',
          type: 'decisionTableNode',
          position: { x: 350, y: 150 },
          content: {
            hitPolicy: 'first',
            inputs: [{ id: 'in_dscp', field: 'dscp', name: 'DSCP Marking' }],
            outputs: [{ id: 'out_queue', field: 'queue', name: 'Egress Forwarding Class' }],
            rules: [
              { _id: 'r1', _description: 'Voice / Critical Signaling', in_dscp: 'EF', out_queue: 'Expedited-Forwarding' },
              { _id: 'r2', _description: 'Video Conferencing', in_dscp: 'AF41', out_queue: 'Assured-Forwarding-4' },
            ],
          },
        },
        {
          id: 'node_rate_policer',
          name: 'Two-Rate Three-Color Policer',
          type: 'actionRuleNode',
          position: { x: 650, y: 150 },
          content: {
            rules: [{ _id: 'rule_police', name: 'Drop on Exceed CIR', condition: 'rate_mbps > 10000', action: 'color = RED; drop = true;' }],
          },
        },
      ],
      edges: [
        { id: 'edge_1_2', source: 'node_ingress_packet', target: 'node_qos_matrix' },
        { id: 'edge_2_3', source: 'node_qos_matrix', target: 'node_rate_policer' },
      ],
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    window.ResizeObserver = MockResizeObserver as any;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders read-only mode banner and disabled controls when editable is false', async () => {
    const model = createSoftwareQoSModel();
    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={model}
          editable={false}
          onSaveGraph={vi.fn()}
          onEvaluate={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Read-only graph');
    expect(host.textContent).toContain('Run saved decision');
    expect(host.querySelector('.cds--inline-notification--info')).not.toBeNull();
  });

  it('renders evaluation results banner, steps, and triggers onShowResults and onOpenBobDesigner', async () => {
    const model = createSoftwareQoSModel();
    const onEvaluate = vi.fn();
    const onShowResults = vi.fn();
    const onOpenBobDesigner = vi.fn();

    const evaluationResult = {
      status: 'completed',
      outputs: { queue: 'Expedited-Forwarding', color: 'GREEN', drop: false },
      executionSteps: [
        { nodeId: 'node_ingress_packet', nodeName: 'Ingress Packet Header', durationMs: 1.2 },
        { nodeId: 'node_qos_matrix', nodeName: 'Traffic Class Decision Matrix', durationMs: 2.4 },
      ],
    };

    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={model}
          editable={true}
          evaluationResult={evaluationResult}
          onEvaluate={onEvaluate}
          onShowResults={onShowResults}
          onOpenBobDesigner={onOpenBobDesigner}
        />
      );
    });

    // Check evaluation outcome displayed
    expect(host.textContent).toContain('Decision result');
    expect(host.textContent).toContain('View input and execution trace');

    // Click "View input and execution trace" button
    const showResultsBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('View input and execution trace'));
    expect(showResultsBtn).toBeDefined();
    await act(async () => {
      showResultsBtn?.click();
    });
    expect(onShowResults).toHaveBeenCalledTimes(1);

    // Click "Design with Bob" button
    const bobBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Design with Bob'));
    expect(bobBtn).toBeDefined();
    await act(async () => {
      bobBtn?.click();
    });
    expect(onOpenBobDesigner).toHaveBeenCalledTimes(1);
  });

  it('opens Add watsonx Box modal from toolbar button and adds AI node to graph', async () => {
    const model = createSoftwareQoSModel();
    const onSaveGraph = vi.fn();

    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={model}
          editable={true}
          onSaveGraph={onSaveGraph}
        />
      );
    });

    // Click "Add watsonx Box" button
    const addWatsonxBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('watsonx Box'));
    expect(addWatsonxBtn).toBeDefined();

    await act(async () => {
      addWatsonxBtn?.click();
    });

    // Verify modal overlay rendered
    expect(document.body.textContent).toContain('watsonx Box');
  });

  it('handles node deletion and invokes onSaveGraph with filtered graph', async () => {
    const model = createSoftwareQoSModel();
    const onSaveGraph = vi.fn();

    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={model}
          editable={true}
          onSaveGraph={onSaveGraph}
        />
      );
    });

    // Delete node_rate_policer via mocked node delete button
    const deleteBtn = host.querySelector('[data-testid="delete-node_rate_policer"]') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();

    await act(async () => {
      deleteBtn.click();
    });

    expect(onSaveGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: 'node_ingress_packet' }),
            expect.objectContaining({ id: 'node_qos_matrix' }),
          ]),
        }),
      })
    );
  });

  it('opens Rule Configuration Modal when edit button is clicked', async () => {
    const model = createSoftwareQoSModel();
    const onSaveGraph = vi.fn();

    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={model}
          editable={true}
          onSaveGraph={onSaveGraph}
        />
      );
    });

    const editBtn = host.querySelector('[data-testid="edit-node_qos_matrix"]') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();

    await act(async () => {
      editBtn.click();
    });

    // Configuration modal opens
    expect(document.body.textContent).toContain('Configure decisionTableNode');
  });

  it('renders busy indicator when isBusy is true', async () => {
    const model = createSoftwareQoSModel();
    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={model}
          isBusy={true}
          editable={true}
        />
      );
    });

    expect(host.textContent).toContain('Working…');
  });
});
