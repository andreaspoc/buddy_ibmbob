// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
                <button data-testid={`edit-${n.id}`} onClick={() => n.data?.onEdit?.(n.id)}>
                  edit-{n.id}
                </button>
                <button data-testid={`delete-${n.id}`} onClick={() => n.data?.onDelete?.(n.id)}>
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
      applyNodeChanges: (changes: any[], current: any[]) => current,
      applyEdgeChanges: (changes: any[], current: any[]) => current,
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

// @ts-expect-error plain JS JSX component outside web tsconfig
import VisualGraphEditor from '../../../decisions-buddy/src/components/canvas/VisualGraphEditor.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import CustomNode from '../../../decisions-buddy/src/components/canvas/CustomNode.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import ModernNodeEditor from '../../../decisions-buddy/src/components/canvas/ModernNodeEditor.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import AddWatsonxBoxModal from '../../../decisions-buddy/src/components/AddWatsonxBoxModal.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import SimulatorTab from '../../../decisions-buddy/src/components/SimulatorTab.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import CP4DGovernanceTab from '../../../decisions-buddy/src/components/CP4DGovernanceTab.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import App from '../../../decisions-buddy/src/App.jsx';

function createSampleModel(overrides = {}) {
  return {
    id: 'credit-eval',
    name: 'Customer Discount & Risk Decision',
    description: 'Enterprise decision model evaluating customer tier and risk policy',
    version: 1,
    owner: 'admin',
    status: 'draft',
    environment: 'development',
    _dirty: false,
    graph: {
      nodes: [
        {
          id: 'node_in',
          name: 'Customer Input',
          type: 'inputNode',
          position: { x: 50, y: 150 },
          content: {},
        },
        {
          id: 'node_dt',
          name: 'Discount Matrix',
          type: 'decisionTableNode',
          position: { x: 350, y: 150 },
          content: {
            hitPolicy: 'first',
            inputs: [{ id: 'in_1', field: 'customer.tier', name: 'Customer Tier' }],
            outputs: [{ id: 'out_1', field: 'discount', name: 'Discount %' }],
            rules: [{ _id: 'r1', _description: 'VIP discount', in_1: 'VIP', out_1: '20' }],
          },
        },
        {
          id: 'node_exp',
          name: 'Fee Calc',
          type: 'expressionNode',
          position: { x: 600, y: 150 },
          content: {
            expressions: [{ key: 'fee', value: 'cart.total * 0.05' }],
          },
        },
        {
          id: 'node_sw',
          name: 'Branch Switch',
          type: 'switchNode',
          position: { x: 800, y: 150 },
          content: {
            statements: [{ id: 's1', condition: 'fee > 10' }],
          },
        },
        {
          id: 'node_out',
          name: 'Decision Output',
          type: 'outputNode',
          position: { x: 1050, y: 150 },
          content: { schema: [] },
        },
      ],
      edges: [
        { id: 'edge_1', sourceId: 'node_in', targetId: 'node_dt' },
        { id: 'edge_2', sourceId: 'node_dt', targetId: 'node_exp' },
        { id: 'edge_3', sourceId: 'node_exp', targetId: 'node_sw' },
        { id: 'edge_4', sourceId: 'node_sw', targetId: 'node_out', sourceHandle: 's1' },
      ],
      vocabulary: [],
    },
    defaultInput: {
      customer: { tier: 'VIP', monthlySpend: 150 },
    },
    ...overrides,
  };
}

function setupMockFetch(customHandlers: Record<string, any> = {}) {
  const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method || 'GET';

    for (const [key, handler] of Object.entries(customHandlers)) {
      if (urlStr.includes(key)) {
        const body = typeof handler === 'function' ? await handler(init) : handler;
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
      }
    }

    if (urlStr.includes('/api/decisions/me')) {
      return { ok: true, status: 200, json: async () => ({ username: 'admin', isAdmin: true }) };
    }
    if (urlStr.includes('/api/decisions/admin/integrations')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: {
            ikc: { enabled: true, configured: true, catalog_id: 'cat-ikc-01', base_url: 'https://cp4d.example.com', origin: 'https://cp4d.example.com' },
            wxdi: { enabled: false, configured: false, catalog_id: '' },
          },
          encryption_available: true,
        }),
      };
    }
    if (urlStr.includes('/api/decisions/models/credit-eval/metadata')) {
      return { ok: true, status: 200, json: async () => ({ openapi: '3.0.0', info: { title: 'Credit Decision Contract' } }) };
    }
    if (urlStr.includes('/api/decisions/models/credit-eval/test-cases')) {
      if (method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ suiteRevision: 2, message: 'Saved' }) };
      }
      return { ok: true, status: 200, json: async () => ({ suiteRevision: 1, cases: [{ name: 'VIP Customer', input: { customer: { tier: 'VIP' } }, expected: { discount: 20 } }] }) };
    }
    if (urlStr.includes('/api/decisions/models/credit-eval/run-tests')) {
      return { ok: true, status: 200, json: async () => ({ suiteRevision: 1, decisionVersion: 1, results: [{ name: 'VIP Customer', passed: true, actual: { discount: 20 } }] }) };
    }
    if (urlStr.includes('/api/decisions/models/credit-eval/governance')) {
      return { ok: true, status: 200, json: async () => ({ decision: { id: 'credit-eval', name: 'Customer Discount Decision', version: 1, status: 'published', environment: 'production' } }) };
    }
    if (urlStr.includes('/api/decisions/models/credit-eval')) {
      return {
        ok: true,
        status: 200,
        json: async () => createSampleModel({ version: 1, _dirty: false }),
      };
    }
    if (urlStr.includes('/api/decisions/models')) {
      if (method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            decision: { id: 'credit-eval', name: 'Customer Discount Decision', version: 2, status: 'draft' },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'credit-eval', name: 'Customer Discount & Risk Decision', version: 1 }],
      };
    }
    if (urlStr.includes('/api/decisions/cp4d/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: {
            ikc: { configured: true, enabled: true, catalogId: 'cat-ikc-01', origin: 'https://cp4d.example.com' },
            wxdi: { configured: false, enabled: false },
          },
        }),
      };
    }
    if (urlStr.includes('/api/decisions/cp4d/governance/credit-eval/map-term')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          termMappings: {
            'customer.tier': { field: 'customer.tier', type: 'input', termId: 'term-tier', termName: 'Customer Tier', verification: 'active_remote_term' },
          },
        }),
      };
    }
    if (urlStr.includes('/api/decisions/cp4d/governance/credit-eval')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          syncStatus: 'synced',
          syncedVersion: 1,
          termMappings: {
            'customer.tier': { field: 'customer.tier', type: 'input', termId: 'term-tier', termName: 'Customer Tier', verification: 'active_remote_term' },
          },
          lineageManifest: { nodesCount: 3 },
        }),
      };
    }
    if (urlStr.includes('/api/decisions/cp4d/terms')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'term-tier', name: 'Customer Tier' },
          { id: 'term-score', name: 'Credit Score' },
        ],
      };
    }
    if (urlStr.includes('/api/decisions/cp4d/sync/credit-eval')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: 'Catalog synchronization completed successfully.' }),
      };
    }
    if (urlStr.includes('/api/decisions/audit-logs')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 1,
            decisionId: 'credit-eval',
            userId: 'admin',
            durationMicros: 420,
            nodesExecuted: 3,
            createdAt: '2026-10-28T22:00:00Z',
            inputData: { customer: { tier: 'VIP' } },
            outputResult: { discount: 20 },
          },
        ],
      };
    }
    if (urlStr.includes('/api/decisions/watsonx/test')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          aiRecommendation: { recommendation: 'APPROVE', riskScore: 0.05 },
          mlScore: { prediction: 'retention', probability: 0.94 },
        }),
      };
    }
    if (urlStr.includes('/api/decisions/evaluate/batch')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ result: { discount: 20 } }],
        }),
      };
    }
    if (urlStr.includes('/api/decisions/evaluate')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: { discount: 20, approved: true },
          performance: { durationMicros: 450, durationMillis: 0.45, nodesExecuted: 3 },
          trace: [
            {
              id: 'dt-1',
              name: 'Discount Table',
              type: 'decisionTableNode',
              durationMicros: 350,
              status: 'success',
              ruleTrace: [
                {
                  ruleIndex: 0,
                  ruleId: 'r1',
                  passed: true,
                  description: 'VIP discount rule',
                  conditions: [{ field: 'customer.tier', test: 'VIP', details: 'VIP match', passed: true }],
                },
              ],
              outputSnapshot: { discount: 20 },
            },
          ],
        }),
      };
    }
    if (urlStr.includes('/api/decisions/simulation/kpis')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Scenario impact report',
          summary: { successfulScenarios: 1, failedScenarios: 0 },
          baseline: { decisionVersion: 1, summary: { failedScenarios: 0 } },
          metrics: [
            { name: 'Average Discount', aggregation: 'avg', value: 20, unit: '%', sampleCount: 1, excludedCount: 0, errorCount: 0, status: 'complete' },
          ],
          comparison: [
            { name: 'Average Discount', baseline: 20, current: 20, delta: 0, unit: '%', comparable: true },
          ],
        }),
      };
    }
    if (urlStr.includes('/api/decisions/simulation/import-workbook')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cases: [{ name: 'Workbook Case', input: { customer: { tier: 'VIP' } }, expected: { discount: 20 } }],
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    };
  });

  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('Decisions-Buddy Comprehensive UI Components', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.matchMedia = vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    class MockWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      send = vi.fn();
    }
    vi.stubGlobal('WebSocket', MockWebSocket);

    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-download-url');
    URL.revokeObjectURL = vi.fn();

    setupMockFetch();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  describe('VisualGraphEditor & Canvas Node Editors', () => {
    it('renders toolbar buttons and enforces read-only banner when not editable', async () => {
      const model = createSampleModel();
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
      const addWatsonxBtn = host.querySelector('button[disabled]');
      expect(addWatsonxBtn).not.toBeNull();
    });

    it('triggers save decision & run and auto-layout actions in editable mode', async () => {
      const model = createSampleModel();
      const onSaveGraph = vi.fn();
      const onSaveAndRun = vi.fn();
      const onOpenBobDesigner = vi.fn();

      await act(async () => {
        root.render(
          <VisualGraphEditor
            model={model}
            editable={true}
            onSaveGraph={onSaveGraph}
            onSaveAndRun={onSaveAndRun}
            onOpenBobDesigner={onOpenBobDesigner}
          />
        );
      });

      // Click "Design with Bob"
      const bobBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Design with Bob'));
      expect(bobBtn).toBeDefined();
      await act(async () => {
        bobBtn?.click();
      });
      expect(onOpenBobDesigner).toHaveBeenCalledTimes(1);

      // Click "Auto Layout"
      const autoLayoutBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Auto Layout'));
      expect(autoLayoutBtn).toBeDefined();
      await act(async () => {
        autoLayoutBtn?.click();
      });

      // Click "Save decision & Run"
      const saveRunBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save decision & Run'));
      expect(saveRunBtn).toBeDefined();
      await act(async () => {
        saveRunBtn?.click();
      });
      expect(onSaveGraph).toHaveBeenCalled();
      expect(onSaveAndRun).toHaveBeenCalled();
    });

    it('adds nodes from palette by clicking palette items', async () => {
      const model = createSampleModel();
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

      const paletteItem = Array.from(host.querySelectorAll('div')).find(el => el.textContent?.includes('Decision Table') && el.style.borderLeft);
      expect(paletteItem).toBeDefined();

      await act(async () => {
        paletteItem?.click();
      });

      // Checks that publish was called with new node
      expect(onSaveGraph).toHaveBeenCalled();
    });

    it('handles drag-over and drop onto the canvas wrapper', async () => {
      const model = createSampleModel();
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

      const flowWrapper = host.querySelector('[data-testid="mock-react-flow"]');
      expect(flowWrapper).not.toBeNull();

      const dragEvent = new Event('dragover', { bubbles: true, cancelable: true }) as any;
      dragEvent.dataTransfer = { dropEffect: 'none' };
      await act(async () => {
        flowWrapper?.dispatchEvent(dragEvent);
      });

      const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as any;
      dropEvent.dataTransfer = {
        getData: (type: string) => (type === 'application/reactflow-nodetype' ? 'expressionNode' : ''),
      };
      dropEvent.clientX = 200;
      dropEvent.clientY = 250;

      await act(async () => {
        flowWrapper?.dispatchEvent(dropEvent);
      });

      expect(onSaveGraph).toHaveBeenCalled();
    });

    it('opens and updates Decision Table Node rules in modal', async () => {
      const model = createSampleModel();
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

      // Click edit on node_dt
      const editBtn = host.querySelector('[data-testid="edit-node_dt"]') as HTMLButtonElement;
      expect(editBtn).not.toBeNull();
      await act(async () => {
        editBtn.click();
      });

      expect(host.textContent).toContain('Configure decisionTableNode');

      // Change node name
      const nameInput = host.querySelector('#modal-node-name') as HTMLInputElement;
      expect(nameInput).not.toBeNull();
      await act(async () => {
        nameInput.value = 'Updated Discount Table';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Change Hit Policy
      const hitPolicySelect = host.querySelector('#modal-table-hit-policy') as HTMLSelectElement;
      expect(hitPolicySelect).not.toBeNull();
      await act(async () => {
        hitPolicySelect.value = 'collect';
        hitPolicySelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Add a new column
      const colFieldInput = host.querySelector('#new-col-field') as HTMLInputElement;
      const colNameInput = host.querySelector('#new-col-name') as HTMLInputElement;
      await act(async () => {
        colFieldInput.value = 'customer.score';
        colFieldInput.dispatchEvent(new Event('input', { bubbles: true }));
        colFieldInput.dispatchEvent(new Event('change', { bubbles: true }));
        colNameInput.value = 'Credit Score';
        colNameInput.dispatchEvent(new Event('input', { bubbles: true }));
        colNameInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const addColBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add Column'));
      await act(async () => {
        addColBtn?.click();
      });

      // Add Rule Row
      const addRuleBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add Rule Row'));
      await act(async () => {
        addRuleBtn?.click();
      });

      // Save Node Rules modal submit
      const saveModalBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save Node Rules'));
      expect(saveModalBtn).toBeDefined();
      await act(async () => {
        saveModalBtn?.click();
      });

      expect(onSaveGraph).toHaveBeenCalled();
    });

    it('opens and updates Expression Node rules in modal', async () => {
      const model = createSampleModel();
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

      // Click edit on node_exp
      const editBtn = host.querySelector('[data-testid="edit-node_exp"]') as HTMLButtonElement;
      expect(editBtn).not.toBeNull();
      await act(async () => {
        editBtn.click();
      });

      expect(host.textContent).toContain('Configure expressionNode');

      const setInputValue = (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      // Update node name
      const nameInput = host.querySelector('#modal-node-name') as HTMLInputElement;
      if (nameInput) {
        await act(async () => {
          setInputValue(nameInput, 'Updated Fee Calc');
        });
      }

      // Add an expression
      const keyInput = host.querySelector('#new-exp-key') as HTMLInputElement;
      const valInput = host.querySelector('#new-exp-val') as HTMLInputElement;
      if (keyInput && valInput) {
        await act(async () => {
          setInputValue(keyInput, 'discountedTotal');
          setInputValue(valInput, 'total * 0.85');
        });

        const addExpBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add Formula'));
        await act(async () => {
          addExpBtn?.click();
        });
      }

      // Save
      const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save Node Rules'));
      await act(async () => {
        saveBtn?.click();
      });

      expect(onSaveGraph).toHaveBeenCalled();
    });

    it('handles node deletion and removes node from canvas', async () => {
      const model = createSampleModel();
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

      const deleteBtn = host.querySelector('[data-testid="delete-node_exp"]') as HTMLButtonElement;
      expect(deleteBtn).not.toBeNull();
      await act(async () => {
        deleteBtn.click();
      });

      expect(onSaveGraph).toHaveBeenCalled();
    });

    it('opens watsonx box modal when clicking + watsonx Box or editing watsonx node', async () => {
      const model = createSampleModel({
        graph: {
          nodes: [
            {
              id: 'node_wx_ai',
              name: 'watsonx AI Reasoning',
              type: 'watsonxAiNode',
              position: { x: 300, y: 150 },
              content: { modelId: 'ibm/granite-13b-instruct-v2' },
            },
          ],
          edges: [],
        },
      });

      await act(async () => {
        root.render(
          <VisualGraphEditor
            model={model}
            editable={true}
            onSaveGraph={vi.fn()}
          />
        );
      });

      // Click + watsonx Box
      const addWatsonxBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('+ watsonx Box'));
      expect(addWatsonxBtn).toBeDefined();
      await act(async () => {
        addWatsonxBtn?.click();
      });

      expect(host.textContent).toContain('Add watsonx Box to Decision');

      // Close modal
      const cancelBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
      await act(async () => {
        cancelBtn?.click();
      });

      // Click edit on node_wx_ai
      const editBtn = host.querySelector('[data-testid="edit-node_wx_ai"]') as HTMLButtonElement;
      await act(async () => {
        editBtn.click();
      });

      expect(host.textContent).toContain('Configure watsonx Box');
    });

    it('opens and updates Switch Node rules in modal', async () => {
      const model = createSampleModel();
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

      const editBtn = host.querySelector('[data-testid="edit-node_sw"]') as HTMLButtonElement;
      expect(editBtn).not.toBeNull();
      await act(async () => {
        editBtn.click();
      });

      expect(host.textContent).toContain('Configure switchNode');

      const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save Node Rules'));
      await act(async () => {
        saveBtn?.click();
      });
    });

    it('edits Modern actionRuleNode in VisualGraphEditor and saves updated content', async () => {
      const model = createSampleModel({
        graph: {
          nodes: [
            {
              id: 'node_action',
              name: 'Action Policy',
              type: 'actionRuleNode',
              position: { x: 300, y: 150 },
              content: { source: 'if customer.tier == "VIP" then set discount = 20' },
            },
          ],
          edges: [],
          vocabulary: [],
        },
      });
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

      const editBtn = host.querySelector('[data-testid="edit-node_action"]') as HTMLButtonElement;
      expect(editBtn).not.toBeNull();
      await act(async () => {
        editBtn.click();
      });

      expect(host.textContent).toContain('Configure actionRuleNode');

      const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save Node Rules'));
      await act(async () => {
        saveBtn?.click();
      });
    });
  });

  describe('CustomNode Canvas Component', () => {
    it('renders different node types with appropriate styling and headers', async () => {
      const nodeTypes = [
        'inputNode',
        'decisionTableNode',
        'watsonxAiNode',
        'watsonxMlNode',
        'expressionNode',
        'actionRuleNode',
        'switchNode',
        'outputNode',
      ];

      for (const nodeType of nodeTypes) {
        await act(async () => {
          root.render(
            <CustomNode
              id={`node_${nodeType}`}
              selected={false}
              data={{
                nodeType,
                name: `Test ${nodeType}`,
                summary: 'Custom summary',
                content: nodeType === 'switchNode' ? { statements: [{ id: 's1', condition: 'x > 1' }] } : {},
                onEdit: vi.fn(),
                onDelete: vi.fn(),
              }}
            />
          );
        });

        expect(host.textContent).toContain(`Test ${nodeType}`);
        expect(host.textContent).toContain('Custom summary');
      }
    });

    it('triggers onEdit and onDelete callbacks when buttons are clicked', async () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();

      await act(async () => {
        root.render(
          <CustomNode
            id="node_test_1"
            selected={true}
            data={{
              nodeType: 'decisionTableNode',
              name: 'Discount Table',
              onEdit,
              onDelete,
            }}
          />
        );
      });

      const buttons = host.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      await act(async () => {
        buttons[0]?.click();
        buttons[1]?.click();
      });

      expect(onEdit).toHaveBeenCalledWith('node_test_1');
      expect(onDelete).toHaveBeenCalledWith('node_test_1');
    });
  });

  describe('ModernNodeEditor Component', () => {
    it('edits business action rule source and vocabulary terms', async () => {
      const onChange = vi.fn();
      const draft = {
        source: 'if customer.tier == "VIP" then set discount = 20',
        vocabulary: [
          { term: 'Customer Tier', path: 'customer.tier', type: 'string', required: true },
        ],
      };

      await act(async () => {
        root.render(
          <ModernNodeEditor
            type="businessRuleNode"
            draft={draft}
            onChange={onChange}
          />
        );
      });

      expect(host.textContent).toContain('Business action rule');
      expect(host.textContent).toContain('Business vocabulary');
      const termInput = host.querySelector('#term-name-0') as HTMLInputElement;
      expect(termInput?.value).toBe('Customer Tier');

      const addTermBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add business term'));
      expect(addTermBtn).toBeDefined();
      await act(async () => {
        addTermBtn?.click();
      });

      expect(onChange).toHaveBeenCalled();
    });

    it('edits rule agenda conflict resolution and rule sets', async () => {
      const onChange = vi.fn();
      const draft = {
        conflictResolution: 'priority',
        maxCycles: 50,
        rules: [
          { id: 'rule_1', priority: 10, condition: 'balance > 0', actionsText: 'set valid = true' },
        ],
        vocabulary: [],
      };

      await act(async () => {
        root.render(
          <ModernNodeEditor
            type="ruleAgendaNode"
            draft={draft}
            onChange={onChange}
          />
        );
      });

      expect(host.textContent).toContain('Choose the next matching rule');
      expect(host.textContent).toContain('Rule 1');

      const addRuleBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add rule'));
      await act(async () => {
        addRuleBtn?.click();
      });

      expect(onChange).toHaveBeenCalled();
    });

    it('configures fork and join merge policies', async () => {
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <ModernNodeEditor
            type="joinNode"
            draft={{ mergePolicy: 'first' }}
            onChange={onChange}
          />
        );
      });

      expect(host.textContent).toContain('When branches write different values to the same field');
    });
  });

  describe('AddWatsonxBoxModal Component', () => {
    it('returns null when modal is not open', async () => {
      await act(async () => {
        root.render(
          <AddWatsonxBoxModal
            isOpen={false}
            onClose={vi.fn()}
            model={createSampleModel()}
            onUpdateModel={vi.fn()}
          />
        );
      });
      expect(host.innerHTML).toBe('');
    });

    it('configures and tests watsonx.ai foundation model box', async () => {
      const model = createSampleModel();
      const onUpdateModel = vi.fn();
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          <AddWatsonxBoxModal
            isOpen={true}
            onClose={onClose}
            model={model}
            onUpdateModel={onUpdateModel}
            editable={true}
          />
        );
      });

      expect(host.textContent).toContain('Add watsonx Box to Decision');
      expect(host.textContent).toContain('watsonx.ai (Foundation Model)');

      // Test connection
      const testBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Test watsonx.ai Endpoint'));
      expect(testBtn).toBeDefined();
      await act(async () => {
        testBtn?.click();
      });

      expect(host.textContent).toContain('TEST SUCCEEDED');

      // Submit form
      const submitBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add to Decision'));
      expect(submitBtn).toBeDefined();
      await act(async () => {
        submitBtn?.click();
      });

      expect(onUpdateModel).toHaveBeenCalled();
      const updatedModel = onUpdateModel.mock.calls[0][0];
      expect(updatedModel.graph.nodes.some((n: any) => n.type === 'watsonxAiNode')).toBe(true);
      expect(onClose).toHaveBeenCalled();
    });

    it('configures and tests watsonx ML predictive model box', async () => {
      const existingMl = {
        id: 'existing_ml_1',
        name: 'watsonx ML (deployment-churn-risk-v1)',
        type: 'watsonxMlNode',
        content: {
          endpoint: 'https://us-south.ml.cloud.ibm.com',
          spaceId: 'space-123',
          deploymentId: 'deployment-churn-risk-v1',
          scoringType: 'classification',
          outputField: 'mlScore',
          inputMapping: { 'customer_tier': 'customer.tier' },
        },
      };

      const model = createSampleModel({
        graph: {
          nodes: [existingMl],
          edges: [],
        },
      });

      const onUpdateModel = vi.fn();
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          <AddWatsonxBoxModal
            isOpen={true}
            existingNode={existingMl}
            onClose={onClose}
            model={model}
            onUpdateModel={onUpdateModel}
            editable={true}
          />
        );
      });

      expect(host.textContent).toContain('Configure watsonx Box');
      expect(host.textContent).toContain('watsonx ML Service Endpoint');

      const testBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Test watsonx Model API'));
      expect(testBtn).toBeDefined();
      await act(async () => {
        testBtn?.click();
      });

      expect(host.textContent).toContain('TEST SUCCEEDED');

      // Submit form
      const submitBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save watsonx Box'));
      await act(async () => {
        submitBtn?.click();
      });

      expect(onUpdateModel).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('updates an existing watsonx node in place without adding duplicates', async () => {
      const existing = {
        id: 'existing_ai_1',
        name: 'watsonx.ai (ibm/granite-13b-instruct-v2)',
        type: 'watsonxAiNode',
        content: {
          endpoint: 'https://us-south.ml.cloud.ibm.com',
          modelId: 'ibm/granite-13b-instruct-v2',
        },
      };

      const model = createSampleModel({
        graph: {
          nodes: [existing],
          edges: [],
        },
      });

      const onUpdateModel = vi.fn();
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          <AddWatsonxBoxModal
            isOpen={true}
            existingNode={existing}
            onClose={onClose}
            model={model}
            onUpdateModel={onUpdateModel}
            editable={true}
          />
        );
      });

      expect(host.textContent).toContain('Configure watsonx Box');
      const submitBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save watsonx Box'));
      await act(async () => {
        submitBtn?.click();
      });

      expect(onUpdateModel).toHaveBeenCalled();
      const updated = onUpdateModel.mock.calls[0][0];
      expect(updated.graph.nodes.length).toBe(1);
      expect(onClose).toHaveBeenCalled();
    });

    it('handles test connection error feedback and invalid JSON mapping', async () => {
      setupMockFetch({
        '/api/decisions/watsonx/test': () => {
          throw new Error('Connection timed out');
        },
      });

      const model = createSampleModel();
      const onUpdateModel = vi.fn();
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          <AddWatsonxBoxModal
            isOpen={true}
            onClose={onClose}
            model={model}
            onUpdateModel={onUpdateModel}
            editable={true}
          />
        );
      });

      const testBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Test watsonx.ai Endpoint'));
      await act(async () => {
        testBtn?.click();
      });

      expect(host.textContent).toContain('TEST FAILED');
      expect(host.textContent).toContain('Connection timed out');
    });
  });

  describe('SimulatorTab Component', () => {
    it('handles single mode evaluation, reset, and renders performance & trace telemetry', async () => {
      const models = { 'credit-eval': createSampleModel() };
      const setInputJson = vi.fn();
      const onEvaluate = vi.fn();

      const evaluationResult = {
        result: { discount: 20, approved: true },
        performance: {
          durationMicros: 450,
          durationMillis: 0.45,
          nodesExecuted: 3,
        },
        trace: [
          {
            id: 'node_dt',
            name: 'Discount Matrix',
            type: 'decisionTableNode',
            durationMicros: 350,
            status: 'success',
            ruleTrace: [
              {
                ruleIndex: 0,
                ruleId: 'r1',
                passed: true,
                description: 'VIP discount rule',
                conditions: [
                  { field: 'customer.tier', test: 'VIP', details: 'Matches VIP tier', passed: true },
                ],
              },
            ],
            outputSnapshot: { discount: 20 },
          },
        ],
      };

      await act(async () => {
        root.render(
          <SimulatorTab
            selectedModelKey="credit-eval"
            setSelectedModelKey={vi.fn()}
            models={models}
            inputJson='{"customer":{"tier":"VIP"}}'
            setInputJson={setInputJson}
            onEvaluate={onEvaluate}
            evaluationResult={evaluationResult}
            isLoading={false}
            backendConnected={true}
            editable={true}
          />
        );
      });

      expect(host.textContent).toContain('Decision Model Selection');
      expect(host.textContent).toContain('450 μs');
      expect(host.textContent).toContain('Nodes Processed');
      expect(host.textContent).toContain('VIP discount rule');
      expect(host.textContent).toContain('MATCHED');

      // Click evaluate button
      const evalBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Evaluate Decision'));
      expect(evalBtn).toBeDefined();
      await act(async () => {
        evalBtn?.click();
      });
      expect(onEvaluate).toHaveBeenCalled();

      // Click reset default
      const resetBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Reset Default'));
      await act(async () => {
        resetBtn?.click();
      });
      expect(setInputJson).toHaveBeenCalled();
    });

    it('switches to batch mode, parses scenarios and evaluates batch', async () => {
      const models = { 'credit-eval': createSampleModel() };

      await act(async () => {
        root.render(
          <SimulatorTab
            selectedModelKey="credit-eval"
            setSelectedModelKey={vi.fn()}
            models={models}
            inputJson='{"customer":{"tier":"VIP"}}'
            setInputJson={vi.fn()}
            onEvaluate={vi.fn()}
            isLoading={false}
            backendConnected={true}
            editable={true}
          />
        );
      });

      // Switch mode to batch
      const modeSelect = host.querySelector('#simulation-input-mode') as HTMLSelectElement;
      expect(modeSelect).not.toBeNull();
      await act(async () => {
        modeSelect.value = 'batch';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(host.textContent).toContain('Batch Scenarios (JSON)');
      expect(host.textContent).toContain('KPI impact simulation');

      // Click evaluate batch
      const batchEvalBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Evaluate Independent Scenarios'));
      expect(batchEvalBtn).toBeDefined();
      await act(async () => {
        batchEvalBtn?.click();
      });

      expect(host.textContent).toContain('Batch scenario results');

      // Click Run KPI simulation
      const kpiBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Run KPI simulation'));
      expect(kpiBtn).toBeDefined();
      await act(async () => {
        kpiBtn?.click();
      });

      expect(host.textContent).toContain('Scenario impact report');
    });

    it('supports CSV import workflow and maps rows to batch scenarios', async () => {
      const models = { 'credit-eval': createSampleModel() };

      await act(async () => {
        root.render(
          <SimulatorTab
            selectedModelKey="credit-eval"
            setSelectedModelKey={vi.fn()}
            models={models}
            inputJson='{"customer":{"tier":"VIP"}}'
            setInputJson={vi.fn()}
            onEvaluate={vi.fn()}
            isLoading={false}
            backendConnected={true}
            editable={true}
          />
        );
      });

      // Switch mode to batch
      const modeSelect = host.querySelector('#simulation-input-mode') as HTMLSelectElement;
      await act(async () => {
        modeSelect.value = 'batch';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const fileInput = host.querySelector('#simulator-file-upload') as HTMLInputElement;
      expect(fileInput).not.toBeNull();

      const csvContent = 'tier,spend\nVIP,150\nStandard,50';
      const file = new File([csvContent], 'test-scenarios.csv', { type: 'text/csv' });

      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [file], writable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(host.textContent).toContain('Imported 2 CSV rows');

      const useCsvBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Use CSV rows as batch scenarios'));
      expect(useCsvBtn).toBeDefined();
      await act(async () => {
        useCsvBtn?.click();
      });

      expect(host.textContent).not.toContain('Imported 2 CSV rows');
    });

    it('supports Excel (.xlsx) file import', async () => {
      const models = { 'credit-eval': createSampleModel({ version: 1, _dirty: false }) };

      await act(async () => {
        root.render(
          <SimulatorTab
            selectedModelKey="credit-eval"
            setSelectedModelKey={vi.fn()}
            models={models}
            inputJson='{"customer":{"tier":"VIP"}}'
            setInputJson={vi.fn()}
            onEvaluate={vi.fn()}
            isLoading={false}
            backendConnected={true}
            editable={true}
          />
        );
      });

      const modeSelect = host.querySelector('#simulation-input-mode') as HTMLSelectElement;
      await act(async () => {
        modeSelect.value = 'batch';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Upload xlsx file
      const fileInput = host.querySelector('#simulator-file-upload') as HTMLInputElement;
      const file = new File(['mock content'], 'scenarios.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [file], writable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(host.textContent).toContain('Workbook Case');
    });

    it('supports loading, saving, and running saved test cases', async () => {
      const models = { 'credit-eval': createSampleModel({ version: 1, _dirty: false }) };

      await act(async () => {
        root.render(
          <SimulatorTab
            selectedModelKey="credit-eval"
            setSelectedModelKey={vi.fn()}
            models={models}
            inputJson='{"customer":{"tier":"VIP"}}'
            setInputJson={vi.fn()}
            onEvaluate={vi.fn()}
            isLoading={false}
            backendConnected={true}
            editable={true}
          />
        );
      });

      const modeSelect = host.querySelector('#simulation-input-mode') as HTMLSelectElement;
      await act(async () => {
        modeSelect.value = 'batch';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Load saved cases
      const loadBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Load saved cases'));
      expect(loadBtn).toBeDefined();
      await act(async () => {
        loadBtn?.click();
      });

      expect(host.textContent).toContain('Saved cases loaded');

      // Save test cases
      const saveCasesBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save test cases'));
      expect(saveCasesBtn).toBeDefined();
      await act(async () => {
        saveCasesBtn?.click();
      });

      // Run saved tests
      const runSavedBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Run saved tests'));
      expect(runSavedBtn).toBeDefined();
      await act(async () => {
        runSavedBtn?.click();
      });

      expect(host.textContent).toContain('decision version 1');
    });

    it('displays invalid JSON error in single simulation mode', async () => {
      const models = { 'credit-eval': createSampleModel() };

      await act(async () => {
        root.render(
          <SimulatorTab
            selectedModelKey="credit-eval"
            setSelectedModelKey={vi.fn()}
            models={models}
            inputJson='{invalid json'
            setInputJson={vi.fn()}
            onEvaluate={vi.fn()}
            isLoading={false}
            backendConnected={true}
            editable={true}
          />
        );
      });

      const evalBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Evaluate Decision'));
      expect((evalBtn as HTMLButtonElement)?.disabled).toBe(true);
    });
  });

  describe('CP4DGovernanceTab Component', () => {
    it('fetches governance status, renders harvest contract preview, and allows term mapping', async () => {
      const model = createSampleModel({ version: 1, _dirty: false });
      const onGovernanceChanged = vi.fn();

      await act(async () => {
        root.render(
          <CP4DGovernanceTab
            model={model}
            backendConnected={true}
            currentUser={{ username: 'admin', isAdmin: true }}
            onGovernanceChanged={onGovernanceChanged}
          />
        );
      });

      expect(host.textContent).toContain('IBM Cloud Pak for Data (CP4D)');
      expect(host.textContent).toContain('CP4D HTTP Connector & Metadata Harvest');
      expect(host.textContent).toContain('Selected connection configured');

      // Click Inspect Harvest Contract
      const inspectBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Inspect Harvest Contract'));
      expect(inspectBtn).toBeDefined();
      await act(async () => {
        inspectBtn?.click();
      });

      expect(host.textContent).toContain('Credit Decision Contract');

      // Open confirm sync modal
      const syncBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Review catalog synchronization'));
      expect(syncBtn).toBeDefined();
      await act(async () => {
        syncBtn?.click();
      });

      expect(host.textContent).toContain('Confirm catalog synchronization');

      // Submit sync
      const submitSyncBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Synchronize saved version'));
      expect(submitSyncBtn).toBeDefined();
      await act(async () => {
        submitSyncBtn?.click();
      });

      expect(onGovernanceChanged).toHaveBeenCalled();
    });

    it('switches catalog provider to wxdi and assigns business term', async () => {
      const model = createSampleModel({ version: 1, _dirty: false });
      const onGovernanceChanged = vi.fn();

      await act(async () => {
        root.render(
          <CP4DGovernanceTab
            model={model}
            backendConnected={true}
            currentUser={{ username: 'admin', isAdmin: true }}
            onGovernanceChanged={onGovernanceChanged}
          />
        );
      });

      // Change provider
      const providerSelect = host.querySelector('#decision-governance-provider') as HTMLSelectElement;
      expect(providerSelect).not.toBeNull();
      await act(async () => {
        providerSelect.value = 'wxdi';
        providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(providerSelect.value).toBe('wxdi');

      // Assign term
      const termSelect = host.querySelector('select[id^="decision-term-"]') as HTMLSelectElement;
      if (termSelect) {
        await act(async () => {
          termSelect.value = 'term-tier';
          termSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    });

    it('handles metadata fetch failure gracefully', async () => {
      setupMockFetch({
        '/api/decisions/models/credit-eval/metadata': () => {
          throw new Error('Contract unavailable');
        },
      });

      const model = createSampleModel({ version: 1, _dirty: false });

      await act(async () => {
        root.render(
          <CP4DGovernanceTab
            model={model}
            backendConnected={true}
            currentUser={{ username: 'admin', isAdmin: true }}
            onGovernanceChanged={vi.fn()}
          />
        );
      });

      const inspectBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Inspect Harvest Contract'));
      await act(async () => {
        inspectBtn?.click();
      });

      expect(host.textContent).toContain('Failed to fetch metadata contract');
    });
  });

  describe('App Top-Level Workspace Component', () => {
    it('mounts cleanly, fetches models, switches tabs and handles workspace actions', async () => {
      await act(async () => {
        root.render(<App />);
      });

      expect(host.textContent).toContain('Customer Discount & Risk Decision');
      expect(host.textContent).toContain('New decision');
      expect(host.textContent).toContain('Design with Bob');
      expect(host.textContent).toContain('Simulator');
      expect(host.textContent).toContain('Decision table');
      expect(host.textContent).toContain('Visual editor');

      // Click "New decision"
      const newBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'New decision');
      expect(newBtn).toBeDefined();
      await act(async () => {
        newBtn?.click();
      });

      // Switch to Visual Editor tab
      const visualTab = Array.from(host.querySelectorAll('button, div')).find(el => el.textContent === 'Visual editor');
      if (visualTab) {
        await act(async () => {
          visualTab.click();
        });
        expect(host.textContent).toContain('Reset view');
      }

      // Click Export Model
      const exportBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Export Model'));
      expect(exportBtn).toBeDefined();
      await act(async () => {
        exportBtn?.click();
      });

      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it('handles governance promotion, example draft, and bob flow designer integration', async () => {
      await act(async () => {
        root.render(<App />);
      });

      // Click "Load example draft"
      const exampleBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Load example draft'));
      expect(exampleBtn).toBeDefined();
      await act(async () => {
        exampleBtn?.click();
      });

      expect(host.textContent).toContain('example draft');

      // Click "Design with Bob"
      const bobBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Design with Bob');
      expect(bobBtn).toBeDefined();
      await act(async () => {
        bobBtn?.click();
      });

      // Click "Save decision"
      const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save decision'));
      if (saveBtn) {
        await act(async () => {
          saveBtn.click();
        });
      }

      // Governance promotion from header bar
      const promoteBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Promote'));
      if (promoteBtn) {
        await act(async () => {
          promoteBtn.click();
        });

        const confirmBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Confirm transition');
        if (confirmBtn) {
          await act(async () => {
            confirmBtn.click();
          });
        }
      }
    });

    it('handles import of a decision graph JSON file', async () => {
      await act(async () => {
        root.render(<App />);
      });

      const fileInput = host.querySelector('.decisions-file-input') as HTMLInputElement;
      expect(fileInput).not.toBeNull();

      const graphData = {
        nodes: [
          { id: 'in_1', name: 'Input', type: 'inputNode' },
          { id: 'out_1', name: 'Output', type: 'outputNode' },
        ],
        edges: [
          { id: 'e1', sourceId: 'in_1', targetId: 'out_1' },
        ],
      };
      const file = new File([JSON.stringify(graphData)], 'imported-model.json', { type: 'application/json' });

      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [file], writable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(host.textContent).toContain('imported-model');
    });

    it('listens for UI scale and theme messages', async () => {
      await act(async () => {
        root.render(<App />);
      });

      // Post SET_UI_SCALE message
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          source: window,
          data: { type: 'SET_UI_SCALE', scale: 1.25 },
        }));
      });

      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
    });
  });
});
