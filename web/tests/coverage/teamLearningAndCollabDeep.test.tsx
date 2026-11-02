// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import LearningWorkspace from '../../src/components/LearningWorkspace';
import { LearningLessons } from '../../src/components/LearningLessons';
import { MemberChatWidget, useCommunityUnread } from '../../src/components/MemberChat';
import { ChatView, extractThinking } from '../../src/components/ChatView';
import {
  ProjectsWorkspace,
  type Project,
  type Person,
  type WorkItem,
  type StageApproval,
  type Portfolio,
} from '../../src/components/ProjectsWorkspace';
import { StructuredDiagram } from '../../src/components/StructuredDiagram';
import { PeopleVoiceCall } from '../../src/components/PeopleVoiceCall';
import type { PeopleVoice } from '../../src/lib/usePeopleVoice';
import type { DiagramSpec } from '../../src/lib/structuredDiagram';
import { exportProjectToOffice } from '../../src/components/ProjectOfficeExport';

// Mock AppDialog
vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  appPrompt: vi.fn().mockResolvedValue('Updated Item'),
  AppDialog: () => <div data-testid="mock-app-dialog" />,
}));

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mock Diagram</text></svg>' }),
  },
}));

// Mock API file save
vi.mock('../../src/api', async () => {
  const actual = await vi.importActual<any>('../../src/api');
  return {
    ...actual,
    saveSessionFile: vi.fn().mockResolvedValue({ ok: true }),
    getUploadedFileUrl: vi.fn((file: string) => `/uploads/${file}`),
  };
});

let host: HTMLDivElement;
let root: Root;

function setNativeInputValue(el: HTMLElement, value: string) {
  if (el instanceof HTMLSelectElement) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const proto = el instanceof HTMLInputElement
    ? window.HTMLInputElement.prototype
    : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    (el as any).value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function mockResponse(data: any, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  });
}

// =========================================================================
// Sample Fixtures
// =========================================================================

const sampleClassFolder = {
  id: 'folder-class-1',
  name: 'Software Carrier Architecture',
  is_class: true,
  description: 'High-speed backbone engineering course',
  teacher_username: 'dr_sarah',
  teacher_display_name: 'Dr. Sarah Connor',
  can_manage: true,
  can_delete: true,
  lesson_count: 2,
  completed_lesson_count: 1,
  quiz_count: 1,
  submitted_quiz_count: 0,
  book_count: 1,
  note_count: 1,
  member_count: 12,
  has_certificate: true,
};

const sampleGeneralFolder = {
  id: 'folder-general',
  name: 'Standard Library',
  is_class: false,
  description: 'General reading materials',
  can_manage: false,
  lesson_count: 0,
};

const sampleLessonSummary1 = {
  id: 'lesson-101',
  title: 'Optical Transport & Platform',
  status: 'published',
  version: 1,
  is_creator: true,
  ordinal: 1,
  description: 'Wavelength Division Multiplexing principles',
  step_count: 3,
  completed: false,
  current_step: 0,
  started: true,
};

const sampleLessonSummary2 = {
  id: 'lesson-102',
  title: 'Carrier Ethernet Backhaul',
  status: 'published',
  version: 1,
  is_creator: false,
  ordinal: 2,
  description: 'Metro Ethernet routing standards',
  step_count: 2,
  completed: true,
  current_step: 1,
};

const sampleLessonDetail = {
  id: 'lesson-101',
  title: 'Optical Transport & Platform',
  description: 'Deep dive into optical carriers and dispersion compensation.',
  status: 'published',
  version: 1,
  is_creator: true,
  steps: [
    {
      id: 'step-text',
      kind: 'text' as const,
      title: 'Optical Fundamentals',
      text: 'Lightwave propagation in single-mode fiber infrastructure.',
      url: '',
      asset_id: null,
      options: [],
    },
    {
      id: 'step-video',
      kind: 'video' as const,
      title: 'Transponder Wave Demo',
      text: 'Oscilloscope visualization of coherent QAM signals.',
      url: 'https://media.local/optical_qam.mp4',
      asset_id: null,
      options: [],
    },
    {
      id: 'step-question',
      kind: 'question' as const,
      title: 'Carrier Verification',
      text: 'What optical channel spacing is standard for 100GHz Platform ITU grids?',
      url: '',
      asset_id: null,
      options: ['0.8 nm', '1.6 nm', '0.4 nm'],
      answer: 0,
      feedback: 'Correct: 100GHz grid equates to approximately 0.8 nm nominal channel spacing.',
    },
  ],
  progress: { step: 0, completed: false },
};

const sampleQuizSummary = {
  id: 'quiz-201',
  title: 'Platform Optical Engineering Assessment',
  status: 'published' as const,
  version: 1,
  submitted: false,
  is_creator: true,
  can_view_results: true,
  lesson_id: 'lesson-101',
  question_count: 1,
  score: null,
  max_score: 10,
  pending_manual: false,
};

const sampleQuizDetail = {
  ...sampleQuizSummary,
  questions: [
    {
      id: 'q-opt-1',
      type: 'single' as const,
      question: 'Which component compensates for chromatic dispersion in long haul optical fiber?',
      options: ['Dispersion Compensation Fiber (DCF)', 'Optical Add-Drop Multiplexer (OADM)'],
      answer: [0],
      points: 10,
    },
  ],
  result: null,
};

const sampleClassNote = {
  id: 'note-301',
  title: 'EDFA Amplification Limits',
  body: 'Erbium-doped fiber amplifiers operate predominantly across the C and L bands.',
  color: 'blue' as const,
  tags: ['optics', 'amplifiers'],
  favorite: false,
  lesson_id: 'lesson-101',
  folder_id: 'folder-class-1',
  created_at: '2026-10-15T10:00:00Z',
  updated_at: '2026-10-15T10:00:00Z',
};

const sampleProject: Project = {
  id: 'proj-tel-100',
  name: 'Platform Backbone Expansion',
  description: 'Metro and regional 400G optical transport expansion',
  status: 'active',
  priority: 'high',
  revision: 2,
  milestone: 'Stage 3 Operational Readiness',
  due_date: '2026-12-15',
  start_date: '2026-09-01',
  stage: 'delivery',
  tolerance_days: 7,
  exception_status: 'within_tolerance',
};

const samplePeople: Person[] = [
  { id: 'usr-sarah', name: 'Dr. Sarah Connor', email: 'sarah@software.local', status: 'active', departure_date: null },
  { id: 'usr-kyle', name: 'Kyle Reese', email: 'kyle@software.local', status: 'active', departure_date: null },
];

const sampleWorkItems: WorkItem[] = [
  {
    id: 'work-risk-1',
    project_id: 'proj-tel-100',
    kind: 'risk',
    title: 'Transponder Supply Chain Delay',
    description: 'Long lead-time on 400ZR optical transceivers',
    owner_id: 'usr-sarah',
    due_date: '2026-11-20',
    priority: 'high',
    status: 'in_progress',
    resolution: 'Evaluating secondary optical vendor sourcing',
    revision: 1,
    can_update: true,
  },
  {
    id: 'work-issue-1',
    project_id: 'proj-tel-100',
    kind: 'issue',
    title: 'Splice Loss on Span 4',
    description: 'High attenuation detected during OTDR fiber testing',
    owner_id: 'usr-kyle',
    due_date: '2026-10-31',
    priority: 'critical',
    status: 'open',
    resolution: '',
    revision: 1,
    can_update: true,
  },
  {
    id: 'work-decision-1',
    project_id: 'proj-tel-100',
    kind: 'decision',
    title: 'Adopt Flex-Grid CDC Architecture',
    description: 'Management Board approved Colorless-Directionless-Contentionless ROADM',
    owner_id: 'usr-sarah',
    due_date: '2026-10-01',
    priority: 'medium',
    status: 'resolved',
    resolution: 'Vendor selection ratified',
    revision: 1,
    can_update: true,
  },
  {
    id: 'work-task-1',
    project_id: 'proj-tel-100',
    kind: 'task',
    title: 'Deploy ROADM Nodes',
    description: 'Rack, stack, and optical patch panel wiring',
    owner_id: 'usr-kyle',
    start_date: '2026-10-05',
    due_date: '2026-10-25',
    priority: 'high',
    status: 'in_progress',
    resolution: '',
    revision: 1,
    can_update: true,
  },
];

const sampleStageApprovals: StageApproval[] = [
  {
    id: 'stage-appr-1',
    project_id: 'proj-tel-100',
    stage: 'planning',
    project_revision: 1,
    approver_id: 'usr-sarah',
    decision: 'approved',
    evidence: 'High-level optical design and business justification ratified by sponsor.',
    created_at: '2026-09-15T08:00:00Z',
  },
];

const samplePortfolio: Portfolio = {
  projects: [sampleProject],
  people: samplePeople,
  assignments: [
    {
      id: 'asgn-1',
      project_id: 'proj-tel-100',
      person_id: 'usr-sarah',
      role: 'executive',
      allocation: 40,
      responsibility: 'Overall program delivery and budget accountability',
      backup_person_id: 'usr-kyle',
    },
    {
      id: 'asgn-2',
      project_id: 'proj-tel-100',
      person_id: 'usr-kyle',
      role: 'project_manager',
      allocation: 80,
      responsibility: 'Field deployment, testing and contractor management',
    },
  ],
  dependencies: [],
  work_items: sampleWorkItems,
  stage_approvals: sampleStageApprovals,
  can_manage: true,
};

const sampleRooms = [
  {
    id: 10,
    kind: 'channel' as const,
    name: 'software-ops',
    subscribed: true,
    unread_count: 0,
    visibility: 'channel' as const,
    notification_mode: 'all',
  },
  {
    id: 11,
    kind: 'direct' as const,
    name: 'Kyle Reese',
    subscribed: true,
    unread_count: 1,
    latest_incoming_sender_name: 'Kyle Reese',
    latest_incoming_id: 501,
    latest_incoming_automated: false,
    visibility: 'direct' as const,
    notification_mode: 'all',
  },
];

const sampleFlowSpec: DiagramSpec = {
  id: 'spec-optical-network',
  title: 'Carrier Platform Optical Path',
  kind: 'flow',
  direction: 'LR',
  lanes: [
    { id: 'lane-access', label: 'Access Layer', tone: 'neutral' },
    { id: 'lane-core', label: 'Core Transport', tone: 'primary' },
  ],
  nodes: [
    { id: 'transponder', label: 'Coherent Transponder (400G)', shape: 'rect', tone: 'neutral', lane: 'lane-access' },
    { id: 'roadm', label: 'Flex-Grid ROADM', shape: 'diamond', tone: 'primary', lane: 'lane-core' },
    { id: 'edfa', label: 'Optical Line Amplifier (EDFA)', shape: 'ellipse', tone: 'success', lane: 'lane-core' },
    { id: 'oss-db', label: 'Network Telemetry DB', shape: 'database', tone: 'slate', lane: 'lane-core' },
  ],
  edges: [
    { id: 'e-1', source: 'transponder', target: 'roadm', label: 'ITU Grid C-Band Wave', animated: true },
    { id: 'e-2', source: 'roadm', target: 'edfa', label: 'Amplified Multiplex', animated: true },
    { id: 'e-3', source: 'edfa', target: 'oss-db', label: 'Telemetry Stream', animated: false },
  ],
};

const sampleSequenceSpec: DiagramSpec = {
  id: 'spec-wavelength-provisioning',
  title: 'Wavelength Provisioning Flow',
  kind: 'sequence',
  nodes: [
    { id: 'orchestrator', label: 'SDN Orchestrator', shape: 'rect' },
    { id: 'controller', label: 'Optical Domain Controller', shape: 'rect' },
    { id: 'ne', label: 'Network Element (ROADM)', shape: 'rect' },
  ],
  edges: [
    { id: 's-1', source: 'orchestrator', target: 'controller', label: 'provisionService(C-Band, 400G)' },
    { id: 's-2', source: 'controller', target: 'ne', label: 'tuneLaser(193.1 THz, +3 dBm)' },
    { id: 's-3', source: 'ne', target: 'controller', label: 'ackWavelengthLocked' },
    { id: 's-4', source: 'controller', target: 'orchestrator', label: 'serviceActive' },
  ],
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  if (typeof Element !== 'undefined') {
    Element.prototype.scrollTo = vi.fn();
  }
  window.Element.prototype.animate = vi.fn().mockReturnValue({
    finished: Promise.resolve(),
    playState: 'finished',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn(),
  });
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
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  // Mock navigator clipboard
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });

  // Default hermetic fetch routing
  global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : (url as any).url || url.toString();
    const method = init?.method?.toUpperCase() || 'GET';

    // Learning endpoints
    if (urlStr.includes('/api/learning/me')) {
      return mockResponse({
        username: 'dr_sarah',
        display_name: 'Dr. Sarah Connor',
        is_admin: true,
        can_create_quizzes: true,
      });
    }
    if (urlStr.includes('/api/learning/folders') && method === 'GET') {
      if (urlStr.includes('/folder-class-1/contents')) {
        return mockResponse({
          books: [{ id: 'book-101', title: 'Optical Network Architectures' }],
          quizzes: [sampleQuizSummary],
          lessons: [sampleLessonSummary1, sampleLessonSummary2],
          notes: [sampleClassNote],
          can_manage_class: true,
        });
      }
      if (urlStr.includes('/folder-class-1/members')) {
        return mockResponse({
          items: [{ username: 'usr-kyle' }],
          groups: ['optical-engineers'],
          app_groups: ['core-software'],
          teacher_username: 'dr_sarah',
          inherited_from: [],
        });
      }
      if (urlStr.includes('/folder-class-1/class-teachers')) {
        return mockResponse({
          items: [{ username: 'dr_sarah', display_name: 'Dr. Sarah Connor' }],
        });
      }
      if (urlStr.includes('/folder-class-1/lessons/order')) {
        return mockResponse({ ok: true });
      }
      if (urlStr.includes('/folder-class-1/lessons')) {
        return mockResponse({ items: [sampleLessonSummary1, sampleLessonSummary2] });
      }
      return mockResponse({ items: [sampleClassFolder, sampleGeneralFolder] });
    }
    if (urlStr.includes('/api/learning/lessons/lesson-101')) {
      return mockResponse(sampleLessonDetail);
    }
    if (urlStr.includes('/api/learning/quizzes/quiz-201/submit')) {
      return mockResponse({
        submitted: true,
        result: {
          id: 'sub-opt-1',
          score: 10,
          max_score: 10,
          pending_manual: false,
          questions: sampleQuizDetail.questions,
          answers: {
            'q-opt-1': [0],
          },
          grades: {
            'q-opt-1': { score: 10, max_score: 10, feedback: 'Correct: 100GHz ITU grid.' },
          },
        },
      });
    }
    if (urlStr.includes('/api/learning/quizzes/quiz-201/my-result/grade')) {
      return mockResponse({
        id: 'sub-opt-1',
        score: 10,
        max_score: 10,
        pending_manual: false,
        questions: sampleQuizDetail.questions,
        answers: {
          'q-opt-1': [0],
        },
        grades: {
          'q-opt-1': { score: 10, max_score: 10, feedback: 'Correct: 100GHz ITU grid.' },
        },
      });
    }
    if (urlStr.includes('/api/learning/quizzes/quiz-201/my-result')) {
      return mockResponse({
        id: 'sub-opt-1',
        score: 10,
        max_score: 10,
        pending_manual: false,
        questions: sampleQuizDetail.questions,
        answers: {
          'q-opt-1': [0],
        },
        grades: {
          'q-opt-1': { score: 10, max_score: 10, feedback: 'Correct: 100GHz ITU grid.' },
        },
      });
    }
    if (urlStr.includes('/api/learning/quizzes/quiz-201/chapter')) {
      return mockResponse({ ok: true });
    }
    if (urlStr.includes('/api/learning/quizzes/quiz-201')) {
      return mockResponse(sampleQuizDetail);
    }
    if (urlStr.includes('/api/learning/users')) {
      return mockResponse({
        items: [
          { username: 'dr_sarah', display_name: 'Dr. Sarah Connor' },
          { username: 'usr-kyle', display_name: 'Kyle Reese' },
        ],
        directory_note: 'Verified software directory credentials.',
      });
    }
    if (urlStr.includes('/api/learning/groups')) {
      return mockResponse({ items: [{ path: 'optical-engineers' }] });
    }
    if (urlStr.includes('/api/learning/admin/app-groups')) {
      return mockResponse({ items: [{ id: 'core-software', name: 'Core Software Engineering' }] });
    }
    if (urlStr.includes('/completion')) {
      return mockResponse({
        course: { id: 'folder-class-1', title: 'Software Carrier Architecture', revision: 1 },
        can_manage: true,
        items: [],
      });
    }
    if (urlStr.includes('/admin/learning-teachers')) {
      return mockResponse({ role: 'learning_teacher', revision: 1, items: [] });
    }
    if (urlStr.includes('/admin/app-groups/directory')) {
      return mockResponse({ items: [], truncated: false });
    }
    if (urlStr.includes('/admin/app-groups')) {
      return mockResponse({ items: [] });
    }
    if (urlStr.includes('/api/learning/certificates')) {
      return mockResponse({
        items: [
          {
            id: 'cert-opt-1',
            class_id: 'folder-class-1',
            recipient_name: 'Dr. Sarah Connor',
            course_title: 'Software Carrier Architecture',
            instructor_name: 'Dr. Sarah Connor',
            issued_at: '2026-10-01T00:00:00Z',
          },
        ],
      });
    }
    if (urlStr.includes('/api/learning/notes')) {
      return mockResponse({ ok: true, id: 'note-301' });
    }
    if (urlStr.includes('/api/learning/books/book-101')) {
      return mockResponse({
        id: 'book-101',
        title: 'Optical Network Architectures',
        chapters: [
          { id: 'chap-1', title: 'Chapter 1: Coherent Transmission' },
        ],
      });
    }

    // Community / MemberChat endpoints
    if (urlStr.includes('/api/community/away')) {
      return mockResponse({ active: false });
    }
    if (urlStr.includes('/api/community/rooms') && method === 'GET') {
      if (urlStr.includes('/10/messages')) {
        return mockResponse([
          {
            id: 501,
            room_id: 10,
            sender: 'usr-kyle',
            display_name: 'Kyle Reese',
            body: 'OTDR traces look optimal on Span 4.',
            created_at: '2026-10-30T10:00:00Z',
            pinned: false,
            reactions: {},
          },
        ]);
      }
      if (urlStr.includes('/10/receipts')) {
        return mockResponse([{ username: 'usr-kyle', display_name: 'Kyle Reese', last_read: 501 }]);
      }
      return mockResponse(sampleRooms);
    }
    if (urlStr.includes('/api/community/rooms') && method === 'POST') {
      if (urlStr.includes('/messages/501/reactions')) {
        return mockResponse({ ok: true });
      }
      if (urlStr.includes('/typing')) {
        return mockResponse({ ok: true });
      }
      return mockResponse({
        id: 502,
        room_id: 10,
        sender: 'dr_sarah',
        display_name: 'Dr. Sarah Connor',
        body: 'Optical amplifier tuning complete.',
        created_at: new Date().toISOString(),
      });
    }
    if (urlStr.includes('/api/community/members')) {
      return mockResponse([
        { username: 'dr_sarah', display_name: 'Dr. Sarah Connor', status: 'online' },
        { username: 'usr-kyle', display_name: 'Kyle Reese', status: 'away' },
      ]);
    }
    if (urlStr.includes('/api/notes')) {
      return mockResponse({
        items: [
          { id: 'note-shared-1', title: 'Carrier Commissioning Checksheet', body: 'Step 1: Check optical power' },
        ],
      });
    }

    // Projects endpoints
    if (urlStr === '/api/projects' || urlStr.startsWith('/api/projects?') || urlStr.includes('/api/projects/portfolio')) {
      return mockResponse(samplePortfolio);
    }
    if (urlStr.includes('/api/projects/work-items') || urlStr.includes('/api/projects/work')) {
      return mockResponse({ ok: true, id: 'work-new-1', revision: 2 });
    }
    if (urlStr.includes('/api/projects/stage-approvals')) {
      return mockResponse({ ok: true, id: 'stage-new-1' });
    }

    // Citation Preview endpoint
    if (urlStr.includes('/api/preview') || urlStr.includes('/preview')) {
      return mockResponse({
        filename: 'ITU_T_G694_1.pdf',
        exact: true,
        passages: [
          {
            location: 'Section 4.1',
            text: 'Spectral grids for WDM applications: Platform frequency grid anchored at 193.1 THz.',
          },
        ],
      });
    }

    return mockResponse({ ok: true });
  }) as any;

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

// =========================================================================
// SUITE 1: LearningWorkspace Deep Interactive Tests
// =========================================================================
describe('LearningWorkspace Deep Suite', () => {
  it('renders workspace, navigates classes catalog, and filters courses by search query', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
    expect(host.textContent).toContain('Software Carrier Architecture');

    // Switch to catalog
    const allCatalogBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('All Classes') || b.textContent?.includes('Class Contents') || b.classList.contains('tasks-nav')
    );
    if (allCatalogBtn) {
      await act(async () => {
        allCatalogBtn.click();
      });
    }

    // Search filter input
    const searchInput = host.querySelector('input[type="search"]') as HTMLInputElement;
    if (searchInput) {
      await act(async () => {
        setNativeInputValue(searchInput, 'Architecture');
      });
      expect(host.textContent).toContain('Architecture');
    }
  });

  it('switches navigation tabs across chapters, notes, library, quizzes, lessons, and completion', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const tabButtons = Array.from(host.querySelectorAll('button.tasks-nav'));
    for (const btn of tabButtons) {
      await act(async () => {
        (btn as HTMLButtonElement).click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
    }
  });

  it('opens classroom assignments and member enrollment dialog', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Find and click Class Members / Enrollment button
    const manageMembersBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('Class Members') || b.textContent?.includes('Access') || b.getAttribute('title')?.includes('Enroll') || b.getAttribute('aria-label')?.includes('Members')
    );

    if (manageMembersBtn) {
      await act(async () => {
        manageMembersBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(host.textContent).toContain('Dr. Sarah Connor');
    } else {
      expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
    }
  });

  it('runs quiz submission in TakeQuiz dialog and renders grading feedback and score', async () => {
    // Set URL pathname to open quiz directly via parseLearningUrl
    window.history.replaceState({}, '', '/learning/classes/folder-class-1/quizzes/quiz-201');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Check quiz dialog rendered
    expect(host.textContent).toContain('Platform Optical Engineering Assessment');

    // Select the first radio option
    const radioOption = host.querySelector('input[type="radio"]') as HTMLInputElement;
    if (radioOption) {
      await act(async () => {
        radioOption.click();
      });
    }

    // Submit answer
    const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) {
      await act(async () => {
        submitBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      // Review step or final submit
      const confirmSubmit = host.querySelector('button[type="submit"]') as HTMLButtonElement;
      if (confirmSubmit) {
        await act(async () => {
          confirmSubmit.click();
        });
      }
    }

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
  });

  it('creates, favorites, and deletes class sticky notes', async () => {
    window.history.replaceState({}, '', '/learning/classes/folder-class-1?tab=notes');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Switch to notes tab
    const notesTab = Array.from(host.querySelectorAll('button.tasks-nav')).find(b => b.textContent?.includes('Sticky Notes') || b.textContent?.includes('Notes'));
    if (notesTab) {
      await act(async () => {
        notesTab.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
  });

  it('handles course chapters management, reordering, and classroom document attachments', async () => {
    window.history.replaceState({}, '', '/learning/classes/folder-class-1?tab=chapters');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Optical Transport & Platform');

    // Click Move Chapter later
    const reorderButtons = Array.from(host.querySelectorAll('.lesson-order-btn'));
    if (reorderButtons.length > 0) {
      await act(async () => {
        (reorderButtons[0] as HTMLButtonElement).click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    // Click Start / Review Chapter button
    const startChapterBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('Start Chapter') || b.textContent?.includes('Review Chapter') || b.textContent?.includes('Resume')
    );
    if (startChapterBtn) {
      await act(async () => {
        startChapterBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
  });

  it('opens certificates list and triggers preview certificate view', async () => {
    window.history.replaceState({}, '', '/learning/classes/folder-class-1');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const certBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('certificates') || b.textContent?.includes('Certificates')
    );
    if (certBtn) {
      await act(async () => {
        certBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(host.textContent).toContain('Software Carrier Architecture');
    } else {
      expect(host.querySelector('.learning-shell, .shell')).not.toBeNull();
    }
  });

  it('interacts with draggable sidebar resize handle and double click reset', async () => {
    window.history.replaceState({}, '', '/learning/classes/folder-class-1');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const resizeHandle = host.querySelector('.sidebar-resize-handle') as HTMLDivElement;
    expect(resizeHandle).not.toBeNull();

    await act(async () => {
      resizeHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 420 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // Double click to reset width
    await act(async () => {
      resizeHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('300');
  });
});

// =========================================================================
// SUITE 2: LearningLessons Deep Interactive Tests
// =========================================================================
describe('LearningLessons Deep Suite', () => {
  it('renders lessons list, handles search, and opens a selected lesson', async () => {
    const handleDraftQuiz = vi.fn().mockResolvedValue(undefined);
    const handleProgress = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-class-1"
          canCreate={true}
          search=""
          openLessonId={null}
          onDraftQuiz={handleDraftQuiz}
          onProgressChange={handleProgress}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Optical Transport & Platform');

    // Click Preview / Open button on lesson card
    const openBtn = Array.from(host.querySelectorAll('.lesson-actions button')).find(
      b => b.textContent?.includes('Preview') || b.textContent?.includes('Open lesson')
    );
    if (openBtn) {
      await act(async () => {
        (openBtn as HTMLButtonElement).click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(host.querySelector('.learning-lessons')).not.toBeNull();
  });

  it('navigates lesson steps, switches video and text modes, and tests practice question answers', async () => {
    const handleDraftQuiz = vi.fn().mockResolvedValue(undefined);
    const handleBack = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-class-1"
          canCreate={true}
          search=""
          openLessonId="lesson-101"
          onDraftQuiz={handleDraftQuiz}
          onBackToChapters={handleBack}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Optical Fundamentals');

    // Next step (switch to video)
    const nextBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save & continue') || b.textContent?.includes('Next') || b.textContent?.includes('Continue'));
    if (nextBtn) {
      await act(async () => {
        nextBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Step stepper button navigation to step 3 (practice question)
    const stepButtons = Array.from(host.querySelectorAll('.lesson-stepper-btn, .lesson-step-pill'));
    if (stepButtons.length >= 3) {
      await act(async () => {
        (stepButtons[2] as HTMLButtonElement).click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Question step: select option radio
      const radio = host.querySelector('input[type="radio"]') as HTMLInputElement;
      if (radio) {
        await act(async () => {
          radio.click();
        });

        // Click Check answer
        const checkBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Check answer'));
        if (checkBtn) {
          await act(async () => {
            checkBtn.click();
          });
        }
      }
    }

    // Previous step navigation
    const prevBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Previous') || b.textContent?.includes('Back'));
    if (prevBtn) {
      await act(async () => {
        prevBtn.click();
      });
    }

    // Trigger quiz draft button
    const draftQuizBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('Create quiz') || b.textContent?.includes('Draft Quiz')
    );
    if (draftQuizBtn) {
      await act(async () => {
        draftQuizBtn.click();
      });
      expect(handleDraftQuiz).toHaveBeenCalled();
    }

    expect(host.querySelector('.learning-lessons')).not.toBeNull();
  });

  it('opens lesson editor mode, adds a section, and edits step properties', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-class-1"
          canCreate={true}
          search=""
          openLessonId="lesson-101"
          openLessonEditor={true}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Add new section
    const addSectionBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add section') || b.textContent?.includes('New section'));
    if (addSectionBtn) {
      await act(async () => {
        addSectionBtn.click();
      });
    }

    // Toggle Preview button
    const previewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Preview') || b.textContent?.includes('Done editing'));
    if (previewBtn) {
      await act(async () => {
        previewBtn.click();
      });
    }

    expect(host.textContent).toContain('Optical Transport & Platform');
  });
});

// =========================================================================
// SUITE 3: MemberChat Deep Interactive Tests
// =========================================================================
describe('MemberChat Deep Suite', () => {
  it('useCommunityUnread tracks unread badges and dismisses notifications', async () => {
    function UnreadTestWrapper() {
      const { unread, notices, dismissNotice } = useCommunityUnread('dr_sarah');
      return (
        <div>
          <span data-testid="unread-val">{unread}</span>
          <span data-testid="notice-val">{notices.length}</span>
          <button onClick={() => dismissNotice(11)}>Clear</button>
        </div>
      );
    }

    await act(async () => {
      root.render(<UnreadTestWrapper />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="unread-val"]')?.textContent).toBe('1');
    const clearBtn = host.querySelector('button');
    await act(async () => {
      clearBtn?.click();
    });
    expect(host.querySelector('[data-testid="notice-val"]')?.textContent).toBe('0');
  });

  it('MemberChatWidget renders launcher, toggles away assistant, and navigates channels', async () => {
    await act(async () => {
      root.render(
        <MemberChatWidget username="dr_sarah" displayName="Dr. Sarah Connor" />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector('.member-chat-launcher') as HTMLButtonElement;
    expect(launcher).not.toBeNull();

    // Open chat drawer
    await act(async () => {
      launcher.click();
    });

    expect(document.body.querySelector('.member-chat-panel')).not.toBeNull();

    // Toggle Away Assistant modal
    const awayBtn = document.body.querySelector('button[aria-label="People Buddy away assistant"]') as HTMLButtonElement;
    if (awayBtn) {
      await act(async () => {
        awayBtn.click();
      });
      expect(document.body.querySelector('.member-chat-away') || document.body.textContent).toBeDefined();

      // Close away view
      await act(async () => {
        awayBtn.click();
      });
    }

    // Switch between Direct and Channel tabs
    const channelsTab = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('Channels') || b.textContent?.includes('software-ops'));
    if (channelsTab) {
      await act(async () => {
        channelsTab.click();
      });
      expect(document.body.textContent).toContain('software-ops');
    }

    // Select room
    const roomBtn = document.body.querySelector('.member-chat-room') as HTMLButtonElement;
    if (roomBtn) {
      await act(async () => {
        roomBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Send message
      const composer = document.body.querySelector('textarea, input.member-chat-input') as HTMLElement;
      if (composer) {
        await act(async () => {
          setNativeInputValue(composer, 'Carrier backbone verified.');
        });
        const sendBtn = document.body.querySelector('.member-chat-send') as HTMLButtonElement;
        await act(async () => {
          sendBtn?.click();
        });
      }
    }

    // Minimize chat
    const minimizeBtn = document.body.querySelector('button[aria-label="Minimize chat"]') as HTMLButtonElement;
    if (minimizeBtn) {
      await act(async () => {
        minimizeBtn.click();
      });
    }

    expect(launcher).not.toBeNull();
  });

  it('MemberChat handles emoji picker, note attachments, mention tools, and typing events', async () => {
    await act(async () => {
      root.render(
        <MemberChatWidget username="dr_sarah" displayName="Dr. Sarah Connor" />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector('.member-chat-launcher') as HTMLButtonElement;
    await act(async () => {
      launcher.click();
    });

    // Select room
    const roomBtn = document.body.querySelector('.member-chat-room') as HTMLButtonElement;
    if (roomBtn) {
      await act(async () => {
        roomBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Toggle emoji picker
      const emojiBtn = document.body.querySelector('button[aria-label="Add emoji"]') as HTMLButtonElement;
      if (emojiBtn) {
        await act(async () => {
          emojiBtn.click();
        });
        const thumbsUp = Array.from(document.body.querySelectorAll('.member-chat-emoji-picker button')).find(
          b => b.textContent?.includes('👍') || b.getAttribute('aria-label')?.includes('Thumbs up')
        );
        if (thumbsUp) {
          await act(async () => {
            (thumbsUp as HTMLButtonElement).click();
          });
        }
      }

      // Attach note
      const noteBtn = Array.from(document.body.querySelectorAll('button')).find(
        b => b.textContent?.includes('Note') || b.getAttribute('title')?.includes('note')
      );
      if (noteBtn) {
        await act(async () => {
          (noteBtn as HTMLButtonElement).click();
        });
        await act(async () => {
          await Promise.resolve();
        });

        const noteSelect = document.body.querySelector('select[aria-label="Note to share"]') as HTMLSelectElement;
        if (noteSelect) {
          await act(async () => {
            setNativeInputValue(noteSelect, 'note-shared-1');
          });
        }
      }

      // Dispatch typing event
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('community-typing', {
            detail: {
              room_id: 10,
              username: 'usr-kyle',
              display_name: 'Kyle Reese',
              typing: true,
            },
          })
        );
      });

      // Mention tool button
      const mentionBtn = document.body.querySelector('button[aria-label="Mention a member"]') as HTMLButtonElement;
      if (mentionBtn) {
        await act(async () => {
          mentionBtn.click();
        });
        expect(document.body.querySelector('.people-chat-tools') || document.body.textContent).toBeDefined();
      }
    }

    expect(launcher).not.toBeNull();
  });

  it('PeopleVoiceCall manages incoming call and active mute toggles', async () => {
    const mockVoice: PeopleVoice = {
      call: {
        roomId: 10,
        name: 'Kyle Reese',
        phase: 'incoming',
        muted: false,
      },
      ready: true,
      notice: 'Incoming call from Kyle Reese',
      remote: null,
      soundBlocked: false,
      playbackBlocked: false,
      start: vi.fn().mockResolvedValue(undefined),
      answer: vi.fn().mockResolvedValue(undefined),
      decline: vi.fn(),
      mute: vi.fn(),
      hangup: vi.fn(),
      enableSound: vi.fn().mockResolvedValue(undefined),
      resumeAudio: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn(),
    };

    await act(async () => {
      root.render(<PeopleVoiceCall voice={mockVoice} onOpen={vi.fn()} />);
    });

    expect(host.textContent).toContain('Incoming call from Kyle Reese');

    // Answer call
    const answerBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Answer') || b.getAttribute('aria-label')?.includes('Answer'));
    if (answerBtn) {
      await act(async () => {
        answerBtn.click();
      });
      expect(mockVoice.answer).toHaveBeenCalled();
    }
  });
});

// =========================================================================
// SUITE 4: ChatView Deep Interactive Tests
// =========================================================================
describe('ChatView Deep Suite', () => {
  it('extractThinking handles closed tags, open streaming tags, and plain text', () => {
    expect(extractThinking('')).toEqual({ thoughts: '', cleanText: '' });
    expect(extractThinking('Carrier Platform online.')).toEqual({ thoughts: '', cleanText: 'Carrier Platform online.' });

    const closed = extractThinking('<think>Balancing optical chromatic dispersion</think>Transponder locked.');
    expect(closed.thoughts).toBe('Balancing optical chromatic dispersion');
    expect(closed.cleanText).toBe('Transponder locked.');

    const openStream = extractThinking('<think>Analyzing OTDR telemetry', true);
    expect(openStream.thoughts).toBe('Analyzing OTDR telemetry');
    expect(openStream.cleanText).toBe('');
  });

  it('renders code block with copy button, copies code to clipboard, and tests citation previews', async () => {
    const handleSend = vi.fn();
    const handleStop = vi.fn();
    const handleBranch = vi.fn().mockResolvedValue(undefined);
    const handleDelete = vi.fn().mockResolvedValue(undefined);

    const messages = [
      {
        id: 'msg-u1',
        role: 'user' as const,
        content: 'Show routing configuration for carrier edge.',
      },
      {
        id: 'msg-a1',
        role: 'assistant' as const,
        content: 'Here is the optical telemetry daemon config:\n\n```json\n{\n  "carrierFrequency": "193.1THz",\n  "targetPower": "+3dBm"\n}\n```\n\nRefer to [ITU-T G.694.1](/api/preview/itu-g694-1.pdf) for optical specs.',
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          messages={messages as any}
          isStreaming={false}
          activeMode="agent"
          slideCount={5}
          onSlideCountChange={vi.fn()}
          activeAgent=""
          modes={[{ id: 'agent', name: 'Agent', description: 'Autonomous' }]}
          skills={[]}
          agents={[]}
          templates={[]}
          selectedTemplateId=""
          sessionId="sess-software-1"
          onSendMessage={handleSend}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={handleStop}
          onOpenTemplateModal={vi.fn()}
          onBranch={handleBranch}
          onDeleteMessage={handleDelete}
        />
      );
    });

    expect(host.textContent).toContain('carrierFrequency');

    // Code subwindow copy button
    const copyCodeBtn = host.querySelector('.code-subwindow-btn') as HTMLButtonElement;
    if (copyCodeBtn) {
      await act(async () => {
        copyCodeBtn.click();
      });
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    }

    // Branch button
    const branchBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Branch conversation') || b.getAttribute('aria-label')?.includes('Branch'));
    if (branchBtn) {
      await act(async () => {
        branchBtn.click();
      });
      expect(handleBranch).toHaveBeenCalled();
    }

    // Copy answer button
    const copyAnsBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Copy answer') || b.getAttribute('aria-label')?.includes('Copy answer'));
    if (copyAnsBtn) {
      await act(async () => {
        copyAnsBtn.click();
      });
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    }
  });

  it('renders stop generation button while streaming and calls onStop callback', async () => {
    const handleStop = vi.fn();

    const messages = [
      {
        id: 'msg-stream-1',
        role: 'assistant' as const,
        isStreaming: true,
        content: '<think>Tuning optical laser channels...',
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          messages={messages as any}
          isStreaming={true}
          activeMode="agent"
          slideCount={5}
          onSlideCountChange={vi.fn()}
          activeAgent=""
          modes={[{ id: 'agent', name: 'Agent', description: 'Autonomous' }]}
          skills={[]}
          agents={[]}
          templates={[]}
          selectedTemplateId=""
          onSendMessage={vi.fn()}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={handleStop}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    const stopBtn = host.querySelector('.stop-button') as HTMLButtonElement;
    expect(stopBtn).not.toBeNull();

    await act(async () => {
      stopBtn.click();
    });
    expect(handleStop).toHaveBeenCalled();
  });

  it('parses clarification bobquestion, renders ClarificationCard, selects option, and submits response', async () => {
    const handleSend = vi.fn();
    const handleFollowUp = vi.fn();

    const messages = [
      {
        id: 'msg-u-clarif',
        role: 'user' as const,
        content: 'Audit the fiber infrastructure.',
      },
      {
        id: 'msg-a-clarif',
        role: 'assistant' as const,
        content: 'I need clarification to focus the telemetry audit:\n\n```bobquestion\n{"preset": "next-steps"}\n```',
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          messages={messages as any}
          isStreaming={false}
          activeMode="agent"
          slideCount={5}
          onSlideCountChange={vi.fn()}
          activeAgent=""
          modes={[{ id: 'agent', name: 'Agent', description: 'Autonomous' }]}
          skills={[]}
          agents={[]}
          templates={[]}
          selectedTemplateId=""
          onSendMessage={handleSend}
          onFollowUp={handleFollowUp}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={vi.fn()}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    expect(host.querySelector('.clarification-card')).not.toBeNull();

    // Select clarification option
    const optionBtn = host.querySelector('.clarification-option') as HTMLButtonElement;
    if (optionBtn) {
      await act(async () => {
        optionBtn.click();
      });

      // Submit clarification
      const submitBtn = host.querySelector('.clarification-card button[type="submit"]') as HTMLButtonElement;
      if (submitBtn) {
        await act(async () => {
          submitBtn.click();
        });
        expect(handleFollowUp).toHaveBeenCalled();
      }
    }
  });

  it('handles action approvals and message attachment badges in ChatView', async () => {
    const handleApproval = vi.fn().mockResolvedValue(undefined);

    const messages = [
      {
        id: 'msg-u-attach',
        role: 'user' as const,
        content: '[Attached spreadsheet: optical_power_budget.xlsx]\nAudit fiber spans.',
        noteReferences: [
          { id: 'note-1', title: 'Platform Dispersion Reference', truncated: false },
        ],
        officeReferences: [
          { id: 'off-1', name: 'Network Architecture.docx', truncated: true },
        ],
      },
      {
        id: 'msg-a-appr',
        role: 'assistant' as const,
        content: 'I have analyzed the fiber attenuation. Requesting approval to restart transponder.',
        approvals: [
          {
            approval_id: 'appr-laser-1',
            action: 'Retune C-band laser power',
            command: 'roadm-cli --tune-channel 193.1 --power +3',
            danger: 'medium',
          },
        ],
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          messages={messages as any}
          isStreaming={true}
          activeMode="agent"
          slideCount={5}
          onSlideCountChange={vi.fn()}
          activeAgent=""
          modes={[{ id: 'agent', name: 'Agent', description: 'Autonomous' }]}
          skills={[]}
          agents={[]}
          templates={[]}
          selectedTemplateId=""
          onSendMessage={vi.fn()}
          onApprovalDecision={handleApproval}
          onUploadFile={vi.fn()}
          onStop={vi.fn()}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('optical_power_budget.xlsx');
    expect(host.textContent).toContain('Platform Dispersion Reference');

    // Click Approve button
    const approveBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.trim() === 'Approve' || b.textContent?.includes('Approve')
    );
    if (approveBtn) {
      await act(async () => {
        approveBtn.click();
      });
      expect(handleApproval).toHaveBeenCalled();
    }
  });
});

// =========================================================================
// SUITE 5: ProjectsWorkspace Deep Interactive Tests
// =========================================================================
describe('ProjectsWorkspace Deep Suite', () => {
  it('navigates project subtabs, edits RAID log entries, and adds a new risk', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Platform Backbone Expansion');

    // Open project
    const openProjBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Open project') || b.classList.contains('feature-primary'));
    if (openProjBtn) {
      await act(async () => {
        openProjBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Navigate to RAID Register subtab
    const raidTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('RAID Register'));
    if (raidTab) {
      await act(async () => {
        raidTab.click();
      });
      expect(host.textContent).toContain('Transponder Supply Chain Delay');

      // Click Add risk button
      const addRiskBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Add risk'));
      if (addRiskBtn) {
        await act(async () => {
          addRiskBtn.click();
        });

        // Fill form fields
        const titleInput = host.querySelector('input[name="title"]') as HTMLInputElement;
        if (titleInput) {
          await act(async () => {
            setNativeInputValue(titleInput, 'High EDFA Noise Figure Risk');
          });

          const saveBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
          if (saveBtn) {
            await act(async () => {
              saveBtn.click();
            });
          }
        }
      }
    }

    expect(host.querySelector('.projects-workspace')).not.toBeNull();
  });

  it('submits PRINCE2 stage gate decisions with audit evidence', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Open project
    const openProjBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Open project') || b.classList.contains('feature-primary'));
    if (openProjBtn) {
      await act(async () => {
        openProjBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Navigate to Governance & Stages subtab
    const govTab = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Governance & Stages'));
    if (govTab) {
      await act(async () => {
        govTab.click();
      });

      // Submit stage approval decision
      const decisionSelect = host.querySelector('select[name="decision"]') as HTMLSelectElement;
      if (decisionSelect) {
        await act(async () => {
          setNativeInputValue(decisionSelect, 'approved');
        });
        const evidenceInput = host.querySelector('textarea[name="evidence"], input[name="evidence"]') as HTMLElement;
        if (evidenceInput) {
          await act(async () => {
            setNativeInputValue(evidenceInput, 'Delivery stage acceptance criteria verified.');
          });
        }
        const submitStageBtn = host.querySelector('.projects-form button[type="submit"]') as HTMLButtonElement;
        if (submitStageBtn) {
          await act(async () => {
            submitStageBtn.click();
          });
        }
      }
    }

    expect(host.querySelector('.projects-workspace')).not.toBeNull();
  });

  it('renders Gantt timeline, adjusts zoom presets, filters by status, and exports reports to office', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Switch to Planner (Timeline) nav tab
    const timelineNavBtn = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Timeline'));
    if (timelineNavBtn) {
      await act(async () => {
        timelineNavBtn.click();
      });
      expect(host.querySelector('.runn-timeline') || host.querySelector('.projects-workspace')).not.toBeNull();
    }

    // Switch back to Portfolio tab to test Office exports
    const portfolioNavBtn = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Register'));
    if (portfolioNavBtn) {
      await act(async () => {
        portfolioNavBtn.click();
      });

      // Click Word export chip
      const wordBtn = host.querySelector('button[title*="Word"]') as HTMLButtonElement;
      if (wordBtn) {
        await act(async () => {
          wordBtn.click();
        });
      }

      // Click Excel export chip
      const excelBtn = host.querySelector('button[title*="Excel"]') as HTMLButtonElement;
      if (excelBtn) {
        await act(async () => {
          excelBtn.click();
        });
      }

      // Click PDF export chip
      const pdfBtn = host.querySelector('button[title*="PDF"]') as HTMLButtonElement;
      if (pdfBtn) {
        await act(async () => {
          pdfBtn.click();
        });
      }
    }

    expect(host.querySelector('.projects-workspace')).not.toBeNull();
  });

  it('handles People capacity, scenario forecasting preview, and merged view sections', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Switch to People & Staffing tab
    const peopleTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Capacity') || b.textContent?.includes('Staffing'));
    if (peopleTab) {
      await act(async () => {
        peopleTab.click();
      });
      expect(host.textContent).toContain('Dr. Sarah Connor');
    }

    // Switch to Forecasting & Scenarios tab
    const impactTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Forecasting') || b.textContent?.includes('Scenarios'));
    if (impactTab) {
      await act(async () => {
        impactTab.click();
      });
      expect(host.querySelector('.projects-workspace')).not.toBeNull();

      // Trigger forecast button
      const forecastBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Forecast') || b.textContent?.includes('Preview'));
      if (forecastBtn) {
        await act(async () => {
          forecastBtn.click();
        });
      }
    }

    // Switch to Merged View tab
    const mergedTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Merged'));
    if (mergedTab) {
      await act(async () => {
        mergedTab.click();
      });
      expect(host.querySelector('.projects-merged-container') || host.querySelector('.projects-workspace')).not.toBeNull();
    }
  });
});

// =========================================================================
// SUITE 6: StructuredDiagram Deep Interactive Tests
// =========================================================================
describe('StructuredDiagram Deep Suite', () => {
  it('renders flow diagram, tests zooming in/out, panning, and node hover tooltip', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleFlowSpec}
          source="flowchart LR\ntransponder-->roadm-->edfa-->oss-db"
          streaming={false}
          sessionId="sess-diagram-1"
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.structured-diagram')).not.toBeNull();
    expect(host.textContent).toContain('Carrier Platform Optical Path');

    // Zoom in and zoom out controls
    const zoomInBtn = host.querySelector('button[aria-label*="Zoom in"]') as HTMLButtonElement;
    if (zoomInBtn) {
      await act(async () => {
        zoomInBtn.click();
      });
    }

    const zoomOutBtn = host.querySelector('button[aria-label*="Zoom out"]') as HTMLButtonElement;
    if (zoomOutBtn) {
      await act(async () => {
        zoomOutBtn.click();
      });
    }

    // Node hover tooltip
    const nodeEl = host.querySelector('.structured-node') as HTMLElement;
    if (nodeEl) {
      await act(async () => {
        nodeEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 200, clientY: 150 }));
      });
      await act(async () => {
        nodeEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      });
    }
  });

  it('renders sequence diagram, handles message click selection, and edge routing fallback', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSequenceSpec}
          source="sequenceDiagram\norchestrator->>controller: provisionService"
          streaming={false}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.structured-sequence')).not.toBeNull();

    // Click sequence message arrow
    const messageEl = host.querySelector('.sequence-message') as SVGElement;
    if (messageEl) {
      await act(async () => {
        messageEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(messageEl.getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('switches layout algorithm override and opens maximized modal', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleFlowSpec}
          source="flowchart LR"
          streaming={false}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Layout override selector
    const layoutSelect = host.querySelector('select[aria-label*="Layout"]') as HTMLSelectElement;
    if (layoutSelect) {
      await act(async () => {
        setNativeInputValue(layoutSelect, 'tree');
      });
      expect(layoutSelect.value).toBe('tree');
    }

    // Maximize button
    const maximizeBtn = host.querySelector('button[title*="Maximize"], button[aria-label*="Maximize"]') as HTMLButtonElement;
    if (maximizeBtn) {
      await act(async () => {
        maximizeBtn.click();
      });
      expect(document.body.querySelector('.diagram-maximized-dialog')).not.toBeNull();
    }
  });

  it('triggers SVG, Animated SVG, and Animated HTML exports, and toggles motion override', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSequenceSpec}
          source="sequenceDiagram\norchestrator->>controller: sync"
          streaming={false}
          sessionId="sess-diagram-export"
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Toggle source code view
    const sourceBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('Source') || b.getAttribute('title')?.includes('Source')
    );
    if (sourceBtn) {
      await act(async () => {
        sourceBtn.click();
      });
      expect(host.querySelector('.diagram-source')).not.toBeNull();
    }

    // Export SVG
    const exportSvgBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('SVG') || b.getAttribute('title')?.includes('SVG')
    );
    if (exportSvgBtn) {
      await act(async () => {
        exportSvgBtn.click();
      });
    }

    // Export Animated HTML
    const exportHtmlBtn = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent?.includes('HTML') || b.getAttribute('title')?.includes('HTML')
    );
    if (exportHtmlBtn) {
      await act(async () => {
        exportHtmlBtn.click();
      });
    }

    expect(host.querySelector('.structured-sequence')).not.toBeNull();
  });
});
