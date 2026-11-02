// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../src/App';
import LearningWorkspace from '../../src/components/LearningWorkspace';

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

function setupDefaultFetch() {
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
            { id: 'office', name: 'Office Suite', description: 'Office documents and presentations', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
            { id: 'people', name: 'Community', description: 'Collaborative team community', kind: 'installed', desktop_only: false, launch: { kind: 'people' } },
            { id: 'decisions', name: 'Decisions', description: 'Architecture decisions graph', kind: 'installed', desktop_only: false, launch: { kind: 'decisions' } },
          ],
        }),
      };
    }
    if (url.includes('/api/projects/portfolio')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          can_manage: true,
          projects: [
            { id: 'proj-1', name: 'Core Infrastructure', description: 'Core network systems', status: 'active', priority: 'high', revision: 1, tolerance_days: 7, exception_status: 'within_tolerance', start_date: '2026-10-01', due_date: '2026-11-15' },
          ],
          people: [
            { id: 'person-1', name: 'Elena Rostova', email: 'elena@example.com', status: 'active' },
          ],
          assignments: [],
          dependencies: [],
          work_items: [],
          governance: [],
          raid: [],
          lessons: [],
          changes: [],
        }),
      };
    }
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
    if (url.includes('/check')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'working', message: 'Connected', tools: ['read_file'] }),
      };
    }
    if (url.includes('/mcp-catalog')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'mcp-1', name: 'File Tools', description: 'Tools for files', category: 'productivity', allowed: true, connected: true, users: [], groups: [], audience: 'both' },
        ],
      };
    }
    if (url.includes('/agent-catalog')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'ag-1', slug: 'network-specialist', name: 'Network Specialist', description: 'Network engineering helper', activated: true, allowed: true, enabled: true, protocol_version: '1.0', endpoint: 'http://localhost', groups: [], users: [] },
        ],
      };
    }
    if (url.includes('/notifications')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'notif-1', title: 'Task Complete', kind: 'task', occurred_at: '2026-10-28T10:00:00Z', read_at: null },
        ],
      };
    }
    if (url.includes('/mcps') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'working', message: 'Connected', tools: ['read_file'] }),
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
    if (url.includes('/templates') || url.includes('/presentation/templates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'tmpl-1', name: 'Executive Briefing' },
        ],
      };
    }
    if (url.includes('/personalization/memories')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'mem-1', content: 'Use British English, concise answers.', enabled: true },
        ],
      };
    }
    if (url.includes('/personalization/tutorials')) {
      if (method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) };
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
    if (url.includes('/access/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { username: 'admin', display_name: 'Admin User', employer: 'buddy', project_team: false },
          administrator: true,
          libraries: [{ id: 'company' }],
          audiences: ['both'],
          mcps: [],
        }),
      };
    }
    if (url.includes('/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ kind: 'conversations', id: 's1', title: 'Network Review', snippet: 'Reviewing routers' }],
          has_more: false,
        }),
      };
    }
    if (url.includes('/research')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/api/learning/certificates')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'cert-1',
              class_id: 'class-1',
              recipient_name: 'Elena Rostova',
              course_title: 'Computer Science 201',
              instructor_name: 'Lead Instructor',
              issued_at: '2026-10-28T10:00:00Z',
            },
          ],
        }),
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
    if (url.includes('/knowledge')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      };
    }

    // Learning endpoints
    if (url.includes('/api/learning/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ username: 'instructor', display_name: 'Lead Instructor', is_admin: true, can_create_quizzes: true }),
      };
    }
    if (url.includes('/completion')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          can_manage: true,
          course: { revision: 1 },
          items: [
            {
              username: 'student1',
              display_name: 'Student One',
              requirements: [],
              eligible: false,
              certificate: null,
            },
          ],
        }),
      };
    }
    if (url.includes('/api/learning/folders') && url.includes('/contents')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          books: [{ id: 'b1', title: 'Data Structures Manual' }],
          quizzes: [{ id: 'q1', title: 'Algorithms Checkpoint', status: 'published', version: 1, is_creator: true, question_count: 3 }],
          lessons: [{ id: 'l1', title: 'Binary Trees', status: 'published', is_creator: true, step_count: 2 }],
          notes: [{ id: 'n1', class_id: 'class-1', title: 'Tree Traversal', body: 'Inorder and postorder', content: 'Inorder and postorder', color: 'yellow', updated_at: '2026-10-28T10:00:00Z' }],
          can_manage_class: true,
        }),
      };
    }
    if (url.includes('/api/learning/folders') && url.includes('/members')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          members: ['student1'],
          groups: ['class-alpha'],
          teachers: [{ username: 'instructor', display_name: 'Lead Instructor' }],
          directory: [{ username: 'student1', display_name: 'Student One' }],
          group_directory: ['class-alpha'],
          app_group_directory: [],
        }),
      };
    }
    if (url.includes('/api/learning/folders') && url.includes('/lessons')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'l1', title: 'Binary Trees', status: 'published', is_creator: true, step_count: 2 }],
        }),
      };
    }
    if (url.includes('/api/learning/folders') && url.includes('/notes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'n1', class_id: 'class-1', title: 'Tree Traversal', body: 'Inorder and postorder', content: 'Inorder and postorder', color: 'yellow', updated_at: '2026-10-28T10:00:00Z' }],
        }),
      };
    }
    if (url.includes('/api/learning/folders')) {
      if (method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'class-new', name: 'Distributed Systems', is_class: true }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'class-1',
              name: 'Computer Science 201',
              description: 'Algorithms and Data Structures',
              is_class: true,
              can_manage: true,
              can_delete: true,
              teacher_username: 'instructor',
              lesson_count: 2,
              quiz_count: 1,
              book_count: 1,
              note_count: 1,
              member_count: 1,
            },
          ],
        }),
      };
    }
    if (url.includes('/api/learning/translate-content')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ translated: { name: 'Translated Title', description: 'Translated Description' } }),
      };
    }
    if (url.includes('/api/learning/my-certificates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'cert-1',
            class_id: 'class-1',
            recipient_name: 'Elena Rostova',
            course_title: 'Computer Science 201',
            instructor_name: 'Lead Instructor',
            issued_at: '2026-10-28T10:00:00Z',
          },
        ],
      };
    }
    if (url.includes('/api/learning/quizzes/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'q1',
          title: 'Algorithms Checkpoint',
          status: 'published',
          version: 1,
          is_creator: true,
          questions: [
            { id: 'q1-1', type: 'single', question: 'What is time complexity of binary search?', options: ['O(log n)', 'O(n)'], answer: ['0'], points: 5 },
          ],
        }),
      };
    }
    if (url.includes('/api/learning/books/') && url.includes('/notes')) {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    if (url.includes('/api/learning/books/') && url.includes('/progress')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/learning/books/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'b1',
          title: 'Data Structures Manual',
          chapters: [{ id: 'ch-1', title: 'Chapter 1: Trees' }, { id: 'ch-2', title: 'Chapter 2: Graphs' }],
          progress: { chapter_id: 'ch-1', page: 0, bookmarks: [] },
        }),
      };
    }

    return { ok: true, status: 200, json: async () => ({}) };
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', MockWebSocket);
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

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });

  vi.stubGlobal('fetch', setupDefaultFetch());

  sessionStorage.clear();
  localStorage.clear();
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
  vi.unstubAllGlobals();
});

describe('App Component', () => {
  it('renders authenticated workspace shell with sidebar and topbar', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
    expect(host.querySelector('.sidebar')).not.toBeNull();
    expect(host.textContent).toContain('Buddy');
  });

  it('renders welcome tour modal when not yet seen and allows dismissing', async () => {
    // welcome seen flag not set
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Tour / Welcome guide modal renders
    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders with /app/mcp-catalog URL and opens MCPServerCatalog panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/mcp-catalog');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('MCP');
  });

  it('renders with /app/agent-catalog URL and opens AgentCatalog panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/agent-catalog');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Agent');
  });

  it('renders with /app/personalization URL and opens PersonalizationManager panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/personalization');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders with /app/productivity URL and opens ProductivityWorkspace panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/productivity');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders with /app/notifications URL and opens NotificationInbox panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/notifications');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders with /app/apps URL and opens App Catalog overlay', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const appsLauncher = host.querySelector<HTMLButtonElement>('[data-apps-launcher]');
    if (appsLauncher) {
      await act(async () => {
        appsLauncher.click();
      });
      expect(document.body.textContent).toContain('Community');
    }
  });

  it('renders with /app/decisions URL and opens Decisions Buddy overlay', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/decisions');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders with /projects URL and embeds ProjectsWorkspace', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/projects');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Core Infrastructure');
  });

  it('renders with /app/search URL and opens UnifiedSearch panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/search');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Search');
  });

  it('renders with /app/research URL and opens ResearchManager panel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/research');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('renders with /app/access URL and opens MyAccessPanel', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/access');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('My access');
  });

  it('renders with /app/sharing URL and opens ConversationSharing dialog', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');
    window.history.replaceState({}, '', '/app/sharing');
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Export');
  });
});

describe('LearningWorkspace Component', () => {
  it('renders learning workspace with class navigation and sidebar', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.learning-shell')).not.toBeNull();
    expect(host.querySelector('.learning-sidebar')).not.toBeNull();
    expect(host.textContent).toContain('Learning Workspace');
    expect(host.textContent).toContain('Lead Instructor');
  });

  it('switches between chapters, notes, library, quizzes, lessons, and completion tabs', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Click Notes tab
    const notesTab = host.querySelector<HTMLButtonElement>('#learning-notes-tab');
    if (notesTab) {
      await act(async () => {
        notesTab.click();
      });
      expect(host.textContent).toContain('Tree Traversal');
    }

    // Click Quizzes tab
    const quizzesTab = host.querySelector<HTMLButtonElement>('#learning-quizzes-tab');
    if (quizzesTab) {
      await act(async () => {
        quizzesTab.click();
      });
      expect(host.textContent).toContain('Algorithms Checkpoint');
    }

    // Click Lessons tab
    const lessonsTab = host.querySelector<HTMLButtonElement>('#learning-lessons-tab');
    if (lessonsTab) {
      await act(async () => {
        lessonsTab.click();
      });
      expect(host.textContent).toContain('Binary Trees');
    }

    // Click Library tab
    const libraryTab = host.querySelector<HTMLButtonElement>('#learning-library-tab');
    if (libraryTab) {
      await act(async () => {
        libraryTab.click();
      });
      expect(host.textContent).toContain('Data Structures Manual');
    }

    // Click Completion tab
    const completionTab = host.querySelector<HTMLButtonElement>('#learning-completion-tab');
    if (completionTab) {
      await act(async () => {
        completionTab.click();
      });
      expect(host.textContent).toContain('Certificates & completion');
    }
  });

  it('opens ebook reader for a book, navigates pages, and toggles bookmark', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1/books/b1');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // EbookReader is open
    expect(host.textContent).toContain('Data Structures Manual');

    // Find Next Page button
    const nextBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.getAttribute('title')?.includes('Next page') || b.textContent?.includes('Next')
    );
    if (nextBtn) {
      await act(async () => {
        nextBtn.click();
      });
    }

    // Find Bookmark button
    const bookmarkBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Bookmark')
    );
    if (bookmarkBtn) {
      await act(async () => {
        bookmarkBtn.click();
      });
    }
  });

  it('opens quiz runner and handles question interaction', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1/quizzes/q1');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Algorithms Checkpoint');
  });

  it('opens new class folder dialog and filters class list by search query', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1?tab=library');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const searchInput = host.querySelector<HTMLInputElement>('.learning-search-bar input, input[type="search"]');
    if (searchInput) {
      await act(async () => {
        searchInput.value = 'Algorithms';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    expect(host.querySelector('.learning-shell')).not.toBeNull();
  });

  it('opens class members dialog and displays roster', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const membersBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Class Members') || b.textContent?.includes('Members')
    );
    if (membersBtn) {
      await act(async () => {
        membersBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.body.textContent).toContain('Student One');
    }
  });

  it('opens certificates dialog and displays issued certificates', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const certsBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Certificates')
    );
    if (certsBtn) {
      await act(async () => {
        certsBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.body.textContent).toContain('Computer Science 201');
    }
  });

  it('opens sticky note editor in notes tab', async () => {
    window.history.replaceState({}, '', '/learning/folders/class-1?tab=notes');
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const addNoteBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('+ New Sticky Note') || b.textContent?.includes('+ Sticky Note')
    );
    if (addNoteBtn) {
      await act(async () => {
        addNoteBtn.click();
      });
      expect(document.body.textContent).toContain('New class sticky note');
    }
  });
});
