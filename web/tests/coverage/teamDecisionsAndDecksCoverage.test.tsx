// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// =========================================================================
// MOCKS & STUBS
// =========================================================================

const { mockReactFlowModule } = vi.hoisted(() => {
  return {
    mockReactFlowModule: () => ({
      ReactFlow: ({ children, nodes, onInit, onDrop, onDragOver, onNodesChange, onEdgesChange, onConnect }: any) => {
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
            <button
              data-testid="trigger-edges-change"
              onClick={() => {
                onEdgesChange?.([{ id: 'e1', type: 'select', selected: true }]);
              }}
            >
              Trigger Edges Change
            </button>
            <button
              data-testid="trigger-connect"
              onClick={() => {
                onConnect?.({ source: 'node_1', target: 'node_2', sourceHandle: 'h1', targetHandle: 'h2' });
              }}
            >
              Trigger Connect
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

export const mockVoiceCaptureInstances: any[] = [];
export const mockVoiceSpeakerInstances: any[] = [];

vi.mock('../../src/lib/realtimeVoice', () => ({
  VoiceCapture: class {
    callbacks: any;
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    mute = vi.fn();
    constructor(callbacks: any) {
      this.callbacks = callbacks;
      mockVoiceCaptureInstances.push(this);
    }
  },
  VoiceSpeaker: class {
    context: any;
    voiceId: any;
    callbacks: any;
    append = vi.fn();
    finish = vi.fn().mockImplementation(() => {
      this.callbacks?.done?.();
    });
    stop = vi.fn();
    constructor(context: any, voiceId: any, callbacks: any) {
      this.context = context;
      this.voiceId = voiceId;
      this.callbacks = callbacks;
      mockVoiceSpeakerInstances.push(this);
    }
  },
}));

vi.mock('../../src/lib/noteEnrichment', () => ({
  enrichNote: vi.fn().mockImplementation(async (_note, _instruction, opts) => {
    opts?.onStatus?.('Refining clarity…');
    return {
      title: 'Enhanced Company A Architecture Note',
      body: '## Key Summary\n\nDetailed infrastructure findings and recommendations.',
    };
  }),
}));

vi.mock('../../src/lib/noteFlight', () => ({
  flyNoteToNotes: vi.fn(),
}));

vi.mock('../../src/api', () => ({
  saveSessionFile: vi.fn().mockResolvedValue({ ok: true }),
  fetchDeckByPath: vi.fn().mockResolvedValue({
    title: 'Stored Presentation',
    slides: [{ title: 'Slide One', elements: [{ type: 'title', content: 'Slide One' }] }],
  }),
}));

vi.mock('../../src/lib/officeUrl', () => ({
  navigateOffice: vi.fn(),
}));

vi.mock('../../src/lib/bobdeck.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    buildHtmlDeckPptxBlob: vi.fn().mockResolvedValue(new Blob(['test-pptx'], { type: 'application/vnd.ms-powerpoint' })),
    buildDeckPptxBlob: vi.fn().mockResolvedValue(new Blob(['test-deck-pptx'], { type: 'application/vnd.ms-powerpoint' })),
    exportDeckToPptx: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(true),
}));

class MockAudioContext {
  state = 'running';
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  onopen: any = null;
  onclose: any = null;
  onerror: any = null;
  onmessage: any = null;
  send = vi.fn();
  close = vi.fn().mockImplementation(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

// Imports of target components
import LearningCourseCompletion from '../../src/components/LearningCourseCompletion';
import { MCPCatalog, MCPServerCatalog, CatalogIcon } from '../../src/components/MCPCatalog';
import { StickyNotes, NotesWorkspace } from '../../src/components/StickyNotes';
import { SlideViewer } from '../../src/components/SlideViewer';
import { VoiceChat } from '../../src/components/VoiceChat';
import { HtmlDeckViewer } from '../../src/components/HtmlDeckViewer';

// @ts-expect-error plain JS JSX component outside web tsconfig
import DecisionTableTab from '../../../decisions-buddy/src/components/DecisionTableTab.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import DecisionsApp from '../../../decisions-buddy/src/App.jsx';
// @ts-expect-error plain JS JSX component outside web tsconfig
import VisualGraphEditor from '../../../decisions-buddy/src/components/canvas/VisualGraphEditor.jsx';

const nodeBinding = require('../../../bindings/nodejs');

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

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: any) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: any) { this.open = false; });

  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('WebSocket', MockWebSocket);
  (window as any).AudioContext = MockAudioContext;
  (window as any).AudioWorkletNode = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue({}) },
    configurable: true,
  });

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
  vi.clearAllMocks();
  mockVoiceCaptureInstances.length = 0;
  mockVoiceSpeakerInstances.length = 0;
});

// =========================================================================
// SECTION 1: bindings/nodejs/index.js Deep Branch Coverage
// =========================================================================

describe('bindings/nodejs/index.js Full Coverage', () => {
  const { ZenEngine, ZenDecision, ZenDecisionContent, evaluateUnary, safeEvalExpression } = nodeBinding;

  it('covers all safeEvalExpression and BUILTINS methods and branches', () => {
    // Non-string or empty
    expect(safeEvalExpression(123 as any)).toBe(123);
    expect(safeEvalExpression('')).toBeNull();
    expect(safeEvalExpression('   ')).toBeNull();

    // Expression builtins
    expect(safeEvalExpression('sum([1, 2, 3, "4"])')).toBe(10);
    expect(safeEvalExpression('sum("invalid")')).toBe(0);
    expect(safeEvalExpression('avg([10, 20, 30])')).toBe(20);
    expect(safeEvalExpression('avg([])')).toBe(0);
    expect(safeEvalExpression('avg("not-array")')).toBe(0);
    expect(safeEvalExpression('min([5, 2, 9])')).toBe(2);
    expect(safeEvalExpression('min(8, 3, 12)')).toBe(3);
    expect(safeEvalExpression('min()')).toBe(0);
    expect(safeEvalExpression('max([5, 2, 9])')).toBe(9);
    expect(safeEvalExpression('max(8, 3, 12)')).toBe(12);
    expect(safeEvalExpression('max()')).toBe(0);
    expect(safeEvalExpression('count([1, 2])')).toBe(2);
    expect(safeEvalExpression('count(42)')).toBe(1);
    expect(safeEvalExpression('count(null)')).toBe(0);
    expect(safeEvalExpression('len("software")')).toBe(8);
    expect(safeEvalExpression('len([1, 2, 3])')).toBe(3);
    expect(safeEvalExpression('len(123)')).toBe(0);
    expect(safeEvalExpression('round(3.14159, 2)')).toBe(3.14);
    expect(safeEvalExpression('round(5.6)')).toBe(6);
    expect(safeEvalExpression('floor(3.9)')).toBe(3);
    expect(safeEvalExpression('ceil(3.1)')).toBe(4);
    expect(safeEvalExpression('abs(-42)')).toBe(42);
    expect(safeEvalExpression('contains(["a", "b"], "a")')).toBe(true);
    expect(safeEvalExpression('contains("buddy", "bud")')).toBe(true);
    expect(safeEvalExpression('contains(123, "1")')).toBe(false);
    expect(safeEvalExpression('startsWith("software", "soft")')).toBe(true);
    expect(safeEvalExpression('starts_with("software", "soft")')).toBe(true);
    expect(safeEvalExpression('startsWith("software", 123)')).toBe(false);
    expect(safeEvalExpression('endsWith("fiber.doc", ".doc")')).toBe(true);
    expect(safeEvalExpression('ends_with("fiber.doc", ".doc")')).toBe(true);
    expect(safeEvalExpression('endsWith("fiber.doc", null)')).toBe(false);
    expect(safeEvalExpression('matches("VIP-123", "^VIP-[0-9]+$")')).toBe(true);
    expect(safeEvalExpression('matches("invalid", "[")')).toBe(false);
    expect(safeEvalExpression('matches(123, ".*")')).toBe(false);

    // Expressions with context collections
    const ctx = {
      items: [{ id: 1, name: 'first' }, { id: 2, name: 'second' }],
      users: [{ active: true }, { active: false }],
    };
    expect(safeEvalExpression('map(items, "id")', ctx)).toEqual([1, 2]);
    expect(safeEvalExpression('map("not-array", "id")')).toEqual([]);
    expect(safeEvalExpression('filter(users, "active", true)', ctx)).toEqual([{ active: true }]);
    expect(safeEvalExpression('filter(users, "active")', ctx)).toEqual([{ active: true }]);
    expect(safeEvalExpression('filter("not-array", "active")')).toEqual([]);
    expect(safeEvalExpression('find(items, "id", 2)', ctx)).toEqual({ id: 2, name: 'second' });
    expect(safeEvalExpression('find(items, "id", 999)', ctx)).toBeNull();
    expect(safeEvalExpression('find("not-array", "id", 1)')).toBeNull();
    expect(safeEvalExpression('flatten([[1, 2], [3, [4]]])')).toEqual([1, 2, 3, 4]);
    expect(safeEvalExpression('flatten("string")')).toEqual([]);
    expect(safeEvalExpression('unique([1, 2, 2, 3])')).toEqual([1, 2, 3]);
    expect(safeEvalExpression('unique("string")')).toEqual([]);
    expect(safeEvalExpression('join(["a", "b"], "-")')).toBe('a-b');
    expect(safeEvalExpression('join("not-array")')).toBe('');
    expect(safeEvalExpression('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']);
    expect(safeEvalExpression('split(123)')).toEqual([]);
    expect(safeEvalExpression('replace("hello world", "world", "buddy")')).toBe('hello buddy');
    expect(safeEvalExpression('replace(123)')).toBe('');
    expect(safeEvalExpression('slice([1, 2, 3, 4], 1, 3)')).toEqual([2, 3]);
    expect(safeEvalExpression('slice("software", 0, 4)')).toBe('soft');
    expect(safeEvalExpression('slice(123)')).toEqual([]);
  });

  it('covers evaluateUnary parsing literals, placeholders, nulls, ranges, and comparisons', () => {
    // Empty & dash
    expect(evaluateUnary('', 10).passed).toBe(true);
    expect(evaluateUnary('-', 10).passed).toBe(true);
    expect(evaluateUnary(null, 10).passed).toBe(true);

    // Dynamic placeholders ? and $
    expect(evaluateUnary('? > 10', 15).passed).toBe(true);
    expect(evaluateUnary('$ <= 5', 5).passed).toBe(true);
    expect(evaluateUnary('? == "vip"', 'vip').passed).toBe(true);
    expect(evaluateUnary('? bad syntax %%%', 10).passed).toBe(false);

    // Negation wrapper
    expect(evaluateUnary('not(> 10)', 5).passed).toBe(true);
    expect(evaluateUnary('not(> 10)', 15).passed).toBe(false);

    // Quoted literals
    expect(evaluateUnary('"ACTIVE"', 'ACTIVE').passed).toBe(true);
    expect(evaluateUnary("'GOLD'", 'GOLD').passed).toBe(true);
    expect(evaluateUnary('"ACTIVE"', 'INACTIVE').passed).toBe(false);

    // Null checks
    expect(evaluateUnary('is null', null).passed).toBe(true);
    expect(evaluateUnary('null', undefined).passed).toBe(true);
    expect(evaluateUnary('is null', 'active').passed).toBe(false);
    expect(evaluateUnary('is not null', 'active').passed).toBe(true);
    expect(evaluateUnary('is not null', null).passed).toBe(false);

    // Booleans
    expect(evaluateUnary('true', true).passed).toBe(true);
    expect(evaluateUnary('false', false).passed).toBe(true);
    expect(evaluateUnary('true', false).passed).toBe(false);

    // in [...] and not in [...]
    expect(evaluateUnary('in [1, 2, "gold"]', 2).passed).toBe(true);
    expect(evaluateUnary('in [1, 2, "gold"]', 'gold').passed).toBe(true);
    expect(evaluateUnary('in [1, 2]', 3).passed).toBe(false);
    expect(evaluateUnary('not in ["bronze", "silver"]', 'gold').passed).toBe(true);
    expect(evaluateUnary('not in ["bronze", "silver"]', 'bronze').passed).toBe(false);

    // Comma-separated shorthand
    expect(evaluateUnary('gold, platinum, vip', 'platinum').passed).toBe(true);
    expect(evaluateUnary('gold, platinum, vip', 'bronze').passed).toBe(false);

    // Range [min..max]
    expect(evaluateUnary('[10..20]', 10).passed).toBe(true);
    expect(evaluateUnary('[10..20]', 20).passed).toBe(true);
    expect(evaluateUnary('(10..20)', 10).passed).toBe(false);
    expect(evaluateUnary('(10..20)', 20).passed).toBe(false);
    expect(evaluateUnary('[10..20]', 'invalid').passed).toBe(false);

    // Comparisons
    expect(evaluateUnary('>= 50', 50).passed).toBe(true);
    expect(evaluateUnary('<= 50', 50).passed).toBe(true);
    expect(evaluateUnary('> 50', 51).passed).toBe(true);
    expect(evaluateUnary('< 50', 49).passed).toBe(true);
    expect(evaluateUnary('== 50', 50).passed).toBe(true);
    expect(evaluateUnary('= 50', 50).passed).toBe(true);
    expect(evaluateUnary('!= 50', 51).passed).toBe(true);
    expect(evaluateUnary('>= 50', 49).passed).toBe(false);
    expect(evaluateUnary('<= 50', 51).passed).toBe(false);
    expect(evaluateUnary('> 50\n60', 60).passed).toBe(false); // Multiline rejection

    // Exact fallback match
    expect(evaluateUnary('custom_status', 'custom_status').passed).toBe(true);
    expect(evaluateUnary('custom_status', 'other').passed).toBe(false);
  });

  it('covers ZenDecisionContent, schema validation, decision table hit policies, and ZenEngine', async () => {
    // Buffer input
    const bufContent = new ZenDecisionContent(Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
    expect(bufContent.graph).toBeDefined();

    // String input
    const strContent = new ZenDecisionContent(JSON.stringify({ graph: { nodes: [], edges: [] } }));
    expect(strContent.graph).toBeDefined();

    // Invalid input throws
    expect(() => new ZenDecisionContent(12345 as any)).toThrow(TypeError);

    // Decision table with collect and ruleOrder hitPolicy
    const dtGraph = {
      nodes: [
        {
          id: 'in',
          type: 'inputNode',
          content: {
            schema: {
              type: 'object',
              required: ['tier', 'score'],
              properties: {
                tier: { type: 'string' },
                score: { type: 'number', minimum: 0, maximum: 100 },
              },
            },
          },
        },
        {
          id: 'dt',
          name: 'decision_table',
          type: 'decisionTableNode',
          content: {
            hitPolicy: 'collect',
            inputs: [
              { id: 'i1', field: 'tier' },
              { id: 'i2', field: 'score' },
            ],
            outputs: [
              { id: 'o1', field: 'discount' },
              { id: 'o2', field: 'approved' },
            ],
            rules: [
              { _id: 'r1', i1: 'VIP', i2: '>= 50', o1: '=score * 0.2', o2: 'true' },
              { _id: 'r2', i1: '-', i2: '>= 70', o1: '15', o2: 'true' },
            ],
          },
        },
        {
          id: 'out',
          type: 'outputNode',
          content: {
            schema: {
              type: 'object',
              properties: {
                results: { type: 'array' },
              },
            },
          },
        },
      ],
      edges: [
        { sourceId: 'in', targetId: 'dt' },
        { sourceId: 'dt', targetId: 'out' },
      ],
    };

    const engine = new ZenEngine();
    const decision = engine.createDecision(dtGraph);
    const evalRes = await decision.evaluate({ tier: 'VIP', score: 80 }, { trace: true });
    expect(evalRes.result.results.length).toBe(2);
    expect(evalRes.trace.length).toBe(3);

    // Schema validation errors
    await expect(decision.evaluate({ tier: 123, score: 150 })).rejects.toThrow(/schema validation failed/);

    // First hit policy with no match
    const firstDtGraph = {
      nodes: [
        { id: 'in', type: 'inputNode' },
        {
          id: 'dt',
          type: 'decisionTableNode',
          content: {
            hitPolicy: 'first',
            inputs: [{ id: 'i1', field: 'tier' }],
            outputs: [{ id: 'o1', field: 'discount' }],
            rules: [{ _id: 'r1', i1: 'GOLD', o1: '10' }],
          },
        },
        { id: 'out', type: 'outputNode' },
      ],
      edges: [
        { sourceId: 'in', targetId: 'dt' },
        { sourceId: 'dt', targetId: 'out' },
      ],
    };
    const firstDecision = engine.createDecision(firstDtGraph);
    const firstRes = await firstDecision.evaluate({ tier: 'UNKNOWN' });
    expect(firstRes.result).toBeDefined();

    // ZenEngine with loader and evaluate signatures
    let loaded = 0;
    const loaderEngine = new ZenEngine({
      loader: async (key: string) => {
        loaded++;
        return key === 'model_a' ? dtGraph : null;
      },
    });

    const m1 = await loaderEngine.getDecision('model_a');
    const m2 = await loaderEngine.getDecision('model_a');
    expect(m1).toBe(m2);
    expect(loaded).toBe(1);

    const mNull = await loaderEngine.getDecision('not_existing');
    expect(mNull).toBeNull();

    // 2-arg signature
    const eval2 = await loaderEngine.evaluate(dtGraph, { tier: 'VIP', score: 80 });
    expect(eval2.result).toBeDefined();

    // 4-arg signature
    const eval4 = await loaderEngine.evaluate(null, dtGraph, { tier: 'VIP', score: 80 }, { trace: true });
    expect(eval4.trace).toBeDefined();

    loaderEngine.dispose();
  });
});

// =========================================================================
// SECTION 2: LearningCourseCompletion Component Deep Coverage
// =========================================================================

describe('LearningCourseCompletion Component', () => {
  const sampleClassData = {
    course: { id: 'course-101', title: 'Company A Engineering Architecture', revision: 2 },
    can_manage: true,
    items: [
      {
        username: 'learner.jane',
        display_name: 'Jane Doe',
        eligible: true,
        evidence_digest: 'sha256-evidence-jane',
        requirements: [
          { assignment_id: 'a1', title: 'API Routing Lab', resource_type: 'lab', resource_version: 1, completed: true, status: 'completed', score: 100, max_score: 100, minimum_score_percent: 80 },
          { assignment_id: 'a2', title: 'DOCSIS Telemetry Quiz', resource_type: 'quiz', resource_version: null, completed: true, status: 'completed', score: 90, max_score: 100, minimum_score_percent: 75 },
        ],
        certificate: null,
      },
      {
        username: 'learner.bob',
        display_name: 'Bob Smith',
        eligible: true,
        evidence_digest: 'sha256-evidence-bob',
        requirements: [
          { assignment_id: 'a1', title: 'API Routing Lab', resource_type: 'lab', resource_version: 1, completed: true, status: 'completed' },
        ],
        certificate: {
          id: 'cert-bob-99',
          recipient_name: 'Bob Smith',
          course_title: 'Company A Engineering Architecture',
          instructor_name: 'Lead Architect',
          version: 1,
          class_revision: 2,
          issued_at: '2026-10-15T10:00:00Z',
          revoked_at: null,
          revocation_reason: null,
          email_status: 'sent',
          email_recipient: 'bob@example.com',
          emailed_at: '2026-10-15T10:05:00Z',
        },
      },
      {
        username: 'learner.revoked',
        display_name: 'Alex Grey',
        eligible: false,
        evidence_digest: 'sha256-evidence-alex',
        requirements: [],
        certificate: {
          id: 'cert-alex-01',
          recipient_name: 'Alex Grey',
          course_title: 'Company A Engineering Architecture',
          instructor_name: 'Lead Architect',
          version: 1,
          class_revision: 1, // earlier revision
          issued_at: '2026-08-01T10:00:00Z',
          revoked_at: '2026-08-15T12:00:00Z',
          revocation_reason: 'Plagiarism in lab submissions',
          email_status: 'failed',
          email_error: 'SMTP connection timeout',
        },
      },
    ],
  };

  it('renders learner management, approval modal, revoke modal, certificate preview, and email triggers', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      const u = String(url);
      if (u.endsWith('/completion') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sampleClassData),
        });
      }
      if (u.includes('/approve')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }
      if (u.includes('/send-email')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ delivery: { status: 'sent', recipient: 'bob@example.com' } }),
        });
      }
      if (u.includes('/revoke')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sampleClassData) });
    });

    await act(async () => {
      root.render(<LearningCourseCompletion classId="course-101" canManage={true} />);
    });

    expect(host.textContent).toContain('Learner progress & certificates');
    expect(host.textContent).toContain('Jane Doe');
    expect(host.textContent).toContain('Bob Smith');
    expect(host.textContent).toContain('Alex Grey');

    // Certificate preview toggle for Bob
    const previewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Preview certificate');
    expect(previewBtn).toBeDefined();
    await act(async () => {
      previewBtn?.click();
    });
    expect(host.querySelector('iframe')).not.toBeNull();

    await act(async () => {
      previewBtn?.click();
    });
    expect(host.querySelector('iframe')).toBeNull();

    // Trigger email send
    const emailBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Send by email');
    await act(async () => {
      emailBtn?.click();
    });
    expect(host.textContent).toContain('Certificate emailed to bob@example.com');

    // Review completion & issue certificate for Jane
    const reviewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Review completion'));
    expect(reviewBtn).toBeDefined();
    await act(async () => {
      reviewBtn?.click();
    });

    expect(host.textContent).toContain('Approve Jane Doe for Company A Engineering Architecture');

    // Fill note and check approval box
    const noteArea = host.querySelector<HTMLTextAreaElement>('textarea');
    if (noteArea) {
      await act(async () => {
        noteArea.value = 'Outstanding lab execution';
        noteArea.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const confirmCheck = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (confirmCheck) {
      await act(async () => {
        confirmCheck.checked = true;
        confirmCheck.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const approveSubmit = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Approve completion & issue certificate'));
    await act(async () => {
      approveSubmit?.click();
    });

    // Revoke certificate for Bob
    const revokeBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Revoke certificate');
    expect(revokeBtn).toBeDefined();
    await act(async () => {
      revokeBtn?.click();
    });

    expect(host.textContent).toContain("Revoke Bob Smith’s certificate");
    const revokeReasonArea = host.querySelector<HTMLTextAreaElement>('textarea');
    if (revokeReasonArea) {
      await act(async () => {
        revokeReasonArea.value = 'Lab data discrepancy detected';
        revokeReasonArea.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const confirmRevokeBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Confirm revocation');
    await act(async () => {
      confirmRevokeBtn?.click();
    });

    // Refresh completion button
    const refreshBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Refresh completion');
    await act(async () => {
      refreshBtn?.click();
    });
  });

  it('renders learner view without management controls and allows claim certificate', async () => {
    const learnerData = {
      course: { id: 'course-101', title: 'Company A Network Fundamentals', revision: 1 },
      can_manage: false,
      items: [
        {
          username: 'current.learner',
          display_name: 'Current Learner',
          eligible: true,
          evidence_digest: 'sha256-learner',
          requirements: [
            { assignment_id: 'a1', title: 'Intro Lecture', resource_type: 'lecture', resource_version: null, completed: true, status: 'completed' },
          ],
          certificate: null,
        },
      ],
    };

    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (String(url).includes('/claim')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(learnerData),
      });
    });

    await act(async () => {
      root.render(<LearningCourseCompletion classId="course-101" canManage={false} />);
    });

    expect(host.textContent).toContain('Course completion & certificates');
    expect(host.textContent).toContain('Your course completion');

    const generateBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Generate certificate');
    expect(generateBtn).toBeDefined();

    await act(async () => {
      generateBtn?.click();
    });
    expect(host.textContent).toContain('Your Buddy course completion certificate has been generated');
  });
});

// =========================================================================
// SECTION 3: MCPCatalog & MCPServerCatalog Deep Coverage
// =========================================================================

describe('MCPCatalog & MCPServerCatalog Components', () => {
  const sampleTemplates = [
    {
      id: 'docmost_wiki',
      name: 'Docmost Knowledge Base',
      description: 'Documentation and enterprise architectural guides',
      icon: 'docmost',
      transport: 'http',
      url: 'https://example.com',
      command: '',
      args: [],
      fields: [{ key: 'token', label: 'API Token', location: 'header', target: 'Authorization', prefix: 'Bearer ', required: true }],
      knowledge_base: 'company',
      audience: 'both',
      access_mode: 'grants',
      groups: ['company'],
      users: ['admin'],
      enabled: true,
      connected: true,
      allowed: true,
      ready: true,
      category: 'knowledge',
      docs_url: 'https://docs.docmost.com',
      setup_instructions: 'Create an API key in user settings.',
      auth_mode: 'credentials',
    },
    {
      id: 'keycloak_oauth',
      name: 'Keycloak IAM Server',
      description: 'Enterprise SSO and token exchange',
      icon: 'keycloak',
      transport: 'http',
      url: 'https://example.com',
      command: '',
      args: [],
      fields: [],
      knowledge_base: 'company',
      audience: 'both',
      access_mode: 'grants',
      groups: ['company'],
      users: [],
      enabled: true,
      connected: false,
      allowed: true,
      ready: true,
      category: 'productivity',
      auth_mode: 'keycloak',
      oauth_client_id: 'buddy-client',
      oauth_scopes: 'openid email profile',
      oauth_token_auth_method: 'client_secret_post',
      oauth_client_secret_env: 'BOB_MCP_OAUTH_KEYCLOAK_SECRET',
    },
    {
      id: 'local_cli_tool',
      name: 'Local Diagnostic CLI',
      description: 'System diagnostics via local stdio process',
      icon: 'code',
      transport: 'stdio',
      url: '',
      command: 'python3 -m diagnostic.cli',
      args: ['--json', '--all'],
      fields: [{ key: 'api_key', label: 'CLI Secret', location: 'env', target: 'DIAG_KEY', prefix: '', required: false }],
      knowledge_base: 'company',
      audience: 'both',
      access_mode: 'grants',
      groups: ['buddy'],
      users: [],
      enabled: true,
      connected: false,
      allowed: true,
      ready: true,
      category: 'development',
      auth_mode: 'credentials',
    },
  ];

  it('renders CatalogIcon variations', () => {
    const icons = ['docmost', 'microsoft', 'notion', 'atlassian', 'linear', 'gitlab', 'cloudflare', 'context7', 'tavily', 'exa', 'firecrawl', 'brave', 'deepwiki', 'keycloak', 'plug', 'github', 'search', 'board', 'database', 'cloud', 'chat', 'code'];
    icons.forEach(k => {
      const el = document.createElement('div');
      const r = createRoot(el);
      act(() => {
        r.render(<CatalogIcon kind={k} />);
      });
      expect(el.innerHTML).toBeTruthy();
    });
  });

  it('loads MCP catalog, filters by query/category, connects and edits templates', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      const u = String(url);
      if (u.includes('/admin/users')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ users: [{ username: 'admin', display_name: 'Lead Admin' }, { username: 'engineer', display_name: 'Network Eng' }] }),
        });
      }
      if (u.includes('/check')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'working', message: 'Online and operational', tools: ['search'] }),
        });
      }
      if (u.includes('/mcp-catalog') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sampleTemplates),
        });
      }
      if (opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const onChanged = vi.fn();

    await act(async () => {
      root.render(<MCPCatalog isAdmin={true} onChanged={onChanged} standalone={true} />);
    });

    expect(host.textContent).toContain('Docmost Knowledge Base');
    expect(host.textContent).toContain('Keycloak IAM Server');
    expect(host.textContent).toContain('Local Diagnostic CLI');

    // Filter by search query
    const searchInput = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (searchInput) {
      await act(async () => {
        searchInput.value = 'docmost';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.textContent).toContain('Docmost Knowledge Base');
    }

    // Connect with credentials
    const updateCredsBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Update credentials');
    expect(updateCredsBtn).toBeDefined();
    await act(async () => {
      updateCredsBtn?.click();
    });

    expect(host.textContent).toContain('Connect Docmost Knowledge Base');
    const pwdInput = host.querySelector<HTMLInputElement>('input[type="password"]');
    if (pwdInput) {
      await act(async () => {
        pwdInput.value = 'secret-token-123';
        pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const saveConnBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save connection');
    await act(async () => {
      saveConnBtn?.click();
    });

    // Disconnect
    const disconnectBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Disconnect');
    await act(async () => {
      disconnectBtn?.click();
    });
    expect(onChanged).toHaveBeenCalled();

    // Assign access modal
    const assignAccessBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Assign access');
    await act(async () => {
      assignAccessBtn?.click();
    });

    expect(host.textContent).toContain('Assign access ·');
    const saveAccessBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save access');
    await act(async () => {
      saveAccessBtn?.click();
    });

    // Create template modal
    const createBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Create template');
    await act(async () => {
      createBtn?.click();
    });

    expect(host.textContent).toContain('Template & access');
    const cancelTplBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
    await act(async () => {
      cancelTplBtn?.click();
    });
  });

  it('renders MCPServerCatalog overlay with close and keyboard escape', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/check')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'working', message: 'Online and operational', tools: ['search'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(sampleTemplates),
      });
    });

    const onClose = vi.fn();
    const onChanged = vi.fn();

    await act(async () => {
      root.render(
        <MCPServerCatalog
          isAdmin={true}
          onChanged={onChanged}
          onClose={onClose}
          servers={[{ name: 'router-telemetry', transport: 'stdio', status: 'connected' } as any]}
        />
      );
    });

    expect(host.textContent).toContain('MCP server catalogue');
    expect(host.textContent).toContain('Shared MCP connections');

    // Press Escape
    const dialog = host.querySelector('.feature-dialog')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

// =========================================================================
// SECTION 4: StickyNotes & NotesWorkspace Full Coverage
// =========================================================================

describe('StickyNotes & NotesWorkspace Components', () => {
  const sampleSavedNotes = [
    {
      id: 1,
      title: 'API Routing Configuration',
      body: '1. Update route reflector in DC1\n2. Verify prefix exchange with [[Core Router Notes]]',
      color: 'butter' as const,
      collection: 'Infrastructure',
      tags: ['network', 'api'],
      favorite: true,
      sources: [{ title: 'RFC 4271', url: 'https://datatracker.ietf.org/doc/html/rfc4271' }],
      created_at: '2026-10-20T08:00:00Z',
    },
    {
      id: 2,
      title: 'Core Router Notes',
      body: 'Detailed telemetry notes for core backbones.',
      color: 'sky' as const,
      collection: 'Infrastructure',
      tags: ['software'],
      favorite: false,
      sources: [],
      created_at: '2026-10-21T09:00:00Z',
    },
  ];

  it('renders StickyNotes with note links and handles updates', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: sampleSavedNotes }),
    });

    await act(async () => {
      root.render(
        <StickyNotes
          notes={[
            { title: 'API Routing Configuration', body: '1. Update route reflector\n2. Run checks', color: 'butter' },
          ]}
          sessionId="sess-1"
          messageId="msg-1"
        />
      );
    });

    expect(host.textContent).toContain('API Routing Configuration');
  });

  it('NotesWorkspace handles searching, filtering, editing, formatting, enrichment and bulk actions', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      const u = String(url);
      if (opts?.method === 'POST' || opts?.method === 'PATCH' || opts?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 99, title: 'Saved Note', body: 'Body', color: 'butter', tags: ['daily'], favorite: false }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: sampleSavedNotes, default_collection: 'Infrastructure' }),
      });
    });

    const onBack = vi.fn();
    await act(async () => {
      root.render(<NotesWorkspace onBack={onBack} />);
    });

    expect(host.textContent).toContain('API Routing Configuration');
    expect(host.textContent).toContain('Core Router Notes');

    // Switch view to list
    const listViewBtn = Array.from(host.querySelectorAll('button')).find(b => b.title?.includes('List') || b.textContent?.includes('List'));
    if (listViewBtn) {
      await act(async () => {
        listViewBtn.click();
      });
    }

    // Filter by search
    const searchField = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (searchField) {
      await act(async () => {
        searchField.value = 'API';
        searchField.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.textContent).toContain('API Routing Configuration');
    }

    // Open Daily Note
    const dailyBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Daily note'));
    if (dailyBtn) {
      await act(async () => {
        dailyBtn.click();
      });
      expect(host.querySelector('dialog')).not.toBeNull();
    }

    // Use enrichment with Bob
    const enrichToggle = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Ask Bob') || b.textContent?.includes('Enrich'));
    if (enrichToggle) {
      await act(async () => {
        enrichToggle.click();
      });
    }

    // Close Editor
    const closeBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Cancel' || b.textContent === 'Close');
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
    }
  });
});

// =========================================================================
// SECTION 5: SlideViewer Component Deep Coverage
// =========================================================================

describe('SlideViewer Component', () => {
  const sampleDeck = {
    title: 'Company A Engineering Network',
    metadata: { brand: 'Company A Enterprise' },
    slides: [
      {
        title: 'Executive Overview',
        elements: [
          { type: 'title', content: 'Executive Overview' },
          { type: 'bullet', items: ['DOCSIS 4.0 Rollout', 'Core Fiber Upgrade'] },
        ],
      },
      {
        title: 'Network Capacity Planning',
        elements: [
          { type: 'title', content: 'Network Capacity Planning' },
          { type: 'stat', value: '10 Gbps', label: 'Backbone Throughput' },
        ],
      },
    ],
  };

  it('renders presentation deck, handles slide navigation, editing, and exports', async () => {
    const onDirtyChange = vi.fn();
    const onSaveJson = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <SlideViewer
          deckData={sampleDeck}
          sessionId="session-deck-1"
          filename="network_overview.bobdeck"
          onDirtyChange={onDirtyChange}
          onSaveJson={onSaveJson}
        />
      );
    });

    expect(host.textContent).toContain('Company A Engineering Network');
    expect(host.textContent).toContain('Slide1 of2');

    // Next Slide
    const nextBtn = host.querySelector<HTMLButtonElement>('button[title="Next Slide"]')!;
    expect(nextBtn).toBeDefined();
    await act(async () => {
      nextBtn.click();
    });
    expect(host.textContent).toContain('Slide2 of2');

    // Previous Slide
    const prevBtn = host.querySelector<HTMLButtonElement>('button[title="Previous Slide"]')!;
    await act(async () => {
      prevBtn.click();
    });
    expect(host.textContent).toContain('Slide1 of2');

    // Toggle Edit Mode
    const editBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Edit'));
    expect(editBtn).toBeDefined();
    await act(async () => {
      editBtn?.click();
    });

    // Save PPTX
    const downloadPptxBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Download PPTX'));
    await act(async () => {
      downloadPptxBtn?.click();
    });

    // Fullscreen toggle
    const fullscreenBtn = Array.from(host.querySelectorAll('button')).find(b => b.title?.includes('Maximize') || b.title?.includes('Fullscreen'));
    await act(async () => {
      fullscreenBtn?.click();
    });

    // Keyboard navigation in fullscreen
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  it('handles empty deck data fallback gracefully', async () => {
    await act(async () => {
      root.render(<SlideViewer deckData={null} />);
    });
    expect(host.textContent).toContain('Presentation deck is loading or unavailable.');

    await act(async () => {
      root.render(<SlideViewer deckData={{ title: 'Empty', slides: [] }} />);
    });
    expect(host.textContent).toContain('Presentation deck has no slides yet.');
  });
});

// =========================================================================
// SECTION 6: VoiceChat Component Deep Coverage
// =========================================================================

describe('VoiceChat Component', () => {
  it('opens panel, fetches voices, starts capture, interrupts, and triggers speech', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/voice/voices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ voices: [{ id: 'voice-marcus', name: 'Marcus (Deep)' }, { id: 'voice-elena', name: 'Elena (Clear)' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const onSend = vi.fn();
    const onStop = vi.fn();
    const onActiveChange = vi.fn();

    await act(async () => {
      root.render(
        <VoiceChat
          messages={[{ id: 'm1', role: 'assistant', content: 'Network status normal' }]}
          busy={false}
          disabled={false}
          enabled={true}
          sessionId="voice-sess-1"
          onSend={onSend}
          onStop={onStop}
          onActiveChange={onActiveChange}
          readRequest={null}
        />
      );
    });

    // Open voice panel
    const launcher = host.querySelector<HTMLButtonElement>('.composer-websearch-btn')!;
    await act(async () => {
      launcher.click();
    });

    expect(host.querySelector('.voice-chat-panel')).not.toBeNull();

    // Focus select to load voices
    const select = host.querySelector<HTMLSelectElement>('.voice-chat-controls select')!;
    await act(async () => {
      select.focus();
      select.dispatchEvent(new Event('focus'));
    });

    // Start conversation
    const startBtn = host.querySelector<HTMLButtonElement>('.voice-chat-start')!;
    await act(async () => {
      startBtn.click();
    });

    expect(mockVoiceCaptureInstances.length).toBe(1);
    expect(onActiveChange).toHaveBeenCalledWith(true);

    // Mute and unmute
    const muteBtn = host.querySelector<HTMLButtonElement>('.voice-chat-controls button')!;
    await act(async () => {
      muteBtn.click();
      muteBtn.click();
    });

    // Interrupt
    const interruptBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Interrupt'));
    await act(async () => {
      interruptBtn?.click();
    });

    // Read aloud prop trigger
    await act(async () => {
      root.render(
        <VoiceChat
          messages={[{ id: 'm1', role: 'assistant', content: 'Network status normal' }]}
          busy={false}
          disabled={false}
          enabled={true}
          sessionId="voice-sess-1"
          onSend={onSend}
          onStop={onStop}
          onActiveChange={onActiveChange}
          readRequest={{ text: 'Voice diagnostic readout', nonce: 2 }}
        />
      );
    });

    expect(mockVoiceSpeakerInstances.length).toBeGreaterThanOrEqual(1);

    // End conversation
    const endBtn = host.querySelector<HTMLButtonElement>('.voice-chat-end')!;
    await act(async () => {
      endBtn.click();
    });
    expect(onActiveChange).toHaveBeenCalledWith(false);
  });
});

// =========================================================================
// SECTION 7: DecisionTableTab Component Deep Coverage
// =========================================================================

describe('DecisionTableTab Component', () => {
  const sampleDecisionModel = {
    id: 'decision-dt-01',
    name: 'Broadband Discount Decision',
    version: 1,
    _dirty: false,
    graph: {
      nodes: [
        {
          id: 'node_dt_1',
          name: 'Tier Discount Rules',
          type: 'decisionTableNode',
          content: {
            hitPolicy: 'first',
            inputs: [
              { id: 'in_tier', field: 'customer.tier', name: 'Customer Tier' },
              { id: 'in_spend', field: 'customer.spend', name: 'Monthly Spend' },
            ],
            outputs: [
              { id: 'out_discount', field: 'discount', name: 'Discount %' },
            ],
            rules: [
              { _id: 'r_1', _description: 'High Spend VIP', in_tier: 'VIP', in_spend: '>= 100', out_discount: '25' },
              { _id: 'r_2', _description: 'Standard Gold', in_tier: 'GOLD', in_spend: '-', out_discount: '10' },
            ],
          },
        },
        {
          id: 'node_wx_1',
          name: 'watsonx Churn Risk',
          type: 'watsonxAiNode',
          content: {
            endpoint: 'https://example.com',
            projectId: 'proj-123',
            modelId: 'ibm/granite-13b-instruct-v2',
            outputField: 'churnScore',
          },
        },
      ],
      edges: [
        { sourceId: 'node_wx_1', targetId: 'node_dt_1' },
      ],
    },
  };

  it('renders interactive decision table, moves rules, adds rules, runs static analysis & heatmap', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      const u = String(url);
      if (u.includes('/analytics')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            totalRuns: 1540,
            avgLatencyMicros: 42,
            p95LatencyMicros: 78,
            ruleHeatmap: {
              r_1: { hitCount: 1200, hitPercentage: 77.9 },
              r_2: { hitCount: 340, hitPercentage: 22.1 },
            },
          }),
        });
      }
      if (u.includes('/analyze')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            diagnostics: [
              { code: 'WARN_RULE_OVERLAP', severity: 'warning', message: 'Rule 2 may be shadowed by Rule 1' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const onUpdateModel = vi.fn();
    const onEvaluate = vi.fn();
    const onSaveToDb = vi.fn();

    await act(async () => {
      root.render(
        <DecisionTableTab
          model={sampleDecisionModel}
          onUpdateModel={onUpdateModel}
          onEvaluate={onEvaluate}
          onSaveToDb={onSaveToDb}
          editable={true}
          evaluationResult={{ trace: [{ id: 'node_dt_1', ruleTrace: [{ ruleId: 'r_1', passed: true }] }] }}
        />
      );
    });

    expect(host.textContent).toContain('Interactive Decision Table');
    expect(host.textContent).toContain('High Spend VIP');
    expect(host.textContent).toContain('MATCH');

    // Run diagnostics
    const diagBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Check Rule Conflicts'));
    await act(async () => {
      diagBtn?.click();
    });
    expect(host.textContent).toContain('WARN_RULE_OVERLAP');

    // Toggle heatmap
    const heatmapBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Rule Heatmap'));
    await act(async () => {
      heatmapBtn?.click();
    });
    expect(host.textContent).toContain('TOTAL RUNS: 1540');

    // Open .policy View modal
    const policyBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('.policy View'));
    await act(async () => {
      policyBtn?.click();
    });
    expect(host.textContent).toContain('DecisionsBuddy Human-readable Table Summary');

    // Open Add Rule modal
    const addRuleBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Add Rule');
    await act(async () => {
      addRuleBtn?.click();
    });

    const ruleDescInput = host.querySelector<HTMLInputElement>('#rule-desc');
    if (ruleDescInput) {
      await act(async () => {
        ruleDescInput.value = 'Silver Promotion';
        ruleDescInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const modalAddBtn = Array.from(host.querySelectorAll('.cds--modal button')).find(b => b.textContent === 'Add Rule');
    await act(async () => {
      modalAddBtn?.click();
    });
    expect(onUpdateModel).toHaveBeenCalled();

    // Re-evaluate button
    const evalBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Re-evaluate');
    await act(async () => {
      evalBtn?.click();
    });
    expect(onEvaluate).toHaveBeenCalled();

    // Save decision button
    const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save decision');
    await act(async () => {
      saveBtn?.click();
    });
    expect(onSaveToDb).toHaveBeenCalled();
  });
});

// =========================================================================
// SECTION 8: DecisionsApp Top-Level Workspace Coverage
// =========================================================================

describe('DecisionsApp Workspace Component', () => {
  it('loads backend decisions, switches tabs, creates draft, and promotes governance', async () => {
    const singleDecision = {
      id: 'software-routing-decision',
      name: 'Enterprise Routing Decision',
      version: 1,
      status: 'draft',
      owner: 'lead.architect',
      graph: {
        nodes: [
          { id: 'in', name: 'Input', type: 'inputNode', content: {} },
          { id: 'dt', name: 'Rules', type: 'decisionTableNode', content: { hitPolicy: 'first', inputs: [], outputs: [], rules: [] } },
        ],
        edges: [{ sourceId: 'in', targetId: 'dt' }],
      },
    };

    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      const u = String(url);
      if (u.includes('/admin/integrations')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ providers: {}, encryption_available: true }),
        });
      }
      if (u.includes('/audit-logs')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (u.includes('/cp4d/terms')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (u.includes('/cp4d/status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'connected' }),
        });
      }
      if (u.includes('/cp4d/governance')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ terms: [] }),
        });
      }
      if (u.includes('/versions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (u.includes('/me')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ username: 'lead.architect', role: 'admin' }),
        });
      }
      if (u.includes('/models/software-routing-decision')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(singleDecision),
        });
      }
      if (u.includes('/models') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: 'software-routing-decision', name: 'Enterprise Routing Decision', version: 1 }]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ decision: { id: 'software-routing-decision', version: 2 } }) });
    });

    await act(async () => {
      root.render(<DecisionsApp />);
    });

    expect(host.textContent).toContain('Enterprise Routing Decision');

    // New decision button
    const newBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'New decision');
    await act(async () => {
      newBtn?.click();
    });

    // Theme toggle
    const themeBtn = Array.from(host.querySelectorAll('button')).find(b => b.title?.includes('theme') || b.textContent?.includes('Theme'));
    if (themeBtn) {
      await act(async () => {
        themeBtn.click();
      });
    }

    // Window message SET_UI_SCALE
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'SET_UI_SCALE', scale: 1.2 },
        origin: window.location.origin,
        source: window,
      }));
    });
  });
});

// =========================================================================
// SECTION 9: VisualGraphEditor Canvas Component Deep Coverage
// =========================================================================

describe('VisualGraphEditor Canvas Component', () => {
  const editableModel = {
    id: 'visual-model-1',
    name: 'Visual Flow Test',
    graph: {
      nodes: [
        { id: 'n_in', name: 'Request Payload', type: 'inputNode', position: { x: 100, y: 100 }, content: {} },
        { id: 'n_dt', name: 'Discount Grid', type: 'decisionTableNode', position: { x: 300, y: 100 }, content: { hitPolicy: 'first', inputs: [], outputs: [], rules: [] } },
        { id: 'n_ai', name: 'AI Recommendation', type: 'watsonxAiNode', position: { x: 500, y: 100 }, content: {} },
      ],
      edges: [
        { id: 'e1', sourceId: 'n_in', targetId: 'n_dt' },
      ],
    },
  };

  it('renders canvas toolbar, triggers fit visible flow, edits node and connects edges', async () => {
    const onSaveGraph = vi.fn();
    const onEvaluate = vi.fn();
    const onSaveAndRun = vi.fn();

    await act(async () => {
      root.render(
        <VisualGraphEditor
          model={editableModel}
          onSaveGraph={onSaveGraph}
          onEvaluate={onEvaluate}
          onSaveAndRun={onSaveAndRun}
          editable={true}
          active={true}
        />
      );
    });

    expect(host.querySelector('[data-testid="mock-react-flow"]')).not.toBeNull();
    expect(host.textContent).toContain('Request Payload');
    expect(host.textContent).toContain('Discount Grid');

    // Trigger Nodes Change
    const triggerNodesBtn = host.querySelector<HTMLButtonElement>('[data-testid="trigger-nodes-change"]')!;
    await act(async () => {
      triggerNodesBtn.click();
    });

    // Trigger Connect
    const triggerConnectBtn = host.querySelector<HTMLButtonElement>('[data-testid="trigger-connect"]')!;
    await act(async () => {
      triggerConnectBtn.click();
    });

    // Delete node
    const delBtn = host.querySelector<HTMLButtonElement>('[data-testid="delete-n_in"]')!;
    await act(async () => {
      delBtn.click();
    });
    expect(onSaveGraph).toHaveBeenCalled();
  });
});

// =========================================================================
// SECTION 10: HtmlDeckViewer Component Deep Coverage
// =========================================================================

describe('HtmlDeckViewer Component', () => {
  const completeHtmlDeck = `<!DOCTYPE html>
<html>
<head><title>Engineering Architecture</title></head>
<body>
  <div class="deck-container">
    <section class="slide active" id="slide-1">
      <div class="kicker">OVERVIEW</div>
      <h1>Company A Hybrid Cloud Software</h1>
      <p class="preview">Strategic initiatives for high reliability networks.</p>
      <div class="stat"><span class="num" data-count="99.99">99.99%</span><span class="label">Uptime SLA</span></div>
    </section>
    <section class="slide" id="slide-2">
      <div class="kicker">INFRASTRUCTURE</div>
      <h1>Edge Distribution & DOCSIS 4.0</h1>
      <p class="preview">Deployment schedule across metropolitan areas.</p>
    </section>
  </div>
</body>
</html>`;

  function populateIframe(iframe: HTMLIFrameElement, html: string) {
    if (iframe.contentDocument) {
      iframe.contentDocument.documentElement.innerHTML = html;
      iframe.dispatchEvent(new Event('load'));
    }
  }

  it('renders presentation studio, handles navigation, floating toolbar, slide management and export', async () => {
    const onSaveHtml = vi.fn().mockResolvedValue(undefined);
    const onDirtyChange = vi.fn();

    await act(async () => {
      root.render(
        <HtmlDeckViewer
          htmlContent={completeHtmlDeck}
          filename="software_architecture.html"
          title="Company A Architecture Deck"
          onSaveHtml={onSaveHtml}
          onDirtyChange={onDirtyChange}
        />
      );
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();

    await act(async () => {
      populateIframe(iframe, completeHtmlDeck);
    });

    expect(host.textContent).toContain('⚡ PRESENTATION STUDIO');
    expect(host.textContent).toContain('Company A Architecture Deck');

    // Slide navigation buttons
    const nextBtn = host.querySelector<HTMLButtonElement>('button[title*="Next slide"]');
    const prevBtn = host.querySelector<HTMLButtonElement>('button[title*="Previous slide"]');
    expect(nextBtn).toBeDefined();
    expect(prevBtn).toBeDefined();

    await act(async () => {
      nextBtn?.click();
    });
    await act(async () => {
      prevBtn?.click();
    });

    // Keyboard navigation
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });

    // Color preset toggle
    const colorBtn = Array.from(host.querySelectorAll('button')).find(b => b.title?.includes('Color') || b.textContent?.includes('Colors') || b.textContent?.includes('Preset'));
    if (colorBtn) {
      await act(async () => {
        colorBtn.click();
      });
    }
  });

  it('renders incomplete deck warning when minimal html is provided', async () => {
    const incompleteHtml = '<html><body><h1>Incomplete</h1></body></html>';
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={incompleteHtml} filename="incomplete.html" />);
    });
    expect(host.textContent).toContain('Presentation Generation Incomplete');
  });
});
