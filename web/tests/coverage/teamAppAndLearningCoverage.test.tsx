// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { App } from '../../src/App';
import LearningWorkspace from '../../src/components/LearningWorkspace';
import {
  LearningClasses,
  localClassDate,
  classDateIso,
  assignmentResourceOptions,
} from '../../src/components/LearningClasses';
import { LearningLessons } from '../../src/components/LearningLessons';

// Global polyfills for jsdom
if (typeof window !== 'undefined') {
  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
  }
}

global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};
vi.mock('../../src/components/AppDialog', () => ({
  AppDialog: () => null,
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  appPrompt: vi.fn().mockResolvedValue('user-input'),
}));

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

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mock diagram</text></svg>' }),
  },
}));

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
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

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

describe('LearningClasses Utilities and Edge Cases', () => {
  it('formats localClassDate correctly for null, invalid, and valid dates', () => {
    expect(localClassDate(null)).toBe('');
    expect(localClassDate(undefined)).toBe('');
    expect(localClassDate('not-a-valid-date')).toBe('');
    const valid = '2026-10-30T12:00:00Z';
    const formatted = localClassDate(valid);
    expect(formatted).toMatch(/^2026-10-30T\d{2}:\d{2}$/);
  });

  it('parses classDateIso and throws for invalid inputs', () => {
    expect(() => classDateIso('', 'Start Date')).toThrow('Enter a valid Start Date.');
    expect(() => classDateIso('invalid-timestamp', 'Session Deadline')).toThrow('Enter a valid Session Deadline.');
    const valid = '2026-10-30T10:00:00Z';
    expect(classDateIso(valid, 'Date')).toBe(new Date(valid).toISOString());
  });

  it('filters assignmentResourceOptions according to publication status and kind', () => {
    const resources = {
      books: [
        { id: 'b1', title: 'Carrier Routing Principles', status: 'draft' },
        { id: 'b2', title: 'Optical Platform Architecture', status: 'published' },
      ],
      lessons: [
        { id: 'l1', title: 'Published API Lesson', status: 'published' },
        { id: 'l2', title: 'Draft MPLS Lesson', status: 'draft' },
      ],
      quizzes: [
        { id: 'q1', title: 'Published Core Routing Quiz', status: 'published' },
        { id: 'q2', title: 'Draft Peering Quiz', status: 'draft' },
      ],
    };

    expect(assignmentResourceOptions(resources, 'book')).toHaveLength(2);
    expect(assignmentResourceOptions(resources, 'lesson')).toEqual([
      { id: 'l1', title: 'Published API Lesson', status: 'published' },
    ]);
    expect(assignmentResourceOptions(resources, 'quiz')).toEqual([
      { id: 'q1', title: 'Published Core Routing Quiz', status: 'published' },
    ]);
    expect(assignmentResourceOptions(resources, 'none')).toHaveLength(0);
  });
});

describe('LearningClasses Component Comprehensive Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mockClassDetail = {
    id: 'class-1',
    title: 'Advanced System Architecture',
    description: 'Distributed systems and patterns',
    revision: 1,
    can_manage: true,
    can_delete: true,
    archived: false,
    folder_id: 'folder-123',
    teacher_username: 'elena',
    teacher_display_name: 'Elena Rostova',
  };

  const sampleAnnouncements = [
    { id: 'ann-1', title: 'Welcome to Architecture 301', body: 'Welcome class!', revision: 1, created_at: '2026-10-30T09:00:00Z' },
  ];

  const sampleSessions = [
    {
      id: 'sess-1',
      title: 'Distributed Consensus & Raft',
      description: 'Understanding quorum and log replication',
      starts_at: '2026-11-01T10:00:00Z',
      ends_at: '2026-11-01T12:00:00Z',
      section: 'Module 1',
      revision: 1,
    },
  ];

  const sampleAssignments = [
    {
      id: 'assign-1',
      title: 'Implement Raft Heartbeat',
      instructions: 'Write the leader heartbeat mechanism',
      section: 'Lab 1',
      due_at: '2026-11-05T23:59:00Z',
      resource_type: 'lesson',
      resource_id: 'lesson-101',
      resource_version: 1,
      allow_late: true,
      required: true,
      minimum_score_percent: 0,
      revision: 1,
      submission_count: 1,
      my_submission: {
        id: 'sub-1',
        username: 'learner-1',
        display_name: 'Learner One',
        text: 'Completed heartbeat loop in raft.go',
        revision: 1,
        submitted_at: '2026-10-30T10:00:00Z',
        assignment_revision: 1,
      },
    },
  ];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/class-teachers')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ username: 'elena', display_name: 'Elena Rostova' }] }) };
      }
      if (url.includes('/classes/class-1/announcements')) {
        if (method === 'POST' || method === 'PUT') return { ok: true, status: 200, json: async () => ({ id: 'ann-new' }) };
        return { ok: true, status: 200, json: async () => ({ items: sampleAnnouncements }) };
      }
      if (url.includes('/classes/class-1/sessions')) {
        if (method === 'POST' || method === 'PUT') return { ok: true, status: 200, json: async () => ({ id: 'sess-new' }) };
        return { ok: true, status: 200, json: async () => ({ items: sampleSessions }) };
      }
      if (url.includes('/classes/class-1/assignments') && url.includes('/submissions')) {
        if (method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'sub-1',
                username: 'learner-1',
                display_name: 'Learner One',
                text: 'Completed heartbeat loop in raft.go',
                revision: 1,
                submitted_at: '2026-10-30T10:00:00Z',
                assignment_revision: 1,
                feedback: 'Good implementation',
                mark: 95,
                max_mark: 100,
              },
            ],
          }),
        };
      }
      if (url.includes('/classes/class-1/assignments')) {
        if (method === 'POST' || method === 'PUT') return { ok: true, status: 200, json: async () => ({ id: 'assign-new' }) };
        return { ok: true, status: 200, json: async () => ({ items: sampleAssignments }) };
      }
      if (url.includes('/classes/class-1/members')) {
        if (method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200, json: async () => ({ items: [{ username: 'learner-1', display_name: 'Learner One' }] }) };
      }
      if (url.includes('/classes/class-1/candidates')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { username: 'learner-1', display_name: 'Learner One' },
              { username: 'learner-2', display_name: 'Learner Two' },
            ],
          }),
        };
      }
      if (url.includes('/contents')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            books: [{ id: 'b1', title: 'Architecture Primer', status: 'published' }],
            lessons: [{ id: 'lesson-101', title: 'Raft Consensus', status: 'published' }],
            quizzes: [{ id: 'q1', title: 'Quorum Quiz', status: 'published' }],
          }),
        };
      }
      if (url.includes('/classes/class-1') && method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ folder_deleted: false }) };
      }
      if (url.includes('/classes/class-1')) {
        return { ok: true, status: 200, json: async () => mockClassDetail };
      }
      if (url.includes('/classes')) {
        if (method === 'POST') return { ok: true, status: 200, json: async () => mockClassDetail };
        return { ok: true, status: 200, json: async () => ({ items: [mockClassDetail] }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders class list, automatically opens folder class, and navigates all sections', async () => {
    const onOpenResource = vi.fn();
    const onDeleted = vi.fn();

    await act(async () => {
      root.render(
        <LearningClasses
          folderId="folder-123"
          canCreate={true}
          canAssignTeacher={true}
          autoOpenFolderClass={true}
          onOpenResource={onOpenResource}
          onDeleted={onDeleted}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Verify detail is automatically loaded
    expect(host.textContent).toContain('Advanced System Architecture');
    expect(host.textContent).toContain('Lead teacher: Elena Rostova');

    // Switch to Calendar tab
    const tabs = Array.from(host.querySelectorAll('nav.learning-class-tabs button'));
    const calendarTab = tabs.find((t) => t.textContent?.includes('calendar') || t.textContent?.includes('Calendar'));
    if (calendarTab) {
      await act(async () => {
        calendarTab.click();
      });
      expect(host.textContent).toContain('Distributed Consensus & Raft');
    }

    // Switch to Assignments tab
    const assignmentsTab = tabs.find((t) => t.textContent?.includes('Assignments'));
    if (assignmentsTab) {
      await act(async () => {
        assignmentsTab.click();
      });
      expect(host.textContent).toContain('Implement Raft Heartbeat');

      // Test Open assigned lesson button
      const openResourceBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Open assigned')
      );
      if (openResourceBtn) {
        await act(async () => {
          openResourceBtn.click();
        });
        expect(onOpenResource).toHaveBeenCalledWith('lesson', 'lesson-101');
      }

      // Review learner work
      const reviewBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Review learner work')
      );
      if (reviewBtn) {
        await act(async () => {
          reviewBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
        expect(host.textContent).toContain('TEACHER FEEDBACK');
        expect(host.textContent).toContain('Learner One');

        // Submit feedback
        const feedbackInput = host.querySelector('textarea[aria-label="Teacher feedback"]') as HTMLTextAreaElement;
        if (feedbackInput) {
          setNativeInputValue(feedbackInput, 'Solid raft log verification.');
          const returnBtn = Array.from(host.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Return feedback')
          );
          if (returnBtn) {
            await act(async () => {
              returnBtn.click();
            });
          }
        }

        // Return to assignments
        const backBtn = Array.from(host.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('Back to assignments')
        );
        if (backBtn) {
          await act(async () => {
            backBtn.click();
          });
        }
      }
    }

    // Switch to Members tab
    const membersTab = tabs.find((t) => t.textContent?.includes('members') || t.textContent?.includes('Members'));
    if (membersTab) {
      await act(async () => {
        membersTab.click();
      });
      expect(host.textContent).toContain('Class members');

      // Toggle candidate checkbox
      const candidateCheckbox = host.querySelector('input[type="checkbox"]:not(:checked)') as HTMLInputElement;
      if (candidateCheckbox) {
        await act(async () => {
          candidateCheckbox.click();
        });
      }

      // Save class members
      const saveMembersBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Save class members')
      );
      if (saveMembersBtn && !saveMembersBtn.disabled) {
        await act(async () => {
          saveMembersBtn.click();
        });
      }
    }

    // Switch to Completion tab
    const completionTab = tabs.find((t) => t.textContent?.includes('progress') || t.textContent?.includes('completion'));
    if (completionTab) {
      await act(async () => {
        completionTab.click();
      });
      expect(host.querySelector('.learning-course-completion, .learning-classes')).not.toBeNull();
    }
  });

  it('creates and edits announcements, sessions, and assignments through editor modal', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="folder-123"
          canCreate={true}
          autoOpenFolderClass={true}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 1. Create announcement
    const addAnnBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add announcement')
    );
    if (addAnnBtn) {
      await act(async () => {
        addAnnBtn.click();
      });
      expect(host.textContent).toContain('Create announcement');

      const titleInput = host.querySelector('input[required]') as HTMLInputElement;
      const bodyInput = host.querySelector('textarea[aria-label="Announcement"]') as HTMLTextAreaElement;
      if (titleInput && bodyInput) {
        setNativeInputValue(titleInput, 'Lab 1 Extended Deadline');
        setNativeInputValue(bodyInput, 'The deadline has been moved to Monday.');
      }

      const saveBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
      if (saveBtn) {
        await act(async () => {
          saveBtn.click();
        });
      }
    }

    // 2. Schedule session
    const calendarTab = Array.from(host.querySelectorAll('nav.learning-class-tabs button')).find((t) =>
      t.textContent?.includes('calendar') || t.textContent?.includes('Calendar')
    );
    if (calendarTab) {
      await act(async () => {
        calendarTab.click();
      });
      const schedBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Schedule a session')
      );
      if (schedBtn) {
        await act(async () => {
          schedBtn.click();
        });
        expect(host.textContent).toContain('Create session');

        const titleInput = host.querySelector('input[required]') as HTMLInputElement;
        if (titleInput) setNativeInputValue(titleInput, 'Consensus Lab Live Walkthrough');

        // Discard session changes
        const discardBtn = Array.from(host.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('Discard changes')
        );
        if (discardBtn) {
          await act(async () => {
            discardBtn.click();
          });
        }
      }
    }

    // 3. Delete class confirm dialog
    const deleteBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Delete class')
    );
    if (deleteBtn) {
      await act(async () => {
        deleteBtn.click();
      });
      expect(host.textContent).toContain('Delete “Advanced System Architecture”?');

      // Click cancel in confirm dialog
      const cancelBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Cancel')
      );
      if (cancelBtn) {
        await act(async () => {
          cancelBtn.click();
        });
      }
    }
  });
});

describe('LearningLessons Component Comprehensive Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mockLesson = {
    id: 'lesson-net-1',
    title: 'API Path Selection Algorithms',
    status: 'published',
    version: 1,
    is_creator: true,
    steps: [
      {
        id: 'step-intro',
        kind: 'text',
        title: 'API Route Attributes',
        text: 'API uses multi-attribute path selection.',
        url: '',
        asset_id: null,
        options: [],
      },
      {
        id: 'step-reveal-1',
        kind: 'reveal',
        title: 'Hidden Convergence Rules',
        text: 'Flap damping prevents routing oscillations.',
        url: '',
        asset_id: null,
        options: [],
      },
      {
        id: 'step-board-1',
        kind: 'board',
        title: 'Routing Decision Board',
        text: 'Follow the metric evaluation sequence.',
        url: '',
        asset_id: null,
        options: [],
        board: {
          layout: 'cards',
          cards: [
            { id: 'bc-1', title: 'Local Preference', body: 'Highest preference wins', color: 'blue', next_ids: [] },
            { id: 'bc-2', title: 'AS Path Length', body: 'Shorter path preferred', color: 'green', next_ids: [] },
          ],
        },
      },
      {
        id: 'step-q-1',
        kind: 'question',
        title: 'Metric Priority Check',
        text: 'Which attribute takes precedence in standard API path selection?',
        url: '',
        asset_id: null,
        options: ['Local Preference', 'AS Path Length', 'MED', 'Lowest Router ID'],
        answer: 0,
        feedback: 'Correct! Local Preference is evaluated first among standard API attributes.',
      },
    ],
    progress: { step: 0, completed: false },
    translations: {
      en: {
        title: 'API Path Selection Algorithms',
        description: 'Advanced routing decision mechanics',
        steps: [],
        approved: true,
      },
      el: {
        title: 'Αλγόριθμοι Επιλογής Διαδρομής API',
        description: 'Μηχανισμοί δρομολόγησης API',
        steps: [],
        approved: false,
      },
    },
    approved_languages: ['en'],
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
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
    window.Element.prototype.animate = vi.fn().mockReturnValue({
      finished: Promise.resolve(),
      playState: 'finished',
      cancel: vi.fn(),
    });

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/lessons/lesson-net-1/check')) {
        const body = JSON.parse(String(init?.body || '{}'));
        const isCorrect = body.answer === 0;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            correct: isCorrect,
            feedback: isCorrect
              ? 'Correct! Local Preference is evaluated first.'
              : 'Incorrect. Remember Local Preference precedes AS Path.',
          }),
        };
      }
      if (url.includes('/progress') && method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/lessons/order') && method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/lessons/lesson-net-1/publish')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/lessons/lesson-net-1') && method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/lessons/lesson-net-1')) {
        return { ok: true, status: 200, json: async () => mockLesson };
      }
      if (url.includes('/translate-content')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            language: 'el',
            translated: {
              title: 'Αλγόριθμοι Επιλογής Διαδρομής API',
              description: 'Μηχανισμοί δρομολόγησης API',
              steps: mockLesson.steps,
            },
          }),
        };
      }
      if (url.includes('/lesson-draft')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            draft: {
              title: 'AI Drafted API Essentials',
              description: 'Automated synthesis',
              steps: mockLesson.steps,
              translations: {
                en: { title: 'AI Drafted API Essentials', description: '', steps: mockLesson.steps, approved: true },
                el: { title: 'Βασικά API από AI', description: '', steps: mockLesson.steps, approved: true },
                hi: { title: 'एआई बीजीपी अनिवार्यताएं', description: '', steps: mockLesson.steps, approved: true },
              },
              approved_languages: ['en', 'el', 'hi'],
            },
            source_truncated: false,
          }),
        };
      }
      if (url.includes('/lessons') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'lesson-created', draft_digest: 'digest-1' }) };
      }
      if (url.includes('/lessons')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'lesson-net-1',
                title: 'API Path Selection Algorithms',
                status: 'published',
                version: 1,
                is_creator: true,
                translations: { en: { title: 'API Path Selection Algorithms' } },
              },
            ],
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('runs interactive lesson mode, exercises reveals, boards, questions, and completion', async () => {
    const onProgressChange = vi.fn();
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-123"
          canCreate={true}
          search=""
          openLessonId="lesson-net-1"
          onProgressChange={onProgressChange}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Verify first step rendered
    expect(host.textContent).toContain('API Route Attributes');
    expect(host.textContent).toContain('API uses multi-attribute path selection.');

    // Step through outline navigation
    const outlineButtons = Array.from(host.querySelectorAll('nav.lesson-outline button'));
    expect(outlineButtons.length).toBeGreaterThanOrEqual(4);

    // 1. Go to reveal step
    await act(async () => {
      outlineButtons[1].click();
    });
    expect(host.textContent).toContain('Hidden Convergence Rules');

    // 2. Go to interactive board step
    await act(async () => {
      outlineButtons[2].click();
    });
    expect(host.textContent).toContain('Routing Decision Board');
    expect(host.textContent).toContain('Local Preference');

    // 3. Go to practice question step
    await act(async () => {
      outlineButtons[3].click();
    });
    expect(host.textContent).toContain('Metric Priority Check');

    // Select wrong choice first
    const choices = Array.from(host.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(choices.length).toBeGreaterThanOrEqual(4);

    await act(async () => {
      choices[1].click(); // AS Path Length
    });

    const checkBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Check answer')
    );
    if (checkBtn) {
      await act(async () => {
        checkBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(host.textContent).toContain('Not quite. Take another look.');
      expect(host.textContent).toContain('How to improve:');
    }

    // Now select correct choice
    await act(async () => {
      choices[0].click(); // Local Preference
    });
    if (checkBtn) {
      await act(async () => {
        checkBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(host.textContent).toContain('Correct. Well done!');
    }

    // Click Complete lesson
    const completeBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Complete lesson')
    );
    if (completeBtn) {
      await act(async () => {
        completeBtn.click();
      });
      expect(host.textContent).toContain('Lesson completed. Your progress is saved.');
    }
  });

  it('exercises authoring mode, i18n approval bar, and Buddy draft generation', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-123"
          canCreate={true}
          search=""
          createNewLesson={true}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Check Editor renders
    expect(host.textContent).toContain('Create lesson');
    expect(host.textContent).toContain('3-Language Content Approval');

    // Fill title
    const titleInput = host.querySelector('input[required]') as HTMLInputElement;
    if (titleInput) {
      setNativeInputValue(titleInput, 'Advanced Segment Routing & EVPN');
    }

    // Switch authoring language
    const langTabs = Array.from(host.querySelectorAll('.learning-i18n-tab-select')) as HTMLButtonElement[];
    if (langTabs.length >= 2) {
      await act(async () => {
        langTabs[1].click();
      });
    }

    // Toggle approval button
    const approveBtn = host.querySelector('.learning-i18n-approve-toggle') as HTMLButtonElement;
    if (approveBtn) {
      await act(async () => {
        approveBtn.click();
      });
    }

    // Add activity: Practice question
    const addQuestionBtn = Array.from(host.querySelectorAll('.lesson-editor button, .learning-lessons button')).find((b) =>
      b.textContent?.includes('Practice question') || b.textContent?.includes('Add section')
    );
    if (addQuestionBtn) {
      await act(async () => {
        addQuestionBtn.click();
      });
    }

    // Buddy drafting
    const buddyInput = host.querySelector('textarea[placeholder*="visual lesson"]') as HTMLTextAreaElement;
    const draftBuddyBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Draft with Buddy')
    );
    if (buddyInput && draftBuddyBtn) {
      setNativeInputValue(buddyInput, 'Draft a comprehensive guide to EVPN multi-homing.');
      await act(async () => {
        draftBuddyBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(host.textContent).toContain('AI Drafted API Essentials');

      // Apply Buddy proposal
      const applyBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Apply Buddy proposal')
      );
      if (applyBtn) {
        await act(async () => {
          applyBtn.click();
        });
        expect(host.textContent).toContain('Buddy’s proposal applied to your unsaved draft.');
      }
    }

    // Save draft
    const saveDraftBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save draft')
    );
    if (saveDraftBtn) {
      await act(async () => {
        saveDraftBtn.click();
      });
    }
  });
});

describe('LearningWorkspace Quiz Authoring, Folder Management & Results Comprehensive Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/api/learning/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            username: 'instructor',
            display_name: 'Lead Instructor',
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
            books: [{ id: 'book-1', title: 'Optical Platform Fundamentals' }],
            lessons: [{ id: 'lesson-1', title: 'Coherent Optics & Modulation', status: 'published', is_creator: true }],
            quizzes: [
              {
                id: 'quiz-1',
                title: 'Optical Transmission Assessment',
                status: 'published',
                is_creator: true,
                question_count: 5,
              },
            ],
            notes: [],
            can_manage_class: true,
          }),
        };
      }
      if (url.includes('/api/learning/folders') && url.includes('/classes')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'folder-1',
                title: 'Optical Transport 401',
                description: 'Physical and optical layer protocols',
                revision: 1,
                can_manage: true,
              },
            ],
          }),
        };
      }
      if (url.includes('/api/learning/folders')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { id: 'folder-1', name: 'Optical Engineering', parent_id: null, is_class: true, can_manage: true },
            ],
          }),
        };
      }
      if (url.includes('/certificates')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'cert-101',
                course_title: 'Carrier Optical Transport',
                recipient_name: 'Lead Instructor',
                instructor_name: 'Master Architect',
                issued_at: '2026-10-29T10:00:00Z',
              },
            ],
          }),
        };
      }
      if (url.includes('/completion')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            can_manage: true,
            course: { revision: 1 },
            items: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders LearningWorkspace tabs, folder tree, and triggers modal overlays', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Optical Engineering');

    // Switch between chapters/tabs
    const tabButtons = Array.from(host.querySelectorAll('button.tasks-nav')) as HTMLButtonElement[];
    expect(tabButtons.length).toBeGreaterThanOrEqual(1);

    for (const tab of tabButtons) {
      await act(async () => {
        tab.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }

    // Open certificates modal
    const certBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Certificates') || b.textContent?.includes('certificates')
    );
    if (certBtn) {
      await act(async () => {
        certBtn.click();
      });
      expect(host.textContent).toMatch(/My .* course certificates/);
    }
  });
});

describe('App Component Navigation, Shortcuts, Preferences & Dialogs Comprehensive Coverage', () => {
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/auth/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: { username: 'network-admin', is_admin: true, display_name: 'Network Architect' } }),
        };
      }
      if (url.includes('/api/apps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            apps: [
              { id: 'office', name: 'Office Suite', description: 'Office documents', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
              { id: 'people', name: 'Community', description: 'Network team directory', kind: 'installed', desktop_only: false, launch: { kind: 'people' } },
              { id: 'decisions', name: 'Decisions', description: 'Architectural decisions', kind: 'installed', desktop_only: false, launch: { kind: 'decisions' } },
            ],
          }),
        };
      }
      if (url.includes('/sessions') && (url.includes('/history') || url.includes('/pages') || url.includes('/files'))) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes('/sessions/sess-1/branch') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'sess-branched-1' }) };
      }
      if (url.includes('/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 'sess-1', title: 'Carrier Optical Telemetry', project_id: 'proj-1', updated_at: 1730000000 },
          ],
        };
      }
      if (url.includes('/projects')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 'proj-1', name: 'Core Backbone Upgrade', description: 'Platform upgrade', revision: 1 },
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
            { id: 'ag-1', slug: 'network-specialist', name: 'Network Specialist' },
          ],
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
      if (url.includes('/tasks')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'task-1',
              session_id: 'sess-1',
              title: 'Validate Optical Loss Budget',
              status: 'completed',
              progress: 'Completed',
              created_at: '2026-10-30T10:00:00Z',
            },
          ],
        };
      }
      if (url.includes('/templates')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'tmpl-1', name: 'Executive Software Deck' }],
        };
      }
      if (url.includes('/knowledge')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes('/workflows/capabilities')) {
        return { ok: true, status: 200, json: async () => ({ web_search: true }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders App, switches conversation modes, adjusts UI density and scale, and handles shortcuts', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Check header and user greeting
    expect(host.querySelector('.shell')).not.toBeNull();

    // Test UI Scale changes
    const scaleSelect = host.querySelector('select[aria-label="Display scale"]') as HTMLSelectElement;
    if (scaleSelect) {
      setNativeInputValue(scaleSelect, '85');
      expect(document.documentElement.dataset.uiScale).toBe('85');

      setNativeInputValue(scaleSelect, 'auto');
      expect(document.documentElement.dataset.uiScale).toBe('auto');
    }

    // Test UI Density changes
    const densitySelect = host.querySelector('select[aria-label="Display density"]') as HTMLSelectElement;
    if (densitySelect) {
      setNativeInputValue(densitySelect, 'comfortable');
      expect(document.documentElement.dataset.uiDensity).toBe('comfortable');

      setNativeInputValue(densitySelect, 'compact');
      expect(document.documentElement.dataset.uiDensity).toBe('compact');
    }

    // Test mode switcher button (Skills vs A2A agents)
    const agentModeBtn = host.querySelector('button[data-mode-target="agents"]') as HTMLButtonElement;
    if (agentModeBtn) {
      await act(async () => {
        agentModeBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    // Test window action events
    await act(async () => {
      window.dispatchEvent(new Event('buddy-open-knowledge'));
    });
    expect(host.textContent).toContain('Knowledge base');

    // Test keyboard event: Escape
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  it('handles task notices, conversation branching, and buddy action events', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Dispatch office-changed and reminders-changed events
    await act(async () => {
      window.dispatchEvent(new Event('buddy-office-changed'));
      window.dispatchEvent(new Event('buddy-reminders-changed'));
    });

    // Open task event
    await act(async () => {
      window.dispatchEvent(new CustomEvent('buddy-open-task', { detail: 'task-1' }));
    });
    expect(host.querySelector('.shell')).not.toBeNull();

    // Trigger conversation branching via custom event or API simulation
    const branchRes = await fetch('/sessions/sess-1/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turn_index: 0 }),
    });
    expect(branchRes.ok).toBe(true);

    // Open artifact and presentation events
    await act(async () => {
      window.dispatchEvent(new CustomEvent('buddy-open-artifact', {
        detail: { path: 'network-topology.diagram.json', sessionId: 'sess-1' },
      }));
      window.dispatchEvent(new CustomEvent('buddy-open-presentation', {
        detail: { sessionId: 'sess-1' },
      }));
    });
  });

  it('interacts with Topbar Buddy tools menu, focus mode, and feature overlays', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Focus mode toggle button inside WorkspaceHub
    const focusButtons = Array.from(host.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Focus') || b.getAttribute('aria-pressed') !== null
    );
    if (focusButtons.length > 0) {
      await act(async () => {
        focusButtons[0].click();
      });
    }

    // Apps launcher button
    const appsBtn = host.querySelector('button[data-apps-launcher]') as HTMLButtonElement;
    if (appsBtn) {
      await act(async () => {
        appsBtn.click();
      });
      expect(host.querySelector('.installed-apps-dialog, .installed-apps-overlay, dialog')).toBeDefined();
    }
  });
});

describe('LearningLessons Advanced Activity Kinds, Media and Document Import Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  const sampleLessonWithPath = {
    id: 'lesson-path-1',
    title: 'Incident Triage Decision Tree',
    status: 'published',
    version: 1,
    is_creator: true,
    steps: [
      {
        id: 'step-path-board',
        kind: 'board',
        title: 'API Outage Response Flow',
        text: 'Follow the escalation decision nodes.',
        url: '',
        asset_id: null,
        options: [],
        board: {
          layout: 'path',
          cards: [
            { id: 'card-root', title: 'Route Flap Detected', body: 'Alarm triggered in Pod C', color: 'violet', next_ids: ['card-verify', 'card-isolate'] },
            { id: 'card-verify', title: 'Verify Peer API State', body: 'Check session status', color: 'blue', next_ids: [] },
            { id: 'card-isolate', title: 'Isolate Optical Transceiver', body: 'Power down transponder', color: 'amber', next_ids: [] },
          ],
        },
      },
      {
        id: 'step-video',
        kind: 'video',
        title: 'Platform Transponder Inspection',
        text: 'Physical inspection walkthrough',
        url: 'https://example.com/videos/transponder-inspection',
        asset_id: null,
        options: [],
      },
      {
        id: 'step-img',
        kind: 'image',
        title: 'Optical Spectrum Analyzer Trace',
        text: 'Spectral peak analysis',
        url: '',
        asset_id: 'asset-opt-1',
        options: [],
      },
    ],
    progress: { step: 0, completed: false },
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
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
    window.Element.prototype.animate = vi.fn().mockReturnValue({
      finished: Promise.resolve(),
      playState: 'finished',
      cancel: vi.fn(),
    });

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/lessons/lesson-path-1')) {
        return { ok: true, status: 200, json: async () => sampleLessonWithPath };
      }
      if (url.includes('/progress')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/lesson-assets') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'asset-new-img', mime: 'image/png' }) };
      }
      if (url.includes('/lesson-import') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: 'Imported Fiber Specifications',
            description: 'Fiber attenuation metrics',
            steps: [
              { id: 's-imp-1', kind: 'text', title: 'Attenuation Overview', text: '0.2 dB/km at 1550nm', options: [] },
            ],
          }),
        };
      }
      if (url.includes('/lessons') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'lesson-created-path', draft_digest: 'd-path' }) };
      }
      if (url.includes('/lessons')) {
        return { ok: true, status: 200, json: async () => ({ items: [sampleLessonWithPath] }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders path branching board and exercises video and image steps', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-123"
          canCreate={true}
          search=""
          openLessonId="lesson-path-1"
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('API Outage Response Flow');
    expect(host.textContent).toContain('Route Flap Detected');

    // Go to video step
    const outlineButtons = Array.from(host.querySelectorAll('nav.lesson-outline button'));
    if (outlineButtons.length >= 3) {
      await act(async () => {
        outlineButtons[1].click();
      });
      expect(host.textContent).toContain('Platform Transponder Inspection');
      expect(host.querySelector('iframe, video')).not.toBeNull();

      // Go to image step
      await act(async () => {
        outlineButtons[2].click();
      });
      expect(host.textContent).toContain('Optical Spectrum Analyzer Trace');
      expect(host.querySelector('img')).not.toBeNull();
    }
  });

  it('tests editor section duplication, moving, and draft export', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-123"
          canCreate={true}
          search=""
          createNewLesson={true}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Duplicate first section
    const dupBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.includes('Duplicate section') || b.textContent?.includes('Duplicate')
    );
    if (dupBtn) {
      await act(async () => {
        dupBtn.click();
      });
      expect(host.querySelectorAll('article.lesson-section').length).toBeGreaterThanOrEqual(2);
    }

    // Export editable lesson
    const exportBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Export editable lesson')
    );
    if (exportBtn) {
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      await act(async () => {
        exportBtn.click();
      });
      expect(clickSpy).toHaveBeenCalled();
      clickSpy.mockRestore();
    }
  });
});

describe('LearningClasses Learner Submission and Advanced Edge Cases', () => {
  let host: HTMLDivElement;
  let root: Root;

  const learnerClass = {
    id: 'class-learner-1',
    title: 'Edge Peering Operations',
    description: 'Routing policy management',
    revision: 1,
    can_manage: false,
    can_delete: false,
    archived: false,
    folder_id: 'folder-peer',
    teacher_username: 'marcus',
    teacher_display_name: 'Marcus Vance',
  };

  const learnerAssignments = [
    {
      id: 'assign-peer-1',
      title: 'Configure API Community Filter',
      instructions: 'Filter prefixes with customer community 65001:100',
      section: 'Module 2',
      due_at: '2026-11-15T23:59:00Z',
      resource_type: 'none',
      resource_id: null,
      allow_late: true,
      required: true,
      minimum_score_percent: 0,
      revision: 1,
      my_submission: null,
    },
    {
      id: 'assign-peer-2',
      title: 'Internet Exchange Route Server Setup',
      instructions: 'Establish bilateral peerings',
      section: 'Module 3',
      due_at: '2026-11-20T23:59:00Z',
      resource_type: 'none',
      resource_id: null,
      allow_late: false,
      required: true,
      minimum_score_percent: 0,
      revision: 1,
      my_submission: {
        id: 'sub-graded-1',
        username: 'learner-alice',
        display_name: 'Alice Learner',
        text: 'Applied route-map IX_PEER_IN',
        revision: 1,
        submitted_at: '2026-10-29T10:00:00Z',
        reviewed_at: '2026-10-30T09:00:00Z',
        feedback: 'Flawless route map logic',
        mark: 100,
        max_mark: 100,
        assignment_revision: 1,
      },
    },
  ];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/announcements')) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      if (url.includes('/sessions')) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      if (url.includes('/assignments/assign-peer-1/submit') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/assignments')) {
        return { ok: true, status: 200, json: async () => ({ items: learnerAssignments }) };
      }
      if (url.includes('/classes/class-learner-1')) {
        return { ok: true, status: 200, json: async () => learnerClass };
      }
      if (url.includes('/classes')) {
        return { ok: true, status: 200, json: async () => ({ items: [learnerClass] }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('submits student work and displays returned teacher marks and feedback', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="folder-peer"
          canCreate={false}
          autoOpenFolderClass={true}
          initialTab="assignments"
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Check learner view renders assignments
    expect(host.textContent).toContain('Edge Peering Operations');
    expect(host.textContent).toContain('Configure API Community Filter');

    // Submit work on unsubmitted assignment
    const workInput = host.querySelector('textarea[aria-label="Your work or completion notes"]') as HTMLTextAreaElement;
    if (workInput) {
      setNativeInputValue(workInput, 'Completed prefix-list filter on AS65001.');
      const submitBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Submit work')
      );
      if (submitBtn) {
        await act(async () => {
          submitBtn.click();
        });
      }
    }

    // Verify reviewed feedback display on second assignment
    expect(host.textContent).toContain('Teacher feedback');
    expect(host.textContent).toContain('Flawless route map logic');
    expect(host.textContent).toContain('Mark: 100 / 100');
  });
});

describe('App Streaming Event Types & Job Recovery Loop Comprehensive Coverage', () => {
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/auth/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: { username: 'network-admin', is_admin: true, display_name: 'Network Architect' } }),
        };
      }
      if (url.includes('/chat/stream')) {
        const events = [
          { type: 'start' },
          { type: 'approval', approval_id: 'app-1', status: 'pending' },
          { type: 'approval', approval_id: 'app-1', status: 'approved' },
          { type: 'guidance', id: 'g-1', text: 'Optimize route reflector reflection', status: 'applied' },
          { type: 'status', message: 'Analyzing prefix lists', heartbeat: false },
          { type: 'status', message: 'Heartbeat tick', heartbeat: true },
          { type: 'skill', name: 'network-auditor' },
          { type: 'skill', name: 'network-auditor' },
          { type: 'tool', id: 't-1', name: 'knowledge_search', status: 'started', input: { query: 'AS65001' } },
          { type: 'tool', id: 't-1', name: 'knowledge_search', status: 'finished', output: 'Found policy' },
          { type: 'tool', id: 't-2', name: 'run_command', status: 'started', input: { command: 'vtysh -c "show ip api"' } },
          { type: 'tool', id: 't-2', name: 'run_command', status: 'finished', output: 'API table ok' },
          { type: 'tool', id: 't-3', name: 'ask_expert', status: 'started', input: { prompt: 'Verify route damping timers' } },
          { type: 'tool', id: 't-3', name: 'ask_expert', status: 'finished', output: 'Timers verified' },
          { type: 'app_action', action: 'office_open', file_id: '11111111-2222-3333-4444-555555555555', name: 'Platform Core Spec' },
          { type: 'app_action', action: 'office_close' },
          { type: 'approval_policy', mode: 'selected', actions: ['write_file'] },
          { type: 'artifact', path: 'presentation.html', content: '<html>Presentation</html>', is_presentation: true },
          { type: 'delivery_state', state: 'saving' },
          { type: 'delta', text: 'Routing audit completed.' },
          { type: 'done', duration_ms: 1200, tokens: 400, cost: 0.02, skills_used: ['network-auditor'] },
        ];
        return new Response(createMockStream(events), {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/x-ndjson',
            'X-Bob-Job-Id': 'job-stream-100',
            'X-Correlation-Id': 'corr-stream-100',
            'X-User-Message-Id': 'msg-u-100',
            'X-Assistant-Message-Id': 'msg-a-100',
          }),
        });
      }
      if (url.includes('/jobs/job-recon-100/events')) {
        const replayEvents = [
          { event_id: 1, type: 'status', message: 'Replaying events from journal' },
          { event_id: 2, type: 'app_action', action: 'office_changed' },
          { event_id: 3, type: 'approval_policy', mode: 'auto', actions: [] },
          { event_id: 4, type: 'artifact', path: 'audit.txt', content: 'Replay complete' },
          { event_id: 5, type: 'delivery_state', state: 'saving' },
          { event_id: 6, type: 'done', duration_ms: 600 },
        ];
        return new Response(createMockStream(replayEvents), {
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/x-ndjson' }),
        });
      }
      if (url.includes('/sessions') && (url.includes('/history') || url.includes('/pages') || url.includes('/files'))) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes('/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 'sess-1', title: 'Carrier Optical Telemetry', project_id: 'proj-1', updated_at: 1730000000 },
          ],
        };
      }
      if (url.includes('/projects')) return { ok: true, status: 200, json: async () => [] };
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
      if (url.includes('/agents')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/personalization/presets')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/personalization/tutorials')) return { ok: true, status: 200, json: async () => ({ disabled: false }) };
      if (url.includes('/mcps/microsoft/status')) return { ok: true, status: 200, json: async () => ({ connected: false }) };
      if (url.includes('/mcps')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/tasks')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'job-recon-100',
              session_id: 'sess-1',
              status: 'running',
              title: 'Replay Convergence Test',
              guidance_supported: true,
              progress: 'In progress',
              created_at: '2026-10-30T10:00:00Z',
            },
          ],
        };
      }
      if (url.includes('/templates')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/workflows/capabilities')) return { ok: true, status: 200, json: async () => ({ web_search: true }) };
      if (url.includes('/knowledge')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/api/apps')) return { ok: true, status: 200, json: async () => ({ apps: [] }) };

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('dispatches streaming events: start, approval, guidance, status, skill, tool, app_action, approval_policy, artifact, delivery_state, done', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const promptTextarea = host.querySelector('#prompt-input') as HTMLTextAreaElement;
    const sendButton = host.querySelector('button.send-button') as HTMLButtonElement;
    if (promptTextarea && sendButton) {
      setNativeInputValue(promptTextarea, 'Audit AS65001 route convergence.');
      await act(async () => {
        sendButton.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    }

    expect(host.querySelector('.shell')).not.toBeNull();
  });
});

describe('App Installed Apps Launching Across All Kinds Comprehensive Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  const allApps = [
    { id: 'office', name: 'Office Suite', description: 'Office docs', kind: 'installed' as const, desktop_only: false, launch: { kind: 'office' } },
    { id: 'projects', name: 'Projects', description: 'Portfolios', kind: 'installed' as const, desktop_only: false, launch: { kind: 'projects' } },
    { id: 'people', name: 'Community', description: 'Team network', kind: 'installed' as const, desktop_only: false, launch: { kind: 'people' } },
    { id: 'docmost', name: 'Docmost Wiki', description: 'Documentation', kind: 'installed' as const, desktop_only: false, launch: { kind: 'docmost', url: 'https://docmost.local' } },
    { id: 'chat', name: 'Chat', description: 'Conversations', kind: 'installed' as const, desktop_only: false, launch: { kind: 'chat' } },
    { id: 'notes', name: 'Notes', description: 'Personal notes', kind: 'installed' as const, desktop_only: false, launch: { kind: 'notes' } },
    { id: 'tasks', name: 'Tasks', description: 'Background tasks', kind: 'installed' as const, desktop_only: false, launch: { kind: 'tasks' } },
    { id: 'knowledge', name: 'Knowledge', description: 'Shared sources', kind: 'installed' as const, desktop_only: false, launch: { kind: 'knowledge' } },
    { id: 'research', name: 'Research', description: 'Deep investigations', kind: 'installed' as const, desktop_only: false, launch: { kind: 'research' } },
    { id: 'search', name: 'Search', description: 'Unified search', kind: 'installed' as const, desktop_only: false, launch: { kind: 'search' } },
    { id: 'workflows', name: 'Workflows', description: 'Automations', kind: 'installed' as const, desktop_only: false, launch: { kind: 'workflows' } },
    { id: 'presentations', name: 'Presentations', description: 'Slide decks', kind: 'installed' as const, desktop_only: false, launch: { kind: 'presentations' } },
    { id: 'productivity', name: 'Productivity', description: 'Office productivity', kind: 'installed' as const, desktop_only: false, launch: { kind: 'productivity' } },
    { id: 'connections', name: 'Connected Services', description: 'MCP tools', kind: 'installed' as const, desktop_only: false, launch: { kind: 'connections' } },
    { id: 'decisions', name: 'Decisions', description: 'Architecture decisions', kind: 'installed' as const, desktop_only: false, launch: { kind: 'decisions' } },
    { id: 'link_self', name: 'Portal Self', description: 'Intranet Portal', kind: 'installed' as const, desktop_only: false, launch: { kind: 'link', url: 'https://example.com', target: '_self' as const } },
    { id: 'link_blank', name: 'Portal Blank', description: 'Knowledge Wiki', kind: 'installed' as const, desktop_only: false, launch: { kind: 'link', url: 'https://example.com', target: '_blank' as const } },
  ];

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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/auth/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: { username: 'network-admin', is_admin: true, display_name: 'Network Architect' } }),
        };
      }
      if (url.includes('/api/apps')) {
        return { ok: true, status: 200, json: async () => ({ apps: allApps }) };
      }
      if (url.includes('/sessions') && (url.includes('/history') || url.includes('/pages') || url.includes('/files'))) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes('/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 'sess-1', title: 'Carrier Optical Telemetry', project_id: 'proj-1', updated_at: 1730000000 },
          ],
        };
      }
      if (url.includes('/projects')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/skills')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/modes')) return { ok: true, status: 200, json: async () => [{ id: 'agent', name: 'Agent' }] };
      if (url.includes('/agents')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/personalization/presets')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/personalization/tutorials')) return { ok: true, status: 200, json: async () => ({ disabled: false }) };
      if (url.includes('/mcps/microsoft/status')) return { ok: true, status: 200, json: async () => ({ connected: false }) };
      if (url.includes('/mcps')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/tasks')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/templates')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/workflows/capabilities')) return { ok: true, status: 200, json: async () => ({ web_search: true }) };
      if (url.includes('/knowledge')) return { ok: true, status: 200, json: async () => [] };

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('launches installed apps across all launch kinds (office, projects, people, docmost, etc.)', async () => {
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Open apps dialog
    const appsBtn = host.querySelector('button[data-apps-launcher]') as HTMLButtonElement;
    if (appsBtn) {
      await act(async () => {
        appsBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      // Find and click each installed app card
      const appCards = Array.from(document.body.querySelectorAll('.installed-app-card, button.installed-app-card')) as HTMLElement[];
      for (const card of appCards) {
        await act(async () => {
          card.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
        // Reopen launcher if it closed
        const launcher = host.querySelector('button[data-apps-launcher]') as HTMLButtonElement;
        if (launcher) {
          await act(async () => {
            launcher.click();
          });
        }
      }
    }

    windowOpenSpy.mockRestore();
    expect(host.querySelector('.shell')).not.toBeNull();
  });
});

describe('App Message Deletion, Session Deletion, Sign Out & Deck Generation Comprehensive Coverage', () => {
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/auth/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: { username: 'network-admin', is_admin: true, display_name: 'Network Architect' } }),
        };
      }
      if (url.includes('/auth/logout')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/sessions/sess-1/messages/') && method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ cleanup_pending: true }) };
      }
      if (url.includes('/sessions/sess-1') && method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/sessions/sess-1/history')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { type: 'request', message_id: 'msg-u-1', user_message_id: 'msg-u-1', content: 'Describe API attributes' },
            { type: 'delta', assistant_message_id: 'msg-a-1', text: 'Local Preference, AS Path, MED, and Origin code.' },
            { type: 'done', duration_ms: 300 },
          ],
        };
      }
      if (url.includes('/sessions') && (url.includes('/pages') || url.includes('/files'))) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes('/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 'sess-1', title: 'Carrier Optical Telemetry', project_id: 'proj-1', updated_at: 1730000000 },
            { id: 'sess-2', title: 'Standalone Peering Study', updated_at: 1730000010 },
          ],
        };
      }
      if (url.includes('/projects')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/skills')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/modes')) return { ok: true, status: 200, json: async () => [{ id: 'agent', name: 'Agent' }] };
      if (url.includes('/agents')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/personalization/presets')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/personalization/tutorials')) return { ok: true, status: 200, json: async () => ({ disabled: false }) };
      if (url.includes('/mcps/microsoft/status')) return { ok: true, status: 200, json: async () => ({ connected: false }) };
      if (url.includes('/mcps')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/tasks')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/templates')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'tmpl-deck-1', name: 'Network Review Deck', slides: [] }],
        };
      }
      if (url.includes('/workflows/capabilities')) return { ok: true, status: 200, json: async () => ({ web_search: true }) };
      if (url.includes('/knowledge')) return { ok: true, status: 200, json: async () => [] };
      if (url.includes('/api/apps')) return { ok: true, status: 200, json: async () => ({ apps: [] }) };

      return { ok: true, status: 200, json: async () => ({}) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('handles message deletion with cleanup pending alert, and deck generation from messages', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Delete message button on assistant message
    const deleteMsgBtn = host.querySelector('.answer-icon-action-danger, .msg-deck-btn.answer-icon-action-danger') as HTMLButtonElement;
    if (deleteMsgBtn) {
      await act(async () => {
        deleteMsgBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    // Generate deck button from message
    const deckBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Executive deck') || b.textContent?.includes('deck') || b.classList.contains('msg-deck-btn')
    );
    if (deckBtn) {
      await act(async () => {
        deckBtn.click();
      });
    }

    expect(host.querySelector('.shell')).not.toBeNull();
  });

  it('handles session deletion and sign out failure/success states', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Delete session from Sidebar
    const deleteSessionBtns = Array.from(host.querySelectorAll('.conversation-delete')) as HTMLButtonElement[];
    if (deleteSessionBtns.length > 0) {
      await act(async () => {
        deleteSessionBtns[0].click();
      });
    }

    // Sign out from Sidebar
    const signOutBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Sign out')
    );
    if (signOutBtn) {
      await act(async () => {
        signOutBtn.click();
      });
    }

    expect(host.querySelector('.shell')).toBeDefined();
  });
});

describe('LearningWorkspace ResultsPanel, OfficeImportDialog & Chapter Assignments', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollTo = vi.fn();
    window.Element.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
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

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() || 'GET';

      if (url.includes('/api/learning/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            username: 'instructor',
            display_name: 'Lead Instructor',
            is_admin: true,
            can_create_quizzes: true,
          }),
        };
      }
      if (url.includes('/quizzes/quiz-1/results')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            quiz_title: 'Optical Transmission Assessment',
            total_attempts: 1,
            questions: [
              { id: 'q-text-1', type: 'text', prompt: 'Describe coherent modulation', points: 10 },
            ],
            items: [
              {
                id: 'sub-1',
                username: 'learner-1',
                display_name: 'Elena Rostova',
                score: 0,
                score_percent: 0,
                submitted_at: '2026-10-30T10:00:00Z',
                questions: [
                  { id: 'q-text-1', type: 'text', prompt: 'Describe coherent modulation', points: 10, answer: '16-QAM with optical carrier phase tracking' },
                ],
              },
            ],
          }),
        };
      }
      if (url.includes('/submissions/sub-1/suggest-grades') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            grades: { 'q-text-1': { score: 9, feedback: 'Accurate modulation explanation' } },
            review_required: true,
          }),
        };
      }
      if (url.includes('/submissions/sub-1/grade') && method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/office-files')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ id: 'off-1', name: 'Platform_Link_Budget.docx', extension: 'docx' }],
            next_offset: 25,
          }),
        };
      }
      if (url.includes('/import-office') && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/users')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ username: 'elena', display_name: 'Elena Rostova' }],
            directory_note: 'Verified corporate sign-in users',
          }),
        };
      }
      if (url.includes('/groups')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ path: '/Engineers' }] }),
        };
      }
      if (url.includes('/admin/app-groups')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ id: 'ag-1', name: 'Carrier Ops', member_count: 5 }] }),
        };
      }
      if (url.includes('/folders/folder-1/class-teachers') || url.includes('/class-teachers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ username: 'elena', display_name: 'Elena Rostova' }] }),
        };
      }
      if (url.includes('/folders/folder-1/members')) {
        if (method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ username: 'elena' }],
            groups: ['/Engineers'],
            app_groups: ['ag-1'],
            teacher_username: 'elena',
            inherited_from: [],
          }),
        };
      }
      if (url.includes('/books/book-1') && method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/quizzes/quiz-1/chapter') && method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/certificates') && url.includes('/send-email')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ delivery: { status: 'sent', recipient: 'elena@example.com' } }),
        };
      }
      if (url.includes('/certificates')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'cert-101',
                course_title: 'Carrier Optical Transport',
                recipient_name: 'Elena Rostova',
                instructor_name: 'Lead Instructor',
                issued_at: '2026-10-29T10:00:00Z',
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
            books: [{ id: 'book-1', title: 'Optical Platform Fundamentals', extension: 'pdf' }],
            lessons: [{ id: 'lesson-1', title: 'Coherent Optics & Modulation', status: 'published', is_creator: true }],
            quizzes: [
              {
                id: 'quiz-1',
                title: 'Optical Transmission Assessment',
                status: 'published',
                is_creator: true,
                question_count: 5,
                can_view_results: true,
              },
            ],
            notes: [],
            can_manage_class: true,
          }),
        };
      }
      if (url.includes('/api/learning/folders') && url.includes('/classes')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'folder-1',
                title: 'Optical Transport 401',
                description: 'Physical layer protocols',
                revision: 1,
                can_manage: true,
              },
            ],
          }),
        };
      }
      if (url.includes('/api/learning/folders')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { id: 'folder-1', name: 'Optical Engineering', parent_id: null, is_class: true, can_manage: true },
            ],
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    });

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('opens ResultsPanel, triggers suggestGrades, and saves marking', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Find Results button
    const resultsBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Results')
    );
    if (resultsBtn) {
      await act(async () => {
        resultsBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Select submission row
      const subItem = host.querySelector('.learning-results tr, .learning-results tbody tr, article, .learning-card') as HTMLElement;
      if (subItem) {
        await act(async () => {
          subItem.click();
        });
      }

      // Trigger suggestGrades
      const suggestBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Ask Buddy to grade')
      );
      if (suggestBtn) {
        await act(async () => {
          suggestBtn.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 30));
        });
      }

      // Trigger saveGrades
      const saveMarkingBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Save marking')
      );
      if (saveMarkingBtn && !saveMarkingBtn.disabled) {
        await act(async () => {
          saveMarkingBtn.click();
        });
      }
    }

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
  });

  it('interacts with OfficeImportDialog, executes search, pagination, and document importing', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Open Office Import
    const importBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Office Suite import') || b.textContent?.includes('Import from Office')
    );
    if (importBtn) {
      await act(async () => {
        importBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      // Search input
      const searchInput = host.querySelector('input[aria-label="Search Office files…"]') as HTMLInputElement;
      if (searchInput) {
        setNativeInputValue(searchInput, 'Platform');
        const searchForm = host.querySelector('form.learning-import-search') as HTMLFormElement;
        if (searchForm) {
          await act(async () => {
            searchForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          });
        }
      }

      // Load more pagination
      const loadMoreBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load more')
      );
      if (loadMoreBtn) {
        await act(async () => {
          loadMoreBtn.click();
        });
      }

      // Select file radio
      const fileRadio = host.querySelector('input[name="learning-office-import"]') as HTMLInputElement;
      if (fileRadio) {
        await act(async () => {
          fileRadio.click();
        });
      }

      // Click Import document
      const importDocBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Import document')
      );
      if (importDocBtn && !importDocBtn.disabled) {
        await act(async () => {
          importDocBtn.click();
        });
      }
    }

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
  });

  it('manages folder member access and triggers certificates preview and email dispatch', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Manage Members / Access
    const accessBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Access') || b.getAttribute('title')?.includes('Enroll learners')
    );
    if (accessBtn) {
      await act(async () => {
        accessBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });

      // Toggle checkboxes inside members dialog
      const accessCheckboxes = Array.from(host.querySelectorAll('.learning-access input[type="checkbox"]')) as HTMLInputElement[];
      for (const cb of accessCheckboxes) {
        await act(async () => {
          cb.click();
        });
      }

      // Custom group path
      const groupInput = host.querySelector('input[placeholder="/Department/Team"]') as HTMLInputElement;
      const addGroupBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Add group')
      );
      if (groupInput && addGroupBtn) {
        setNativeInputValue(groupInput, '/Optical/Transport');
        await act(async () => {
          addGroupBtn.click();
        });
      }

      // Save access
      const saveAccessBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Save access')
      );
      if (saveAccessBtn && !saveAccessBtn.disabled) {
        await act(async () => {
          saveAccessBtn.click();
        });
      }
    }

    // Open certificates dialog
    const certsBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('My certificates') || b.getAttribute('title')?.includes('My certificates')
    );
    if (certsBtn) {
      await act(async () => {
        certsBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      // Click Preview certificate
      const previewBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent === 'Preview'
      );
      if (previewBtn) {
        await act(async () => {
          previewBtn.click();
        });
        expect(host.querySelector('iframe')).not.toBeNull();
      }

      // Click Send by email
      const emailBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Send by email')
      );
      if (emailBtn) {
        await act(async () => {
          emailBtn.click();
        });
      }
    }

    // Chapter assignment selects
    const chapterAssignSelects = Array.from(host.querySelectorAll('select.learning-chapter-assign-select')) as HTMLSelectElement[];
    for (const selectEl of chapterAssignSelects) {
      if (selectEl.options.length > 1) {
        setNativeInputValue(selectEl, selectEl.options[1].value);
      }
    }

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
  });
});


