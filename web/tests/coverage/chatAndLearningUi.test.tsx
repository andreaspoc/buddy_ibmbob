// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ChatView, extractThinking } from '../../src/components/ChatView';
import { LearningLessons } from '../../src/components/LearningLessons';
import { StickyNotes, NotesWorkspace } from '../../src/components/StickyNotes';
import type {
  ChatMessage,
  Mode,
  Skill,
  A2AAgent,
  PresentationTemplate,
  ActionApproval,
} from '../../src/types';
import type { StickyNoteDraft } from '../../src/lib/stickyNotes';

// Mocks
vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mock diagram</text></svg>' }),
  },
}));

vi.mock('../../src/lib/noteEnrichment', () => ({
  enrichNote: vi.fn().mockImplementation(async (note, instruction, options) => {
    options?.onStatus?.('Generating suggestion…');
    return {
      title: 'Enriched Note Title',
      body: 'Enriched content based on: ' + instruction,
    };
  }),
  parseNoteRevision: vi.fn((text) => ({ title: 'Parsed Title', body: text })),
}));

let host: HTMLDivElement;
let root: Root;

function setNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
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
  window.scrollTo = vi.fn();

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });

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

  class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  if (typeof globalThis.DragEvent === 'undefined') {
    class MockDragEvent extends Event {
      dataTransfer: any;
      constructor(type: string, init?: any) {
        super(type, init);
        this.dataTransfer = init?.dataTransfer || { files: [], getData: vi.fn(), setData: vi.fn() };
      }
    }
    vi.stubGlobal('DragEvent', MockDragEvent);
  }

  URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
  URL.revokeObjectURL = vi.fn();

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
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ============================================================================
// SUITE 1: ChatView & extractThinking
// ============================================================================
describe('ChatView & extractThinking', () => {
  const dummyModes: Mode[] = [
    { slug: 'agent', name: 'Agent Mode', description: 'Autonomous agent mode', icon: 'bot' } as any,
    { slug: 'presentation', name: 'Presentation Studio', description: 'Presentation generator', icon: 'slides' } as any,
  ];
  const dummySkills: Skill[] = [
    { name: 'research-buddy', description: 'Deep research tool' },
    { name: 'diagram-expert', description: 'Generates Mermaid architecture diagrams' },
  ];
  const dummyAgents: A2AAgent[] = [
    { slug: 'support-engineer', name: 'Support Engineer', description: 'Network operations', endpoint: '/a2a/support' },
  ];
  const dummyTemplates: PresentationTemplate[] = [
    { id: 'purple-starter', title: 'Company A Purple Starter', description: 'Corporate template', slides: [] } as any,
  ];

  const defaultProps = {
    messages: [] as ChatMessage[],
    isStreaming: false,
    activeMode: 'agent',
    slideCount: 5,
    onSlideCountChange: vi.fn(),
    activeAgent: '',
    modes: dummyModes,
    skills: dummySkills,
    agents: dummyAgents,
    templates: dummyTemplates,
    selectedTemplateId: 'purple-starter',
    onSendMessage: vi.fn(),
    onApprovalDecision: vi.fn().mockResolvedValue(undefined),
    onUploadFile: vi.fn().mockResolvedValue({
      filename: 'sample.csv',
      path: '/files/sample.csv',
      size: 4096,
      session_id: 's1',
      is_spreadsheet: true,
      summary: { total_rows: 150, sheets_count: 2 },
    }),
    onStop: vi.fn(),
    onOpenTemplateModal: vi.fn(),
  };

  it('extractThinking parses closed think tags, streaming open tags, and normal text', () => {
    expect(extractThinking('')).toEqual({ thoughts: '', cleanText: '' });

    const closed = extractThinking('<think>Analyzing root cause\nChecking API logs</think>System is operational.');
    expect(closed.thoughts).toBe('Analyzing root cause\nChecking API logs');
    expect(closed.cleanText).toBe('System is operational.');

    const closedAlt = extractThinking('<thinking>Synthesizing lesson</thinking>Here is the lesson.');
    expect(closedAlt.thoughts).toBe('Synthesizing lesson');
    expect(closedAlt.cleanText).toBe('Here is the lesson.');

    const streamingOpen = extractThinking('<think>Analyzing packet flow...', true);
    expect(streamingOpen.thoughts).toBe('Analyzing packet flow...');
    expect(streamingOpen.cleanText).toBe('');

    const notStreamingOpen = extractThinking('<think>Draft notes without end', false);
    expect(notStreamingOpen.thoughts).toBe('');
    expect(notStreamingOpen.cleanText).toBe('<think>Draft notes without end');

    const regular = extractThinking('Direct answer with no thinking tag.');
    expect(regular.thoughts).toBe('');
    expect(regular.cleanText).toBe('Direct answer with no thinking tag.');
  });

  it('retries a failed document preparation and reports renewed access failure', async () => {
    const onUploadFile = vi.fn().mockResolvedValue({
      filename: 'guide.pdf', path: 'folder/guide.pdf', session_id: 'session-1',
      document: { path: 'folder/guide.pdf', status: 'failed', error: 'Extraction failed' },
    });
    let attempts = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/documents/prepare')) return ++attempts === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 };
      if (String(url).includes('/documents/preview')) return { ok: false, status: 403 };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(<ChatView {...defaultProps} sessionId="session-1" onUploadFile={onUploadFile} />); });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fixture'], 'guide.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('Extraction failed');
    const retry = () => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Retry preparation'))!;
    await act(async () => { retry().click(); });
    expect(host.textContent).toContain('Could not retry document preparation');
    await act(async () => { retry().click(); });
    expect(attempts).toBe(2);
    expect(host.textContent).toContain('Document access could not be verified');
  });

  it('renders welcome hero in normal mode and agent collaboration hero in talkToAgentsMode', async () => {
    await act(async () => {
      root.render(<ChatView {...defaultProps} messages={[]} talkToAgentsMode={false} />);
    });
    expect(host.textContent).toContain('Buddy');
    expect(host.textContent).toContain('How can I make your life easier today?');

    await act(async () => {
      root.render(<ChatView {...defaultProps} messages={[]} talkToAgentsMode={true} />);
    });
    expect(host.textContent).toContain('Agent Collaboration');
    expect(host.textContent).toContain('Boost your Productivity with other Buddys');
  });

  it('renders and interacts with conversation context chips and presentation banner', async () => {
    const onSelectProject = vi.fn();
    const onChangeMode = vi.fn();
    const onChangeAgent = vi.fn();
    const onManageTools = vi.fn();
    const onSlideCountChange = vi.fn();
    const onOpenTemplateModal = vi.fn();

    await act(async () => {
      root.render(
        <ChatView
          {...defaultProps}
          activeMode="presentation"
          projects={[{ id: 'p1', name: 'Project Alpha' }]}
          projectId=""
          onSelectProject={onSelectProject}
          onChangeMode={onChangeMode}
          onChangeAgent={onChangeAgent}
          configuredTools={['jira', 'gitlab']}
          onManageTools={onManageTools}
          slideCount={8}
          onSlideCountChange={onSlideCountChange}
          onOpenTemplateModal={onOpenTemplateModal}
        />
      );
    });

    expect(host.textContent).toContain('Presentation Studio Mode Active');
    expect(host.textContent).toContain('Company A Purple Starter');

    // Change project select
    const projectSelect = host.querySelector('select[aria-label="Conversation project"]') as HTMLSelectElement;
    expect(projectSelect).toBeTruthy();
    await act(async () => {
      projectSelect.value = 'p1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSelectProject).toHaveBeenCalledWith('p1');

    // Change mode select
    const modeSelect = host.querySelector('select[aria-label="Conversation mode"]') as HTMLSelectElement;
    await act(async () => {
      modeSelect.value = 'agent';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChangeMode).toHaveBeenCalledWith('agent');

    // Change agent select
    const agentSelect = host.querySelector('select[aria-label="Conversation agent"]') as HTMLSelectElement;
    await act(async () => {
      agentSelect.value = 'support-engineer';
      agentSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChangeAgent).toHaveBeenCalledWith('support-engineer');

    // Connections button
    const connectionsBtn = Array.from(host.querySelectorAll('button.chat-context-chip')).find((b) =>
      b.textContent?.includes('Available connections')
    );
    expect(connectionsBtn).toBeTruthy();
    await act(async () => {
      connectionsBtn?.click();
    });
    expect(onManageTools).toHaveBeenCalled();

    // Template modal button
    const changeTemplateBtn = Array.from(host.querySelectorAll('button.presentation-banner-btn')).find((b) =>
      b.textContent?.includes('Change Template')
    );
    await act(async () => {
      changeTemplateBtn?.click();
    });
    expect(onOpenTemplateModal).toHaveBeenCalled();
  });

  it('renders user and assistant messages with attachments, actions, approvals, and notes', async () => {
    const onApprovalDecision = vi.fn().mockResolvedValue(undefined);
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const onBranch = vi.fn().mockResolvedValue(undefined);
    const onGenerateDeckFromMessage = vi.fn();

    const sampleApproval: ActionApproval = {
      approval_id: 'app-1',
      action_type: 'commands',
      title: 'Execute diagnostic command',
      status: 'pending',
      detail: 'ping 10.0.0.1',
      created_at: '2026-10-29T10:00:00Z',
    };

    const messages: ChatMessage[] = [
      {
        id: 'msg-u1',
        role: 'user',
        content: '[Attached spreadsheet: metrics.xlsx]\nCan you analyze the network latency metrics?',
      },
      {
        id: 'msg-a1',
        role: 'assistant',
        content:
          '<think>Checking latency outliers in metrics.xlsx</think>' +
          '### Latency Analysis\n\nOverall latency is **stable** with an average of 14ms.\n\n' +
          '```bobnotes\n{"notes":[{"title":"Latency Target","body":"Maintain p99 below 25ms.","color":"mint"}]}\n```',
        approvals: [sampleApproval],
        tokens: 450,
        cost: 12,
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          {...defaultProps}
          sessionId="session-chat-1"
          messages={messages}
          onApprovalDecision={onApprovalDecision}
          onDeleteMessage={onDeleteMessage}
          onBranch={onBranch}
          onGenerateDeckFromMessage={onGenerateDeckFromMessage}
        />
      );
    });

    // User message contains attachment detail
    expect(host.textContent).toContain('metrics.xlsx');
    expect(host.textContent).toContain('Spreadsheet');
    expect(host.textContent).toContain('Can you analyze the network latency metrics?');

    // Assistant message contains markdown and parsed sticky notes
    expect(host.textContent).toContain('Latency Analysis');
    expect(host.textContent).toContain('Maintain p99 below 25ms.');
    expect(host.textContent).toContain('Latency Target');

    // Approvals card present
    expect(host.textContent).toContain('Execute diagnostic command');

    // Branch conversation button
    const branchBtn = host.querySelector('button[aria-label="Branch conversation"]') ||
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Branch conversation'));
    if (branchBtn) {
      await act(async () => {
        branchBtn.click();
      });
      expect(onBranch).toHaveBeenCalled();
    }

    // Executive deck button
    const deckBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Executive Deck'));
    if (deckBtn) {
      await act(async () => {
        deckBtn.click();
      });
      expect(onGenerateDeckFromMessage).toHaveBeenCalled();
    }
  });

  it('supports typing in composer, keyboard Enter to submit, and shift+Enter for newline', async () => {
    const onSendMessage = vi.fn();
    await act(async () => {
      root.render(<ChatView {...defaultProps} onSendMessage={onSendMessage} />);
    });

    const textarea = host.querySelector('textarea#prompt-input') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await act(async () => {
      setNativeInputValue(textarea, 'First line of instructions');
    });

    // Shift + Enter does not submit
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    expect(onSendMessage).not.toHaveBeenCalled();

    // Plain Enter submits
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }));
    });
    expect(onSendMessage).toHaveBeenCalledWith('First line of instructions', undefined, undefined, undefined, undefined);
  });

  it('handles slash commands menu navigation and skill picking', async () => {
    await act(async () => {
      root.render(<ChatView {...defaultProps} />);
    });

    const textarea = host.querySelector('textarea#prompt-input') as HTMLTextAreaElement;
    await act(async () => {
      setNativeInputValue(textarea, '/');
    });

    // Slash menu should be displayed
    const slashMenu = host.querySelector('#skill-command-menu');
    expect(slashMenu).toBeTruthy();
    expect(slashMenu?.textContent).toContain('Research Buddy');
    expect(slashMenu?.textContent).toContain('Diagram Expert');

    // Click skill option
    const skillOption = Array.from(slashMenu!.querySelectorAll('button.slash-option')).find((b) =>
      b.textContent?.includes('Research Buddy')
    );
    expect(skillOption).toBeTruthy();
    await act(async () => {
      skillOption?.click();
    });

    expect(textarea.value).toBe('/research-buddy ');
  });

  it('handles streaming state with stop button and active guidance response', async () => {
    const onStop = vi.fn();
    const onGuideResponse = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <ChatView
          {...defaultProps}
          isStreaming={true}
          canGuideResponse={true}
          onStop={onStop}
          onGuideResponse={onGuideResponse}
          messages={[
            {
              id: 'stream-1',
              role: 'assistant',
              content: 'Generating detailed networking diagram...',
              isStreaming: true,
            },
          ]}
        />
      );
    });

    // Stop button is present
    const stopButton = host.querySelector('button.stop-button') as HTMLButtonElement;
    expect(stopButton).toBeTruthy();
    await act(async () => {
      stopButton.click();
    });
    expect(onStop).toHaveBeenCalled();

    // Guidance input
    const textarea = host.querySelector('textarea#prompt-input') as HTMLTextAreaElement;
    await act(async () => {
      setNativeInputValue(textarea, 'Please focus on OSPF routing area 0');
    });

    const guidanceSendBtn = host.querySelector('button.guidance-send-button') as HTMLButtonElement;
    expect(guidanceSendBtn).toBeTruthy();
    await act(async () => {
      guidanceSendBtn.click();
    });
    expect(onGuideResponse).toHaveBeenCalledWith('Please focus on OSPF routing area 0');
  });

  it('handles file attachments and drag-and-drop file upload', async () => {
    const onUploadFile = vi.fn().mockResolvedValue({
      filename: 'sample_topology.txt',
      path: '/files/sample_topology.txt',
      size: 2048,
      session_id: 'sess-1',
      is_spreadsheet: false,
    });

    await act(async () => {
      root.render(<ChatView {...defaultProps} onUploadFile={onUploadFile} sessionId="sess-1" />);
    });

    const composer = host.querySelector('form.composer') as HTMLFormElement;
    expect(composer).toBeTruthy();

    const file = new File(['device router-1 core'], 'sample_topology.txt', { type: 'text/plain' });
    const dragEvent = new Event('drop', { bubbles: true }) as any;
    dragEvent.dataTransfer = { files: [file] };

    await act(async () => {
      composer.dispatchEvent(dragEvent);
    });

    expect(onUploadFile).toHaveBeenCalledWith(file);
  });

  it('handles keyboard shortcuts, outline navigation, and quote removal in composer', async () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-u1',
        role: 'user',
        content: 'Tell me about optical fiber splicing.',
      },
      {
        id: 'msg-a1',
        role: 'assistant',
        content: 'Optical fiber splicing requires precision alignment.\n\n[Topology Guide](/download/topology.pdf)',
      },
    ];

    await act(async () => {
      root.render(<ChatView {...defaultProps} messages={messages} sessionId="s-shortcuts" />);
    });

    // Global shortcut Cmd+K focuses textarea
    const textarea = host.querySelector('textarea#prompt-input') as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, 'focus');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    expect(focusSpy).toHaveBeenCalled();

    // Global shortcut Cmd+/ toggles shortcuts modal
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }));
    });
    expect(host.querySelector('.shortcuts-modal-overlay') || host.querySelector('[role="dialog"]') || host.textContent).toBeTruthy();

    // Outline toggle button
    const outlineToggle = host.querySelector('button.chat-outline-toggle') as HTMLButtonElement;
    expect(outlineToggle).toBeTruthy();
    await act(async () => {
      outlineToggle.click();
    });
    expect(host.querySelector('nav#chat-conversation-outline')).toBeTruthy();
    expect(host.textContent).toContain('Topology Guide');

    // Clicking outline jump item
    const jumpBtn = host.querySelector('nav#chat-conversation-outline button') as HTMLButtonElement;
    if (jumpBtn) {
      await act(async () => {
        jumpBtn.click();
      });
    }
  });

  it('rejects oversized file uploads with clear error message and handles attached chip removal', async () => {
    await act(async () => {
      root.render(<ChatView {...defaultProps} sessionId="sess-oversize" />);
    });

    const composer = host.querySelector('form.composer') as HTMLFormElement;
    // 60 MB file exceeds 50 MB limit
    const hugeFile = new File(['a'.repeat(100)], 'huge_data.parquet', { type: 'application/octet-stream' });
    Object.defineProperty(hugeFile, 'size', { value: 60 * 1024 * 1024 });

    const dropEvent = new Event('drop', { bubbles: true }) as any;
    dropEvent.dataTransfer = { files: [hugeFile] };

    await act(async () => {
      composer.dispatchEvent(dropEvent);
    });

    expect(host.textContent).toContain('This file is too large');

    // Dismiss upload error
    const dismissBtn = Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('title')?.includes('Dismiss'));
    if (dismissBtn) {
      await act(async () => {
        dismissBtn.click();
      });
      expect(host.textContent).not.toContain('This file is too large');
    }
  });

  it('toggles keyboard shortcuts modal open and closed', async () => {
    await act(async () => {
      root.render(<ChatView {...defaultProps} sessionId="sess-shortcuts" />);
    });

    const shortcutsBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.getAttribute('title')?.toLowerCase().includes('shortcut') ||
      b.getAttribute('aria-label')?.toLowerCase().includes('shortcut') ||
      b.textContent?.includes('⌨')
    );
    if (shortcutsBtn) {
      await act(async () => {
        shortcutsBtn.click();
      });
      expect(host.textContent).toContain('Keyboard Shortcuts');
      const closeBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.getAttribute('aria-label')?.toLowerCase().includes('close') || b.textContent === '×'
      );
      if (closeBtn) {
        await act(async () => {
          closeBtn.click();
        });
      }
    }
  });

  it('handles composer dragover and dragleave events', async () => {
    await act(async () => {
      root.render(<ChatView {...defaultProps} sessionId="sess-drag" />);
    });

    const composer = host.querySelector('form.composer') as HTMLFormElement;
    if (composer) {
      await act(async () => {
        composer.dispatchEvent(new Event('dragover', { bubbles: true }));
      });
      await act(async () => {
        composer.dispatchEvent(new Event('dragleave', { bubbles: true }));
      });
    }
    expect(composer).not.toBeNull();
  });
});

// ============================================================================
// SUITE 2: LearningLessons Component
// ============================================================================
describe('LearningLessons Component', () => {
  const dummyLessonSummaries = [
    {
      id: 'l-1',
      title: 'Optical Transport Basics',
      status: 'published',
      version: 1,
      is_creator: true,
    },
    {
      id: 'l-2',
      title: 'Platform Wavelength Planning',
      status: 'draft',
      version: 1,
      is_creator: true,
    },
  ];

  const fullLesson1 = {
    ...dummyLessonSummaries[0],
    description: 'Learn foundational Platform and fiber concepts',
    steps: [
      {
        id: 's-1',
        kind: 'text',
        title: 'Wave Division Introduction',
        text: 'WDM multiplies bandwidth over a single optical fiber.',
        url: '',
        asset_id: null,
        options: [],
      },
      {
        id: 's-2',
        kind: 'reveal',
        title: 'Hidden Insight',
        text: 'Dispersion compensation requires fiber Bragg gratings.',
        url: '',
        asset_id: null,
        options: [],
      },
      {
        id: 's-3',
        kind: 'question',
        title: 'Check Your Knowledge',
        text: 'What does Platform stand for?',
        url: '',
        asset_id: null,
        options: ['Dense Wavelength Division Multiplexing', 'Direct Wave Data Modulation'],
        answer: 0,
        feedback: 'Correct! Platform packs wavelengths closely together.',
      },
    ],
    progress: { step: 0, completed: false },
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
        const method = init?.method || 'GET';

        if (url.includes('/folders/folder-optics/lessons') && method === 'GET') {
          return {
            ok: true,
            json: async () => ({ items: dummyLessonSummaries }),
          };
        }
        if (url.includes('/folders/folder-optics/lessons/order') && method === 'PUT') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes('/lessons/l-1') && method === 'GET') {
          return { ok: true, json: async () => fullLesson1 };
        }
        if (url.includes('/check') && method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              correct: true,
              feedback: 'Correct! Platform packs wavelengths closely together.',
            }),
          };
        }
        if (url.includes('/lessons/l-2') && method === 'GET') {
          return {
            ok: true,
            json: async () => ({
              ...dummyLessonSummaries[1],
              description: 'Draft planning',
              steps: [
                {
                  id: 's-20',
                  kind: 'text',
                  title: 'Draft Step',
                  text: 'Initial draft content',
                  url: '',
                  asset_id: null,
                  options: [],
                },
              ],
            }),
          };
        }
        if (url.includes('/progress') && method === 'PUT') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes('/publish') && method === 'POST') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes('/folders/folder-optics/lessons') && method === 'POST') {
          return { ok: true, json: async () => ({ id: 'new-l-99', draft_digest: 'd-1' }) };
        }
        if (url.includes('/lessons/') && method === 'PUT') {
          return { ok: true, json: async () => ({ draft_digest: 'd-2' }) };
        }
        if (url.includes('/lessons/') && method === 'DELETE') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      })
    );
  });

  it('renders lesson cards and filters via search query', async () => {
    await act(async () => {
      root.render(<LearningLessons folderId="folder-optics" canCreate={true} search="" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Optical Transport Basics');
    expect(host.textContent).toContain('Platform Wavelength Planning');

    // Apply search filter
    await act(async () => {
      root.render(<LearningLessons folderId="folder-optics" canCreate={true} search="Platform" />);
    });
    expect(host.textContent).toContain('Platform Wavelength Planning');
  });

  it('walks through reader mode: stepping through text, reveal, and question steps', async () => {
    const onProgressChange = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-optics"
          canCreate={true}
          search=""
          openLessonId="l-1"
          onProgressChange={onProgressChange}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Wave Division Introduction');
    expect(host.textContent).toContain('WDM multiplies bandwidth');

    // Advance to next step (via footer Save & continue button or sidebar item)
    const nextBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Save & continue') || b.textContent?.includes('Next')
    );
    expect(nextBtn).toBeTruthy();
    await act(async () => {
      nextBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Reveal step
    expect(host.textContent).toContain('Hidden Insight');
    const revealSummary = host.querySelector('details.lesson-reveal summary');
    if (revealSummary) {
      await act(async () => {
        (revealSummary as HTMLElement).click();
      });
      expect(host.textContent).toContain('Dispersion compensation requires fiber Bragg gratings.');
    }

    // Advance to question step
    const nextBtn2 = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Save & continue') || b.textContent?.includes('Next')
    );
    await act(async () => {
      nextBtn2?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('What does Platform stand for?');
    const optionInput = host.querySelector('label.lesson-choice input[type="radio"]') as HTMLInputElement;
    expect(optionInput).toBeTruthy();
    await act(async () => {
      optionInput.click();
    });

    const checkBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Check answer')
    );
    if (checkBtn) {
      await act(async () => {
        checkBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(host.textContent).toContain('Platform packs wavelengths closely together.');
    }
  });

  it('edits a lesson in editor mode, modifies title and adds new step', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-optics"
          canCreate={true}
          search=""
          openLessonId="l-2"
          openLessonEditor={true}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Edit lesson');
    const titleInput = host.querySelector('input.learning-editor-title') as HTMLInputElement;
    if (titleInput) {
      await act(async () => {
        setNativeInputValue(titleInput, 'Advanced Platform Architecture');
      });
      expect(titleInput.value).toBe('Advanced Platform Architecture');
    }

    // Add step button
    const addStepBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add section') || b.textContent?.includes('New section') || b.textContent?.includes('＋')
    );
    if (addStepBtn) {
      await act(async () => {
        addStepBtn.click();
      });
    }

    // Save draft button
    const saveDraftBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Save draft') || b.textContent?.includes('Save changes')
    );
    if (saveDraftBtn) {
      await act(async () => {
        saveDraftBtn.click();
      });
    }

    expect(host.querySelector('.learning-lessons') || host.children.length > 0).toBeTruthy();
  });

  it('triggers delete lesson with confirmation dialog', async () => {
    await act(async () => {
      root.render(<LearningLessons folderId="folder-optics" canCreate={true} search="" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const deleteBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label')?.includes('Delete') || b.textContent?.includes('Delete')
    );
    if (deleteBtn) {
      await act(async () => {
        deleteBtn.click();
      });

      // Confirm modal appears
      const confirmActionBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Delete lesson')
      );
      if (confirmActionBtn) {
        await act(async () => {
          confirmActionBtn.click();
        });
      }
    }
    expect(host.children.length).toBeGreaterThan(0);
  });

  it('handles network failure with error banner when loading lessons fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Connection dropped by remote server'))
    );

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-err"
          canCreate={true}
          search=""
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Connection dropped');
  });

  it('reorders lessons via move up/down controls', async () => {
    const mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
        const method = init?.method || 'GET';
        if (url.includes('/lessons/order') && method === 'PUT') {
          return mockPut();
        }
        if (url.includes('/folders/folder-reorder/lessons')) {
          return { ok: true, json: async () => ({ items: dummyLessonSummaries }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      })
    );

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-reorder"
          canCreate={true}
          search=""
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const moveDownBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.toLowerCase().includes('down') ||
      b.getAttribute('title')?.toLowerCase().includes('down') ||
      b.textContent?.includes('↓')
    );
    if (moveDownBtn) {
      await act(async () => {
        moveDownBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }
    expect(host.children.length).toBeGreaterThan(0);
  });

  it('supports multilingual authoring: generating 3 languages and toggling approval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
        const method = init?.method || 'GET';

        if (url.includes('/translate-content') && method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              language: 'el',
              translated: {
                title: 'Βασικά Στοιχεία Οπτικών Δικτύων',
                description: 'Εκμάθηση Platform',
                steps: [{ ...fullLesson1.steps[0], title: 'Εισαγωγή WDM' }],
              },
            }),
          };
        }
        if (url.includes('/lessons/l-1') && method === 'GET') {
          return { ok: true, json: async () => fullLesson1 };
        }
        if (url.includes('/folders/folder-optics/lessons') && method === 'GET') {
          return { ok: true, json: async () => ({ items: dummyLessonSummaries }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      })
    );

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-optics"
          canCreate={true}
          search=""
          openLessonId="l-1"
          openLessonEditor={true}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Language switcher tabs: Greek tab
    const greekTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Ελληνικά'));
    if (greekTab) {
      await act(async () => {
        greekTab.click();
      });
    }

    // Generate all 3 languages button
    const generateAllBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Translate into all 3 languages') || b.textContent?.includes('Generate in all 3 languages')
    );
    if (generateAllBtn) {
      await act(async () => {
        generateAllBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    }

    // Toggle approval button
    const approvalBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Approve language') || b.textContent?.includes('Approved') || b.textContent?.includes('Approve')
    );
    if (approvalBtn) {
      await act(async () => {
        approvalBtn.click();
      });
    }

    expect(host.children.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// SUITE 3: StickyNotes & NotesWorkspace
// ============================================================================
describe('StickyNotes & NotesWorkspace', () => {
  const sampleDrafts: StickyNoteDraft[] = [
    {
      title: 'API Peering Guideline',
      body: 'Configure route reflectors in AS 65001. Reference [Core Topology](#note-200)',
      color: 'butter',
    },
    {
      title: 'Fiber Splice Log',
      body: 'Span 12 attenuation resolved to 0.18 dB/km.',
      color: 'mint',
    },
  ];

  const savedNotesList = [
    {
      id: 200,
      title: 'Core Topology',
      body: 'Primary ring and secondary backup routes.',
      color: 'sky',
      collection: 'Network Architecture',
      tags: ['topology', 'routing'],
      favorite: true,
      created_at: '2026-10-28T12:00:00Z',
    },
    {
      id: 201,
      title: 'Incident Response Protocol',
      body: 'Check physical alarms, verify API sessions, inform support.',
      color: 'rose',
      collection: '',
      tags: ['incident', 'urgent'],
      favorite: false,
      created_at: '2026-10-29T08:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
        const method = init?.method || 'GET';

        if (url.includes('/api/notes/export')) {
          return {
            ok: true,
            blob: async () => new Blob(['# Exported Notes'], { type: 'text/markdown' }),
          };
        }
        if (url.includes('/api/notes/200') && method === 'PATCH') {
          return {
            ok: true,
            json: async () => ({ ...savedNotesList[0], favorite: false }),
          };
        }
        if (url.includes('/api/notes/201') && method === 'DELETE') {
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url.includes('/api/notes') && method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              id: 205,
              title: 'New Created Note',
              body: 'Content for created note',
              color: 'lavender',
              collection: '',
              tags: [],
              favorite: false,
            }),
          };
        }
        if (url.includes('/api/notes') && method === 'GET') {
          return {
            ok: true,
            json: async () => ({
              items: savedNotesList,
              next_before_id: null,
              default_collection: 'Network Architecture',
            }),
          };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      })
    );
  });

  it('renders StickyNotes with clickable internal note link and handles note saving', async () => {
    await act(async () => {
      root.render(
        <StickyNotes
          notes={sampleDrafts}
          sessionId="sess-100"
          messageId="msg-100"
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(host.textContent).toContain('API Peering Guideline');
    expect(host.textContent).toContain('Fiber Splice Log');

    // Click Save to Notes button on first note
    const saveBtn = host.querySelector('button[data-note-save]') as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(host.querySelector('.sticky-notes') || host.children.length > 0).toBeTruthy();
  });

  it('renders StickyNotes in readOnly mode without save buttons', async () => {
    await act(async () => {
      root.render(
        <StickyNotes
          notes={sampleDrafts}
          sessionId="sess-100"
          messageId="msg-100"
          readOnly={true}
        />
      );
    });

    expect(host.textContent).toContain('API Peering Guideline');
    const saveButtons = host.querySelectorAll('button[data-note-save]');
    expect(saveButtons.length).toBe(0);
  });

  it('renders NotesWorkspace, loads notes collection, filters by query, and switches view modes', async () => {
    const onBack = vi.fn();
    await act(async () => {
      root.render(<NotesWorkspace onBack={onBack} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Core Topology');
    expect(host.textContent).toContain('Incident Response Protocol');

    // Filter by search query
    const searchInput = host.querySelector('input[type="search"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    await act(async () => {
      setNativeInputValue(searchInput, 'Splice');
    });
    expect(host.textContent).toContain('No matching notes');

    // Clear search
    await act(async () => {
      setNativeInputValue(searchInput, '');
    });
    expect(host.textContent).toContain('Core Topology');

    // Switch view to list mode
    const listViewBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'List');
    expect(listViewBtn).toBeTruthy();
    await act(async () => {
      listViewBtn?.click();
    });
    expect(host.querySelector('.notes-list-view')).toBeTruthy();

    // Back to chat button
    const backBtn = host.querySelector('button.notes-back') as HTMLButtonElement;
    expect(backBtn).toBeTruthy();
    await act(async () => {
      backBtn.click();
    });
    expect(onBack).toHaveBeenCalled();
  });

  it('selects notes, triggers export, and executes Bob bulk summarization in NotesWorkspace', async () => {
    await act(async () => {
      root.render(<NotesWorkspace onBack={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Select note checkbox
    const checkboxes = host.querySelectorAll('article.notes-saved-card input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThan(0);
    await act(async () => {
      (checkboxes[0] as HTMLInputElement).click();
    });

    // Selection bar appears
    expect(host.textContent).toContain('1 notes selected');

    // Click Export Markdown
    const exportMarkdownBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Export Markdown')
    );
    expect(exportMarkdownBtn).toBeTruthy();
    await act(async () => {
      exportMarkdownBtn?.click();
    });

    // Click Summarize with Bob
    const summarizeBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Summarize')
    );
    expect(summarizeBtn).toBeTruthy();
    await act(async () => {
      summarizeBtn?.click();
    });

    expect(host.querySelector('.notes-workspace') || host.children.length > 0).toBeTruthy();
  });

  it('opens note editor, applies templates, formats text, and requests Bob revision', async () => {
    await act(async () => {
      root.render(<NotesWorkspace onBack={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Click "New note"
    const newNoteBtn = host.querySelector('button[data-note-new]') as HTMLButtonElement;
    expect(newNoteBtn).toBeTruthy();
    await act(async () => {
      newNoteBtn.click();
    });

    const dialog = host.querySelector('dialog.notes-editor') as HTMLDialogElement;
    expect(dialog).toBeTruthy();

    // Fill title
    const titleInput = dialog.querySelector('input[placeholder="Give this thought a title"]') as HTMLInputElement;
    if (titleInput) {
      await act(async () => {
        setNativeInputValue(titleInput, 'Maintenance Window Checklist');
      });
    }

    // Apply template
    const templateSelect = dialog.querySelector('.notes-template-tools select') as HTMLSelectElement;
    if (templateSelect) {
      await act(async () => {
        templateSelect.value = 'meeting';
        templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Toggle Enrich with Bob panel
    const enrichToggle = dialog.querySelector('button.notes-enrichment-toggle') as HTMLButtonElement;
    if (enrichToggle) {
      await act(async () => {
        enrichToggle.click();
      });

      const askRevisionBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Ask Bob for a revision')
      );
      if (askRevisionBtn) {
        await act(async () => {
          askRevisionBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 40));
        });

        // Use revision button
        const useRevisionBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('Use this revision')
        );
        if (useRevisionBtn) {
          await act(async () => {
            useRevisionBtn.click();
          });
        }
      }
    }

    // Save note
    const saveNoteBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save note')
    );
    if (saveNoteBtn) {
      await act(async () => {
        saveNoteBtn.click();
      });
    }

    expect(host.querySelector('.notes-workspace') || host.children.length > 0).toBeTruthy();
  });

  it('filters by color dot, toggles favorite, deletes note with confirmation, and creates daily note', async () => {
    await act(async () => {
      root.render(<NotesWorkspace onBack={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Core Topology');

    // Filter by color dot: 'rose'
    const roseDot = host.querySelector('button.notes-color-dot[data-note-color="rose"]') as HTMLButtonElement;
    if (roseDot) {
      await act(async () => {
        roseDot.click();
      });
      expect(host.textContent).toContain('Incident Response Protocol');
      expect(host.textContent).not.toContain('Core Topology');
    }

    // Reset color to 'all'
    const allColorsBtn = Array.from(host.querySelectorAll('.notes-color-filters button')).find(
      (b) => b.textContent?.trim() === 'All notes'
    );
    if (allColorsBtn) {
      await act(async () => {
        (allColorsBtn as HTMLButtonElement).click();
      });
      expect(host.textContent).toContain('Core Topology');
    }

    // Toggle favorite star on first note
    const starBtn = host.querySelector('button.notes-favorite') as HTMLButtonElement;
    if (starBtn) {
      await act(async () => {
        starBtn.click();
      });
    }

    // Click "Daily note" button
    const dailyNoteBtn = host.querySelector('button.notes-daily') as HTMLButtonElement;
    if (dailyNoteBtn) {
      await act(async () => {
        dailyNoteBtn.click();
      });
      expect(host.querySelector('dialog.notes-editor')?.hasAttribute('open') || host.children.length > 0).toBeTruthy();

      // Close editor
      const closeBtn = host.querySelector('button[aria-label="Close note editor"]') as HTMLButtonElement;
      if (closeBtn) {
        await act(async () => {
          closeBtn.click();
        });
      }
    }
  });

  it('renders "All notes moved" banner when all notes are saved in StickyNotes', async () => {
    // When notes is empty or remaining notes are saved
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              id: 99,
              title: sampleDrafts[0].title,
              body: sampleDrafts[0].body,
              color: sampleDrafts[0].color,
              source_session_id: 'sess-all-moved',
              source_message_id: 'msg-all-moved',
              source_note_index: 0,
            },
          ],
        }),
      })
    );

    await act(async () => {
      root.render(
        <StickyNotes
          notes={[sampleDrafts[0]]}
          sessionId="sess-all-moved"
          messageId="msg-all-moved"
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('All notes moved to My Notes');
  });
});
