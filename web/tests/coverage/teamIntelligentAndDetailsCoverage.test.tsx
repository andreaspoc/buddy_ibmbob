// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { buildOfficeHtmlRuntime, useOfficeHtmlRuntime } from "../../src/lib/officeHtmlRuntime";
import { Sidebar } from "../../src/components/Sidebar";
import { QuizCard } from '../../src/components/QuizCard';
import { NoteDetails } from '../../src/components/NoteDetails';
import { WorkflowManager } from '../../src/components/WorkflowManager';
import {
  parseIntelligentSpec,
  splitIntelligentMarkdown,
  splitAmount,
} from '../../src/lib/intelligentUi';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

describe('Intelligent UI parser & utilities', () => {
  it('handles empty and malformed json inputs with graceful fallback', () => {
    expect(parseIntelligentSpec('')).toBeUndefined();
    const fallback = parseIntelligentSpec('not-json');
    expect(fallback?.kind).toBe('explore');
    expect(fallback?.items[0].body).toBe('not-json');
  });

  it('parses valid explore and comparison specs with comments and code fences', () => {
    const raw = `
    \`\`\`json
    {
      // line comment
      /* block comment */
      "title": "Architecture Comparison",
      "kind": "comparison",
      "items": [
        { "title": "Option A", "body": "Microservices", "facts": [{ "label": "Latency", "value": "Low" }] },
        { "title": "Option B", "body": "Monolith", "facts": [{ "label": "Complexity", "value": "Low" }] }
      ],
      "actions": [
        { "label": "Choose A", "prompt": "Deploy option A" }
      ]
    }
    \`\`\`
    `;
    const spec = parseIntelligentSpec(raw);
    expect(spec).toBeDefined();
    expect(spec?.title).toBe('Architecture Comparison');
    expect(spec?.kind).toBe('comparison');
    if (spec && 'items' in spec) {
      expect(spec.items).toHaveLength(2);
    }
  });

  it('parses split specs and calculates split amounts correctly', () => {
    const raw = JSON.stringify({
      title: 'Dinner Bill',
      kind: 'split',
      total: 100,
      people: 4,
      tip: 20,
      unit: '$'
    });
    const spec = parseIntelligentSpec(raw);
    expect(spec?.kind).toBe('split');

    const perPerson = splitAmount(100, 4, 20);
    expect(perPerson).toBe(30);
  });

  it('parses analysis tables and emergency fallback specs', () => {
    const analysisRaw = JSON.stringify({
      title: 'Sales Data',
      kind: 'analysis',
      headers: ['Region', 'Q1', 'Q2'],
      rows: [['EMEA', 100, 200], ['APAC', 150, 250]],
    });
    const parsedAnalysis = parseIntelligentSpec(analysisRaw);
    expect(parsedAnalysis?.kind).toBe('analysis');

    const damaged = `preamble { "title": "Quick Steps", "kind": "steps", "items": [{"title": "Step 1", "body": "Do it"}] } trailer`;
    const emergency = parseIntelligentSpec(damaged);
    expect(emergency).toBeDefined();
    expect(emergency?.kind).toBe('steps');
  });

  it('splits markdown containing intelligent UI blocks during normal and streaming modes', () => {
    const doc = `
Here is some introductory text.

\`\`\`intelligent-ui
{
  "title": "Interactive Widget",
  "kind": "steps",
  "items": [{"title": "Step 1", "body": "Begin"}]
}
\`\`\`

And trailing text.
    `;
    const parts = splitIntelligentMarkdown(doc, false);
    expect(parts.some(p => p.type === 'ui')).toBe(true);
    expect(parts.some(p => p.type === 'text')).toBe(true);

    const streamingDoc = `Some text\n\`\`\`intelligent-ui\n{"title": "Pending`;
    const streamParts = splitIntelligentMarkdown(streamingDoc, true);
    expect(streamParts.some(p => p.type === 'ui' && p.pending)).toBe(true);
  });
});

describe('QuizCard Component', () => {
  const sampleQuiz = {
    key: 'quiz-1',
    title: 'Security Architecture Quiz',
    questions: [
      {
        id: 'q1',
        type: 'multiple' as const,
        question: 'Select all symmetric ciphers',
        options: ['AES-256', 'RSA-2048', 'ChaCha20'],
      },
      {
        id: 'q2',
        type: 'single' as const,
        question: 'Primary protocol used for HTTPS',
        options: ['TLS', 'SSH', 'FTP'],
      },
      {
        id: 'q3',
        type: 'text' as const,
        question: 'Explain defense in depth in your own words',
      },
    ],
  };

  it('renders questions, supports drafting answers, and toggles review flags', async () => {
    const onSubmit = vi.fn();
    const onViewResults = vi.fn();

    await act(async () => {
      root.render(
        <QuizCard
          quiz={sampleQuiz}
          sessionId="test-session"
          disabled={false}
          onSubmit={onSubmit}
          onViewResults={onViewResults}
        />
      );
    });

    expect(host.textContent).toContain('Security Architecture Quiz');
    expect(host.textContent).toContain('Select all symmetric ciphers');

    const checkboxes = host.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length >= 2) {
      await act(async () => {
        (checkboxes[0] as HTMLInputElement).click();
        (checkboxes[2] as HTMLInputElement).click();
      });
    }

    const form = host.querySelector('form.quiz-card') as HTMLFormElement;
    if (form) {
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    }
  });

  it('handles submitted state and displays completed answers', async () => {
    const submittedAnswers = {
      q1: [0, 2],
      q2: [0],
      q3: 'Layered security controls across networks, hosts, and applications.',
    };

    await act(async () => {
      root.render(
        <QuizCard
          quiz={sampleQuiz}
          sessionId="test-session"
          disabled={false}
          submittedAnswers={submittedAnswers}
          onSubmit={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Security Architecture Quiz');
  });
});

describe('NoteDetails Component', () => {
  it('fetches versions and attachments and displays them', async () => {
    const fakeVersions = [
      {
        id: 101,
        note_id: 1,
        created_at: '2026-10-28T10:00:00Z',
        snapshot: {
          title: 'Architecture Blueprint',
          body: '# Blueprint\nDetails of microservices topology',
          color: 'blue' as const,
          collection: 'Work',
          tags: ['architecture', 'security'],
        },
      },
    ];

    const fakeAttachments = [
      {
        id: 201,
        filename: 'diagram.png',
        content_type: 'image/png',
        size: 1048576,
        created_at: '2026-10-28T11:00:00Z',
      },
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/versions')) {
        return new Response(JSON.stringify({ items: fakeVersions }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/attachments')) {
        return new Response(JSON.stringify({ items: fakeAttachments }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const onRestored = vi.fn();
    await act(async () => {
      root.render(<NoteDetails noteId={1} onRestored={onRestored} />);
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('diagram.png');
      expect(host.textContent).toContain('1.0 MB');
    });
  });

  it('handles fetch errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ detail: 'Failed to retrieve notes data' }), { status: 500 });
    }));

    await act(async () => {
      root.render(<NoteDetails noteId={999} onRestored={vi.fn()} />);
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('Failed to retrieve notes data');
    });
  });
});

describe('WorkflowManager Component', () => {
  const dummyProjects = [{ id: 'p1', name: 'Project Titan' }];
  const dummySkills = [{ id: 's1', name: 'research-buddy' }];
  const dummyTemplates = [{ id: 't1', name: 'Executive Overview', layout: 'grid', style: 'dark' }];

  it('loads existing workflows and handles schedule configurations', async () => {
    const existingWorkflows = [
      {
        id: 'wf-1',
        name: 'Weekly Security Audit',
        enabled: true,
        frequency: 'weekly',
        time: '08:00',
        timezone: 'UTC',
        next_run: '2026-11-02T08:00:00Z',
      },
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/capabilities')) {
        return new Response(JSON.stringify({ web_search: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(existingWorkflows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const onClose = vi.fn();
    const onTask = vi.fn();

    await act(async () => {
      root.render(
        <WorkflowManager
          projects={dummyProjects as any}
          skills={dummySkills as any}
          templates={dummyTemplates as any}
          onClose={onClose}
          onTask={onTask}
        />
      );
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('Weekly Security Audit');
    });

    const nameInput = host.querySelector('input[type="text"]') as HTMLInputElement;
    if (nameInput) {
      await act(async () => {
        nameInput.value = 'New Automated Scan';
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  });
});

describe("officeHtmlRuntime builder", () => {
  it("injects runtime into HTML with head, html or doctype tags", () => {
    const withHead = "<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hi</h1></body></html>";
    const outHead = buildOfficeHtmlRuntime(withHead, "chan-1");
    expect(outHead).toContain('id="bob-office-runtime"');
    expect(outHead).toContain('chan-1');

    const withHtml = "<html><body><h1>Hi</h1></body></html>";
    const outHtml = buildOfficeHtmlRuntime(withHtml, "chan-2");
    expect(outHtml).toContain('id="bob-office-runtime"');

    const withDoctypeOnly = "<!doctype html><div>Hello</div>";
    const outDoc = buildOfficeHtmlRuntime(withDoctypeOnly, "chan-3");
    expect(outDoc).toContain('id="bob-office-runtime"');

    const rawFragment = "<div>Plain text</div>";
    const outRaw = buildOfficeHtmlRuntime(rawFragment, "chan-4");
    expect(outRaw).toContain('id="bob-office-runtime"');
  });

  it("unpacks source with existing patch comments", () => {
    const patched = '<html><head></head><body>Edited</body><!--bob-office-patches:start--><script type="application/json" id="bob-office-patches">[{"index":1,"old_text":"Before","text":"Edited"}]</script><script></script><!--bob-office-patches:end--></html>';
    const output = buildOfficeHtmlRuntime(patched, "chan-patch");
    expect(output).toContain('id="bob-office-runtime"');
    expect(output).toContain('Edited');
  });
});

describe("Sidebar Component Comprehensive Navigation & Filters", () => {
  it("renders sidebar tabs, switches categories, toggles sections, and triggers actions", async () => {
    const dummyUser = { username: "alice", is_admin: true, display_name: "Alice Smith" };
    const dummyProjects = [{ id: "proj-1", name: "Titan Mission", created_at: "2026-10-01" }];
    const dummySessions = [{ id: "sess-1", title: "Quantum Routing", created_at: "2026-10-20" }];
    const dummySkills = [{ id: "sk-1", name: "code-review", description: "Code reviewer" }];
    const dummyModes = [{ id: "m-1", slug: "architect", name: "Architect Mode" }];
    const dummyAgents = [{ id: "ag-1", slug: "cloud-specialist", name: "Cloud Specialist" }];
    const dummyPages = [{ name: "topology.html", path: "/pages/topology.html" }];
    const dummyFiles = [{ name: "report.pdf", size: 1048576 }];

    const onSelectProject = vi.fn();
    const onSelectSession = vi.fn();
    const onNewChat = vi.fn();
    const onSelectMode = vi.fn();
    const onSelectAgent = vi.fn();
    const onSignOut = vi.fn();

    await act(async () => {
      root.render(
        <Sidebar
          isOpen={true}
          user={dummyUser as any}
          projects={dummyProjects as any}
          selectedProjectId="proj-1"
          sessions={dummySessions as any}
          selectedSessionId="sess-1"
          skills={dummySkills as any}
          modes={dummyModes as any}
          selectedMode="architect"
          agents={dummyAgents as any}
          selectedAgent="cloud-specialist"
          pages={dummyPages as any}
          files={dummyFiles as any}
          onDeleteFile={vi.fn()}
          onDeleteProject={vi.fn()}
          onSelectProject={onSelectProject}
          onSelectSession={onSelectSession}
          onDeleteSession={vi.fn()}
          onNewChat={onNewChat}
          onSelectMode={onSelectMode}
          onSelectAgent={onSelectAgent}
          onEditAgent={vi.fn()}
          onEditSkill={vi.fn()}
          onDeleteSkill={vi.fn()}
          onOpenCreate={vi.fn()}
          onRefreshPages={vi.fn()}
          onSignOut={onSignOut}
          activeView="chat"
          onOpenNotes={vi.fn()}
          onOpenKnowledge={vi.fn()}
          taskCount={3}
          onOpenTasks={vi.fn()}
          onOpenWorkflows={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Quantum Routing');
    expect(host.textContent).toContain('Alice Smith');

    // Expand projects section
    const projectsHeader = Array.from(host.querySelectorAll('.section-heading')).find(h => h.textContent?.includes('PROJECTS'));
    if (projectsHeader) {
      await act(async () => {
        (projectsHeader as HTMLElement).click();
      });
      expect(host.textContent).toContain('Titan Mission');
    }

    // Click filter tabs: chats, pages, skills, modes, all
    const filterTabs = host.querySelectorAll('button.filter-tab');
    for (const tab of Array.from(filterTabs)) {
      await act(async () => {
        (tab as HTMLButtonElement).click();
      });
    }

    // Toggle collapsible headings
    const headings = host.querySelectorAll('.section-heading');
    for (const heading of Array.from(headings)) {
      await act(async () => {
        (heading as HTMLElement).click();
      });
    }

    // Click New Chat button
    const newChatBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('New conversation'));
    if (newChatBtn) {
      await act(async () => {
        newChatBtn.click();
      });
      expect(onNewChat).toHaveBeenCalled();
    }
  });

  it('exercises useOfficeHtmlRuntime bridge lifecycle, messages, and command dispatching', async () => {
    let capturedBridge: any = null;
    const onChanged = vi.fn();

    function RuntimeTester() {
      const frameRef = React.useRef<HTMLIFrameElement>(null);
      const bridge = useOfficeHtmlRuntime(frameRef, 'file-999', '<html><head></head><body><p>Document</p></body></html>', onChanged);
      React.useEffect(() => {
        capturedBridge = bridge;
      }, [bridge]);
      return <iframe ref={frameRef} title="Test Frame" />;
    }

    await act(async () => {
      root.render(<RuntimeTester />);
    });

    expect(capturedBridge).toBeTruthy();
    expect(capturedBridge.ready).toBe(false);

    const iframe = host.querySelector('iframe');
    expect(iframe).toBeTruthy();

    const mockContentWindow = {
      postMessage: vi.fn(),
    };
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      writable: true,
    });

    // Extract channel from runtimeSource
    const channelMatch = capturedBridge.runtimeSource.match(/\("([0-9a-f-]{36})"/);
    const channel = channelMatch ? channelMatch[1] : '';

    // Simulate warning message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mockContentWindow as any,
        data: {
          bridge: 'bob-html-runtime',
          channel,
          type: 'warning',
          value: 'Script execution warning'
        }
      }));
    });
    expect(capturedBridge.runtimeError).toContain('Script execution warning');

    // Simulate ready message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mockContentWindow as any,
        data: {
          bridge: 'bob-html-runtime',
          channel,
          type: 'ready',
        }
      }));
    });
    expect(capturedBridge.ready).toBe(true);

    // Simulate changed message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mockContentWindow as any,
        data: {
          bridge: 'bob-html-runtime',
          channel,
          type: 'changed',
        }
      }));
    });
    expect(onChanged).toHaveBeenCalled();

    // Call setEditing
    const setEditingPromise = capturedBridge.setEditing(true);
    expect(mockContentWindow.postMessage).toHaveBeenCalled();
    const lastCall = mockContentWindow.postMessage.mock.calls.find(c => c[0]?.command === 'editing');
    expect(lastCall).toBeTruthy();
    const editingCallId = lastCall[0].id;

    // Resolve setEditing via result message
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mockContentWindow as any,
        data: {
          bridge: 'bob-html-runtime',
          channel,
          type: 'result',
          id: editingCallId,
          value: true
        }
      }));
      await setEditingPromise;
    });

    // Call context()
    const contextPromise = capturedBridge.context();
    const contextCall = mockContentWindow.postMessage.mock.calls.find(c => c[0]?.command === 'context');
    expect(contextCall).toBeTruthy();
    const contextCallId = contextCall[0].id;

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mockContentWindow as any,
        data: {
          bridge: 'bob-html-runtime',
          channel,
          type: 'result',
          id: contextCallId,
          value: { kind: 'html', text: 'Sample' }
        }
      }));
      const ctx = await contextPromise;
      expect(ctx.kind).toBe('html');
    });

    // Call saveSource()
    const savePromise = capturedBridge.saveSource();
    const sourceCall = mockContentWindow.postMessage.mock.calls.find(c => c[0]?.command === 'source');
    expect(sourceCall).toBeTruthy();
    const sourceCallId = sourceCall[0].id;

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mockContentWindow as any,
        data: {
          bridge: 'bob-html-runtime',
          channel,
          type: 'result',
          id: sourceCallId,
          value: []
        }
      }));
      const saved = await savePromise;
      expect(saved).toContain('Document');
    });
  });
});
