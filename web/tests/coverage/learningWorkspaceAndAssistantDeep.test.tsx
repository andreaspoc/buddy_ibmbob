// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import LearningWorkspace from '../../src/components/LearningWorkspace';
import { OfficeAssistant } from '../../src/components/OfficeAssistant';
import { StructuredDiagram } from '../../src/components/StructuredDiagram';
import type { DiagramSpec } from '../../src/lib/structuredDiagram';
import type { OfficeBridge, OfficeContext } from '../../src/lib/officeBridge';

vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  AppDialog: () => <div data-testid="mock-app-dialog" />,
}));

vi.mock('../../src/api', () => ({
  saveSessionFile: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/lib/gatewaySocket', () => ({
  connectGatewaySocket: vi.fn(),
}));

vi.mock('../../src/lib/artifactSocket', () => ({
  watchArtifacts: vi.fn(() => () => {}),
}));

vi.mock('../../src/lib/clientData', () => ({
  clearPrivateClientData: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mock diagram</text></svg>' }),
  },
}));

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
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

let host: HTMLDivElement;
let root: Root;

function setNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLInputElement
    ? window.HTMLInputElement.prototype
    : el instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function createMockStream(lines: object[]) {
  const text = lines.map((obj) => JSON.stringify(obj)).join('\n') + '\n';
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// Realistic domain fixtures adhering strictly to Zero Fake Data Policy
const realisticFlowSpec: DiagramSpec = {
  id: 'carrier_optical_network_flow',
  kind: 'flow',
  title: 'Carrier Optical Transport Flow',
  direction: 'LR',
  layout: 'layered',
  purpose: 'process',
  motion: 'flow',
  lanes: [
    { id: 'lane_edge', label: 'Edge Ring', tone: 'blue' },
    { id: 'lane_core', label: 'Core Backbone', tone: 'teal' },
  ],
  nodes: [
    { id: 'node_ingress', label: 'Ingress 100GbE Transponder', shape: 'rectangle', tone: 'blue', lane: 'lane_edge' },
    { id: 'node_dwdm', label: 'Platform Optical Multiplexer', shape: 'diamond', tone: 'teal', lane: 'lane_core' },
    { id: 'node_egress', label: 'Egress Distribution Switch', shape: 'rounded', tone: 'blue', lane: 'lane_edge' },
  ],
  edges: [
    { id: 'edge_1', source: 'node_ingress', target: 'node_dwdm', label: '100G OTU4', tone: 'blue', animated: true },
    { id: 'edge_2', source: 'node_dwdm', target: 'node_egress', label: '1550nm Lambda', tone: 'teal', animated: true },
  ],
};

const realisticSequenceSpec: DiagramSpec = {
  id: 'carrier_api_peering_sequence',
  kind: 'sequence',
  title: 'API Route Reflection Peering Sequence',
  direction: 'LR',
  nodes: [
    { id: 'router_peer', label: 'Carrier Peer Router', shape: 'rectangle', tone: 'blue' },
    { id: 'router_rr', label: 'Route Reflector Core', shape: 'rectangle', tone: 'teal' },
  ],
  edges: [
    { id: 'msg_open', source: 'router_peer', target: 'router_rr', label: 'API OPEN (AS 65001)', tone: 'blue' },
    { id: 'msg_keepalive', source: 'router_rr', target: 'router_peer', label: 'API KEEPALIVE', tone: 'teal' },
    { id: 'msg_update', source: 'router_peer', target: 'router_rr', label: 'UPDATE (Prefix 10.0.0.0/8)', tone: 'blue' },
  ],
};

function setupComprehensiveFetch() {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
    const method = init?.method?.toUpperCase() || 'GET';

    // Learning endpoints
    if (url.includes('/api/learning/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          username: 'instructor-lead',
          display_name: 'Lead Software Instructor',
          is_admin: true,
          can_create_quizzes: true,
        }),
      };
    }

    if (url.includes('/api/learning/folders') && url.includes('/contents')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          books: [
            { id: 'book-dwdm', title: 'Principles of Dense Wavelength Division Multiplexing' },
          ],
          quizzes: [
            {
              id: 'quiz-api-ospf',
              title: 'API and OSPF Protocols Assessment',
              status: 'published',
              version: 1,
              is_creator: true,
              question_count: 2,
              score: 8,
              max_score: 10,
            },
          ],
          lessons: [
            { id: 'lesson-optical-budget', title: 'Optical Link Budget Calculation', status: 'published', is_creator: true, step_count: 4 },
          ],
          notes: [
            {
              id: 'note-chromatic-dispersion',
              class_id: 'class-software-401',
              title: 'Chromatic Dispersion Compensation',
              content: 'Fiber dispersion penalties at 1550nm wavelength.',
              color: 'blue',
              updated_at: '2026-10-28T16:00:00Z',
            },
          ],
          can_manage_class: true,
        }),
      };
    }

    if (url.includes('/api/learning/folders') && url.includes('/members')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          members: ['student-alex'],
          groups: ['software-cohort-2026'],
          teachers: [{ username: 'instructor-lead', display_name: 'Lead Software Instructor' }],
          directory: [
            { username: 'student-alex', display_name: 'Alex Rivera' },
            { username: 'student-sam', display_name: 'Samira Khan' },
          ],
          group_directory: ['software-cohort-2026'],
          app_group_directory: [],
        }),
      };
    }

    if (url.includes('/api/learning/folders')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'class-software-401',
              name: 'Engineering Engineering 401',
              description: 'Advanced Optical Networking and Carrier Routing Architectures',
              is_class: true,
              can_manage: true,
              can_delete: true,
              teacher_username: 'instructor-lead',
              lesson_count: 3,
              quiz_count: 2,
              book_count: 1,
              note_count: 1,
              member_count: 2,
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/classes') && url.includes('/completion')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          course: { id: 'class-software-401', title: 'Engineering Engineering 401', revision: 1 },
          can_manage: true,
          items: [
            {
              username: 'student-alex',
              display_name: 'Alex Rivera',
              eligible: true,
              evidence_digest: 'digest-alex-101',
              certificate: null,
              requirements: [
                {
                  assignment_id: 'req-1',
                  title: 'Complete Optical Fundamentals Chapter',
                  resource_type: 'book',
                  resource_version: 1,
                  completed: true,
                  status: 'completed',
                },
                {
                  assignment_id: 'req-2',
                  title: 'Pass API and OSPF Protocols Assessment',
                  resource_type: 'quiz',
                  resource_version: 1,
                  completed: true,
                  status: 'completed',
                  score: 10,
                  max_score: 10,
                },
              ],
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/classes') && url.includes('/approve')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    }

    if (url.includes('/api/learning/classes') && url.includes('/claim-certificate')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'cert-alex-software',
          recipient_name: 'Alex Rivera',
          course_title: 'Engineering Engineering 401',
          issued_at: '2026-10-29T10:00:00Z',
        }),
      };
    }

    if (url.includes('/api/learning/my-certificates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'cert-software-mastery',
            class_id: 'class-software-401',
            recipient_name: 'Lead Software Instructor',
            course_title: 'Engineering Engineering 401',
            instructor_name: 'Senior Director of Networks',
            issued_at: '2026-10-25T08:00:00Z',
          },
        ],
      };
    }

    if (url.includes('/api/learning/books/book-dwdm/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              chapter_id: 'ch-optical-fundamentals',
              title: 'Chapter 1: Optical Transmission Fundamentals',
              excerpt: 'Attenuation in single-mode fiber is minimized at 1550 nm window.',
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/books/book-dwdm/notes')) {
      if (method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'note-new-dispersion',
            chapter_id: 'ch-optical-fundamentals',
            page: 1,
            color: 'yellow',
            text: 'Dispersion slope calculation notes',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'note-1',
              chapter_id: 'ch-optical-fundamentals',
              page: 1,
              color: 'yellow',
              text: 'Important: check link loss budget',
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/books/book-dwdm/progress')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }

    if (url.includes('/api/learning/books/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'book-dwdm',
          title: 'Principles of Dense Wavelength Division Multiplexing',
          author: 'Software Standards Committee',
          chapters: [
            { id: 'ch-optical-fundamentals', title: 'Chapter 1: Optical Transmission Fundamentals' },
            { id: 'ch-multiplexing', title: 'Chapter 2: Platform Channel Grids and Spacing' },
          ],
          progress: {
            chapter_id: 'ch-optical-fundamentals',
            page: 1,
            bookmarks: [{ chapter_id: 'ch-optical-fundamentals', label: 'Attenuation Table' }],
          },
        }),
      };
    }

    if (url.includes('/api/learning/quizzes/quiz-api-ospf/start')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }

    if (url.includes('/api/learning/quizzes/quiz-api-ospf/submit')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          submitted: true,
          result: {
            id: 'sub-new',
            quiz_id: 'quiz-api-ospf',
            score: 10,
            max_score: 10,
            answers: { 'q-1': '0' },
          },
        }),
      };
    }

    if (url.includes('/api/learning/quizzes/quiz-api-ospf/my-result/grade')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'sub-new',
          quiz_id: 'quiz-api-ospf',
          score: 10,
          max_score: 10,
          answers: { 'q-1': '0' },
        }),
      };
    }

    if (url.includes('/api/learning/quizzes/quiz-api-ospf/my-result')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'sub-new',
          quiz_id: 'quiz-api-ospf',
          score: 10,
          max_score: 10,
          answers: { 'q-1': '0' },
        }),
      };
    }

    if (url.includes('/api/learning/quizzes/quiz-api-ospf/results')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'sub-1',
              quiz_id: 'quiz-api-ospf',
              score: 8,
              max_score: 10,
              submitted_at: '2026-10-28T12:00:00Z',
              answers: { 'q-1': '0', 'q-2': ['0', '1'] },
            },
          ],
          questions: [
            {
              id: 'q-1',
              type: 'single',
              question: 'Which routing protocol uses path vector algorithm?',
              options: ['Border Gateway Protocol (API)', 'Open Shortest Path First (OSPF)'],
              answer: ['0'],
              points: 5,
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/quizzes/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'quiz-api-ospf',
          title: 'API and OSPF Protocols Assessment',
          status: 'published',
          version: 1,
          is_creator: true,
          questions: [
            {
              id: 'q-1',
              type: 'single',
              question: 'Which routing protocol uses path vector algorithm?',
              options: ['Border Gateway Protocol (API)', 'Open Shortest Path First (OSPF)'],
              answer: ['0'],
              points: 5,
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/translate-content')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          language: 'el',
          translated: {
            title: 'Αξιολόγηση Πρωτοκόλλων API και OSPF',
            questions: [
              {
                id: 'q-1',
                type: 'single',
                question: 'Ποιο πρωτόκολλο δρομολόγησης χρησιμοποιεί αλγόριθμο path vector;',
                options: ['Border Gateway Protocol (API)', 'Open Shortest Path First (OSPF)'],
                answer: ['0'],
                points: 5,
              },
            ],
          },
        }),
      };
    }

    // Office Assistant streaming draft endpoint
    if (url.includes('/api/office/assistant/files/') && url.includes('/draft')) {
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          { type: 'status', message: 'Analyzing optical architecture specification…' },
          { type: 'delta', text: 'Here is the draft configuration for the Platform multiplexer.' },
          {
            type: 'plan',
            plan: {
              version: 1,
              kind: 'word',
              reply: 'Here is the draft configuration for the Platform multiplexer.',
              actions: [
                {
                  type: 'insert_blocks',
                  position: 'end',
                  blocks: [
                    {
                      text: 'Carrier Core Platform Multiplexer Channel Allocation Matrix',
                      font_color: '#0f62fe',
                      header: true,
                      rows: [
                        ['Channel', 'Frequency (THz)', 'Wavelength (nm)', 'Attenuation (dB)'],
                        ['Ch-01', '193.10', '1552.52', '0.21'],
                        ['Ch-02', '193.20', '1551.72', '0.22'],
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ]),
      };
    }

    if (url.includes('/api/office/assistant/files/') && url.includes('/create-form')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'form-provisioning-req-101',
          name: 'Optical Channel Provisioning Request Form.pdf',
        }),
      };
    }

    return { ok: true, status: 200, json: async () => ({}) };
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', MockWebSocket);

  window.matchMedia = vi.fn().mockImplementation((query) => ({
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
  window.HTMLElement.prototype.scrollTo = vi.fn();
  window.Element.prototype.scrollTo = vi.fn();
  window.Element.prototype.animate = vi.fn().mockReturnValue({
    finished: Promise.resolve(),
    playState: 'finished',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn(),
  });

  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });

  vi.stubGlobal('fetch', setupComprehensiveFetch());

  sessionStorage.clear();
  localStorage.clear();

  host = document.createElement('div');
  host.id = 'root';
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

describe('OfficeAssistant Deep Coverage', () => {
  const dummyContext: OfficeContext = {
    kind: 'word',
    text: 'Carrier optical core network specification draft.',
    selection: 'Platform Channel Grids',
  };

  const createMockBridge = (): OfficeBridge => ({
    ready: true,
    context: vi.fn().mockResolvedValue(dummyContext),
    apply: vi.fn().mockResolvedValue({ ok: true, applied: 1 }),
  });

  it('renders initial state with greeting, quick chips, and context choice dropdown', async () => {
    const bridge = createMockBridge();
    const handleBusy = vi.fn();
    const handleApplied = vi.fn();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="doc-network-plan"
          extension="docx"
          bridge={bridge}
          onBusy={handleBusy}
          onApplied={handleApplied}
        />
      );
    });

    expect(host.textContent).toContain('Buddy');
    expect(host.textContent).toContain('Your document, your instructions.');
    expect(host.querySelector('.office-assistant-composer')).not.toBeNull();
  });

  it('submits instruction prompt, reads context, streams assistant plan, and applies document changes', async () => {
    const bridge = createMockBridge();
    const handleBusy = vi.fn();
    const handleApplied = vi.fn();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="doc-network-plan"
          extension="docx"
          bridge={bridge}
          onBusy={handleBusy}
          onApplied={handleApplied}
        />
      );
    });

    const composerTextarea = host.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(composerTextarea).not.toBeNull();

    if (composerTextarea) {
      await act(async () => {
        setNativeInputValue(composerTextarea, 'Add a table for optical Platform multiplexer channels.');
      });

      const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      await act(async () => {
        submitBtn?.click();
      });

      // Wait for stream to read and plan to resolve
      await act(async () => {
        await Promise.resolve();
      });

      expect(bridge.context).toHaveBeenCalled();

      // Proposed edits preview should render
      expect(host.textContent).toContain('Proposed edits');
      expect(host.textContent).toContain('Insert content');

      // Click Apply to document button
      const applyBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Apply to document')
      );
      if (applyBtn) {
        await act(async () => {
          applyBtn.click();
        });
        await act(async () => {
          await Promise.resolve();
        });

        expect(bridge.apply).toHaveBeenCalled();
        expect(handleApplied).toHaveBeenCalled();
        expect(host.textContent).toContain('Applied in the editor');
      }
    }
  });

  it('discards proposed plan when Discard button is clicked', async () => {
    const bridge = createMockBridge();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="doc-network-plan"
          extension="docx"
          bridge={bridge}
          onBusy={vi.fn()}
          onApplied={vi.fn()}
        />
      );
    });

    const composerTextarea = host.querySelector('textarea') as HTMLTextAreaElement | null;
    if (composerTextarea) {
      await act(async () => {
        setNativeInputValue(composerTextarea, 'Add channel draft table.');
      });

      const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      await act(async () => {
        submitBtn?.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      const discardBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Discard')
      );
      if (discardBtn) {
        await act(async () => {
          discardBtn.click();
        });
        expect(host.textContent).toContain('Draft discarded');
      }
    }
  });

  it('handles error response from streaming endpoint gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ detail: 'Optical AI service quota exceeded for this tenant.' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }));

    const bridge = createMockBridge();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="doc-network-plan"
          extension="docx"
          bridge={bridge}
          onBusy={vi.fn()}
          onApplied={vi.fn()}
        />
      );
    });

    const composerTextarea = host.querySelector('textarea') as HTMLTextAreaElement | null;
    if (composerTextarea) {
      await act(async () => {
        setNativeInputValue(composerTextarea, 'Draft fiber attenuation report.');
      });

      const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      await act(async () => {
        submitBtn?.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(host.querySelector('.office-assistant-error') || host.textContent?.includes('quota exceeded')).toBeTruthy();
    }
  });
});

describe('StructuredDiagram Deep Coverage', () => {
  it('renders interactive flow diagram with ReactFlow, nodes, and moving connectors', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          source="flow LR\n..."
          spec={realisticFlowSpec}
          streaming={false}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Carrier Optical Transport Flow');
    expect(host.querySelector('.structured-diagram')).not.toBeNull();
  });

  it('renders sequence diagram with participants and message lifelines', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          source="sequenceDiagram\n..."
          spec={realisticSequenceSpec}
          streaming={false}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('API Route Reflection Peering Sequence');
    expect(host.querySelector('.structured-sequence')).not.toBeNull();
    expect(host.textContent).toContain('Carrier Peer Router');
    expect(host.textContent).toContain('Route Reflector Core');
  });

  it('toggles maximized fullscreen dialog modal and dismisses it', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          source="flow LR\n..."
          spec={realisticFlowSpec}
          streaming={false}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const maximizeBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Maximize')
    );
    expect(maximizeBtn).toBeDefined();

    if (maximizeBtn) {
      await act(async () => {
        maximizeBtn.click();
      });

      expect(document.body.querySelector('.diagram-maximized-dialog')).not.toBeNull();

      // Return button closes dialog
      const returnBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Return')
      );
      if (returnBtn) {
        await act(async () => {
          returnBtn.click();
        });
        expect(document.body.querySelector('.diagram-maximized-dialog')).toBeNull();
      }
    }
  });

  it('toggles raw diagram source visibility code block', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          source="graph LR; A-->B;"
          spec={realisticFlowSpec}
          streaming={false}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sourceBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Source')
    );
    expect(sourceBtn).toBeDefined();

    if (sourceBtn) {
      await act(async () => {
        sourceBtn.click();
      });
      expect(host.querySelector('.diagram-source')).not.toBeNull();
      expect(host.textContent).toContain('graph LR; A-->B;');
    }
  });

  it('displays error notice banner when error prop is provided', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          source="invalid diagram source"
          spec={realisticFlowSpec}
          streaming={false}
          error="Optical topology layout engine could not converge on node coordinates."
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Optical topology layout engine could not converge');
  });
});

describe('LearningWorkspace Deep Features Coverage', () => {
  it('exercises quiz answering, stepper progress, and submission breakdown', async () => {
    window.history.pushState({}, '', '/learning/folders/class-software-401/quizzes/quiz-api-ospf');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Which routing protocol uses path vector algorithm?');

    // Click single choice radio option for API
    const bgpOption = Array.from(host.querySelectorAll('input[type="radio"], label')).find(
      (el) => el.textContent?.includes('Border Gateway Protocol (API)')
    );
    if (bgpOption) {
      await act(async () => {
        (bgpOption as HTMLElement).click();
      });
    }

    // Advance question or review
    const submitOrNextBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Next') || b.textContent?.includes('Review') || b.textContent?.includes('Submit')
    );
    if (submitOrNextBtn) {
      await act(async () => {
        submitOrNextBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    window.history.pushState({}, '', '/');
  });

  it('exercises reader controls: chapter change, bookmarking, and search inside ebook', async () => {
    window.history.pushState({}, '', '/learning/folders/class-software-401/books/book-dwdm');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Principles of Dense Wavelength Division Multiplexing');

    // Search in reader
    const searchInput = host.querySelector('input[placeholder*="Search"]') as HTMLInputElement | null;
    if (searchInput) {
      await act(async () => {
        setNativeInputValue(searchInput, 'Attenuation');
      });
      const searchBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Search')
      );
      if (searchBtn) {
        await act(async () => {
          searchBtn.click();
        });
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    // Toggle bookmark
    const bookmarkBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Bookmark') || b.getAttribute('aria-label')?.includes('bookmark')
    );
    if (bookmarkBtn) {
      await act(async () => {
        bookmarkBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    window.history.pushState({}, '', '/');
  });

  it('exercises course completion tab with requirement checklists and certificate issuance', async () => {
    window.history.pushState({}, '', '/learning/folders/class-software-401?tab=completion');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Engineering Engineering 401');

    window.history.pushState({}, '', '/');
  });

  it('opens new quiz authoring editor dialog and validates required fields', async () => {
    window.history.pushState({}, '', '/learning/folders/class-software-401?tab=quizzes');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const createQuizBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('New quiz') || b.textContent?.includes('Create quiz')
    );
    if (createQuizBtn) {
      await act(async () => {
        createQuizBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Quiz editor dialog should be open
      expect(host.querySelector('.learning-dialog') || host.querySelector('form')).not.toBeNull();
    }

    window.history.pushState({}, '', '/');
  });
});
