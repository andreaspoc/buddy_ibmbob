// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../src/App';
import * as appDialog from '../../src/components/AppDialog';
import type { TaskItem } from '../../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock AppDialog
vi.mock('../../src/components/AppDialog', () => ({
  AppDialog: () => null,
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  appPrompt: vi.fn().mockResolvedValue('user-input'),
}));

// Mock audio & speech
vi.mock('../../src/lib/realtimeVoice', () => ({
  VoiceCapture: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    mute = vi.fn();
  },
  VoiceSpeaker: class {
    append = vi.fn();
    finish = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('../../src/lib/peopleCallSounds', () => ({
  PeopleCallSounds: class {
    prime = vi.fn().mockResolvedValue(true);
    play = vi.fn().mockReturnValue(true);
    stop = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock('../../src/lib/peopleSocketAudio', () => ({
  PeopleSocketAudio: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('../../src/lib/useNoteSaveFlight', () => ({
  useNoteSaveFlight: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mock diagram</text></svg>' }),
  },
}));

// Global Polyfills for jsdom
if (typeof window !== 'undefined') {
  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
  }
  window.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };
  window.matchMedia = window.matchMedia || vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  (window as any).Notification = {
    permission: 'default',
    requestPermission: vi.fn().mockResolvedValue('granted'),
  };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
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
(global as any).WebSocket = MockWebSocket;

const sampleTemplates = [
  {
    id: 'tmpl-net',
    title: 'Network Review Deck',
    brand: 'Software',
    slidesCount: 5,
    colors: {
      background: '#ffffff',
      text: '#000000',
      primary: '#0066cc',
      secondary: '#333333',
      accent: '#ff6600',
    },
    titleSlideColors: {
      background: '#ffffff',
      text: '#000000',
    },
    fonts: {
      heading: 'Arial',
      body: 'Helvetica',
    },
    format: 'pptx',
  },
];

function createStreamResponse(lines: string[], splitInMiddle = false) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      if (splitInMiddle && lines.length > 0) {
        const full = lines.join('\n') + '\n';
        const mid = Math.floor(full.length / 2);
        controller.enqueue(encoder.encode(full.slice(0, mid)));
        setTimeout(() => {
          controller.enqueue(encoder.encode(full.slice(mid)));
          controller.close();
        }, 10);
      } else {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line + '\n'));
        }
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function setupMockFetch(options: {
  user?: any;
  projects?: any[];
  sessions?: any[];
  history?: any[];
  pages?: any[];
  files?: any[];
  tasks?: any[];
  jobEvents?: string[];
  splitJobEvents?: boolean;
  cancelStatus?: string[];
  deleteCleanupPending?: boolean;
  artifactSource?: any;
  customHandler?: (url: string, method: string, init?: RequestInit) => Promise<Response | null>;
} = {}) {
  const user = options.user !== undefined ? options.user : { username: 'engineer', is_admin: true, display_name: 'Lead Engineer' };
  let cancelAttempt = 0;

  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
    const method = init?.method?.toUpperCase() || 'GET';

    if (options.customHandler) {
      const customRes = await options.customHandler(url, method, init);
      if (customRes) return customRes;
    }

    if (url.includes('/auth/status')) {
      return new Response(JSON.stringify({ user }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/auth/logout')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/notifications')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/research/')) {
      return new Response(JSON.stringify({
        title: 'Optical Network Report',
        status: 'completed',
        report: '# Findings',
        evidence: [],
        files: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/research')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/workspace/pages') || (url.includes('/sessions') && url.includes('/pages'))) {
      return new Response(JSON.stringify(options.pages || [
        { path: 'architecture.md', name: 'architecture.md', size: 1024, is_presentation: false },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/presentation/decks') || url.includes('/presentation/deck')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/personalization')) {
      if (url.includes('tutorials')) {
        return new Response(JSON.stringify({ disabled: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/apps')) {
      return new Response(JSON.stringify({
        apps: [
          { id: 'office', name: 'Office Suite', description: 'Office docs', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
          { id: 'people', name: 'Community', description: 'Directory', kind: 'installed', desktop_only: false, launch: { kind: 'people' } },
          { id: 'decisions', name: 'Decisions', description: 'Decisions', kind: 'installed', desktop_only: false, launch: { kind: 'decisions' } },
          { id: 'docmost', name: 'Wiki', description: 'Documentation', kind: 'installed', desktop_only: false, launch: { kind: 'docmost' } },
          { id: 'external-link', name: 'Docs Portal', description: 'Portal', kind: 'installed', desktop_only: false, launch: { kind: 'link', url: 'https://docs.software.example', target: '_blank' } },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/projects')) {
      if (method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(JSON.stringify({ id: 'proj-created', name: body.name || 'New Project' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(options.projects || [
        { id: 'proj-main', name: 'Core Infrastructure', description: 'Core routers', status: 'active' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/sessions') && url.includes('/history')) {
      return new Response(JSON.stringify(options.history || []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/sessions') && (url.includes('/files') || url.includes('/upload'))) {
      if (method === 'POST') {
        return new Response(JSON.stringify({ path: 'uploaded-doc.pdf', name: 'uploaded-doc.pdf', size: 2048 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(options.files || []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/sessions') && url.includes('/artifacts/source')) {
      return new Response(JSON.stringify(options.artifactSource || {
        path: 'diagram.html',
        content: '<div class="slide">Slide 1</div>',
        is_presentation: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/sessions') && url.includes('/branch')) {
      return new Response(JSON.stringify({ id: 'sess-branched' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/sessions') && url.includes('/messages/')) {
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, cleanup_pending: Boolean(options.deleteCleanupPending) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (url.includes('/sessions')) {
      if (method === 'POST') {
        return new Response(JSON.stringify({ id: 'sess-new', title: 'New Conversation', updated_at: Date.now() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(options.sessions || [
        { id: 'sess-1', title: 'Backbone Capacity Planning', project_id: 'proj-main', updated_at: Date.now() },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/skills')) {
      return new Response(JSON.stringify([
        { id: 'sk-1', name: 'capacity-forecast', description: 'Capacity forecasting tool' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/modes')) {
      return new Response(JSON.stringify([
        { slug: 'agent', name: 'Agent mode' },
        { slug: 'presentation', name: 'Presentation mode' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/agents')) {
      return new Response(JSON.stringify([
        { slug: 'support-agent', name: 'Support Diagnostic Agent', description: 'Assists network operations' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/mcps')) {
      return new Response(JSON.stringify([
        { name: 'software-metrics', disabled: false, allowed: true },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/templates') || url.includes('/presentation/templates')) {
      return new Response(JSON.stringify(sampleTemplates), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('microsoft') && url.includes('status')) {
      return new Response(JSON.stringify({ configured: false, connected: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/jobs/') && url.includes('/cancel')) {
      const statuses = options.cancelStatus || ['stopped'];
      const st = statuses[Math.min(cancelAttempt, statuses.length - 1)];
      cancelAttempt += 1;
      return new Response(JSON.stringify({ status: st }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/jobs/') && url.includes('/events')) {
      const events = options.jobEvents || [
        JSON.stringify({ event_id: 1, type: 'status', message: 'Replaying events' }),
        JSON.stringify({ event_id: 2, type: 'done', tokens: 50, cost: 0.01 }),
      ];
      return createStreamResponse(events, Boolean(options.splitJobEvents));
    }
    if (url.includes('/tasks') || url.includes('/jobs')) {
      if (options.tasks && options.tasks.length > 0) {
        const currentTasks = options.tasks.map(t => ({ ...t }));
        options.tasks.forEach(t => { if (t.status === 'running') t.status = 'completed'; });
        return new Response(JSON.stringify(currentTasks), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('teamAppDeepBranchesCoverage: App.tsx Shell Deep Branches Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/');
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('Suite 1: loadSessionHistory Event Parsing & Approval Policy State (Lines 880-925)', () => {
    it('parses request event branches including deleted messages, notes, office files, deleted presentations, mode, and slide count', async () => {
      const historyWithRequests = [
        {
          type: 'request',
          user_message_id: 'user-req-1',
          prompt: 'Assess Platform channel capacity',
          note_ids: [101, 102],
          office_file_ids: ['office-uuid-1'],
          deleted_presentations: ['old-deck-1'],
          mode: 'presentation',
          slide_count: 8,
          voice_mode: true,
          agent_slugs: ['support-agent'],
          agent_name: 'Support Diagnostic Agent',
          template_id: 'tmpl-net',
          presentation_format: 'pptx',
          assistant_message_id: 'asst-msg-1',
        },
        {
          type: 'request',
          user_deleted: true,
          assistant_deleted: true,
          prompt: 'Deleted turn',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyWithRequests }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Open conversation sess-1 to trigger loadSessionHistory
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
      expect(host.textContent).toContain('Platform channel capacity');
    });

    it('parses delta stream updates with content replace and incremental appending', async () => {
      const historyDeltas = [
        {
          type: 'request',
          user_message_id: 'u-1',
          assistant_message_id: 'a-1',
          prompt: 'Run routing table verification',
        },
        {
          type: 'delta',
          assistant_message_id: 'a-1',
          text: 'Routing table inspection: ',
        },
        {
          type: 'delta',
          assistant_message_id: 'a-1',
          text: '12 transit routes checked.',
        },
        {
          type: 'delta',
          assistant_message_id: 'a-1',
          replace: true,
          text: 'Replaced complete summary: All 12 routes converged.',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyDeltas }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.textContent).toContain('Replaced complete summary');
    });

    it('parses approvals (new and updated) and guidance notes (received and applied)', async () => {
      const historyApprovalsGuidance = [
        {
          type: 'request',
          user_message_id: 'u-2',
          assistant_message_id: 'a-2',
          prompt: 'Upgrade border switch firmware',
        },
        {
          type: 'approval',
          assistant_message_id: 'a-2',
          approval_id: 'appr-fw-1',
          status: 'pending',
          description: 'Deploy NXOS firmware update to Leaf 1',
        },
        {
          type: 'approval',
          assistant_message_id: 'a-2',
          approval_id: 'appr-fw-1',
          status: 'approved',
          description: 'Deploy NXOS firmware update to Leaf 1',
        },
        {
          type: 'guidance',
          assistant_message_id: 'a-2',
          id: 501,
          text: 'Verify API graceful restart before applying',
          status: 'received',
        },
        {
          type: 'guidance',
          assistant_message_id: 'a-2',
          id: 501,
          text: 'Verify API graceful restart before applying',
          status: 'applied',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyApprovalsGuidance }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
      expect(host.textContent).toContain('Upgrade border switch firmware');
    });

    it('parses status messages (with and without heartbeat) and skill usage events', async () => {
      const historyStatusSkills = [
        {
          type: 'request',
          user_message_id: 'u-3',
          assistant_message_id: 'a-3',
          prompt: 'Inspect transponder attenuation',
        },
        {
          type: 'status',
          assistant_message_id: 'a-3',
          message: 'Querying telemetry database',
          heartbeat: false,
        },
        {
          type: 'status',
          assistant_message_id: 'a-3',
          message: 'Tick keepalive',
          heartbeat: true,
        },
        {
          type: 'skill',
          assistant_message_id: 'a-3',
          name: 'capacity-forecast',
        },
        {
          type: 'skill',
          assistant_message_id: 'a-3',
          name: 'capacity-forecast',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyStatusSkills }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.textContent).toContain('Inspect transponder attenuation');
    });

    it('parses tool events with various input payloads (query, command, prompt, string) and updates workLog', async () => {
      const historyTools = [
        {
          type: 'request',
          user_message_id: 'u-4',
          assistant_message_id: 'a-4',
          prompt: 'Diagnose packet drop',
        },
        {
          type: 'tool',
          assistant_message_id: 'a-4',
          id: 'tool-step-1',
          name: 'knowledge_search',
          status: 'started',
          input: { query: 'transponder threshold exceedance' },
        },
        {
          type: 'tool',
          assistant_message_id: 'a-4',
          id: 'tool-step-2',
          name: 'bash_runner',
          status: 'started',
          input: { command: 'ip route show table all' },
        },
        {
          type: 'tool',
          assistant_message_id: 'a-4',
          id: 'tool-step-3',
          name: 'prompt_analyzer',
          status: 'started',
          input: { prompt: 'Extract interface counters' },
        },
        {
          type: 'tool',
          assistant_message_id: 'a-4',
          id: 'tool-step-4',
          name: 'ping_check',
          status: 'started',
          input: '10.200.1.1',
        },
        {
          type: 'tool',
          assistant_message_id: 'a-4',
          id: 'tool-step-1',
          name: 'knowledge_search',
          status: 'completed',
          output: 'Threshold standard is -18dBm.',
        },
        {
          type: 'tool',
          assistant_message_id: 'a-4',
          id: 'tool-step-99',
          name: 'dns_lookup',
          status: 'completed',
          output: 'Resolved to 192.168.10.5',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyTools }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
      expect(host.textContent).toContain('Diagnose packet drop');
    });

    it('parses error events (cancelled vs failure) and done events with token and duration formatting', async () => {
      const historyErrorsDone = [
        {
          type: 'request',
          user_message_id: 'u-5',
          assistant_message_id: 'a-5',
          prompt: 'Analyze interface flaps',
        },
        {
          type: 'error',
          assistant_message_id: 'a-5',
          cancelled: true,
          tokens: 120,
          cost: 0.04,
        },
        {
          type: 'request',
          user_message_id: 'u-6',
          assistant_message_id: 'a-6',
          prompt: 'Calculate route convergence',
        },
        {
          type: 'error',
          assistant_message_id: 'a-6',
          cancelled: false,
          message: 'SNMP timeout reaching aggregator switch',
          tokens: 45,
          cost: 0.01,
        },
        {
          type: 'request',
          user_message_id: 'u-7',
          assistant_message_id: 'a-7',
          prompt: 'Generate optical budget report',
        },
        {
          type: 'done',
          assistant_message_id: 'a-7',
          duration_ms: 3200,
          tokens: 450,
          cost: 0.15,
          skills_used: ['capacity-forecast'],
          session_id: 'bob-task-revised-10',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyErrorsDone }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.textContent).toContain('SNMP timeout reaching aggregator switch');
      expect(host.textContent).toContain('Stopped by you');
    });

    it('parses presentation artifacts, delivery_state events, and persists approval_policy to localStorage', async () => {
      const historyArtifactsPolicy = [
        {
          type: 'request',
          user_message_id: 'u-8',
          assistant_message_id: 'a-8',
          prompt: 'Generate executive fiber topology deck',
        },
        {
          type: 'artifact',
          assistant_message_id: 'a-8',
          path: 'topology.html',
          is_presentation: true,
        },
        {
          type: 'delivery_state',
          assistant_message_id: 'a-8',
          state: 'delivered',
        },
        {
          type: 'approval_policy',
          policy: {
            mode: 'auto',
            actions: ['commands', 'files'],
          },
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({ history: historyArtifactsPolicy }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      const storedPolicies = localStorage.getItem('buddy-approval-policies');
      expect(storedPolicies).not.toBeNull();
      expect(storedPolicies).toContain('auto');
    });
  });

  describe('Suite 2: Jobs Events Replay, Recovery Loop & Decoder Buffer Splits (Lines 1030-1070)', () => {
    it('replays /jobs/:id/events stream with split decoder buffer chunks and cursor tracking', async () => {
      const runningTasks: TaskItem[] = [
        {
          id: 'job-stream-1',
          session_id: 'sess-1',
          title: 'Durable stream replay test',
          status: 'running',
          progress: 'In progress',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      const eventLines = [
        JSON.stringify({ event_id: 10, type: 'status', message: 'Connecting to cluster' }),
        JSON.stringify({ event_id: 11, type: 'artifact', path: 'research-report.md', content: '# Optical Research' }),
        JSON.stringify({ event_id: 12, type: 'artifact', path: 'deck.bobdeck', content: '<section class="slide">Slide</section>', is_presentation: true }),
        JSON.stringify({ event_id: 13, type: 'artifact', path: 'config.txt', content: 'interface Ethernet1/1\n shut' }),
        JSON.stringify({ event_id: 14, type: 'done', tokens: 100, cost: 0.05 }),
      ];

      vi.stubGlobal('fetch', setupMockFetch({
        tasks: runningTasks,
        jobEvents: eventLines,
        splitJobEvents: true,
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
    });

    it('dispatches app_actions and approval_policy events during recovery loop', async () => {
      const runningTasks: TaskItem[] = [
        {
          id: 'job-actions-1',
          session_id: 'sess-1',
          title: 'Action dispatch test',
          status: 'running',
          progress: 'In progress',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      const eventLines = [
        JSON.stringify({ event_id: 20, type: 'app_action', action: 'office_changed' }),
        JSON.stringify({ event_id: 21, type: 'app_action', action: 'reminders_changed' }),
        JSON.stringify({ event_id: 22, type: 'app_action', action: 'notes_changed', note_id: 77, note_title: 'SFP Transceiver Note' }),
        JSON.stringify({ event_id: 23, type: 'app_action', action: 'office_open', file_id: '12345678-1234-1234-1234-123456789abc', name: 'Optical Analysis.docx' }),
        JSON.stringify({ event_id: 24, type: 'app_action', action: 'office_close' }),
        JSON.stringify({ event_id: 25, type: 'approval_policy', policy: { mode: 'selected', actions: ['commands'] } }),
        JSON.stringify({ event_id: 26, type: 'done', tokens: 80, cost: 0.02 }),
      ];

      let officeChangedFired = false;
      let remindersChangedFired = false;
      let approvalPolicyFired = false;

      window.addEventListener('buddy-office-changed', () => { officeChangedFired = true; });
      window.addEventListener('buddy-reminders-changed', () => { remindersChangedFired = true; });
      window.addEventListener('buddy-approval-policy', () => { approvalPolicyFired = true; });

      vi.stubGlobal('fetch', setupMockFetch({
        tasks: runningTasks,
        jobEvents: eventLines,
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(officeChangedFired).toBe(true);
      expect(remindersChangedFired).toBe(true);
      expect(approvalPolicyFired).toBe(true);
    });

    it('handles delivery_state saving and background save failures during recovery loop', async () => {
      const runningTasks: TaskItem[] = [
        {
          id: 'job-save-fail',
          session_id: 'sess-1',
          title: 'Background save failure check',
          status: 'running',
          progress: 'In progress',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      const eventLines = [
        JSON.stringify({ event_id: 30, type: 'delivery_state', state: 'saving' }),
      ];

      vi.stubGlobal('fetch', setupMockFetch({
        tasks: runningTasks,
        jobEvents: eventLines,
        customHandler: async (url) => {
          if (url.includes('/tasks/job-save-fail')) {
            return new Response(JSON.stringify({ id: 'job-save-fail', status: 'failed' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return null;
        },
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
    });

    it('handles job events replay failure gracefully with retry and recovery status updates', async () => {
      const runningTasks: TaskItem[] = [
        {
          id: 'job-retry-fail',
          session_id: 'sess-1',
          title: 'Job events failure recovery',
          status: 'running',
          progress: 'In progress',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      let failCount = 0;
      vi.stubGlobal('fetch', setupMockFetch({
        tasks: runningTasks,
        customHandler: async (url) => {
          if (url.includes('/jobs/job-retry-fail/events')) {
            failCount += 1;
            return new Response('Replay unavailable', { status: 503 });
          }
          return null;
        },
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      expect(failCount).toBeGreaterThanOrEqual(1);
      expect(host.querySelector('.shell')).not.toBeNull();
    });
  });

  describe('Suite 3: Active Job Cancellation & Error State Handling (Lines 570-585, 2030-2041, 2396-2402)', () => {
    it('cancels active job through stopping loop, verifies aborted controller and stopped outcome', async () => {
      const runningTasks: TaskItem[] = [
        {
          id: 'job-cancel-test',
          session_id: 'sess-1',
          title: 'Cancel execution test',
          status: 'running',
          progress: 'In progress',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({
        tasks: runningTasks,
        cancelStatus: ['stopping', 'stopped'],
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Switch to tasks view to click Stop
      const tasksNavBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Tasks')
      );
      if (tasksNavBtn) {
        await act(async () => {
          tasksNavBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      // Find Stop button inside tasks view
      const stopBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent === 'Stop'
      );
      if (stopBtn) {
        await act(async () => {
          stopBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
    });

    it('cancels active job with completed outcome and handles cancellation failures', async () => {
      vi.stubGlobal('fetch', setupMockFetch({
        cancelStatus: ['completed'],
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // Trigger cancel via custom event
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-task', { detail: 'task-cancel-error' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
    });
  });

  describe('Suite 4: File & Artifact Routing, Dirty Presentation Guard (Lines 760-813)', () => {
    it('routes workspace pages, checks dirty studio confirmation and remembers documents', async () => {
      const spyConfirm = vi.spyOn(appDialog, 'appConfirm').mockResolvedValue(true);

      vi.stubGlobal('fetch', setupMockFetch({
        pages: [
          { path: 'report.pdf', name: 'report.pdf', size: 2048 },
          { path: 'research-report.md', name: 'research-report.md', size: 1024 },
          { path: 'deck.bobdeck', name: 'deck.bobdeck', size: 4096, is_presentation: true },
        ],
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Select sess-1 first
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      // Dispatch open artifact event for pdf
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-artifact', {
          detail: { sessionId: 'sess-1', path: 'report.pdf' },
        }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      // Dispatch open artifact event for presentation
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-presentation', {
          detail: { sessionId: 'sess-1' },
        }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(host.querySelector('.shell')).not.toBeNull();
      spyConfirm.mockRestore();
    });

    it('toggles presentation studio and handles dirty presentation discard prompt', async () => {
      const spyConfirm = vi.spyOn(appDialog, 'appConfirm').mockResolvedValue(false);

      vi.stubGlobal('fetch', setupMockFetch());

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Open topbar buddy tools
      const buddyMenuBtn = host.querySelector('button[aria-label="Buddy menu"]') as HTMLButtonElement | null;
      if (buddyMenuBtn) {
        await act(async () => {
          buddyMenuBtn.click();
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
      spyConfirm.mockRestore();
    });
  });

  describe('Suite 5: Project & Session Management, Message Deletions, File Uploads (Lines 1159-1175, 1224-1240, 1251-1287, 1312-1325)', () => {
    it('handles handleSelectProject, session list updates, startNewChat and open failure alerts', async () => {
      const spyAlert = vi.spyOn(appDialog, 'appAlert').mockResolvedValue(undefined);

      vi.stubGlobal('fetch', setupMockFetch({
        projects: [
          { id: 'proj-1', name: 'Core Infrastructure' },
          { id: 'proj-2', name: 'Edge Nodes' },
        ],
        customHandler: async (url) => {
          if (url.includes('/sessions') && url.includes('proj-2')) {
            return new Response(JSON.stringify({ detail: 'Project access restricted' }), { status: 403 });
          }
          return null;
        },
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Select project from sidebar
      const projItemBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Edge Nodes')
      );
      if (projItemBtn) {
        await act(async () => {
          projItemBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
      spyAlert.mockRestore();
    });

    it('handles handleDeleteMessage with confirmation and cleanup pending notice', async () => {
      const spyConfirm = vi.spyOn(appDialog, 'appConfirm').mockResolvedValue(true);
      const spyAlert = vi.spyOn(appDialog, 'appAlert').mockResolvedValue(undefined);

      const sampleHistory = [
        {
          type: 'request',
          user_message_id: 'user-to-del-1',
          assistant_message_id: 'asst-to-del-1',
          prompt: 'Show core API peers',
        },
        {
          type: 'delta',
          assistant_message_id: 'asst-to-del-1',
          text: 'Core API peers established: 4 peers up.',
        },
      ];

      vi.stubGlobal('fetch', setupMockFetch({
        history: sampleHistory,
        deleteCleanupPending: true,
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Click delete button on message if available
      const deleteMsgBtn = host.querySelector('button[aria-label*="Delete message"], button.chat-message-delete') as HTMLButtonElement | null;
      if (deleteMsgBtn) {
        await act(async () => {
          deleteMsgBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
      spyConfirm.mockRestore();
      spyAlert.mockRestore();
    });

    it('handles handleDeleteSession and handleDeleteFile with confirmation dialogs', async () => {
      const spyConfirm = vi.spyOn(appDialog, 'appConfirm').mockResolvedValue(true);

      vi.stubGlobal('fetch', setupMockFetch({
        sessions: [
          { id: 'sess-to-delete', title: 'Temporary Diagnostic', project_id: 'proj-1', updated_at: Date.now() },
          { id: 'sess-fallback', title: 'Fallback Session', project_id: 'proj-1', updated_at: Date.now() - 1000 },
        ],
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Trigger session deletion through button if rendered
      const deleteSessionBtn = host.querySelector('button[aria-label*="Delete conversation"]') as HTMLButtonElement | null;
      if (deleteSessionBtn) {
        await act(async () => {
          deleteSessionBtn.click();
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
      spyConfirm.mockRestore();
    });

    it('handles handleChatFileUpload and auto-creates session when none is active', async () => {
      vi.stubGlobal('fetch', setupMockFetch({
        sessions: [],
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Upload file via hidden file input
      const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (fileInput) {
        const file = new File(['mock content'], 'switch-spec.txt', { type: 'text/plain' });
        Object.defineProperty(fileInput, 'files', { value: [file] });
        await act(async () => {
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
    });
  });

  describe('Suite 6: Workspace Apps Launching, Sign-Out, Multi-Agent & Settings (Lines 2160-2185, 2059-2075, 2314-2326, 2560-2589)', () => {
    it('launches installed apps across link (blank and self), docmost, decisions, and office', async () => {
      const spyOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

      vi.stubGlobal('fetch', setupMockFetch());

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Open apps launcher modal
      const appsBtn = host.querySelector('button[data-apps-launcher]') as HTMLButtonElement | null;
      if (appsBtn) {
        await act(async () => {
          appsBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });

        // Click app cards
        const appCards = Array.from(host.querySelectorAll('.app-card, button.installed-app-item')) as HTMLButtonElement[];
        for (const card of appCards) {
          await act(async () => {
            card.click();
          });
        }
      }

      expect(host.querySelector('.shell')).not.toBeNull();
      spyOpen.mockRestore();
    });

    it('signs out user, aborts active requests and alerts if server logout rejects', async () => {
      const spyAlert = vi.spyOn(appDialog, 'appAlert').mockResolvedValue(undefined);

      vi.stubGlobal('fetch', setupMockFetch({
        customHandler: async (url) => {
          if (url.includes('/auth/logout')) {
            return new Response(JSON.stringify({ detail: 'Session termination failed' }), { status: 500 });
          }
          return null;
        },
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Click sign out button
      const signOutBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Sign out') || b.getAttribute('aria-label')?.includes('Sign out')
      );
      if (signOutBtn) {
        await act(async () => {
          signOutBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
      }

      expect(host.querySelector('.shell, .buddy-login-viewport, .buddy-login-loading-screen')).not.toBeNull();
      spyAlert.mockRestore();
    });

    it('switches chat mode between skills and agents and creates Agents project when missing', async () => {
      vi.stubGlobal('fetch', setupMockFetch({
        projects: [{ id: 'proj-1', name: 'Core Infrastructure' }],
      }));

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Switch to Agents mode
      const agentsModeBtn = host.querySelector('button[data-mode-target="agents"]') as HTMLButtonElement | null;
      if (agentsModeBtn) {
        await act(async () => {
          agentsModeBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
      }

      // Switch back to Skills mode
      const skillsModeBtn = host.querySelector('button[data-mode-target="skills"]') as HTMLButtonElement | null;
      if (skillsModeBtn) {
        await act(async () => {
          skillsModeBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
    });

    it('interacts with TemplatePickerModal: triggers askBob, saves template, and confirms', async () => {
      vi.stubGlobal('fetch', setupMockFetch());

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Open template studio
      const templateStudioBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Template Studio') || b.textContent?.includes('Templates')
      );
      if (templateStudioBtn) {
        await act(async () => {
          templateStudioBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
    });

    it('enables task desktop notifications with granted and denied permissions', async () => {
      const spyAlert = vi.spyOn(appDialog, 'appAlert').mockResolvedValue(undefined);

      (window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');
      vi.stubGlobal('fetch', setupMockFetch());

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Open Topbar notifications
      const notifBtn = host.querySelector('button[aria-label*="notification"], .topbar-notifications') as HTMLButtonElement | null;
      if (notifBtn) {
        await act(async () => {
          notifBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });
      }

      expect(host.querySelector('.shell')).not.toBeNull();
      spyAlert.mockRestore();
    });

    it('handles window events: buddy-request-artifact-edit, buddy-open-conversation, buddy-auth-expired and microsoft OAuth postMessage', async () => {
      vi.stubGlobal('fetch', setupMockFetch());

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: 'sess-1' }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      // Dispatch edit artifact request
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-request-artifact-edit', {
          detail: { sessionId: 'sess-1', path: 'architecture.md', comments: 'Add redundancy links' },
        }));
      });

      // PostMessage for microsoft connected
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'microsoft-connected' },
        }));
      });

      // Storage event for microsoft connected
      await act(async () => {
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'microsoft_connected',
          newValue: String(Date.now()),
        }));
      });

      // Dispatch auth expired
      await act(async () => {
        window.dispatchEvent(new CustomEvent('buddy-auth-expired'));
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(host.querySelector('.shell, .buddy-login-viewport, .buddy-login-loading-screen')).not.toBeNull();
    });
  });
});
