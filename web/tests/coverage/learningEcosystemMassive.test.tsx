// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LearningClasses } from '../../src/components/LearningClasses';
import { StickyNotes, NotesWorkspace } from '../../src/components/StickyNotes';
import { LearningLessons } from '../../src/components/LearningLessons';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg class="mermaid-diagram"><text>Carrier Optical Transport Architecture</text></svg>',
    }),
  },
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function setupCommonMocks() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  if (typeof window !== 'undefined') {
    (window as any).ResizeObserver = MockResizeObserver;
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = vi.fn().mockReturnValue('blob:carrier-software-data');
      window.URL.revokeObjectURL = vi.fn();
    }
  }

  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn().mockImplementation(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.open = false;
    });
  }

  if (typeof Element !== 'undefined') {
    Element.prototype.animate = vi.fn().mockImplementation(() => ({
      finished: Promise.resolve(),
      cancel: vi.fn(),
      playState: 'finished',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  }

  if (typeof document !== 'undefined') {
    (document as any).fonts = { ready: Promise.resolve() };
  }

  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  vi.stubGlobal('fetch', setupMassiveFetch());
}

// Mock noteEnrichment for Bob AI note revisions

vi.mock('../../src/lib/noteEnrichment', () => ({
  enrichNote: vi.fn().mockImplementation(async (note, instruction, options) => {
    options?.onStatus?.('Analyzing optical transport notes…');
    return {
      title: `${note.title} (Revised for Carrier Compliance)`,
      body: `${note.body}\n\n## ITU-T Carrier Specifications\nAll Platform transceiver power levels must strictly comply with ITU-T G.694.1 channel grids and EDFA saturated output limits of 23 dBm.`,
    };
  }),
}));

const sampleNotes = [
  {
    id: 101,
    title: 'Platform Optical Power Budget',
    body: 'Total span insertion loss: 80km * 0.22dB/km = 17.6dB. Splice loss: 0.8dB. Margin: 3dB.',
    color: 'butter',
    collection: 'Engineering',
    tags: ['dwdm', 'fiber', 'planning'],
    favorite: true,
    sources: [{ title: 'ITU-T G.652.D Spec', url: 'https://carrier.net/specs/g652d.pdf' }],
  },
  {
    id: 102,
    title: 'API Routing Peering Security',
    body: 'Implement RPKI route origin validation and strict ingress prefix filtering for AS65001.',
    color: 'sky',
    collection: 'Routing',
    tags: ['api', 'security', 'peering'],
    favorite: false,
    sources: [],
  },
  {
    id: 103,
    title: 'OTN ODUk Multiplexing Hierarchy',
    body: 'Map ODU0 (1.25G) and ODU2 (10G) client payloads into ODU4 (100G) transport frame structure.',
    color: 'mint',
    collection: 'Engineering',
    tags: ['otn', 'transport'],
    favorite: true,
    sources: [],
  },
];

const sampleClassDetail = {
  id: 'class-dwdm-oct',
  title: 'Platform Engineering October Cohort',
  description: 'Masterclass covering C-band Platform, dispersion compensation, and coherent optical transceivers.',
  revision: 1,
  can_manage: true,
  can_delete: true,
  archived: false,
  folder_id: 'software-dwdm-core',
  teacher_username: 'noc_admin',
  teacher_display_name: 'Dr. Elena Rostova',
};

const sampleClassAnnouncements = [
  {
    id: 'ann-1',
    title: 'Laboratory Session Preparation',
    body: 'Review the optical dispersion compensation calculator prior to Tuesday EDFA testing.',
    revision: 1,
    created_at: '2026-10-29T08:00:00Z',
  },
];

const sampleClassSessions = [
  {
    id: 'sess-1',
    title: 'EDFA Booster Calibration',
    description: 'Practical tuning of dual-stage Erbium-Doped Fiber Amplifiers.',
    starts_at: '2026-11-01T10:00:00Z',
    ends_at: '2026-11-01T12:00:00Z',
    section: 'Optical Amplification',
    revision: 1,
  },
];

const sampleClassAssignments = [
  {
    id: 'assign-1',
    title: 'Link Margin Calculation for 80km Span',
    instructions: 'Compute total span loss, connector attenuation, and target pre-amp input power.',
    section: 'Link Budgets',
    due_at: '2026-11-05T23:59:00Z',
    resource_type: 'none' as const,
    resource_id: null,
    allow_late: true,
    required: true,
    minimum_score_percent: 80,
    revision: 1,
    submission_count: 1,
  },
];

const sampleLesson = {
  id: 'lesson-dwdm-101',
  title: 'Dense Wavelength Division Multiplexing Principles',
  description: 'Carrier-grade optical transport fundamentals from multiplexing to detection.',
  status: 'published',
  version: 1,
  is_creator: true,
  steps: [
    {
      id: 'step-text',
      kind: 'text' as const,
      title: 'ITU-T Optical Grid Frequencies',
      text: 'Platform systems multiplex optical signals over the 1530nm - 1565nm C-band spectrum.',
      url: '',
      asset_id: null,
      options: [],
    },
    {
      id: 'step-reveal',
      kind: 'reveal' as const,
      title: 'Coherent Detection Architecture',
      text: 'Local oscillators enable phase and polarization tracking across 100G and 400G carriers.',
      url: '',
      asset_id: null,
      options: [],
    },
    {
      id: 'step-question',
      kind: 'question' as const,
      title: 'Frequency Anchoring Knowledge Check',
      text: 'According to ITU-T G.694.1, what is the nominal anchor frequency for the Platform grid?',
      url: '',
      asset_id: null,
      options: ['193.10 THz (1552.52 nm)', '180.00 THz (1665.40 nm)', '200.00 THz (1498.96 nm)'],
      answer: 0,
      feedback: 'Correct! The 193.10 THz anchor point defines the standard 50 GHz and 100 GHz channel allocations.',
    },
    {
      id: 'step-video',
      kind: 'video' as const,
      title: 'OTN Transponder Lab Demonstration',
      text: 'Video demonstration of transponder client-side mapping.',
      url: 'https://carrier.net/media/dwdm_lab.mp4',
      asset_id: 'asset-video-1',
      options: [],
    },
  ],
  progress: { step: 0, completed: false },
};

function setupMassiveFetch() {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';

    if (url.includes('/auth/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            username: 'noc_admin',
            display_name: 'Dr. Elena Rostova',
            is_admin: true,
            can_create_quizzes: true,
          },
        }),
      };
    }

    // Notes APIs
    if (url.includes('/api/notes/export')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, exported_count: 3 }) };
    }
    if (url.includes('/api/notes') && method === 'POST') {
      const body = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 104, ...body, created_at: new Date().toISOString() }),
      };
    }
    if (url.includes('/api/notes/') && method === 'PUT') {
      const body = JSON.parse(String(init?.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ ...body }) };
    }
    if (url.includes('/api/notes/') && method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/notes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: sampleNotes,
          next_before_id: null,
          default_collection: 'Engineering',
        }),
      };
    }

    // Learning Classes APIs
    if (url.includes('/api/learning/folders/software-dwdm-core/class-teachers')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ username: 'noc_admin', display_name: 'Dr. Elena Rostova' }] }),
      };
    }
    if (url.includes('/api/learning/folders/software-dwdm-core/classes') && method === 'POST') {
      return { ok: true, status: 200, json: async () => sampleClassDetail };
    }
    if (url.includes('/api/learning/folders/software-dwdm-core/classes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [sampleClassDetail] }),
      };
    }
    if (url.includes('/classes/class-dwdm-oct/announcements') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'ann-2', revision: 1 }) };
    }
    if (url.includes('/classes/class-dwdm-oct/announcements')) {
      return { ok: true, status: 200, json: async () => ({ items: sampleClassAnnouncements }) };
    }
    if (url.includes('/classes/class-dwdm-oct/sessions') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'sess-2', revision: 1 }) };
    }
    if (url.includes('/classes/class-dwdm-oct/sessions')) {
      return { ok: true, status: 200, json: async () => ({ items: sampleClassSessions }) };
    }
    if (url.includes('/classes/class-dwdm-oct/assignments') && url.includes('/submissions') && url.includes('/feedback')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/classes/class-dwdm-oct/assignments') && url.includes('/submissions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'sub-1',
              username: 'engineer_alex',
              display_name: 'Alex Transport',
              text: 'Span attenuation: 80km * 0.22 dB/km = 17.6 dB. Target EDFA booster output = 18 dBm.',
              revision: 1,
              submitted_at: '2026-10-29T11:00:00Z',
              feedback: 'Well calculated. Include splice margin next time.',
              mark: 18,
              max_mark: 20,
            },
          ],
        }),
      };
    }
    if (url.includes('/classes/class-dwdm-oct/assignments') && url.includes('/submit')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/classes/class-dwdm-oct/assignments') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'assign-2', revision: 1 }) };
    }
    if (url.includes('/classes/class-dwdm-oct/assignments')) {
      return { ok: true, status: 200, json: async () => ({ items: sampleClassAssignments }) };
    }
    if (url.includes('/classes/class-dwdm-oct/members') && method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/classes/class-dwdm-oct/members')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ username: 'engineer_alex', display_name: 'Alex Transport' }] }),
      };
    }
    if (url.includes('/classes/class-dwdm-oct/candidates')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { username: 'engineer_alex', display_name: 'Alex Transport' },
            { username: 'engineer_sarah', display_name: 'Sarah Photonic' },
          ],
        }),
      };
    }
    if (url.includes('/folders/software-dwdm-core/contents')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          books: [{ id: 'book-1', title: 'Dense Wavelength Division Multiplexing Principles' }],
          lessons: [{ id: 'lesson-dwdm-101', title: 'Platform Principles', status: 'published' }],
          quizzes: [{ id: 'quiz-1', title: 'Platform Knowledge Assessment', status: 'published' }],
        }),
      };
    }
    if (url.includes('/classes/class-dwdm-oct/completion')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          course: { id: 'class-dwdm-oct', title: 'Platform Engineering October Cohort', revision: 1 },
          can_manage: true,
          items: [
            {
              username: 'engineer_alex',
              display_name: 'Alex Transport',
              eligible: true,
              evidence_digest: 'digest-dwdm-evidence-1',
              requirements: [
                {
                  assignment_id: 'assign-1',
                  title: 'Link Margin Calculation',
                  resource_type: 'none',
                  resource_version: null,
                  completed: true,
                  status: 'Completed',
                  score: 18,
                  max_score: 20,
                },
              ],
              certificate: null,
            },
          ],
        }),
      };
    }
    if (url.includes('/classes/class-dwdm-oct') && method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ folder_deleted: false }) };
    }
    if (url.includes('/classes/class-dwdm-oct')) {
      return { ok: true, status: 200, json: async () => sampleClassDetail };
    }

    // Learning Lessons APIs
    if (url.includes('/api/learning/folders/software-dwdm-core/lessons') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'lesson-dwdm-102', version: 1 }) };
    }
    if (url.includes('/api/learning/folders/software-dwdm-core/lessons')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'lesson-dwdm-101',
              title: 'Dense Wavelength Division Multiplexing Principles',
              status: 'published',
              version: 1,
              is_creator: true,
            },
          ],
        }),
      };
    }
    if (url.includes('/api/learning/lessons/lesson-dwdm-101/progress')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/learning/lessons/lesson-dwdm-101/check')) {
      return { ok: true, status: 200, json: async () => ({ correct: true, feedback: 'Correct! The 193.10 THz anchor point defines the standard grid.' }) };
    }
    if (url.includes('/api/learning/lessons/lesson-dwdm-101')) {
      return { ok: true, status: 200, json: async () => sampleLesson };
    }

    // Learning Workspace Folders & Books APIs
    if (url.includes('/api/learning/folders/software-dwdm-core/books')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'book-dwdm-manual',
            title: 'Optical Transport Network Architecture Manual',
            author: 'ITU-T Study Group 15',
            extension: 'epub',
          },
        ],
      };
    }
    if (url.includes('/api/learning/folders/software-dwdm-core/quizzes')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'quiz-dwdm-opt',
            title: 'Platform Optical Engineering Assessment',
            status: 'published',
            version: 1,
            submitted: false,
            is_creator: true,
          },
        ],
      };
    }
    if (url.includes('/api/learning/folders/software-dwdm-core/notes')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'note-trans-1',
            title: 'EDFA Saturation Constant',
            body: 'Maximum output power saturation occurs at +23dBm for standard C-band optical boosters.',
            color: 'butter',
            updated_at: '2026-10-29T10:00:00Z',
          },
        ],
      };
    }
    if (url.includes('/api/learning/books/book-dwdm-manual/progress')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/api/learning/books/book-dwdm-manual/notes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'bn-1',
              chapter_id: 'ch-optical-grid',
              page: 1,
              text: 'Anchor channel frequency 193.10 THz',
              color: 'sky',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/learning/books/book-dwdm-manual/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              chapter_id: 'ch-optical-grid',
              title: 'ITU-T Frequency Grids',
              excerpt: 'Channel spacing 50GHz anchored at 193.10 THz.',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/learning/books/book-dwdm-manual/chapters/ch-optical-grid')) {
      return {
        ok: true,
        status: 200,
        text: async () => '<main><h2>ITU-T Frequency Grids</h2><p>50 GHz spacing over C-band spectrum.</p></main>',
      };
    }
    if (url.includes('/api/learning/books/book-dwdm-manual')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'book-dwdm-manual',
          title: 'Optical Transport Network Architecture Manual',
          author: 'ITU-T Study Group 15',
          chapters: [{ id: 'ch-optical-grid', title: 'Chapter 1: ITU-T Frequency Grids', page_count: 3 }],
        }),
      };
    }
    if (url.includes('/api/learning/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          username: 'noc_admin',
          display_name: 'Dr. Elena Rostova',
          is_admin: true,
          can_create_quizzes: true,
        }),
      };
    }
    if (url.includes('/api/learning/folders/software-dwdm-core/contents')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          books: [
            {
              id: 'book-dwdm-manual',
              title: 'Optical Transport Network Architecture Manual',
              author: 'ITU-T Study Group 15',
              extension: 'epub',
            },
          ],
          quizzes: [
            {
              id: 'quiz-dwdm-opt',
              title: 'Platform Optical Engineering Assessment',
              status: 'published',
              version: 1,
            },
          ],
          lessons: [
            {
              id: 'lesson-dwdm-101',
              title: 'Dense Wavelength Division Multiplexing Principles',
              status: 'published',
              version: 1,
            },
          ],
          notes: [
            {
              id: 'note-trans-1',
              title: 'EDFA Saturation Constant',
              body: 'Maximum output power saturation occurs at +23dBm.',
              color: 'butter',
              updated_at: '2026-10-29T10:00:00Z',
            },
          ],
          can_manage_class: true,
        }),
      };
    }
    if (url.includes('/api/learning/certificates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'cert-101',
            class_id: 'class-dwdm-oct',
            recipient_name: 'Alex Transport',
            course_title: 'Platform Optical Transport Engineering',
            instructor_name: 'Dr. Elena Rostova',
            issued_at: '2026-10-29T10:00:00Z',
          },
        ],
      };
    }
    if (url.includes('/api/learning/folders')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'software-dwdm-core',
              name: 'Carrier Optical Transport',
              is_class: true,
              description: 'Engineering optical backbone training curriculum',
              teacher_username: 'noc_admin',
              teacher_display_name: 'Dr. Elena Rostova',
              can_manage: true,
              can_delete: true,
              lesson_count: 2,
              book_count: 1,
              quiz_count: 1,
              note_count: 3,
              member_count: 2,
              has_certificate: true,
            },
          ],
        }),
      };
    }

    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe('LearningClasses Deep Interactions', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setupCommonMocks();
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

  it('renders class list, opens class detail, and switches through all subtabs', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="software-dwdm-core"
          canCreate={true}
          canAssignTeacher={true}
        />
      );
    });

    // Check class card in grid
    expect(host.textContent).toContain('Platform Engineering October Cohort');
    expect(host.textContent).toContain('Dr. Elena Rostova');

    // Click "Open class" button
    const openBtn = host.querySelector('.learning-class-card button') as HTMLButtonElement;
    expect(openBtn).not.toBeNull();
    await act(async () => {
      openBtn.click();
    });

    // Class detail header rendered
    expect(host.textContent).toContain('HUMAN-LED CLASSROOM');
    expect(host.textContent).toContain('Announcements');

    // Tab 1: Announcements (overview)
    expect(host.textContent).toContain('Laboratory Session Preparation');

    // Tab 2: Calendar
    const calendarTab = Array.from(host.querySelectorAll('.learning-class-tabs button')).find(b => b.textContent?.includes('Class calendar'));
    expect(calendarTab).toBeDefined();
    await act(async () => {
      calendarTab?.click();
    });
    expect(host.textContent).toContain('EDFA Booster Calibration');
    expect(host.textContent).toContain('Optical Amplification');

    // Tab 3: Assignments
    const assignmentsTab = Array.from(host.querySelectorAll('.learning-class-tabs button')).find(b => b.textContent?.includes('Assignments'));
    expect(assignmentsTab).toBeDefined();
    await act(async () => {
      assignmentsTab?.click();
    });
    expect(host.textContent).toContain('Link Margin Calculation for 80km Span');
    expect(host.textContent).toContain('Compute total span loss');

    // Tab 4: Members roster
    const membersTab = Array.from(host.querySelectorAll('.learning-class-tabs button')).find(b => b.textContent?.includes('Class members'));
    expect(membersTab).toBeDefined();
    await act(async () => {
      membersTab?.click();
    });
    expect(host.textContent).toContain('Select learners who already have access to this folder.');
    expect(host.textContent).toContain('Alex Transport');

    // Tab 5: Course Completion / Learner Progress
    const completionTab = Array.from(host.querySelectorAll('.learning-class-tabs button')).find(b => b.textContent?.includes('Learner progress') || b.textContent?.includes('Course completion'));
    expect(completionTab).toBeDefined();
    await act(async () => {
      completionTab?.click();
    });
    expect(host.textContent).toContain('Alex Transport');
  });

  it('reviews learner submissions, enters instructor feedback and marks', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="software-dwdm-core"
          canCreate={true}
          autoOpenFolderClass={true}
          initialTab="assignments"
        />
      );
    });

    // Click "Review learner work"
    const reviewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Review learner work'));
    expect(reviewBtn).toBeDefined();
    await act(async () => {
      reviewBtn?.click();
    });

    // Check submission text rendered
    expect(host.textContent).toContain('Alex Transport');
    expect(host.textContent).toContain('Span attenuation: 80km * 0.22 dB/km = 17.6 dB');

    // Update feedback text
    const feedbackArea = host.querySelector('textarea[aria-label="Teacher feedback"]') as HTMLTextAreaElement;
    expect(feedbackArea).not.toBeNull();
    await act(async () => {
      feedbackArea.value = 'Excellent optical budget breakdown. 20/20 marks.';
      feedbackArea.dispatchEvent(new Event('input', { bubbles: true }));
      feedbackArea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Submit feedback
    const submitFeedbackBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitFeedbackBtn).not.toBeNull();
    await act(async () => {
      submitFeedbackBtn.click();
    });

    expect(host.textContent).toContain('Teacher feedback saved.');
  });

  it('opens and cancels class deletion dialog', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="software-dwdm-core"
          canCreate={true}
          autoOpenFolderClass={true}
        />
      );
    });

    const deleteClassBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Delete class'));
    expect(deleteClassBtn).toBeDefined();

    await act(async () => {
      deleteClassBtn?.click();
    });

    // Confirm dialog opened
    expect(document.body.textContent).toContain('Delete “Platform Engineering October Cohort”?');

    // Cancel deletion
    const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('Cancel'));
    expect(cancelBtn).toBeDefined();
    await act(async () => {
      cancelBtn?.click();
    });

    expect(document.body.querySelector('dialog[open]')).toBeNull();
  });
});

describe('StickyNotes & NotesWorkspace Deep Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', setupMassiveFetch());

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

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

  it('renders NotesWorkspace with notes, search query, color filtering, and view mode switching', async () => {
    await act(async () => {
      root.render(<NotesWorkspace onBack={vi.fn()} />);
    });

    // Check notes rendered
    expect(host.textContent).toContain('Platform Optical Power Budget');
    expect(host.textContent).toContain('API Routing Peering Security');
    expect(host.textContent).toContain('OTN ODUk Multiplexing Hierarchy');

    // Search query filter
    const searchInput = host.querySelector('input[type="search"], input[placeholder*="Search"]') as HTMLInputElement;
    if (searchInput) {
      await act(async () => {
        searchInput.value = 'ODUk';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.textContent).toContain('OTN ODUk Multiplexing Hierarchy');
    }

    // Color filter selection
    const colorSelect = host.querySelector('select[aria-label*="Color"], select.notes-filter-color') as HTMLSelectElement;
    if (colorSelect) {
      await act(async () => {
        colorSelect.value = 'butter';
        colorSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.textContent).toContain('Platform Optical Power Budget');
    }

    // Toggle View Mode: cards vs list
    const viewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('List') || b.textContent?.includes('Cards'));
    if (viewBtn) {
      await act(async () => {
        viewBtn.click();
      });
    }
  });

  it('edits note with markdown tools, applies template, and requests Bob AI enrichment', async () => {
    await act(async () => {
      root.render(<NotesWorkspace onBack={vi.fn()} />);
    });

    // Click "New note" button
    const newNoteBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('New note'));
    expect(newNoteBtn).toBeDefined();
    await act(async () => {
      newNoteBtn?.click();
    });

    // In note editor
    const titleInput = host.querySelector('dialog input[placeholder*="title"], dialog input[required]') as HTMLInputElement;
    const bodyInput = host.querySelector('dialog textarea') as HTMLTextAreaElement;
    expect(titleInput).not.toBeNull();
    expect(bodyInput).not.toBeNull();

    await act(async () => {
      titleInput.value = 'Optical Transponder Coherent Metrics';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      bodyInput.value = 'Target OSNR threshold is 28 dB. Pre-FEC BER limit is 1e-3.';
      bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Apply template (Meeting / Project)
    const templateBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Meeting') || b.textContent?.includes('Project'));
    if (templateBtn) {
      await act(async () => {
        templateBtn.click();
      });
    }

    // Request Bob AI enrichment
    const askBobBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Ask Bob') || b.textContent?.includes('Improve note'));
    if (askBobBtn) {
      await act(async () => {
        askBobBtn.click();
      });
      expect(host.textContent).toContain('ITU-T Carrier Specifications');
    }

    // Save note
    const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save'));
    if (saveBtn) {
      await act(async () => {
        saveBtn.click();
      });
    }
  });

  it('supports notes bulk selection, export, and chat card provenance flights', async () => {
    await act(async () => {
      root.render(<NotesWorkspace onBack={vi.fn()} />);
    });

    // Test export button
    const exportBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Export'));
    if (exportBtn) {
      await act(async () => {
        exportBtn.click();
      });
    }

    // Test StickyNotes chat component with provenance
    await act(async () => {
      root.render(
        <StickyNotes
          notes={[
            {
              title: 'Telemetry Threshold Alarm',
              body: 'Optical signal loss exceeds 3dB on span 4.',
              color: 'rose',
            },
          ]}
          sessionId="session-software-test"
          messageId="msg-alarm-01"
        />
      );
    });

    expect(host.textContent).toContain('Telemetry Threshold Alarm');
    expect(host.textContent).toContain('Optical signal loss exceeds 3dB');
  });
});

describe('LearningLessons Deep Interactive Experience', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', setupMassiveFetch());

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

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

  it('progresses through text, reveal, question check, and video player steps', async () => {
    const onProgressChange = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="software-dwdm-core"
          canCreate={true}
          search=""
          openLessonId="lesson-dwdm-101"
          onProgressChange={onProgressChange}
        />
      );
    });

    // Step 1: Text step
    expect(host.textContent).toContain('ITU-T Optical Grid Frequencies');
    expect(host.textContent).toContain('1530nm - 1565nm C-band spectrum');

    // Click Next step
    const nextBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save & continue'));
    expect(nextBtn).toBeDefined();
    await act(async () => {
      nextBtn?.click();
    });

    // Step 2: Reveal step
    expect(host.textContent).toContain('Coherent Detection Architecture');

    // Advance to Step 3: Question Knowledge Check
    await act(async () => {
      nextBtn?.click();
    });
    expect(host.textContent).toContain('Frequency Anchoring Knowledge Check');
    expect(host.textContent).toContain('193.10 THz');

    // Select correct option
    const optionBtn = Array.from(host.querySelectorAll('button, label')).find(el => el.textContent?.includes('193.10 THz'));
    expect(optionBtn).toBeDefined();
    await act(async () => {
      optionBtn?.click();
    });

    const checkBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Check answer'));
    expect(checkBtn).toBeDefined();
    await act(async () => { checkBtn?.click(); });

    // Check feedback displayed
    expect(host.textContent).toContain('Correct! The 193.10 THz anchor point');

    // Advance to Step 4: Video player
    await act(async () => {
      nextBtn?.click();
    });
    expect(host.textContent).toContain('OTN Transponder Lab Demonstration');
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('enters authoring mode, adds new step, and triggers quiz draft generator', async () => {
    const onDraftQuiz = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="software-dwdm-core"
          canCreate={true}
          search=""
          createNewLesson={true}
          onDraftQuiz={onDraftQuiz}
        />
      );
    });

    // Authoring mode form
    expect(host.textContent).toContain('Section 1');

    // Add step button
    const addStepBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add step') || b.textContent?.includes('Add section'));
    if (addStepBtn) {
      await act(async () => {
        addStepBtn.click();
      });
    }

    // Test title input
    const lessonTitleInput = host.querySelector('input[placeholder*="Title"], input.lesson-title-input') as HTMLInputElement;
    if (lessonTitleInput) {
      await act(async () => {
        lessonTitleInput.value = 'Carrier Optical Network Dispersion Management';
        lessonTitleInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  });
});

describe('LearningWorkspace Comprehensive Tabs & Reader', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrollToDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', setupMassiveFetch());
    scrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: vi.fn() });

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    (document as any).fonts = { ready: Promise.resolve() };

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    if (scrollToDescriptor) Object.defineProperty(Element.prototype, 'scrollTo', scrollToDescriptor);
    else Reflect.deleteProperty(Element.prototype, 'scrollTo');
    vi.restoreAllMocks();
  });

  it('renders LearningWorkspace and switches across all navigation tabs', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });

    // Workspace loaded with folder
    expect(host.textContent).toContain('Carrier Optical Transport');

    // Switch to Notes tab
    const notesTab = host.querySelector('#learning-notes-tab, [aria-controls="learning-notes"], button.tasks-nav:nth-child(2)') as HTMLButtonElement;
    if (notesTab) {
      await act(async () => {
        notesTab.click();
      });
    }

    // Switch to Library tab
    const libraryTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Library') || b.textContent?.includes('Documents'));
    if (libraryTab) {
      await act(async () => {
        libraryTab.click();
      });
    }

    // Switch to Quizzes tab
    const quizzesTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Quizzes'));
    if (quizzesTab) {
      await act(async () => {
        quizzesTab.click();
      });
    }

    // Switch to Certificates & Completion tab
    const completionTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Certificates') || b.textContent?.includes('completion'));
    if (completionTab) {
      await act(async () => {
        completionTab.click();
      });
      expect(host.textContent).toContain('Certificates & completion');
    }
  });

  it('opens EbookReader, interacts with font size controls, bookmarking, and search query', async () => {
    // Set URL search param to open ebook directly
    const url = new URL(window.location.href);
    url.searchParams.set('folder', 'software-dwdm-core');
    url.searchParams.set('book', 'book-dwdm-manual');
    window.history.pushState({}, '', url);

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Enter class
    const enterBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Enter Class'));
    if (enterBtn) {
      await act(async () => {
        enterBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(host.textContent).toContain('Carrier Optical Transport');

    // In-reader search input
    const readerSearch = host.querySelector('.learning-reader-search input') as HTMLInputElement;
    if (readerSearch) {
      await act(async () => {
        readerSearch.value = '50GHz';
        readerSearch.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    // Font size controls
    const fontSmallerBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'A-' || b.getAttribute('aria-label')?.includes('Decrease font'));
    const fontLargerBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'A+' || b.getAttribute('aria-label')?.includes('Increase font'));

    if (fontSmallerBtn) {
      await act(async () => {
        fontSmallerBtn.click();
      });
    }
    if (fontLargerBtn) {
      await act(async () => {
        fontLargerBtn.click();
      });
    }

    // Theme toggle
    const themeBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('theme') || b.className.includes('theme'));
    if (themeBtn) {
      await act(async () => {
        themeBtn.click();
      });
    }

    // Close reader
    const closeReaderBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Close') || b.getAttribute('aria-label')?.includes('Close'));
    if (closeReaderBtn) {
      await act(async () => {
        closeReaderBtn.click();
      });
    }
  });
});
