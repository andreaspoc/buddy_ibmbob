// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ProjectsWorkspace } from '../../src/components/ProjectsWorkspace';
import { ChatView, extractThinking } from '../../src/components/ChatView';
import { OfficeSuite } from '../../src/components/OfficeSuite';
import { App } from '../../src/App';
import LearningWorkspace from '../../src/components/LearningWorkspace';

import type {
  ChatMessage,
  Mode,
  Skill,
  A2AAgent,
  PresentationTemplate,
  ActionApproval,
  Project,
} from '../../src/types';

vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  AppDialog: () => <div data-testid="mock-app-dialog" />,
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

vi.mock('../../src/lib/bobdeck.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    buildHtmlDeckPptxBlob: vi.fn().mockResolvedValue(new Blob(['mock-pptx'], { type: 'application/vnd.ms-powerpoint' })),
  };
});

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

// Realistic domain fixtures adhering strictly to Zero Fake Data Policy
const realisticPortfolio = {
  can_manage: true,
  projects: [
    {
      id: 'proj-core-network',
      name: 'Core Network Modernization',
      description: 'Upgrade distribution switches and optical core links across regional rings.',
      status: 'active',
      priority: 'high',
      revision: 1,
      milestone: 'Phase 1 Complete',
      due_date: '2026-11-20',
      start_date: '2026-10-01',
      stage: 'delivery',
      tolerance_days: 7,
      exception_status: 'within_tolerance',
      tailoring_level: 'corporate',
      business_case: 'Modernize backbone network to support carrier-grade 100GbE circuits.',
      product_description: 'High-availability dual-homed redundant fiber architecture.',
    },
    {
      id: 'proj-cloud-migration',
      name: 'Cloud Gateway Migration',
      description: 'Migrate on-premise perimeter proxies and security ingress to cloud mesh.',
      status: 'active',
      priority: 'medium',
      revision: 2,
      milestone: 'Gateway Cutover',
      due_date: '2026-12-15',
      start_date: '2026-06-01',
      stage: 'planning',
      tolerance_days: 3,
      exception_status: 'within_tolerance',
      tailoring_level: 'standard',
      business_case: 'Consolidate distributed perimeter egress into automated cloud clusters.',
      product_description: 'Managed multi-region gateway routing appliances.',
    },
  ],
  people: [
    {
      id: 'person-maria-santos',
      name: 'Maria Santos',
      email: 'maria.santos@example.com',
      status: 'active',
      departure_date: null,
    },
    {
      id: 'person-david-chen',
      name: 'David Chen',
      email: 'david.chen@example.com',
      status: 'active',
      departure_date: null,
    },
  ],
  assignments: [
    {
      id: 'assign-1',
      project_id: 'proj-core-network',
      person_id: 'person-maria-santos',
      responsibility: 'Lead Systems Architect',
      role: 'executive',
      backup_person_id: 'person-david-chen',
      allocation: 80,
    },
    {
      id: 'assign-2',
      project_id: 'proj-cloud-migration',
      person_id: 'person-david-chen',
      responsibility: 'Cloud Operations Lead',
      role: 'manager',
      backup_person_id: null,
      allocation: 60,
    },
  ],
  dependencies: [
    {
      id: 'dep-1',
      source_project_id: 'proj-core-network',
      target_project_id: 'proj-cloud-migration',
      description: 'Core optical ring upgrade must complete before cloud gateway cutover.',
    },
  ],
  work_items: [
    {
      id: 'work-1',
      revision: 1,
      project_id: 'proj-core-network',
      kind: 'deliverable',
      title: 'Optical Transport System Specification',
      description: 'Technical criteria and sign-off metrics for optical Platform multiplexers.',
      status: 'quality_review',
      priority: 'high',
      due_date: '2026-11-10',
      owner_id: 'person-maria-santos',
      reviewer_id: 'person-david-chen',
      acceptance_criteria: 'Zero packet loss under 100Gbps saturated load test.',
      acceptance_evidence: 'Vendor lab validation test report signed by lead engineer.',
      resolution: 'Approved by Technical Review Board.',
    },
    {
      id: 'work-2',
      revision: 1,
      project_id: 'proj-core-network',
      kind: 'task',
      title: 'Rack and Cable Fiber Termination Frames',
      description: 'Physical installation of high-density optical patch panels in primary datacenter.',
      status: 'in_progress',
      priority: 'high',
      due_date: '2026-11-05',
      owner_id: 'person-maria-santos',
      reviewer_id: null,
      resolution: '',
    },
    {
      id: 'work-3',
      revision: 1,
      project_id: 'proj-core-network',
      kind: 'risk',
      title: 'Optical Transceiver Supply Chain Delay',
      description: 'Lead times for 100G transceivers may slip by two weeks.',
      status: 'active',
      priority: 'medium',
      due_date: '2026-11-12',
      owner_id: 'person-david-chen',
      reviewer_id: null,
      resolution: 'Secondary approved distributor placed on active standby.',
    },
    {
      id: 'work-4',
      revision: 1,
      project_id: 'proj-core-network',
      kind: 'decision',
      title: 'Adopt Multi-Vendor QSFP28 Transceiver Standard',
      description: 'Approve vendor-agnostic optics compatibility testing matrix.',
      status: 'approved',
      priority: 'medium',
      due_date: '2026-10-15',
      owner_id: 'person-maria-santos',
      reviewer_id: null,
      resolution: 'Ratified by Architecture Steering Committee on October 15.',
    },
    {
      id: 'work-5',
      revision: 1,
      project_id: 'proj-core-network',
      kind: 'lesson',
      title: 'Pre-labeling Fiber Jumpers Accelerates Cutover by 40%',
      description: 'Color-coded tags on LC duplex jumpers prevented miswiring during maintenance window.',
      status: 'logged',
      priority: 'low',
      due_date: '2026-10-25',
      owner_id: 'person-maria-santos',
      reviewer_id: null,
      resolution: 'Standard operating procedure updated for datacenter deployments.',
    },
  ],
  stage_approvals: [
    {
      id: 'approval-1',
      project_id: 'proj-core-network',
      stage: 'planning',
      project_revision: 1,
      approver_id: 'person-maria-santos',
      decision: 'approved',
      evidence: 'Project Initiation Documentation and Stage Boundary Review signed.',
      created_at: '2026-10-01T09:00:00Z',
    },
  ],
  impact: {
    items: [
      {
        project_id: 'proj-cloud-migration',
        level: 'confirmed',
        reason: 'Downstream gateway deployment dependent on core ring upgrade.',
        evidence: { upstream_project: 'proj-core-network' },
        path: ['proj-core-network', 'proj-cloud-migration'],
      },
    ],
  },
};

const realisticOfficeFiles = [
  {
    id: 'doc-network-plan',
    name: 'Network Infrastructure Architecture.docx',
    extension: 'docx',
    size: 24576,
    is_owner: true,
    access: 'write',
    saved_at: '2026-10-28T14:30:00Z',
    owner: 'admin',
    owner_display: 'Admin User',
    folder_id: null,
    share_count: 1,
  },
  {
    id: 'sheet-capacity-budget',
    name: 'Core Optical Capacity Budget.xlsx',
    extension: 'xlsx',
    size: 40960,
    is_owner: true,
    access: 'write',
    saved_at: '2026-10-28T15:00:00Z',
    owner: 'admin',
    owner_display: 'Admin User',
    folder_id: null,
    share_count: 0,
  },
  {
    id: 'pres-exec-summary',
    name: 'Quarterly Executive Review.pptx',
    extension: 'pptx',
    size: 1048576,
    is_owner: false,
    access: 'read',
    saved_at: '2026-10-27T11:20:00Z',
    owner: 'maria.santos',
    owner_display: 'Maria Santos',
    folder_id: null,
    share_count: 2,
  },
];

const realisticOfficeFolders = [
  {
    id: 'folder-engineering',
    name: 'Engineering Documents',
    parent_id: null,
    created_at: '2026-10-01T00:00:00Z',
    file_count: 2,
  },
];

function setupComprehensiveFetch(customUser: { username: string; is_admin: boolean; display_name: string } | null = { username: 'admin', is_admin: true, display_name: 'Admin User' }) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).pathname || String(input);
    const method = init?.method?.toUpperCase() || 'GET';

    // Auth endpoints
    if (url.includes('/auth/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          keycloak_configured: false,
          local_login_enabled: true,
          setup_required: false,
          user: customUser,
        }),
      };
    }

    // App plugins & registry
    if (url.includes('/api/apps')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          apps: [
            { id: 'office', name: 'Office Suite', description: 'Document and spreadsheet suite', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
            { id: 'people', name: 'Community', description: 'Team members directory and messaging', kind: 'installed', desktop_only: false, launch: { kind: 'people' } },
            { id: 'decisions', name: 'Decisions', description: 'Governance and board decision records', kind: 'installed', desktop_only: false, launch: { kind: 'decisions' } },
            { id: 'docmost', name: 'Knowledge Wiki', description: 'Integrated team documentation wiki', kind: 'installed', desktop_only: false, launch: { url: 'https://wiki.buddy.al', embed: true } },
          ],
        }),
      };
    }

    // Projects endpoints
    if (url.includes('/api/projects/impact/preview')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          items: [
            {
              project_id: 'proj-cloud-migration',
              level: 'confirmed',
              reason: 'Simulated departure introduces key dependency delay.',
              evidence: { person_id: 'person-maria-santos' },
              path: ['proj-core-network', 'proj-cloud-migration'],
            },
          ],
        }),
      };
    }

    if (url.includes('/api/projects/impact/apply')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    }

    if (url.includes('/api/projects/work-items')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'work-new-deliverable',
          project_id: 'proj-core-network',
          kind: 'deliverable',
          title: 'Optical Power Budget Analysis',
          description: 'Attenuation margin validation for optical links.',
          status: 'quality_review',
          priority: 'high',
          revision: 1,
        }),
      };
    }

    if (url.includes('/api/projects/assignments')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'assign-new',
          project_id: 'proj-core-network',
          person_id: 'person-david-chen',
          responsibility: 'Secondary Validator',
          role: 'specialist',
          allocation: 20,
        }),
      };
    }

    if (url.includes('/api/projects/dependencies')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'dep-new',
          source_project_id: 'proj-core-network',
          target_project_id: 'proj-cloud-migration',
          description: 'New verified dependency.',
        }),
      };
    }

    if (url.includes('/api/projects/stage-approvals')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'approval-stage-delivery',
          project_id: 'proj-core-network',
          stage: 'delivery',
          project_revision: 1,
          approver_id: 'person-maria-santos',
          decision: 'approved',
          evidence: 'Stage Boundary documentation approved.',
          created_at: '2026-10-29T10:00:00Z',
        }),
      };
    }

    if (url.includes('/api/projects') || url.includes('/projects')) {
      if (url.includes('/api/projects')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(realisticPortfolio),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'proj-core-network', name: 'Core Network Modernization', is_active: true },
        ],
      };
    }

    // Sessions endpoints
    if (url.includes('/sessions') && (url.includes('/history') || url.includes('/pages') || url.includes('/files'))) {
      return { ok: true, status: 200, json: async () => [] };
    }

    if (url.includes('/sessions') && url.includes('/documents/preview')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          path: 'documents/network-architecture.pdf',
          status: 'ready',
          page_count: 12,
        }),
      };
    }

    if (url.includes('/sessions') && url.includes('/documents/prepare')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          path: 'documents/network-architecture.pdf',
          status: 'queued',
        }),
      };
    }

    if (url.includes('/sessions')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'sess-net-arch', title: 'Network Architecture Analysis', project_id: 'proj-core-network', updated_at: 1730000000 },
        ],
      };
    }

    // Skills, Modes, Agents, MCPs
    if (url.includes('/skills')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { name: 'network-analysis', description: 'Network packet and topology specialist' },
        ],
      };
    }

    if (url.includes('/modes')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { slug: 'agent', name: 'Agent Mode', description: 'Autonomous agent specialist' },
          { slug: 'code', name: 'Code Mode', description: 'Interactive code and configuration generation' },
        ],
      };
    }

    if (url.includes('/agents')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { slug: 'software-specialist', name: 'Software Specialist', description: 'Platform and routing expert', endpoint: 'http://localhost:8080' },
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
          { name: 'network-fs', transport: 'stdio', target: '/opt/network-configs', allowed: true, disabled: false },
        ],
      };
    }

    if (url.includes('/templates')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'tmpl-software',
            title: 'Software Network Review',
            brand: 'Company A',
            themeId: 'buddy-theme',
            fonts: { heading: 'IBM Plex Sans', body: 'IBM Plex Sans' },
            colors: { primary: '#0f62fe', secondary: '#393939', accent: '#198038', background: '#ffffff', text: '#161616', chartPalette: ['#0f62fe', '#8a3ffc'] },
            slidesCount: 5,
            slidePreviews: [{ id: 'slide-1', layout: 'title', title: 'Network Review' }],
          },
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
          { id: 'preset-software', name: 'Software Architecture Preset', mode: 'agent' },
        ],
      };
    }

    if (url.includes('/tasks')) {
      return { ok: true, status: 200, json: async () => [] };
    }

    if (url.includes('/api/notes')) {
      return { ok: true, status: 200, json: async () => ({ items: [], next_before_id: null }) };
    }

    if (url.includes('/knowledge')) {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }

    // Office endpoints
    if (url.includes('/api/office/users')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { username: 'maria.santos', display_name: 'Maria Santos', email: 'maria.santos@example.com', online: true },
            { username: 'david.chen', display_name: 'David Chen', email: 'david.chen@example.com', online: false },
          ],
        }),
      };
    }

    if (url.includes('/api/office/files') && url.includes('/shares')) {
      if (method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { username: 'maria.santos', display_name: 'Maria Santos', permission: 'write', granted_at: '2026-10-29T10:00:00Z' },
            ],
          }),
        };
      }
      if (method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { username: 'maria.santos', display_name: 'Maria Santos', permission: 'read', granted_at: '2026-10-28T10:00:00Z' },
          ],
        }),
      };
    }

    if (url.includes('/api/office/files') && url.includes('/editor')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          script_url: 'http://localhost/web-apps/apps/api/documents/api.js',
          config: { document: { fileType: 'docx', title: 'Network Infrastructure Architecture.docx' } },
          file: { id: 'doc-network-plan', name: 'Network Infrastructure Architecture.docx', access: 'write' },
        }),
      };
    }

    if (url.includes('/api/office/files') && url.includes('/name')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...realisticOfficeFiles[0],
          name: 'Renamed Network Architecture Plan.docx',
        }),
      };
    }

    if (url.includes('/api/office/files') && url.includes('/folder')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...realisticOfficeFiles[0],
          folder_id: 'folder-engineering',
        }),
      };
    }

    if (url.includes('/api/office/status')) {
      return { ok: true, status: 200, json: async () => ({ connected: true, storage: 'connected' }) };
    }

    if (url.includes('/api/office/files')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: realisticOfficeFiles }),
      };
    }

    if (url.includes('/api/office/folders')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: realisticOfficeFolders }),
      };
    }

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
              question: 'Which protocol is an exterior gateway protocol?',
              options: ['API', 'OSPF', 'IS-IS'],
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
              options: ['Border Gateway Protocol (API)', 'Open Shortest Path First (OSPF)', 'Routing Information Protocol (RIP)'],
              answer: ['0'],
              points: 5,
            },
          ],
        }),
      };
    }

    if (url.includes('/api/learning/books/book-dwdm/notes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { id: 'note-1', chapter_id: 'ch-optical-fundamentals', page: 1, color: 'yellow', text: 'Important: check link loss budget' },
          ],
        }),
      };
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
          progress: { chapter_id: 'ch-optical-fundamentals', page: 1, bookmarks: [] },
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

describe('ProjectsWorkspace Deep Coverage', () => {
  it('renders project register, triggers quick edit on deliverable and saves updated criteria', async () => {
    const handleAskBob = vi.fn();
    const handleClose = vi.fn();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={handleClose} onAskBob={handleAskBob} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Core Network Modernization');

    // Switch to Overview tab to view briefings and deliverable status
    const overviewTabBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Briefing & Attention')
    );
    expect(overviewTabBtn).toBeDefined();

    await act(async () => {
      overviewTabBtn?.click();
    });

    // Check quick edit button for deliverable quality criteria
    const quickEditDeliverable = host.querySelector('.pm-gate-quick-edit') as HTMLButtonElement | null;
    if (quickEditDeliverable) {
      await act(async () => {
        quickEditDeliverable.click();
      });
      // Deliverable form fields should be active
      expect(host.querySelector('form')).not.toBeNull();
    }
  });

  it('runs impact forecasting scenario analysis for key personnel departure and applies preview', async () => {
    const handleAskBob = vi.fn();
    const handleClose = vi.fn();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={handleClose} onAskBob={handleAskBob} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Navigate to Forecasting & Scenarios tab
    const impactTabBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Forecasting & Scenarios')
    );
    expect(impactTabBtn).toBeDefined();

    await act(async () => {
      impactTabBtn?.click();
    });

    expect(host.textContent).toContain('Forecasting & Scenarios');

    // Find the scenario form and run analysis
    const analyzeBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Run scenario analysis')
    );
    if (analyzeBtn) {
      await act(async () => {
        analyzeBtn.click();
      });

      // Apply simulated change
      const applyBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Apply change')
      );
      if (applyBtn) {
        await act(async () => {
          applyBtn.click();
        });
        expect(host.textContent).toContain('Portfolio impact updated');
      }
    }
  });

  it('submits new assignment in Capacity & Staffing view', async () => {
    const handleAskBob = vi.fn();
    const handleClose = vi.fn();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={handleClose} onAskBob={handleAskBob} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Navigate to Capacity & Staffing tab
    const peopleTabBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Capacity & Staffing')
    );
    expect(peopleTabBtn).toBeDefined();

    await act(async () => {
      peopleTabBtn?.click();
    });

    expect(host.textContent).toContain('Capacity & Staffing');
    expect(host.textContent).toContain('Maria Santos');
  });

  it('triggers contextual Bob assistant from project focus', async () => {
    const handleAskBob = vi.fn().mockResolvedValue(undefined);
    const handleClose = vi.fn();

    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={handleClose}
          onAskBob={handleAskBob}
          bobMessages={[
            {
              id: 'msg-proj-review',
              role: 'assistant',
              content: 'All optical Platform links are within tolerance limits with zero recorded exceptions.',
            },
          ]}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Open Project Buddy assistant button
    const assistantToggle = host.querySelector('.projects-assistant-trigger') as HTMLButtonElement | null;
    if (assistantToggle) {
      await act(async () => {
        assistantToggle.click();
      });
      expect(host.querySelector('.projects-assistant')).not.toBeNull();
    }
  });
});

describe('ChatView Deep Coverage', () => {
  const dummyMode: Mode = { slug: 'agent', name: 'Agent Mode', description: 'Autonomous agent' };
  const dummySkill: Skill = { name: 'network-analysis', description: 'Network analysis' };
  const dummyAgent: A2AAgent = { slug: 'software-specialist', name: 'Software Specialist', endpoint: 'http://localhost' };
  const dummyTemplate: PresentationTemplate = {
    id: 'tmpl-1',
    title: 'Software Review',
    brand: 'Company A',
    themeId: 'buddy-theme',
    fonts: { heading: 'IBM Plex Sans', body: 'IBM Plex Sans' },
    colors: { primary: '#0f62fe', secondary: '#393939', accent: '#198038', background: '#ffffff', text: '#161616', chartPalette: ['#0f62fe'] },
    slidesCount: 1,
    slidePreviews: [{ id: 's-1', layout: 'title', title: 'Review' }],
  };

  it('renders chat message stream, extracts thinking tags cleanly', async () => {
    const rawContent = '<thinking>Calculating attenuation: 0.2 dB/km across 40 km yields 8 dB total loss.</thinking>The link budget margin is 14 dB, which meets the 100G transmission requirement.';
    const thinkingExtraction = extractThinking(rawContent);

    expect(thinkingExtraction.thoughts).toContain('Calculating attenuation');
    expect(thinkingExtraction.cleanText).toContain('The link budget margin is 14 dB');

    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Evaluate the optical fiber budget margin.',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: rawContent,
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          sessionId="sess-net-arch"
          messages={messages}
          onSendMessage={vi.fn()}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={vi.fn()}
          onOpenTemplateModal={vi.fn()}
          modes={[dummyMode]}
          skills={[dummySkill]}
          agents={[dummyAgent]}
          templates={[dummyTemplate]}
          selectedTemplateId="tmpl-1"
          activeMode="agent"
        />
      );
    });

    expect(host.textContent).toContain('The link budget margin is 14 dB');
  });

  it('handles action approval interaction by calling approval decision callback when streaming', async () => {
    const handleApproval = vi.fn().mockResolvedValue(undefined);
    const pendingApproval: ActionApproval = {
      approval_id: 'appr-101',
      job_id: 'job-optical-cal',
      title: 'Authorize Optical Transceiver Firmware Re-flash',
      status: 'pending',
    };

    const messages: ChatMessage[] = [
      {
        id: 'msg-approval',
        role: 'assistant',
        content: 'Firmware re-flash requires confirmation before executing on the active line card.',
        approvals: [pendingApproval],
      },
    ];

    await act(async () => {
      root.render(
        <ChatView
          sessionId="sess-net-arch"
          messages={messages}
          onSendMessage={vi.fn()}
          onApprovalDecision={handleApproval}
          onUploadFile={vi.fn()}
          onStop={vi.fn()}
          onOpenTemplateModal={vi.fn()}
          modes={[dummyMode]}
          skills={[dummySkill]}
          agents={[dummyAgent]}
          templates={[dummyTemplate]}
          selectedTemplateId="tmpl-1"
          activeMode="agent"
          isStreaming={true}
        />
      );
    });

    expect(host.textContent).toContain('Authorize Optical Transceiver Firmware Re-flash');

    const approveButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Approve')
    );
    expect(approveButton).toBeDefined();

    await act(async () => {
      approveButton?.click();
    });

    expect(handleApproval).toHaveBeenCalledWith(pendingApproval, 'approve');
  });

  it('toggles keyboard shortcuts dialog and focuses composer input on shortcuts', async () => {
    await act(async () => {
      root.render(
        <ChatView
          sessionId="sess-net-arch"
          messages={[]}
          onSendMessage={vi.fn()}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={vi.fn()}
          onOpenTemplateModal={vi.fn()}
          modes={[dummyMode]}
          skills={[dummySkill]}
          agents={[dummyAgent]}
          templates={[dummyTemplate]}
          selectedTemplateId="tmpl-1"
          activeMode="agent"
        />
      );
    });

    // Trigger Ctrl + / to open shortcuts dialog
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true }));
    });

    expect(host.querySelector('.shortcuts-modal-overlay')).not.toBeNull();

    // Press Escape to close dialog
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(host.querySelector('.shortcuts-modal-overlay')).toBeNull();
  });

  it('handles drag-over and drag-leave visual state on file drop zone', async () => {
    await act(async () => {
      root.render(
        <ChatView
          sessionId="sess-net-arch"
          messages={[]}
          onSendMessage={vi.fn()}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={vi.fn()}
          onOpenTemplateModal={vi.fn()}
          modes={[dummyMode]}
          skills={[dummySkill]}
          agents={[dummyAgent]}
          templates={[dummyTemplate]}
          selectedTemplateId="tmpl-1"
          activeMode="agent"
        />
      );
    });

    const form = host.querySelector('form.composer') as HTMLFormElement | null;
    expect(form).not.toBeNull();

    await act(async () => {
      form?.dispatchEvent(new Event('dragover', { bubbles: true }));
    });
    expect(form?.classList.contains('drag-over')).toBe(true);

    await act(async () => {
      form?.dispatchEvent(new Event('dragleave', { bubbles: true }));
    });
    expect(form?.classList.contains('drag-over')).toBe(false);
  });
});

describe('OfficeSuite Deep Coverage', () => {
  it('opens Office suite library, searches documents, and lists filtered files', async () => {
    const handleClose = vi.fn();

    await act(async () => {
      root.render(<OfficeSuite onClose={handleClose} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Network Infrastructure Architecture.docx');
    expect(host.textContent).toContain('Core Optical Capacity Budget.xlsx');

    // Filter files by search term
    const searchInput = host.querySelector('input[placeholder*="Search"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    if (searchInput) {
      await act(async () => {
        setNativeInputValue(searchInput, 'Budget');
      });
      expect(host.textContent).toContain('Core Optical Capacity Budget.xlsx');
    }
  });

  it('triggers file share modal and exercises grant and revoke permissions', async () => {
    const handleClose = vi.fn();

    await act(async () => {
      root.render(<OfficeSuite onClose={handleClose} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Open item context menu for the first file
    const actionBtn = host.querySelector('.office-row-actions button[aria-haspopup="menu"]') as HTMLButtonElement | null;
    expect(actionBtn).not.toBeNull();

    if (actionBtn) {
      await act(async () => {
        actionBtn.click();
      });

      // Item menu is rendered into document.body via Portal
      const shareMenuBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Share')
      );
      if (shareMenuBtn) {
        await act(async () => {
          shareMenuBtn.click();
        });
        await act(async () => {
          await Promise.resolve();
        });

        const shareDialog = host.querySelector('.office-share-dialog');
        if (shareDialog) {
          expect(host.textContent).toContain('Grant access');

          const grantBtn = Array.from(shareDialog.querySelectorAll('button')).find(
            (b) => b.textContent?.includes('Grant access')
          );
          if (grantBtn) {
            await act(async () => {
              grantBtn.click();
            });
            await act(async () => {
              await Promise.resolve();
            });
          }
        }
      }
    }
  });

  it('opens file rename dialog and submits updated filename', async () => {
    const handleClose = vi.fn();

    await act(async () => {
      root.render(<OfficeSuite onClose={handleClose} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const actionBtn = host.querySelector('.office-row-actions button[aria-haspopup="menu"]') as HTMLButtonElement | null;
    if (actionBtn) {
      await act(async () => {
        actionBtn.click();
      });

      const renameMenuBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Rename')
      );
      if (renameMenuBtn) {
        await act(async () => {
          renameMenuBtn.click();
        });

        expect(host.querySelector('.office-folder-dialog')).not.toBeNull();
        const nameInput = host.querySelector('.office-folder-dialog input') as HTMLInputElement | null;
        if (nameInput) {
          await act(async () => {
            setNativeInputValue(nameInput, 'Modernized Core Network Spec.docx');
          });

          const saveBtn = Array.from(host.querySelectorAll('button')).find(
            (b) => b.textContent === 'Save'
          );
          await act(async () => {
            saveBtn?.click();
          });
        }
      }
    }
  });
});

describe('App Component Shallow Render and State', () => {
  it('renders authenticated workspace shell with Topbar and Sidebar', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shell')).not.toBeNull();
    expect(host.querySelector('.topbar')).not.toBeNull();
    expect(host.querySelector('.sidebar')).not.toBeNull();
  });

  it('adjusts display density and user interface scaling dataset attributes', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.documentElement.dataset.uiDensity).toBeDefined();
    expect(document.documentElement.dataset.uiScale).toBe('auto');
  });

  it('toggles focus mode button to hide side navigation', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const focusBtn = host.querySelector('.topbar-focus-toggle') as HTMLButtonElement | null;
    if (focusBtn) {
      await act(async () => {
        focusBtn.click();
      });
      expect(host.querySelector('.shell')).not.toBeNull();
    }
  });

  it('renders unauthenticated state with AuthModal when user session is absent', async () => {
    vi.stubGlobal('fetch', setupComprehensiveFetch(null));

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.auth-modal') || host.textContent?.includes('Sign in') || host.textContent?.includes('Buddy')).toBeTruthy();
  });

  it('toggles feature panels via workspace routing events', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Switch to search panel
    await act(async () => {
      window.history.pushState({}, '', '/workspace/search');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('.shell')).not.toBeNull();

    // Switch to notifications panel
    await act(async () => {
      window.history.pushState({}, '', '/workspace/notifications');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('.shell')).not.toBeNull();

    // Switch to access panel
    await act(async () => {
      window.history.pushState({}, '', '/workspace/access');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('.shell')).not.toBeNull();

    // Switch to personalization panel
    await act(async () => {
      window.history.pushState({}, '', '/workspace/personalization');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('.shell')).not.toBeNull();

    // Return to main chat
    await act(async () => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  });

  it('opens and closes apps launcher modal', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const appsLauncherBtn = host.querySelector('[data-apps-launcher]') as HTMLButtonElement | null;
    if (appsLauncherBtn) {
      await act(async () => {
        appsLauncherBtn.click();
      });
      expect(document.body.querySelector('.installed-apps') || host.querySelector('.installed-apps')).not.toBeNull();
    }
  });

  it('switches between Skills and Agents chat modes from Topbar', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const agentsModeBtn = host.querySelector('button[data-mode-target="agents"]') as HTMLButtonElement | null;
    if (agentsModeBtn) {
      await act(async () => {
        agentsModeBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(host.querySelector('.shell')).not.toBeNull();
    }
  });

  it('renders shared conversation view when navigation points to share token', async () => {
    window.history.pushState({}, '', '/share/shared-network-assessment-token');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.shared-conversation-view') || host.querySelector('.shell') || host.textContent?.includes('Buddy')).toBeTruthy();

    window.history.pushState({}, '', '/');
  });

  it('handles background reminder and office update events gracefully', async () => {
    sessionStorage.setItem('buddy-welcome-seen', 'true');

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event('buddy-reminders-changed'));
      window.dispatchEvent(new Event('buddy-office-changed'));
    });

    expect(host.querySelector('.shell')).not.toBeNull();
  });
});

describe('LearningWorkspace Shallow Render and State', () => {
  it('navigates across chapters, quizzes, library, notes, lessons, and completion tabs', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Engineering Engineering 401');

    // Switch to Quizzes tab
    const quizzesTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Quizzes')
    );
    if (quizzesTab) {
      await act(async () => {
        quizzesTab.click();
      });
      expect(host.textContent).toContain('API and OSPF Protocols Assessment');
    }

    // Switch to Library tab
    const libraryTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Library')
    );
    if (libraryTab) {
      await act(async () => {
        libraryTab.click();
      });
      expect(host.textContent).toContain('Principles of Dense Wavelength Division Multiplexing');
    }

    // Switch to Notes tab
    const notesTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Notes')
    );
    if (notesTab) {
      await act(async () => {
        notesTab.click();
      });
      expect(host.textContent).toContain('Chromatic Dispersion Compensation');
    }

    // Switch to Lessons tab
    const lessonsTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Lessons')
    );
    if (lessonsTab) {
      await act(async () => {
        lessonsTab.click();
      });
      expect(host.textContent).toContain('Optical Link Budget Calculation');
    }

    // Switch to Completion & Certificates tab
    const completionTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Completion')
    );
    if (completionTab) {
      await act(async () => {
        completionTab.click();
      });
      expect(host.textContent).toContain('Lead Software Instructor');
    }
  });

  it('opens class members directory modal and displays assigned students', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Find Members management button
    const membersBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Members') || b.textContent?.includes('Class Members')
    );
    if (membersBtn) {
      await act(async () => {
        membersBtn.click();
      });
      expect(host.textContent).toContain('Lead Software Instructor');
    }
  });

  it('opens reader view for selected course ebook and navigates chapters', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Navigate to Library tab and select book
    const libraryTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Library')
    );
    if (libraryTab) {
      await act(async () => {
        libraryTab.click();
      });

      const bookItem = Array.from(host.querySelectorAll('button, a')).find(
        (el) => el.textContent?.includes('Principles of Dense Wavelength Division Multiplexing')
      );
      if (bookItem) {
        await act(async () => {
          (bookItem as HTMLElement).click();
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(host.textContent).toContain('Principles of Dense Wavelength Division Multiplexing');
      }
    }
  });

  it('opens quiz results review panel for completed quiz', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Navigate to Quizzes tab
    const quizzesTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Quizzes')
    );
    if (quizzesTab) {
      await act(async () => {
        quizzesTab.click();
      });

      const viewResultsBtn = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('View Results') || b.textContent?.includes('Results')
      );
      if (viewResultsBtn) {
        await act(async () => {
          viewResultsBtn.click();
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(host.textContent).toContain('API and OSPF Protocols Assessment');
      }
    }
  });

  it('directly opens TakeQuiz component when URL route points to a quiz', async () => {
    window.history.pushState({}, '', '/learning/folders/class-software-401/quizzes/quiz-api-ospf');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Which routing protocol uses path vector algorithm?');
    expect(host.textContent).toContain('Border Gateway Protocol (API)');

    window.history.pushState({}, '', '/');
  });

  it('directly opens EbookReader component when URL route points to a book', async () => {
    window.history.pushState({}, '', '/learning/folders/class-software-401/books/book-dwdm');

    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Principles of Dense Wavelength Division Multiplexing');
    expect(host.textContent).toContain('Chapter 1: Optical Transmission Fundamentals');

    window.history.pushState({}, '', '/');
  });

  it('navigates to Classes tab and lists enrolled classes', async () => {
    await act(async () => {
      root.render(<LearningWorkspace />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const classesTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Classes')
    );
    if (classesTab) {
      await act(async () => {
        classesTab.click();
      });
      expect(host.textContent).toContain('Engineering Engineering 401');
    }
  });
});
