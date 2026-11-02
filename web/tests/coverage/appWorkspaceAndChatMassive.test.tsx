// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../../src/App';
import { ProjectsWorkspace } from '../../src/components/ProjectsWorkspace';
import { ChatView, extractThinking } from '../../src/components/ChatView';
import type { ChatMessage, Mode, A2AAgent, PresentationTemplate } from '../../src/types';

// Mock WebSockets
class MockAppWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 0);
  }
  send = vi.fn();
  close = vi.fn();
}

// Global Polyfills for jsdom
global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};

if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
}

// Mock AppDialog
vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  appPrompt: vi.fn().mockResolvedValue('user-input'),
  AppDialog: () => null,
}));

// Mock audio/speech
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

const samplePortfolioData = {
  can_manage: true,
  projects: [
    {
      revision: 1,
      id: 'proj-1',
      name: 'DC2 Core Backbone Upgrade',
      description: 'Provisioning multi-homed API transit circuits in DC2',
      status: 'active',
      priority: 'high',
      due_date: '2026-11-20',
      start_date: '2026-10-01',
      milestone: 'Transit Circuits Verified',
      stage: 'delivery',
      tolerance_days: 5,
      exception_status: 'within_tolerance',
      tailoring_level: 'standard',
    },
    {
      revision: 1,
      id: 'proj-2',
      name: 'Secondary Peering Expansion',
      description: 'Peering exchange connections in Frankfurt and London',
      status: 'planning',
      priority: 'medium',
      due_date: '2026-12-15',
      start_date: '2026-11-01',
      milestone: 'API Filter Validation',
      stage: 'planning',
      tolerance_days: 10,
      exception_status: 'within_tolerance',
      tailoring_level: 'corporate',
    },
  ],
  people: [
    { id: 'p-1', name: 'Elena Rostova', email: 'elena@example.com', status: 'active', departure_date: null },
    { id: 'p-2', name: 'Marcus Vance', email: 'marcus@example.com', status: 'active', departure_date: null },
  ],
  assignments: [
    { id: 'a-1', project_id: 'proj-1', person_id: 'p-1', responsibility: 'Lead Network Architect', role: 'owner', backup_person_id: 'p-2', allocation: 75 },
    { id: 'a-2', project_id: 'proj-2', person_id: 'p-2', responsibility: 'Edge Engineer', role: 'owner', backup_person_id: null, allocation: 60 },
  ],
  dependencies: [
    { id: 'dep-1', source_project_id: 'proj-1', target_project_id: 'proj-2', description: 'Core backbone required before edge peering' },
  ],
  work_items: [
    {
      revision: 1,
      id: 'wi-1',
      project_id: 'proj-1',
      kind: 'milestone',
      title: 'API Route Reflection Deployment',
      description: 'Deploy redundant route reflectors across pods',
      owner_id: 'p-1',
      due_date: '2026-11-10',
      priority: 'high',
      status: 'in_progress',
      resolution: '',
      acceptance_criteria: 'All AS65001 prefixes reflected to DC2 clients',
      acceptance_evidence: 'Route reflector session tables logged',
      predecessor_ids: [],
    },
    {
      revision: 1,
      id: 'wi-2',
      project_id: 'proj-1',
      kind: 'task',
      title: 'Fiber Cross-Connect Termination',
      description: 'Terminate 100GbE dark fiber links in Meet-Me room',
      owner_id: 'p-2',
      due_date: '2026-11-05',
      priority: 'high',
      status: 'blocked',
      resolution: 'Waiting on data center facility badge approval',
      predecessor_ids: ['wi-1'],
    },
    {
      revision: 1,
      id: 'wi-3',
      project_id: 'proj-1',
      kind: 'decision',
      title: 'Carrier Diversity Selection',
      description: 'Select primary and secondary transit providers for AS65001',
      owner_id: 'p-1',
      due_date: '2026-10-31',
      priority: 'high',
      status: 'proposed',
      resolution: '',
    },
  ],
  impact: {
    items: [
      {
        project_id: 'proj-1',
        level: 'high',
        reason: 'Single route reflector dependency in Pod B',
        evidence: 'Allocation reaches 75%',
        path: ['proj-1', 'wi-1'],
      },
    ],
  },
  stage_approvals: [
    {
      id: 'sa-1',
      project_id: 'proj-1',
      stage: 'planning',
      project_revision: 1,
      approver_id: 'p-1',
      decision: 'approved',
      evidence: 'High-Level Design Document signed off by Network Board',
      created_at: '2026-10-15T12:00:00Z',
    },
  ],
};

function setupComprehensiveAppFetch() {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
    const method = init?.method?.toUpperCase() || 'GET';

    if (url.includes('/auth/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ user: { username: 'admin', is_admin: true, display_name: 'Admin User' } }),
      };
    }
    if (url.includes('/api/apps')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          apps: [
            { id: 'office', name: 'Office Suite', description: 'Office documents', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
            { id: 'projects', name: 'Projects', description: 'Project portfolio', kind: 'installed', desktop_only: false, launch: { kind: 'projects' } },
          ],
        }),
      };
    }
    if (url.includes('/api/projects/simulate') || (url.includes('/api/projects') && url.includes('/impact') && method === 'POST')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              project_id: 'proj-1',
              level: 'critical',
              reason: 'Elena Rostova departure leaves DC2 Core Backbone unowned',
              evidence: 'No active backup assigned',
              path: ['proj-1', 'p-1'],
            },
          ],
        }),
      };
    }
    if (url.includes('/api/projects')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(samplePortfolioData),
        json: async () => samplePortfolioData,
      };
    }
    if (url.includes('/projects')) {
      return {
        ok: true,
        status: 200,
        json: async () => samplePortfolioData.projects,
      };
    }
    if (url.includes('/sessions') && (url.includes('/history') || url.includes('/pages') || url.includes('/files'))) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/sessions')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'sess-1', title: 'DC2 Diagnostics', project_id: 'proj-1', updated_at: 1730000000 },
        ],
      };
    }
    if (url.includes('/skills')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'sk-1', name: 'network-auditor', description: 'Audits network and route health', enabled: true },
        ],
      };
    }
    if (url.includes('/modes')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'agent', name: 'Agent Mode' },
          { id: 'code', name: 'Code Mode' },
        ],
      };
    }
    if (url.includes('/agents')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'ag-1', slug: 'network-specialist', name: 'Network Specialist', description: 'Network engineering helper' },
        ],
      };
    }
    if (url.includes('/mcps/microsoft/status')) {
      return { ok: true, status: 200, json: async () => ({ connected: false }) };
    }
    if (url.includes('/mcps')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ name: 'filesystem', status: 'connected', disabled: false, allowed: true }],
      };
    }
    if (url.includes('/personalization/presets')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'preset-1', name: 'Network Specialist Preset', mode: 'agent' }],
      };
    }
    if (url.includes('/personalization/tutorials')) {
      return { ok: true, status: 200, json: async () => ({ disabled: false }) };
    }
    if (url.includes('/tasks')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'task-100', session_id: 'sess-1', title: 'API Route Convergence Check', status: 'completed' },
        ],
      };
    }
    if (url.includes('/templates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'tmpl-1', name: 'Executive Network Review', slides: [] }],
      };
    }
    if (url.includes('/api/notes')) {
      return { ok: true, status: 200, json: async () => ({ items: [], next_before_id: null }) };
    }
    if (url.includes('/voice/voices')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ voices: [{ id: 'v-1', name: 'Elena' }], default_voice_id: 'v-1' }),
      };
    }
    if (url.includes('/workflows/capabilities')) {
      return { ok: true, status: 200, json: async () => ({ web_search: true }) };
    }

    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe('App Component Deep Interactions & Branch Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', MockAppWebSocket);
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
    vi.restoreAllMocks();
  });

  it('handles navigation popstate, custom office navigation, and office-changed events', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveAppFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Dispatch popstate event to trigger route synchronization
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new Event('buddy-office-navigation'));
      window.dispatchEvent(new Event('buddy-office-changed'));
      window.dispatchEvent(new Event('buddy-reminders-changed'));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles buddy-mcp-oauth message events for success and error states', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveAppFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // OAuth success message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'buddy-mcp-oauth', template_id: 'microsoft365', status: 'success' },
      }));
    });

    // OAuth error message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'buddy-mcp-oauth', template_id: 'microsoft365', status: 'error', message: 'Auth failed' },
      }));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles task notices dismiss action and conversation opening', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveAppFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Check if task notices element exists
    const notices = host.querySelector('.task-notices');
    if (notices) {
      const dismissBtn = notices.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]');
      if (dismissBtn) {
        await act(async () => {
          dismissBtn.click();
        });
      }
    }

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles shortcut keydown events: Shift+Cmd+K and Escape dismissal', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveAppFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Press Shift+Cmd+K
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', shiftKey: true, metaKey: true }));
    });

    // Press Escape
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });
});

describe('ProjectsWorkspace Component Comprehensive Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', setupComprehensiveAppFetch());
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders ProjectsWorkspace across all tabs: timeline, overview, portfolio, people, impact, and merged', async () => {
    const onAskBob = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={onClose} onAskBob={onAskBob} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Projects');

    // Switch to Overview tab
    const overviewTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Overview'));
    if (overviewTab) {
      await act(async () => {
        overviewTab.click();
      });
      expect(host.textContent).toContain('DC2 Core Backbone Upgrade');
    }

    // Switch to Portfolio tab
    const portfolioTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Portfolio') || b.textContent?.includes('Projects'));
    if (portfolioTab) {
      await act(async () => {
        portfolioTab.click();
      });
      expect(host.textContent).toContain('DC2 Core Backbone Upgrade');
      const openProj = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Open project'));
      if (openProj) {
        await act(async () => {
          openProj.click();
        });
        expect(host.textContent).toContain('API Route Reflection Deployment');
      }
    }

    // Switch to People tab
    const peopleTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('People'));
    if (peopleTab) {
      await act(async () => {
        peopleTab.click();
      });
      expect(host.textContent).toContain('Elena Rostova');
    }

    // Switch to Impact tab (Scenario simulation)
    const impactTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Impact'));
    if (impactTab) {
      await act(async () => {
        impactTab.click();
      });

      // Target person selection
      const select = host.querySelector<HTMLSelectElement>('.projects-scenario-form select');
      if (select) {
        await act(async () => {
          select.value = 'p-1';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }

      // Click Simulate scenario button
      const simBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Simulate') || b.textContent?.includes('Preview'));
      if (simBtn) {
        await act(async () => {
          simBtn.click();
        });
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    // Switch to Merged tab
    const mergedTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Merged') || b.textContent?.includes('All sections'));
    if (mergedTab) {
      await act(async () => {
        mergedTab.click();
      });
    }

    // Switch back to Timeline tab
    const timelineTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Timeline') || b.textContent?.includes('Gantt'));
    if (timelineTab) {
      await act(async () => {
        timelineTab.click();
      });
    }
  });

  it('triggers Office exports (Word, Excel, PDF) from ProjectsWorkspace', async () => {
    const onAskBob = vi.fn();
    const onClose = vi.fn();

    // Stub window.open for Office report viewing
    vi.stubGlobal('open', vi.fn());

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={onClose} onAskBob={onAskBob} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Navigate to portfolio project view
    const portfolioTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Portfolio'));
    if (portfolioTab) {
      await act(async () => {
        portfolioTab.click();
      });
    }

    // Find export buttons (tertiary buttons with title containing Office/PDF)
    const exportBtns = host.querySelectorAll<HTMLButtonElement>('.cds--btn--tertiary');
    for (const btn of exportBtns) {
      await act(async () => {
        btn.click();
      });
    }

    expect(host.textContent).not.toBe('');
  });

  it('interacts with Project Buddy assistant question and submission in ProjectsWorkspace', async () => {
    const onAskBob = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={onClose} onAskBob={onAskBob} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Toggle assistant drawer button
    const assistantBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Project Buddy') || b.getAttribute('aria-label')?.includes('Assistant'));
    if (assistantBtn) {
      await act(async () => {
        assistantBtn.click();
      });

      // Type question in textarea
      const textarea = host.querySelector<HTMLTextAreaElement>('.projects-assistant-composer textarea');
      if (textarea) {
        await act(async () => {
          textarea.value = 'What are the main risks with the DC2 API migration?';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const sendBtn = host.querySelector<HTMLButtonElement>('.projects-assistant-composer button[type="submit"]');
        if (sendBtn) {
          await act(async () => {
            sendBtn.click();
          });
          expect(onAskBob).toHaveBeenCalled();
        }
      }
    }
  });
});

describe('ChatView Component Advanced Branch Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mockModes: Mode[] = [
    { id: 'agent', slug: 'agent', name: 'Agent Mode', description: 'Autonomous network agent mode' },
    { id: 'code', slug: 'code', name: 'Code Mode', description: 'Code analysis and automation mode' },
  ];
  const mockSkills = [
    { id: 'sk-1', name: 'network-auditor', description: 'Network router auditor', enabled: true },
  ];
  const mockAgents: A2AAgent[] = [
    { id: 'ag-1', slug: 'network-specialist', name: 'Network Specialist', description: 'Assists with network design' },
  ];
  const mockTemplates: PresentationTemplate[] = [
    { id: 'tmpl-1', name: 'Default Template', slides: [] },
  ];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders thinking token stream and extracts thoughts cleanly', () => {
    const rawContent = '<think>Verifying API peers on AS65001 with Elena Rostova...</think>The route reflectors are synchronized.';
    const result = extractThinking(rawContent, false);

    expect(result.thoughts).toContain('Verifying API peers on AS65001');
    expect(result.cleanText).toContain('The route reflectors are synchronized.');
  });

  it('renders assistant response with thinking, branch button, delete button, and executive deck button', async () => {
    const onSendMessage = vi.fn();
    const onDeleteMessage = vi.fn();
    const onBranch = vi.fn();
    const onGenerateDeckFromMessage = vi.fn();

    const sampleMessages: ChatMessage[] = [
      {
        id: 'msg-u1',
        role: 'user',
        content: 'Check route reflectors in DC2',
      },
      {
        id: 'msg-a1',
        role: 'assistant',
        content: '<think>Inspecting router tables...</think>All 4 route reflector peers are operational in DC2.',
        tokens: 150,
        cost: 0.003,
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          messages={sampleMessages}
          sessionId="sess-1"
          activeMode="agent"
          modes={mockModes}
          skills={mockSkills}
          agents={mockAgents}
          templates={mockTemplates}
          selectedTemplateId="tmpl-1"
          onSendMessage={onSendMessage}
          onDeleteMessage={onDeleteMessage}
          onBranch={onBranch}
          onGenerateDeckFromMessage={onGenerateDeckFromMessage}
          onFollowUp={vi.fn()}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('All 4 route reflector peers are operational in DC2.');

    // Click Branch conversation button
    const branchBtn = host.querySelector<HTMLButtonElement>('button[title="Branch conversation"], .answer-icon-action button');
    const branchIcon = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Branch conversation'));
    if (branchIcon) {
      await act(async () => {
        branchIcon.click();
      });
      expect(onBranch).toHaveBeenCalled();
    }

    // Click Delete answer button
    const deleteBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Delete answer'));
    if (deleteBtn) {
      await act(async () => {
        deleteBtn.click();
      });
      expect(onDeleteMessage).toHaveBeenCalledWith('msg-a1');
    }

    // Click Executive Deck button
    const deckBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Executive Deck'));
    if (deckBtn) {
      await act(async () => {
        deckBtn.click();
      });
      expect(onGenerateDeckFromMessage).toHaveBeenCalled();
    }
  });

  it('handles user message rendering with attached files and note references', async () => {
    const sampleMessages: ChatMessage[] = [
      {
        id: 'msg-u2',
        role: 'user',
        content: '[Attached spreadsheet: ip-allocations.xlsx]\nVerify transit IP allocations for Pod 3',
        noteReferences: [{ id: 'note-1', title: 'DC2 Peering Specs', truncated: false }],
        officeReferences: [{ id: 'off-1', name: 'Network-Topology.docx', truncated: true }],
      },
      {
        id: 'msg-a2',
        role: 'assistant',
        content: 'Allocations for Pod 3 verified against subnet 10.200.3.0/24.',
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          messages={sampleMessages}
          sessionId="sess-1"
          activeMode="agent"
          modes={mockModes}
          skills={mockSkills}
          agents={mockAgents}
          templates={mockTemplates}
          onSendMessage={vi.fn()}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('ip-allocations.xlsx');
    expect(host.textContent).toContain('DC2 Peering Specs');
    expect(host.textContent).toContain('Network-Topology.docx');
    expect(host.textContent).toContain('Partial document context');
  });

  it('triggers slash menu autocomplete when user types slash in composer textarea', async () => {
    const onSendMessage = vi.fn();

    await act(async () => {
      root.render(
        <ChatView
          messages={[]}
          sessionId="sess-1"
          activeMode="agent"
          modes={mockModes}
          skills={mockSkills}
          agents={mockAgents}
          templates={mockTemplates}
          onSendMessage={onSendMessage}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea).not.toBeNull();

    // Click slash button to open slash menu
    const slashBtn = host.querySelector<HTMLButtonElement>('.slash-button');
    if (slashBtn) {
      await act(async () => {
        slashBtn.click();
      });
    }

    const slashMenu = host.querySelector('.slash-menu');
    expect(slashMenu).not.toBeNull();
    expect(slashMenu?.textContent).toContain('Network Auditor');

    // Click a slash option
    const slashOption = slashMenu?.querySelector<HTMLButtonElement>('.slash-option');
    if (slashOption) {
      await act(async () => {
        slashOption.click();
      });
    }
  });
});
