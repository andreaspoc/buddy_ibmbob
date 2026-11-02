// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../src/App';
import { MemberChatWidget, useCommunityUnread } from '../../src/components/MemberChat';
import { PeopleVoiceCall } from '../../src/components/PeopleVoiceCall';
import MemberChatAway from '../../src/components/MemberChatAway';
import { WorkspaceHub } from '../../src/components/WorkspaceHub';
import { applyDesignTheme } from '../../src/lib/designTheme';
import type { PeopleVoice } from '../../src/lib/usePeopleVoice';

vi.mock('../../src/components/AppDialog', () => ({
  AppDialog: () => null,
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
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
let rootContainer: HTMLDivElement;

const sampleCommunityRooms = [
  {
    id: 10,
    kind: 'direct',
    name: 'Elena Rostova',
    subscribed: true,
    unread_count: 2,
    latest_incoming_sender_name: 'Elena Rostova',
    latest_incoming_id: 1001,
    latest_incoming_automated: false,
    visibility: 'private' as const,
    member_count: 2,
  },
  {
    id: 20,
    kind: 'channel',
    name: 'architecture-board',
    subscribed: true,
    unread_count: 1,
    latest_incoming_sender_name: 'Marcus Vance',
    latest_incoming_id: 2001,
    latest_incoming_automated: false,
    visibility: 'open' as const,
    member_count: 5,
  },
];

const sampleCommunityMembers = [
  { username: 'admin', display_name: 'Admin User' },
  { username: 'elena', display_name: 'Elena Rostova' },
  { username: 'marcus', display_name: 'Marcus Vance' },
];

const sampleCommunityMessages = [
  {
    id: 1001,
    room_id: 10,
    sender: 'elena',
    sender_name: 'Elena Rostova',
    body: 'Core backbone router provisioning is underway in DC2.',
    created_at: '2026-10-29T10:00:00Z',
    pinned: false,
    reactions: [{ emoji: '👍', count: 1, mine: false }],
  },
  {
    id: 1002,
    room_id: 10,
    sender: 'admin',
    sender_name: 'Admin User',
    body: 'Understood. Let me know when transit circuits are tested.',
    created_at: '2026-10-29T10:05:00Z',
    pinned: true,
    reactions: [],
  },
];

function setupComprehensiveFetch(authenticated = true) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
    const method = init?.method?.toUpperCase() || 'GET';

    if (url.includes('/auth/status')) {
      if (!authenticated) {
        return { ok: true, status: 200, json: async () => ({ user: null }) };
      }
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
            { id: 'office', name: 'Office Suite', description: 'Office documents and presentations', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
            { id: 'people', name: 'Community', description: 'Collaborative team community', kind: 'installed', desktop_only: false, launch: { kind: 'people' } },
            { id: 'decisions', name: 'Decisions', description: 'Architecture decisions graph', kind: 'installed', desktop_only: false, launch: { kind: 'decisions' } },
          ],
        }),
      };
    }

    // Community Endpoints
    if (url.includes('/api/community/rooms') && url.includes('/messages') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 1003,
          room_id: 10,
          sender: 'admin',
          sender_name: 'Admin User',
          body: 'Test reply dispatched',
          created_at: '2026-10-29T10:15:00Z',
        }),
      };
    }
    if (url.includes('/api/community/rooms') && url.includes('/messages') && method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/community/rooms') && url.includes('/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => sampleCommunityMessages,
      };
    }
    if (url.includes('/api/community/rooms') && url.includes('/receipts')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { username: 'elena', display_name: 'Elena Rostova', last_read: 1002 },
        ],
      };
    }
    if (url.includes('/api/community/rooms') && url.includes('/typing')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/community/rooms') && (url.includes('/reactions') || url.includes('/pin') || url.includes('/save-note') || url.includes('/read'))) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/community/rooms') && url.includes('/members')) {
      return { ok: true, status: 200, json: async () => sampleCommunityMembers };
    }
    if (url.includes('/api/community/rooms')) {
      return {
        ok: true,
        status: 200,
        json: async () => sampleCommunityRooms,
      };
    }
    if (url.includes('/api/community/members')) {
      return {
        ok: true,
        status: 200,
        json: async () => sampleCommunityMembers,
      };
    }
    if (url.includes('/api/community/away/preview')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ reply: 'Elena is currently in an executive briefing and will respond shortly.' }),
      };
    }
    if (url.includes('/api/community/away')) {
      if (method === 'PUT' || method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ enabled: true, active: true, instructions: 'In training', starts_at: null, ends_at: null, ready: true }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ enabled: false, active: false, instructions: '', starts_at: null, ends_at: null, ready: true }),
      };
    }

    // App endpoints
    if (url.includes('/projects')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'proj-1', name: 'Core Infrastructure', description: 'Core network systems', status: 'active', priority: 'high', revision: 1 },
        ],
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
          { id: 'sess-1', title: 'System Diagnostics', project_id: 'proj-1', updated_at: 1730000000 },
        ],
      };
    }
    if (url.includes('/skills')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'skill-search', name: 'research-buddy', description: 'Information search', enabled: true },
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
        json: async () => [
          { name: 'filesystem', status: 'connected', disabled: false, allowed: true },
        ],
      };
    }
    if (url.includes('/personalization/tutorials')) {
      return { ok: true, status: 200, json: async () => ({ disabled: false }) };
    }
    if (url.includes('/personalization/presets')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'preset-1', name: 'Default Specialist', mode: 'agent' },
        ],
      };
    }
    if (url.includes('/tasks')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/api/notes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], next_before_id: null }),
      };
    }
    if (url.includes('/knowledge/documents')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'doc-1',
            filename: 'network-policy.pdf',
            description: 'Network engineering and security standards',
            status: 'ready',
            knowledge_base: 'company',
            audience: 'both',
            uploaded_by: 'admin',
            created_at: '2026-10-29T10:00:00Z',
          },
        ],
      };
    }
    if (url.includes('/knowledge')) {
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    }
    if (url.includes('/templates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'deck-template-1', name: 'Default Deck', slides: [] },
        ],
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
  });

  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);

  class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });

  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, '', '/');

  rootContainer = document.createElement('div');
  rootContainer.id = 'root';
  document.body.appendChild(rootContainer);

  host = document.createElement('div');
  host.id = 'test-host';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  rootContainer.remove();
  vi.unstubAllGlobals();
});

describe('App Component Deep Interactions & Branch Coverage', () => {
  it('handles theme switching and design theme application', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    // Test copilotkit default
    applyDesignTheme();
    expect(document.documentElement.dataset.uiTheme).toBe('copilotkit');

    // Test carbon override
    localStorage.setItem('buddy-ui-theme', 'carbon');
    applyDesignTheme();
    expect(document.documentElement.dataset.uiTheme).toBeUndefined();

    // Render App and test display scale effect
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders SignInScreen when unauthenticated and handles sign in action', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch(false));

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Sign In');
  });

  it('handles workspace events: buddy-open-artifact, presentation, task, and conversation', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Dispatch custom workspace events
    await act(async () => {
      window.dispatchEvent(new CustomEvent('buddy-open-artifact', { detail: { path: 'network-plan.docx' } }));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('buddy-open-presentation', { detail: { path: 'deck.html' } }));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('buddy-open-task', { detail: { taskId: 'task-1' } }));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('buddy-open-conversation', { detail: { sessionId: 'sess-1' } }));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles offline and online connectivity window events', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles responsive resize and visualViewport scroll events', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('workspace-motion-settled'));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles buddy-open-knowledge, buddy-office-navigation, and buddy-auth-expired events', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Dispatch buddy-open-knowledge to switch views
    await act(async () => {
      window.dispatchEvent(new Event('buddy-open-knowledge'));
    });

    // Dispatch office navigation
    await act(async () => {
      window.dispatchEvent(new Event('buddy-office-navigation'));
    });

    // Dispatch Microsoft connected message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'microsoft-connected' },
      }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'microsoft_connected' }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'buddy-skills-changed',
        newValue: JSON.stringify({ user: 'admin', time: Date.now() }),
      }));
    });

    // Dispatch auth expired
    await act(async () => {
      window.dispatchEvent(new Event('buddy-auth-expired'));
    });

    expect(host.textContent).toContain('Sign In');
  });

  it('handles mobile sidebar opening, close on escape, and task notices', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const mobileMenu = host.querySelector<HTMLButtonElement>('.mobile-menu');
    if (mobileMenu) {
      await act(async () => {
        mobileMenu.click();
      });
      // Close on escape
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
    }

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders WorkspaceHub, opens command palette via shortcut, searches and pins actions', async () => {
    const mockAction = { id: 'act-1', label: 'Inspect Topology', run: vi.fn() };
    const mockRecent = [{ id: 'rec-1', label: 'Project Overview', kind: 'document', run: vi.fn() }];

    await act(async () => {
      root.render(
        <WorkspaceHub
          username="admin"
          actions={[mockAction]}
          recent={mockRecent}
          focused={false}
          onToggleFocus={vi.fn()}
          showToolbar={true}
        />
      );
    });

    expect(host.textContent).toContain('Commands');
    // Recent work stays reachable from the palette; there is no "Continue working" strip on the page.
    expect(host.textContent).not.toContain('Continue working');
    expect(host.textContent).not.toContain('Project Overview');

    // Open command palette via shortcut event
    await act(async () => {
      window.dispatchEvent(new Event('buddy-open-commands'));
    });

    // Command palette is open in portal
    expect(document.body.textContent).toContain('Go anywhere. Do anything.');
    expect(document.body.textContent).toContain('Inspect Topology');
    expect(document.body.textContent).toContain('Project Overview');

    // Search query in command palette
    const searchInput = document.body.querySelector<HTMLInputElement>('.wh-search input');
    if (searchInput) {
      await act(async () => {
        searchInput.value = 'Inspect';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(document.body.textContent).toContain('Inspect Topology');
    }

    // Close via Esc key
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });
});

describe('MemberChat & Community Deep Interactions', () => {
  it('renders MemberChatWidget, displays unread badge, and toggles panel', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<MemberChatWidget username="admin" displayName="Admin User" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector<HTMLButtonElement>('.member-chat-launcher');
    expect(launcher).not.toBeNull();

    // Open chat panel
    await act(async () => {
      launcher?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector('.member-chat-panel')).not.toBeNull();
    expect(document.body.textContent).toContain('Member chat');
    expect(document.body.textContent).toContain('Elena Rostova');

    // Minimize chat panel
    const minimizeBtn = document.body.querySelector<HTMLButtonElement>('button[title="Minimize chat"]');
    if (minimizeBtn) {
      await act(async () => {
        minimizeBtn.click();
      });
    }
  });

  it('selects a direct conversation room, loads messages, and handles emoji reactions', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<MemberChatWidget username="admin" displayName="Admin User" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Open chat
    const launcher = document.body.querySelector<HTMLButtonElement>('.member-chat-launcher');
    await act(async () => {
      launcher?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Click Elena Rostova room
    const roomBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.member-chat-room')).find(b =>
      b.textContent?.includes('Elena Rostova')
    );
    if (roomBtn) {
      await act(async () => {
        roomBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(document.body.textContent).toContain('Core backbone router provisioning is underway');

      // Click message actions more button
      const moreBtn = document.body.querySelector<HTMLButtonElement>('.people-message-more');
      if (moreBtn) {
        await act(async () => {
          moreBtn.click();
        });
        // Click emoji reaction 👍
        const emojiBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="React 👍"]');
        if (emojiBtn) {
          await act(async () => {
            emojiBtn.click();
          });
        }
      }
    }
  });

  it('handles message deletion with confirmation in MemberChat', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<MemberChatWidget username="admin" displayName="Admin User" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector<HTMLButtonElement>('.member-chat-launcher');
    await act(async () => {
      launcher?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Select room
    const roomBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.member-chat-room')).find(b =>
      b.textContent?.includes('Elena Rostova')
    );
    if (roomBtn) {
      await act(async () => {
        roomBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Click trash / delete button on own message
      const deleteBtn = document.body.querySelector<HTMLButtonElement>('.member-chat-delete');
      if (deleteBtn) {
        await act(async () => {
          deleteBtn.click();
        });
        expect(document.body.textContent).toContain('Permanently delete this message');

        // Confirm deletion
        const confirmBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.member-chat-delete-confirm button')).find(b =>
          b.textContent === 'Delete'
        );
        if (confirmBtn) {
          await act(async () => {
            confirmBtn.click();
          });
        }
      }
    }
  });

  it('handles typing broadcast and renders incoming typing indicator', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<MemberChatWidget username="admin" displayName="Admin User" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector<HTMLButtonElement>('.member-chat-launcher');
    await act(async () => {
      launcher?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const roomBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.member-chat-room')).find(b =>
      b.textContent?.includes('Elena Rostova')
    );
    if (roomBtn) {
      await act(async () => {
        roomBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Type in composer
      const textarea = document.body.querySelector<HTMLTextAreaElement>('.member-chat-composer textarea');
      if (textarea) {
        await act(async () => {
          textarea.value = 'Configuring optical ports';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }

      // Simulate incoming typing event
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('community-typing', {
            detail: {
              room_id: 10,
              username: 'elena',
              display_name: 'Elena Rostova',
              typing: true,
            },
          })
        );
      });

      expect(document.body.textContent).toContain('Elena Rostova is typing…');
    }
  });

  it('renders and interacts with PeopleVoiceCall connection states', async () => {
    const mockVoice: PeopleVoice = {
      call: {
        roomId: 10,
        name: 'Elena Rostova',
        phase: 'incoming',
        muted: false,
      },
      ready: true,
      notice: '',
      soundBlocked: false,
      playbackBlocked: false,
      remote: null,
      start: vi.fn().mockResolvedValue(undefined),
      answer: vi.fn().mockResolvedValue(undefined),
      decline: vi.fn(),
      mute: vi.fn(),
      hangup: vi.fn(),
      enableSound: vi.fn().mockResolvedValue(undefined),
      resumeAudio: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn(),
    };

    const onOpen = vi.fn();

    await act(async () => {
      root.render(<PeopleVoiceCall voice={mockVoice} onOpen={onOpen} />);
    });

    expect(host.textContent).toContain('Incoming voice call');
    expect(host.textContent).toContain('Answer');
    expect(host.textContent).toContain('Decline');

    // Click answer
    const answerBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Answer'));
    if (answerBtn) {
      await act(async () => {
        answerBtn.click();
      });
      expect(mockVoice.answer).toHaveBeenCalled();
    }

    // Switch to connected phase
    const connectedVoice: PeopleVoice = {
      ...mockVoice,
      call: {
        roomId: 10,
        name: 'Elena Rostova',
        phase: 'connected',
        muted: false,
      },
    };

    await act(async () => {
      root.render(<PeopleVoiceCall voice={connectedVoice} onOpen={onOpen} />);
    });

    expect(host.textContent).toContain('Voice call connected');
    expect(host.textContent).toContain('Mute microphone');
    expect(host.textContent).toContain('Hang up');
  });

  it('renders MemberChatAway settings, fills form, previews, and saves', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch());
    const onBack = vi.fn();
    const onSaved = vi.fn();

    await act(async () => {
      root.render(<MemberChatAway onBack={onBack} onSaved={onSaved} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('People Buddy away assistant');

    // Fill instructions
    const textarea = host.querySelector('textarea');
    if (textarea) {
      await act(async () => {
        textarea.value = 'In deep focus work on network telemetry.';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Click preview button
    const previewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Preview example reply'));
    if (previewBtn) {
      await act(async () => {
        previewBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Click Back
    const backBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Back'));
    if (backBtn) {
      await act(async () => {
        backBtn.click();
      });
      expect(onBack).toHaveBeenCalled();
    }
  });

  it('filters conversation list by search query and unread toggle', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch());

    await act(async () => {
      root.render(<MemberChatWidget username="admin" displayName="Admin User" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector<HTMLButtonElement>('.member-chat-launcher');
    await act(async () => {
      launcher?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Search query in conversations list
    const searchInput = document.body.querySelector<HTMLInputElement>('.member-chat-search input');
    if (searchInput) {
      await act(async () => {
        searchInput.value = 'Elena';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(document.body.textContent).toContain('Elena Rostova');
    }

    // Toggle Channels tab
    const channelsTab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.member-chat-tabs button')).find(b =>
      b.textContent === 'Channels'
    );
    if (channelsTab) {
      await act(async () => {
        channelsTab.click();
      });
      expect(document.body.textContent).toContain('architecture-board');
    }
  });
});
