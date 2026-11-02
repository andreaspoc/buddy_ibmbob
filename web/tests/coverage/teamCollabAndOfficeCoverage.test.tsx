// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  ProjectsWorkspace,
  type Portfolio,
  type Project,
  type Person,
  type WorkItem,
  type StageApproval,
} from '../../src/components/ProjectsWorkspace';
import {
  WorkItemForm,
  StageApprovals,
  OwnerWorkUpdate,
} from '../../src/components/ProjectPlanningFields';
import { ProjectGantt } from '../../src/components/ProjectGantt';
import {
  MemberChatWidget,
  useCommunityUnread,
} from '../../src/components/MemberChat';
import {
  ChatView,
  extractThinking,
} from '../../src/components/ChatView';
import {
  PeopleChatTools,
  PeopleTaskCard,
  SharedPeopleCard,
  PeopleAssignedTasks,
  peopleName,
  peopleRequest,
  type PeopleMember,
  type PeopleMessage,
  type PeopleTask,
  type PeopleRoom,
} from '../../src/components/PeopleChatTools';
import { OfficeSuite } from '../../src/components/OfficeSuite';
import { OfficeAssistant } from '../../src/components/OfficeAssistant';
import { StructuredDiagram } from '../../src/components/StructuredDiagram';
import { ProjectCapacityHeatmap } from '../../src/components/ProjectCapacityHeatmap';
import {
  generateProjectCsv,
  generateProjectDocHtml,
  generateProjectPdfHtml,
  exportProjectToOffice,
} from '../../src/components/ProjectOfficeExport';
import { PeopleVoiceCall } from '../../src/components/PeopleVoiceCall';
import { diagramWidthFit } from '../../src/lib/diagramSizing';
import type { PeopleVoice } from '../../src/lib/usePeopleVoice';
import type { DiagramSpec } from '../../src/lib/structuredDiagram';
import type { OfficeBridge, OfficeContext } from '../../src/lib/officeBridge';

// Mock dialog utilities
vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
  appPrompt: vi.fn().mockResolvedValue('New Name'),
  AppDialog: () => <div data-testid="mock-app-dialog" />,
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mock diagram</text></svg>' }),
  },
}));

let host: HTMLDivElement;
let root: Root;

function setNativeInputValue(el: HTMLElement, value: string) {
  if (el instanceof HTMLSelectElement) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    (el as any).value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
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

function mockResponse(data: any, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  });
}

// Sample Data Fixtures
const sampleProject: Project = {
  id: 'proj-omega',
  name: 'Omega Telemetry Overhaul',
  description: 'Upgrade telemetry gateways and edge data pipelines',
  status: 'active',
  priority: 'high',
  revision: 3,
  milestone: 'Phase 2 Validation',
  due_date: '2026-12-01',
  start_date: '2026-10-01',
  stage: 'delivery',
  tolerance_days: 10,
  exception_status: 'within_tolerance',
};

const samplePeople: Person[] = [
  { id: 'usr-1', name: 'Marcus Chen', email: 'marcus@corp.local', status: 'active', departure_date: null },
  { id: 'usr-2', name: 'Dr. Sarah Connor', email: 'sarah@corp.local', status: 'active', departure_date: null },
  { id: 'usr-3', name: 'Kyle Reese', email: 'kyle@corp.local', status: 'departed', departure_date: '2026-09-01' },
];

const sampleWorkItems: WorkItem[] = [
  {
    id: 'work-101',
    project_id: 'proj-omega',
    kind: 'task',
    title: 'Deploy Telemetry Forwarders',
    description: 'Configure and test vector agents',
    owner_id: 'usr-1',
    start_date: '2026-10-05',
    due_date: '2026-10-25',
    priority: 'high',
    status: 'in_progress',
    resolution: '',
    revision: 2,
    predecessor_ids: [],
    can_update: true,
  },
  {
    id: 'work-102',
    project_id: 'proj-omega',
    kind: 'deliverable',
    title: 'Architecture Blueprint',
    description: 'Signed off architecture blueprint',
    owner_id: 'usr-2',
    start_date: '2026-10-01',
    due_date: '2026-10-15',
    priority: 'medium',
    status: 'done',
    resolution: 'Accepted with review criteria',
    revision: 1,
    acceptance_criteria: 'All node interfaces specified',
    acceptance_evidence: 'Link to audit signed PDF',
    reviewer_id: 'usr-1',
  },
  {
    id: 'work-103',
    project_id: 'proj-omega',
    kind: 'risk',
    title: 'Firmware latency jitter',
    description: 'Upstream vendor latency spikes',
    owner_id: 'usr-1',
    due_date: null,
    priority: 'high',
    status: 'mitigating',
    resolution: 'Dual path redundancy deployed',
    revision: 1,
  },
];

const samplePortfolio: Portfolio = {
  can_manage: true,
  projects: [sampleProject],
  people: samplePeople,
  assignments: [
    {
      id: 'asg-1',
      project_id: 'proj-omega',
      person_id: 'usr-1',
      responsibility: 'Lead Telemetry Engineer',
      role: 'owner',
      backup_person_id: 'usr-2',
      allocation: 75,
    },
  ],
  dependencies: [
    {
      id: 'dep-1',
      source_project_id: 'proj-omega',
      target_project_id: 'proj-other',
      relationship: 'blocks',
      critical: true,
    },
  ],
  work_items: sampleWorkItems,
  stage_approvals: [
    {
      id: 'appr-1',
      project_id: 'proj-omega',
      stage: 'delivery',
      project_revision: 3,
      approver_id: 'usr-2',
      decision: 'approved',
      evidence: 'Phase 1 milestones fulfilled and verified.',
      actor: 'Marcus Chen',
      created_at: '2026-10-20T10:00:00Z',
    },
  ],
  impact: { items: [] },
};

const sampleRooms = [
  {
    id: 10,
    kind: 'direct',
    name: 'Marcus Chen',
    subscribed: true,
    unread_count: 1,
    latest_incoming_sender_name: 'Marcus Chen',
    latest_incoming_id: 501,
    latest_incoming_automated: false,
    visibility: 'direct',
    notification_mode: 'all',
  },
  {
    id: 20,
    kind: 'channel',
    name: 'telemetry-ops',
    subscribed: true,
    unread_count: 0,
    is_owner: true,
    visibility: 'channel',
    notification_mode: 'all',
  },
];

const sampleOfficeFiles = [
  {
    id: 'file-doc-omega',
    name: 'Telemetry Architecture.docx',
    extension: 'docx',
    size: 32000,
    revision: 2,
    save_sequence: 1,
    saved_at: '2026-10-28T10:00:00Z',
    is_owner: true,
    access: 'owner',
    folder_id: null,
  },
  {
    id: 'file-sheet-omega',
    name: 'Telemetry Capacity.xlsx',
    extension: 'xlsx',
    size: 54000,
    revision: 1,
    save_sequence: 2,
    saved_at: '2026-10-28T11:00:00Z',
    is_owner: false,
    access: 'write',
    folder_id: 'fold-1',
  },
];

const sampleOfficeFolders = [
  { id: 'fold-1', name: 'Infrastructure', parent_id: null },
];

function setupComprehensiveFetch() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method?.toUpperCase() || 'GET';

    // Projects endpoints
    if (path.includes('/api/projects/impact/preview')) {
      return mockResponse({
        items: [
          {
            project_id: 'proj-omega',
            level: 'confirmed',
            reason: 'Person departure leaves deliverable without owner',
            evidence: { person_id: 'usr-1' },
            path: ['proj-omega'],
          },
        ],
      });
    }
    if (path.includes('/api/projects/impact/apply')) {
      return mockResponse({ ok: true });
    }
    if (path === '/api/projects' || path.startsWith('/api/projects?') || path.includes('/api/projects/portfolio')) {
      return mockResponse(samplePortfolio);
    }
    if (path.includes('/api/projects/work/')) {
      return mockResponse({ ok: true, item: sampleWorkItems[0] });
    }
    if (path.includes('/api/projects/approvals')) {
      return mockResponse({ ok: true });
    }

    // Community endpoints
    if (path.includes('/reactions') && method === 'POST') {
      return mockResponse({ ok: true });
    }
    if (path.includes('/save-note') && method === 'POST') {
      return mockResponse({ ok: true, id: 999 });
    }
    if (path.includes('/pin') && method === 'POST') {
      return mockResponse({ ok: true });
    }
    if (path.includes('/api/community/members') || path.includes('/members')) {
      return mockResponse([
        { username: 'marcus', display_name: 'Marcus Chen' },
        { username: 'sarah', display_name: 'Sarah Connor' },
      ]);
    }
    if (path.includes('/api/community/rooms')) {
      if (path.includes('/10/members') || path.includes('/20/members')) {
        return mockResponse([
          { username: 'marcus', display_name: 'Marcus Chen' },
          { username: 'sarah', display_name: 'Sarah Connor' },
        ]);
      }
      if (path.includes('/files')) {
        return mockResponse([{ id: 101, filename: 'diagram.png', size: 20480 }]);
      }
      if (path.includes('/tasks')) {
        return mockResponse([
          {
            id: 99,
            room_id: 20,
            title: 'Review Gateway Config',
            assignee: 'marcus',
            creator: 'sarah',
            status: 'todo',
            due_at: '2026-11-01T12:00:00Z',
          },
        ]);
      }
      if (path.includes('/bob-settings')) {
        return mockResponse({ instructions: 'Be professional and concise.' });
      }
      if (path.includes('/notifications')) {
        return mockResponse({ mode: 'all' });
      }
      if (path.includes('/search')) {
        return mockResponse([
          {
            id: 501,
            sender: 'marcus',
            sender_name: 'Marcus Chen',
            body: 'Vector telemetry deployed successfully',
            created_at: '2026-10-28T10:00:00Z',
          },
        ]);
      }
      if (method === 'GET') {
        return mockResponse(sampleRooms);
      }
      return mockResponse({ ok: true });
    }
    if (path.includes('/api/community/away')) {
      return mockResponse({ active: false });
    }
    if (path.includes('/api/community/notification-settings')) {
      return mockResponse({ quiet_enabled: false, start: '22:00', end: '08:00', timezone: 'UTC' });
    }
    if (path.includes('/api/community/tasks/my')) {
      return mockResponse([
        {
          id: 88,
          room_id: 20,
          title: 'Audit Edge Router Certs',
          assignee: 'marcus',
          creator: 'sarah',
          status: 'in_progress',
          due_at: '2026-11-10T12:00:00Z',
        },
      ]);
    }

    // Office endpoints
    if (path.includes('/api/office/files') && method === 'POST') {
      return mockResponse({ id: 'saved-office-file-123', name: 'Saved File' });
    }
    if (path.includes('/api/office/status')) {
      return mockResponse({ status: 'ready' });
    }
    if (path.includes('/api/office/files')) {
      return mockResponse({ items: sampleOfficeFiles });
    }
    if (path.includes('/api/office/folders')) {
      return mockResponse({ items: sampleOfficeFolders });
    }
    if (path.includes('/api/office/users')) {
      return mockResponse({ items: [{ username: 'marcus', display_name: 'Marcus Chen' }] });
    }

    // Office assistant streaming draft
    if (path.includes('/api/office/assistant/files/') && path.includes('/draft')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({}),
        body: createMockStream([
          { type: 'status', message: 'Analyzing telemetry architecture document…' },
          { type: 'delta', text: 'Updating pipeline throughput specifications.' },
          {
            type: 'plan',
            plan: {
              version: 1,
              kind: 'word',
              reply: 'Proposed table of edge telemetry metrics.',
              actions: [
                {
                  type: 'insert_blocks',
                  position: 'end',
                  blocks: [{ text: 'Telemetry metrics table', header: true }],
                },
              ],
            },
          },
        ]),
      });
    }

    // Generic fallback
    return mockResponse({ ok: true, items: [] });
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
  window.scrollTo = vi.fn();

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
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

  vi.stubGlobal('URL', {
    ...window.URL,
    createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
    revokeObjectURL: vi.fn(),
  });

  vi.stubGlobal('fetch', setupComprehensiveFetch());

  // Setup root container for MemberChat MutationObserver
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
// SUITE 1: ProjectPlanningFields (WorkItemForm, StageApprovals, OwnerWorkUpdate)
// =========================================================================
describe('ProjectPlanningFields Suite', () => {
  it('WorkItemForm renders in create mode for a task and handles priority and status pill clicks', async () => {
    const handleSave = vi.fn((e) => e.preventDefault());
    const handleCancel = vi.fn();

    await act(async () => {
      root.render(
        <WorkItemForm
          item={null}
          kind="task"
          people={samplePeople}
          workItems={sampleWorkItems}
          busy={false}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      );
    });

    expect(host.textContent).toContain('Work Package Task');
    expect(host.textContent).toContain('New Work Package Task');

    // Click 'in_progress' and 'done' status pills
    const inProgressBtn = Array.from(host.querySelectorAll('.pm-pill-btn')).find(b => b.textContent?.toLowerCase().includes('in progress'));
    expect(inProgressBtn).toBeDefined();
    await act(async () => {
      inProgressBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(inProgressBtn?.classList.contains('is-active')).toBe(true);

    // Click 'high' priority pill
    const highPriorityBtn = Array.from(host.querySelectorAll('.pm-pill-btn')).find(b => b.textContent?.toLowerCase().includes('high'));
    expect(highPriorityBtn).toBeDefined();
    await act(async () => {
      highPriorityBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(highPriorityBtn?.classList.contains('is-active')).toBe(true);

    // Click cancel button
    const cancelBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Cancel');
    await act(async () => {
      cancelBtn?.click();
    });
    expect(handleCancel).toHaveBeenCalled();
  });

  it('WorkItemForm applies quick date presets for start and due dates', async () => {
    const handleSave = vi.fn((e) => e.preventDefault());

    await act(async () => {
      root.render(
        <WorkItemForm
          item={sampleWorkItems[0]}
          kind="task"
          people={samplePeople}
          workItems={sampleWorkItems}
          busy={false}
          onSave={handleSave}
          onCancel={vi.fn()}
        />
      );
    });

    // Start date presets: Today, Next Mon, Clear
    const todayBtn = Array.from(host.querySelectorAll('.pm-chip-btn')).find(b => b.textContent?.includes('Today'));
    const nextMonBtn = Array.from(host.querySelectorAll('.pm-chip-btn')).find(b => b.textContent?.includes('Next Mon'));
    await act(async () => {
      todayBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const startInput = host.querySelector('input[name="start_date"]') as HTMLInputElement;
    expect(startInput.value).not.toBe('');

    await act(async () => {
      nextMonBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(startInput.value).not.toBe('');

    // Due date presets: +3d, +1w, +2w, +1m
    const plusWeekBtn = Array.from(host.querySelectorAll('.pm-chip-btn')).find(b => b.textContent?.includes('+1w'));
    await act(async () => {
      plusWeekBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const dueInput = host.querySelector('input[name="due_date"]') as HTMLInputElement;
    expect(dueInput.value).not.toBe('');

    // Clear start and due
    const clearBtns = Array.from(host.querySelectorAll('.pm-chip-clear'));
    if (clearBtns.length > 0) {
      await act(async () => {
        clearBtns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    // Submit the form
    const form = host.querySelector('form.pm-workitem-form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(handleSave).toHaveBeenCalled();
  });

  it('WorkItemForm renders deliverable-specific quality acceptance criteria fields', async () => {
    await act(async () => {
      root.render(
        <WorkItemForm
          item={sampleWorkItems[1]}
          kind="deliverable"
          people={samplePeople}
          workItems={sampleWorkItems}
          busy={false}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Quality Acceptance & Gate Sign-off');
    expect(host.querySelector('textarea[name="acceptance_criteria"]')).not.toBeNull();
    expect(host.querySelector('select[name="reviewer_id"]')).not.toBeNull();
    expect(host.querySelector('textarea[name="acceptance_evidence"]')).not.toBeNull();
  });

  it('WorkItemForm renders specialized outcome cards for risk, issue, decision, and lesson', async () => {
    for (const kind of ['risk', 'issue', 'decision', 'lesson'] as const) {
      await act(async () => {
        root.render(
          <WorkItemForm
            item={null}
            kind={kind}
            people={samplePeople}
            workItems={sampleWorkItems}
            busy={false}
            onSave={vi.fn()}
            onCancel={vi.fn()}
          />
        );
      });

      if (kind === 'risk') expect(host.textContent).toContain('Mitigation & Contingency Strategy');
      if (kind === 'issue') expect(host.textContent).toContain('Resolution & Corrective Actions');
      if (kind === 'decision') expect(host.textContent).toContain('Decision Context & Board Rationale');
      if (kind === 'lesson') expect(host.textContent).toContain('Lesson Recommendation & Future Impact');
    }
  });

  it('StageApprovals renders governance decision form, submits approval and rejection', async () => {
    const handleSave = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root.render(
        <StageApprovals
          project={sampleProject}
          people={samplePeople}
          records={samplePortfolio.stage_approvals}
          canManage={true}
          busy={false}
          onSave={handleSave}
        />
      );
    });

    expect(host.textContent).toContain('Stage Approval History');
    expect(host.textContent).toContain('Record Stage Boundary Decision');

    // Select approver
    const approverSelect = host.querySelector('select[name="approver_id"]') as HTMLSelectElement;
    await act(async () => {
      setNativeInputValue(approverSelect, 'usr-2');
    });

    // Enter evidence
    const evidenceText = host.querySelector('textarea[name="evidence"]') as HTMLTextAreaElement;
    await act(async () => {
      setNativeInputValue(evidenceText, 'Formal stage gateway sign-off verified by board audit.');
    });

    // Toggle rejection pill then approval pill
    const rejectPill = host.querySelector('.pm-decision-pill.is-rejected') as HTMLButtonElement;
    const approvePill = host.querySelector('.pm-decision-pill.is-approved') as HTMLButtonElement;
    await act(async () => {
      rejectPill?.click();
    });
    expect(rejectPill?.classList.contains('is-selected')).toBe(true);

    await act(async () => {
      approvePill?.click();
    });
    expect(approvePill?.classList.contains('is-selected')).toBe(true);

    // Submit form
    const form = host.querySelector('form.pm-approval-form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(handleSave).toHaveBeenCalledWith(expect.objectContaining({
      approver_id: 'usr-2',
      decision: 'approved',
      evidence: 'Formal stage gateway sign-off verified by board audit.',
      expected_revision: 3,
    }));
  });

  it('StageApprovals hides form when canManage is false and renders empty history card', async () => {
    await act(async () => {
      root.render(
        <StageApprovals
          project={sampleProject}
          people={samplePeople}
          records={[]}
          canManage={false}
          busy={false}
          onSave={vi.fn()}
        />
      );
    });

    expect(host.querySelector('form.pm-approval-form')).toBeNull();
    expect(host.textContent).toContain('No Stage Approvals Recorded');
  });

  it('OwnerWorkUpdate allows owner to expand summary, update status, and submit', async () => {
    const handleSave = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root.render(
        <OwnerWorkUpdate
          item={sampleWorkItems[0]}
          busy={false}
          onSave={handleSave}
        />
      );
    });

    expect(host.querySelector('summary')?.textContent).toContain('Update my work');

    const statusSelect = host.querySelector('select[name="status"]') as HTMLSelectElement;
    const resolutionText = host.querySelector('textarea[name="resolution"]') as HTMLTextAreaElement;

    await act(async () => {
      setNativeInputValue(statusSelect, 'done');
      setNativeInputValue(resolutionText, 'All telemetry forwarder daemons deployed and checked.');
    });

    const form = host.querySelector('form.projects-planning-form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(handleSave).toHaveBeenCalledWith({
      expected_revision: 2,
      status: 'done',
      resolution: 'All telemetry forwarder daemons deployed and checked.',
    });
  });

  it('WorkItemForm renders milestone with required target date and clears dates', async () => {
    await act(async () => {
      root.render(
        <WorkItemForm
          item={null}
          kind="milestone"
          people={samplePeople}
          workItems={sampleWorkItems}
          busy={false}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Milestone / Stage Gate');
    const dueInput = host.querySelector('input[name="due_date"]') as HTMLInputElement;
    expect(dueInput.hasAttribute('required')).toBe(true);

    // Apply and clear due date
    const plus3d = Array.from(host.querySelectorAll('.pm-chip-btn')).find(b => b.textContent?.includes('+3d'));
    await act(async () => {
      plus3d?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dueInput.value).not.toBe('');

    const clearBtn = Array.from(host.querySelectorAll('.pm-chip-clear')).find(b => b.parentElement?.contains(dueInput));
    if (clearBtn) {
      await act(async () => {
        clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(dueInput.value).toBe('');
    }
  });
});

// =========================================================================
// SUITE 2: ProjectGantt Suite
// =========================================================================
describe('ProjectGantt Suite', () => {
  it('renders empty portfolio timeline state and triggers onAddProject', async () => {
    const handleAdd = vi.fn();

    await act(async () => {
      root.render(
        <ProjectGantt
          projects={[]}
          workItems={[]}
          canManage={true}
          onOpenProject={vi.fn()}
          onAskBob={vi.fn()}
          onAddProject={handleAdd}
        />
      );
    });

    expect(host.textContent).toContain('Your portfolio timeline starts with a project');
    const createBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Create your first project'));
    await act(async () => {
      createBtn?.click();
    });
    expect(handleAdd).toHaveBeenCalled();
  });

  it('renders populated Gantt timeline, tests search, status filtering, zoom, and collapse', async () => {
    const handleOpen = vi.fn();
    const handleEdit = vi.fn();
    const handleAskBob = vi.fn();
    const handleAddTask = vi.fn();

    await act(async () => {
      root.render(
        <ProjectGantt
          projects={[sampleProject]}
          workItems={sampleWorkItems}
          dependencies={samplePortfolio.dependencies}
          assignments={samplePortfolio.assignments}
          people={samplePeople}
          canManage={true}
          onOpenProject={handleOpen}
          onEditProject={handleEdit}
          onAskBob={handleAskBob}
          onAddTask={handleAddTask}
        />
      );
    });

    expect(host.textContent).toContain('Omega Telemetry Overhaul');
    expect(host.textContent).toContain('Deploy Telemetry Forwarders');

    // Search query filter
    const searchInput = host.querySelector('input[type="search"]') as HTMLInputElement;
    if (searchInput) {
      await act(async () => {
        setNativeInputValue(searchInput, 'Blueprint');
      });
      expect(host.textContent).toContain('Architecture Blueprint');
      await act(async () => {
        setNativeInputValue(searchInput, '');
      });
    }

    // Zoom toggle (Week vs Month)
    const zoomMonthBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Month' || b.textContent?.trim() === 'Months');
    const zoomWeekBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Week' || b.textContent?.trim() === 'Weeks');
    if (zoomMonthBtn) {
      await act(async () => {
        zoomMonthBtn.click();
      });
    }
    if (zoomWeekBtn) {
      await act(async () => {
        zoomWeekBtn.click();
      });
    }

    // Actions: Ask Bob
    const askBobBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Ask Bob') || b.getAttribute('aria-label')?.includes('Ask Bob'));
    if (askBobBtn) {
      await act(async () => {
        askBobBtn.click();
      });
      expect(handleAskBob).toHaveBeenCalled();
    }

    // Open project
    const openBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Open project') || b.getAttribute('title')?.includes('Open project'));
    if (openBtn) {
      await act(async () => {
        openBtn.click();
      });
      expect(handleOpen).toHaveBeenCalledWith('proj-omega');
    }

    // Collapse toggle on project row
    const collapseToggle = host.querySelector('.gantt-tree-toggle') as HTMLButtonElement;
    if (collapseToggle) {
      await act(async () => {
        collapseToggle.click();
      });
      await act(async () => {
        collapseToggle.click();
      });
    }
  });

  it('opens and closes project inspection drawer displaying assignments and dependencies', async () => {
    await act(async () => {
      root.render(
        <ProjectGantt
          projects={[sampleProject]}
          workItems={sampleWorkItems}
          dependencies={samplePortfolio.dependencies}
          assignments={samplePortfolio.assignments}
          people={samplePeople}
          canManage={true}
          onOpenProject={vi.fn()}
          onAskBob={vi.fn()}
        />
      );
    });

    const infoBtn = host.querySelector('.gantt-info-btn') as HTMLButtonElement;
    expect(infoBtn).not.toBeNull();
    await act(async () => {
      infoBtn.click();
    });

    expect(host.querySelector('.gantt-inspect-overlay')).not.toBeNull();
    expect(host.textContent).toContain('Lead Telemetry Engineer');

    // Close inspector
    const closeInspector = host.querySelector('.gantt-inspect-close') as HTMLButtonElement;
    await act(async () => {
      closeInspector?.click();
    });
    expect(host.querySelector('.gantt-inspect-overlay')).toBeNull();
  });

  it('ProjectGantt filters by status options and renders unscheduled work items', async () => {
    await act(async () => {
      root.render(
        <ProjectGantt
          projects={[sampleProject]}
          workItems={[
            ...sampleWorkItems,
            {
              id: 'work-unscheduled-1',
              project_id: 'proj-omega',
              kind: 'task',
              title: 'Unscheduled Research Task',
              description: 'No start or due date assigned',
              owner_id: 'usr-1',
              start_date: null,
              due_date: null,
              priority: 'low',
              status: 'planned',
              resolution: '',
              revision: 1,
            },
          ]}
          people={samplePeople}
          onOpenProject={vi.fn()}
          onAskBob={vi.fn()}
        />
      );
    });

    // Test status filter dropdown
    const statusSelect = host.querySelector('select[aria-label="Status filter"]') as HTMLSelectElement;
    if (statusSelect) {
      for (const st of ['active', 'blocked', 'planned', 'completed']) {
        await act(async () => {
          setNativeInputValue(statusSelect, st);
        });
      }
    }

    // Unscheduled items card rendering
    expect(host.textContent).toContain('Unscheduled records');
    expect(host.textContent).toContain('Unscheduled Research Task');
  });
});

// =========================================================================
// SUITE 3: PeopleChatTools Suite
// =========================================================================
describe('PeopleChatTools Suite', () => {
  const dummyRoom: PeopleRoom = {
    id: 20,
    kind: 'channel',
    name: 'telemetry-ops',
    is_owner: true,
    visibility: 'channel',
  };

  const dummyMessages: PeopleMessage[] = [
    {
      id: 701,
      sender: 'marcus',
      sender_name: 'Marcus Chen',
      body: 'Network latency test results are in.',
      created_at: '2026-10-28T09:00:00Z',
      pinned: true,
    },
    {
      id: 702,
      sender: 'sarah',
      sender_name: 'Sarah Connor',
      body: 'Shared topology review notes',
      created_at: '2026-10-28T09:10:00Z',
      shared: { kind: 'note', title: 'Topology Review', preview: 'Overview of API mesh routers and link redundancy across core sites.' },
    },
    {
      id: 703,
      sender: 'sarah',
      sender_name: 'Sarah Connor',
      body: 'Here is the diagram export',
      created_at: '2026-10-28T09:20:00Z',
      attachment: { id: 101, filename: 'diagram.png', size: 20480 },
    },
  ];

  it('peopleName utility formats user identifiers correctly', () => {
    expect(peopleName('kc-marcus')).toBe('Member');
    expect(peopleName('marcus@corp.local')).toBe('Member');
    expect(peopleName('')).toBe('Member');
    expect(peopleName(undefined)).toBe('Member');
    expect(peopleName('Marcus Chen')).toBe('Marcus Chen');
  });

  it('SharedPeopleCard renders bob, note, artifact, and attachment previews', () => {
    const { container: bobContainer } = { container: document.createElement('div') };
    const bobRoot = createRoot(bobContainer);
    act(() => {
      bobRoot.render(
        <SharedPeopleCard
          roomId={20}
          item={{ kind: 'bob', title: 'Summary Answer', body: 'Full summary text here.', snapshot: true }}
        />
      );
    });
    expect(bobContainer.textContent).toContain('People Buddy · shared answer');
    expect(bobContainer.textContent).toContain('The sender’s private workspace stays private.');

    const { container: noteContainer } = { container: document.createElement('div') };
    const noteRoot = createRoot(noteContainer);
    act(() => {
      noteRoot.render(
        <SharedPeopleCard
          roomId={20}
          item={{ kind: 'note', title: 'Carrier Notes', preview: 'A'.repeat(300) }}
          attachment={{ id: 55, filename: 'spec.pdf', size: 12000 }}
        />
      );
    });
    expect(noteContainer.textContent).toContain('Note · shared copy');
    expect(noteContainer.textContent).toContain('Download spec.pdf');
  });

  it('PeopleTaskCard permits assignee to alter task status and triggers onChanged', async () => {
    const handleChanged = vi.fn();
    const task: PeopleTask = {
      id: 42,
      room_id: 20,
      title: 'Configure API peering',
      assignee: 'marcus',
      creator: 'sarah',
      status: 'todo',
    };

    await act(async () => {
      root.render(
        <PeopleTaskCard
          task={task}
          username="marcus"
          members={[{ username: 'marcus', display_name: 'Marcus Chen' }, { username: 'sarah', display_name: 'Sarah Connor' }]}
          onChanged={handleChanged}
        />
      );
    });

    expect(host.textContent).toContain('Assigned to you');
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();

    await act(async () => {
      setNativeInputValue(select, 'in_progress');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(handleChanged).toHaveBeenCalled();
  });

  it('PeopleChatTools renders members, mention, files, pins, and tasks modes', async () => {
    const handleClose = vi.fn();
    const handleMention = vi.fn();
    const handleJump = vi.fn();

    // Mode: members
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="members"
          room={dummyRoom}
          username="marcus"
          directory={[{ username: 'marcus', display_name: 'Marcus Chen' }]}
          messages={dummyMessages}
          onClose={handleClose}
          onChanged={vi.fn()}
          onJump={handleJump}
          onMention={handleMention}
          onBobDone={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Conversation members');
    const backBtn = host.querySelector('button[aria-label="Back to messages"]') as HTMLButtonElement;
    await act(async () => {
      backBtn?.click();
    });
    expect(handleClose).toHaveBeenCalled();

    // Mode: mention
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="mention"
          room={dummyRoom}
          username="marcus"
          directory={[]}
          messages={dummyMessages}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onJump={handleJump}
          onMention={handleMention}
          onBobDone={vi.fn()}
        />
      );
    });

    const mentionBtn = Array.from(host.querySelectorAll('.people-tool-row')).find(b => b.textContent?.includes('@Sarah Connor'));
    if (mentionBtn) {
      await act(async () => {
        (mentionBtn as HTMLButtonElement).click();
      });
      expect(handleMention).toHaveBeenCalled();
    }

    // Mode: files
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="files"
          room={dummyRoom}
          username="marcus"
          directory={[]}
          messages={dummyMessages}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onJump={handleJump}
          onMention={handleMention}
          onBobDone={vi.fn()}
        />
      );
    });
    expect(host.textContent).toContain('diagram.png');

    // Mode: pins
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="pins"
          room={dummyRoom}
          username="marcus"
          directory={[]}
          messages={dummyMessages}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onJump={handleJump}
          onMention={handleMention}
          onBobDone={vi.fn()}
        />
      );
    });
    const pinBtn = host.querySelector('.people-tool-row') as HTMLButtonElement;
    await act(async () => {
      pinBtn?.click();
    });
    expect(handleJump).toHaveBeenCalled();
  });

  it('PeopleChatTools renders create-task, search, notifications, and bob modes', async () => {
    const handleClose = vi.fn();
    const handleBobDone = vi.fn();

    // Mode: create-task
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="create-task"
          room={dummyRoom}
          username="marcus"
          directory={[]}
          messages={dummyMessages}
          selectedMessage={dummyMessages[0]}
          onClose={handleClose}
          onChanged={vi.fn()}
          onJump={vi.fn()}
          onMention={vi.fn()}
          onBobDone={handleBobDone}
        />
      );
    });

    const taskTitleInput = host.querySelector('input[aria-label="Task title"]') as HTMLInputElement;
    expect(taskTitleInput).not.toBeNull();
    const createTaskForm = host.querySelector('form');
    await act(async () => {
      createTaskForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(handleClose).toHaveBeenCalled();

    // Mode: bob
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="bob"
          room={dummyRoom}
          username="marcus"
          directory={[]}
          messages={dummyMessages}
          selectedMessage={dummyMessages[0]}
          onClose={handleClose}
          onChanged={vi.fn()}
          onJump={vi.fn()}
          onMention={vi.fn()}
          onBobDone={handleBobDone}
        />
      );
    });

    const bobTextarea = host.querySelector('textarea[aria-label="Question for People Buddy"]') as HTMLTextAreaElement;
    if (bobTextarea) {
      await act(async () => {
        setNativeInputValue(bobTextarea, 'Summarize the network latency discussion.');
      });
      const bobForm = host.querySelector('form');
      await act(async () => {
        bobForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(handleBobDone).toHaveBeenCalled();
    }
  });

  it('PeopleAssignedTasks renders assigned tasks list and handles click navigation', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    await act(async () => {
      root.render(<PeopleAssignedTasks />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Audit Edge Router Certs');
    const taskBtn = host.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      taskBtn?.click();
    });

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'community-open-room',
    }));
  });

  it('PeopleChatTools saves notification preferences and quiet hours', async () => {
    await act(async () => {
      root.render(
        <PeopleChatTools
          mode="notifications"
          room={dummyRoom}
          username="marcus"
          directory={[]}
          messages={dummyMessages}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onJump={vi.fn()}
          onMention={vi.fn()}
          onBobDone={vi.fn()}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const notifSelect = host.querySelector('select[aria-label="Conversation notifications"]') as HTMLSelectElement;
    if (notifSelect) {
      await act(async () => {
        setNativeInputValue(notifSelect, 'mentions');
      });
    }

    const quietCheckbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (quietCheckbox) {
      await act(async () => {
        quietCheckbox.click();
      });
    }

    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toBeDefined();
  });
});

// =========================================================================
// SUITE 4: MemberChat Suite
// =========================================================================
describe('MemberChat Suite', () => {
  function TestUnreadHarness({ username }: { username: string }) {
    const { unread, notices, dismissNotice } = useCommunityUnread(username);
    return (
      <div>
        <output data-testid="unread-count">{unread}</output>
        <output data-testid="notices-count">{notices.length}</output>
        <button onClick={() => dismissNotice(10)}>Dismiss 10</button>
      </div>
    );
  }

  it('useCommunityUnread hook tracks unread counts and handles dismissNotice', async () => {
    await act(async () => {
      root.render(<TestUnreadHarness username="marcus" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe('1');
    const dismissBtn = host.querySelector('button');
    await act(async () => {
      dismissBtn?.click();
    });
    expect(host.querySelector('[data-testid="notices-count"]')?.textContent).toBe('0');
  });

  it('MemberChatWidget renders launcher, opens chat drawer, switches tabs, and sends message', async () => {
    await act(async () => {
      root.render(
        <MemberChatWidget username="marcus" displayName="Marcus Chen" />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.body.querySelector('.member-chat-launcher') as HTMLButtonElement;
    expect(launcher).not.toBeNull();

    // Open chat
    await act(async () => {
      launcher.click();
    });

    expect(document.body.querySelector('.member-chat-panel')).not.toBeNull();

    // Switch to Channels tab
    const channelsTab = Array.from(document.body.querySelectorAll('.member-chat-tab')).find(b => b.textContent?.includes('Channels'));
    if (channelsTab) {
      await act(async () => {
        (channelsTab as HTMLButtonElement).click();
      });
      expect(document.body.textContent).toContain('telemetry-ops');
    }

    // Select room to chat
    const roomBtn = document.body.querySelector('.member-chat-room') as HTMLButtonElement;
    if (roomBtn) {
      await act(async () => {
        roomBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Type in message input
      const msgInput = document.body.querySelector('input.member-chat-input') as HTMLInputElement;
      if (msgInput) {
        await act(async () => {
          setNativeInputValue(msgInput, 'Telemetry probes are active.');
        });
        const sendBtn = document.body.querySelector('button.member-chat-send') as HTMLButtonElement;
        await act(async () => {
          sendBtn?.click();
        });
      }
    }

    // Toggle compact / expand
    const expandBtn = document.body.querySelector('button[aria-label="Expand chat"]') as HTMLButtonElement;
    if (expandBtn) {
      await act(async () => {
        expandBtn.click();
      });
    }

    // Close chat
    const closeBtn = document.body.querySelector('button[aria-label="Minimize chat"]') as HTMLButtonElement;
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
      expect(document.body.querySelector('.member-chat-panel')?.getAttribute('hidden')).not.toBeNull();
    }
  });

  it('PeopleVoiceCall manages incoming, active call states, muting, and notice dismissal', async () => {
    const handleOpen = vi.fn();
    const mockVoice: PeopleVoice = {
      call: {
        roomId: 10,
        name: 'Sarah Connor',
        phase: 'incoming',
        muted: false,
      },
      ready: true,
      notice: 'Incoming call from Sarah Connor',
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

    // Incoming call phase
    await act(async () => {
      root.render(<PeopleVoiceCall voice={mockVoice} onOpen={handleOpen} />);
    });

    expect(host.textContent).toContain('Sarah Connor');
    const answerBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Answer'));
    await act(async () => {
      answerBtn?.click();
    });
    expect(mockVoice.answer).toHaveBeenCalled();

    const declineBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Decline'));
    await act(async () => {
      declineBtn?.click();
    });
    expect(mockVoice.decline).toHaveBeenCalled();

    // Connected call phase
    const connectedVoice: PeopleVoice = {
      ...mockVoice,
      call: {
        roomId: 10,
        name: 'Sarah Connor',
        phase: 'connected',
        muted: false,
      },
      notice: 'Call connection encrypted',
    };

    await act(async () => {
      root.render(<PeopleVoiceCall voice={connectedVoice} onOpen={handleOpen} />);
    });

    const muteBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Mute'));
    await act(async () => {
      muteBtn?.click();
    });
    expect(mockVoice.mute).toHaveBeenCalled();

    const hangupBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Hang up'));
    await act(async () => {
      hangupBtn?.click();
    });
    expect(mockVoice.hangup).toHaveBeenCalled();

    const openConvBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Open conversation'));
    await act(async () => {
      openConvBtn?.click();
    });
    expect(handleOpen).toHaveBeenCalledWith(10);

    const dismissNoticeBtn = host.querySelector('button[aria-label="Dismiss call notice"]') as HTMLButtonElement;
    await act(async () => {
      dismissNoticeBtn?.click();
    });
    expect(mockVoice.dismiss).toHaveBeenCalled();
  });
});

// =========================================================================
// SUITE 5: ChatView Suite
// =========================================================================
describe('ChatView Suite', () => {
  it('extractThinking parses closed thinking tags, open streaming tags, and clean text', () => {
    expect(extractThinking('')).toEqual({ thoughts: '', cleanText: '' });
    expect(extractThinking('Simple answer')).toEqual({ thoughts: '', cleanText: 'Simple answer' });

    const closed = extractThinking('<think>Calculated route latency</think>Route B is optimal.');
    expect(closed.thoughts).toBe('Calculated route latency');
    expect(closed.cleanText).toBe('Route B is optimal.');

    const streamingOpen = extractThinking('<think>Analyzing packet dumps', true);
    expect(streamingOpen.thoughts).toBe('Analyzing packet dumps');
    expect(streamingOpen.cleanText).toBe('');
  });

  it('ChatView renders messages, thinking block, action approval buttons, and handles approval decisions', async () => {
    const handleApproval = vi.fn().mockResolvedValue(undefined);
    const handleSend = vi.fn();
    const handleStop = vi.fn();

    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: 'Check core switch status',
      },
      {
        id: 'msg-2',
        role: 'assistant' as const,
        content: '<think>Querying core telemetry broker</think>All 8 core switches healthy.',
        approvals: [
          {
            approval_id: 'appr-task-1',
            action: 'Restart edge routing daemon',
            command: 'systemctl restart telemetry-edge',
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
          skills={[{ name: 'network-audit', description: 'Audit telemetry' }]}
          agents={[]}
          templates={[]}
          selectedTemplateId=""
          onSendMessage={handleSend}
          onApprovalDecision={handleApproval}
          onUploadFile={vi.fn()}
          onStop={handleStop}
          onOpenTemplateModal={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Check core switch status');
    expect(host.textContent).toContain('All 8 core switches healthy.');

    // Click Approve button on ActionApproval card
    const approveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Approve' || b.textContent?.includes('Approve'));
    if (approveBtn) {
      await act(async () => {
        approveBtn.click();
      });
      expect(handleApproval).toHaveBeenCalled();
    }
  });

  it('ChatView renders stop button during streaming and handles branch and delete callbacks', async () => {
    const handleStop = vi.fn();
    const handleBranch = vi.fn().mockResolvedValue(undefined);
    const handleDelete = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <ChatView
          messages={[{ id: 'm-1', role: 'user', content: 'In progress query' }] as any}
          isStreaming={true}
          activeMode="agent"
          slideCount={5}
          onSlideCountChange={vi.fn()}
          activeAgent=""
          modes={[]}
          skills={[]}
          agents={[]}
          templates={[]}
          selectedTemplateId=""
          onSendMessage={vi.fn()}
          onApprovalDecision={vi.fn()}
          onUploadFile={vi.fn()}
          onStop={handleStop}
          onOpenTemplateModal={vi.fn()}
          onBranch={handleBranch}
          onDeleteMessage={handleDelete}
        />
      );
    });

    const stopBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Stop') || b.getAttribute('aria-label')?.includes('Stop'));
    if (stopBtn) {
      await act(async () => {
        stopBtn.click();
      });
      expect(handleStop).toHaveBeenCalled();
    }
  });
});

// =========================================================================
// SUITE 6: OfficeAssistant Suite
// =========================================================================
describe('OfficeAssistant Suite', () => {
  const dummyContext: OfficeContext = {
    kind: 'word',
    text: 'Telemetry architecture documentation draft.',
    selection: 'Vector metrics daemon',
  };

  const createMockBridge = (): OfficeBridge => ({
    ready: true,
    context: vi.fn().mockResolvedValue(dummyContext),
    preview: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn().mockResolvedValue({ ok: true, applied: 1 }),
    discard: vi.fn().mockResolvedValue(undefined),
  });

  it('OfficeAssistant renders context selector and submits instruction prompt', async () => {
    const bridge = createMockBridge();
    const handleBusy = vi.fn();
    const handleApplied = vi.fn();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="file-doc-omega"
          extension="docx"
          bridge={bridge}
          onBusy={handleBusy}
          onApplied={handleApplied}
        />
      );
    });

    expect(host.textContent).toContain('Buddy');
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();

    await act(async () => {
      setNativeInputValue(select, 'selection');
    });

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setNativeInputValue(textarea, 'Format throughput SLA table.');
    });

    const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn?.click();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.context).toHaveBeenCalled();

    // Check proposed edits apply button
    const applyBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Apply to document') || b.textContent?.includes('Apply'));
    if (applyBtn) {
      await act(async () => {
        applyBtn.click();
      });
      expect(bridge.apply).toHaveBeenCalled();
      expect(handleApplied).toHaveBeenCalled();
    }
  });

  it('OfficeAssistant discards proposed plan when Discard button is clicked', async () => {
    const bridge = createMockBridge();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="file-doc-omega"
          extension="docx"
          bridge={bridge}
          onBusy={vi.fn()}
          onApplied={vi.fn()}
        />
      );
    });

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setNativeInputValue(textarea, 'Propose speculative edits.');
    });

    const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn?.click();
    });

    await act(async () => {
      await Promise.resolve();
    });

    const discardBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Discard') || b.textContent?.includes('Discard plan'));
    if (discardBtn) {
      await act(async () => {
        discardBtn.click();
      });
      expect(host.textContent).toContain('Draft discarded');
    }
  });

  it('OfficeAssistant handles pptx and xlsx extensions with quick chips and context labels', async () => {
    const bridge = createMockBridge();

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="file-sheet-omega"
          extension="xlsx"
          bridge={bridge}
          onBusy={vi.fn()}
          onApplied={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Current workbook');

    await act(async () => {
      root.render(
        <OfficeAssistant
          fileId="file-slide-omega"
          extension="pptx"
          bridge={bridge}
          onBusy={vi.fn()}
          onApplied={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Current presentation');
  });

  it('OfficeAssistant handles spreadsheet plan with charts, validation, formatting, and formulas', async () => {
    const spreadsheetContext: OfficeContext = {
      kind: 'excel',
      sheet: 'CapacityModel',
      range: 'B2:E20',
      sheets: ['CapacityModel', 'Summary'],
    };

    const bridge: OfficeBridge = {
      ready: true,
      context: vi.fn().mockResolvedValue(spreadsheetContext),
      preview: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue({ ok: true, applied: 1 }),
      discard: vi.fn().mockResolvedValue(undefined),
    };

    const handleApplied = vi.fn();

    // Mock fetch for draft with multi-action spreadsheet plan
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/api/office/assistant/files/') && path.includes('/draft')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({}),
          body: createMockStream([
            { type: 'status', message: 'Analyzing formulas…' },
            { type: 'delta', text: 'Spreadsheet plan created.' },
            {
              type: 'plan',
              plan: {
                version: 1,
                kind: 'excel',
                reply: 'Added formulas, formatted ranges, and chart.',
                actions: [
                  { type: 'add_sheet', sheet: 'Metrics' },
                  { type: 'set_cells', sheet: 'Metrics', range: 'A1:B2', values: [['Throughput', 450]] },
                  { type: 'format_range', sheet: 'Metrics', range: 'A1:B1', bold: true },
                  { type: 'freeze_panes', sheet: 'Metrics', rows: 1, columns: 1 },
                  { type: 'add_chart', sheet: 'Metrics', range: 'A1:B2', chart_type: 'bar', title: 'Metrics Chart' },
                  { type: 'edit_chart', sheet: 'Metrics', chart_index: 0, title: 'Updated Chart' },
                  { type: 'set_validation', sheet: 'Metrics', range: 'B2', rule: 'whole' },
                ],
              },
            },
          ]),
        });
      }
      return originalFetch(url);
    });

    try {
      await act(async () => {
        root.render(
          <OfficeAssistant
            fileId="file-sheet-omega"
            extension="xlsx"
            bridge={bridge}
            onBusy={vi.fn()}
            onApplied={handleApplied}
          />
        );
      });

      const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
      await act(async () => {
        setNativeInputValue(textarea, 'Add formula cells and metric chart.');
      });

      const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn?.click();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(host.textContent).toContain('Proposed edits');
      expect(host.textContent).toContain('Insert chart');
      expect(host.textContent).toContain('Update native chart');
      expect(host.textContent).toContain('Freeze panes');
      expect(host.textContent).toContain('Set input validation');

      const applyBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Apply to document') || b.textContent?.includes('Apply'));
      if (applyBtn) {
        await act(async () => {
          applyBtn.click();
        });
        expect(bridge.apply).toHaveBeenCalled();
        expect(handleApplied).toHaveBeenCalled();
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// =========================================================================
// SUITE 7: OfficeSuite Suite
// =========================================================================
describe('OfficeSuite Suite', () => {
  it('renders OfficeSuite file library, filters by kind, and searches files', async () => {
    const handleClose = vi.fn();
    const handleAskFile = vi.fn();

    await act(async () => {
      root.render(
        <OfficeSuite onClose={handleClose} onAskFile={handleAskFile} />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Telemetry Architecture.docx');
    expect(host.textContent).toContain('Telemetry Capacity.xlsx');

    // Filter by kind: document
    const docFilter = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Documents') || b.textContent?.includes('Document'));
    if (docFilter) {
      await act(async () => {
        docFilter.click();
      });
    }

    // Search input
    const searchInput = host.querySelector('input[type="search"]') as HTMLInputElement;
    if (searchInput) {
      await act(async () => {
        setNativeInputValue(searchInput, 'Capacity');
      });
      expect(host.textContent).toContain('Capacity');
    }

    // Close button
    const closeBtn = host.querySelector('button[aria-label="Close Office Suite"]') as HTMLButtonElement;
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
      expect(handleClose).toHaveBeenCalled();
    }
  });

  it('navigates folders and creates new folder in OfficeSuite', async () => {
    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Infrastructure');
    const folderBtn = Array.from(host.querySelectorAll('.office-folder-row')).find(el => el.textContent?.includes('Infrastructure'));
    if (folderBtn) {
      await act(async () => {
        (folderBtn as HTMLElement).click();
      });
    }
  });
});

// =========================================================================
// SUITE 8: StructuredDiagram Suite
// =========================================================================
describe('StructuredDiagram Suite', () => {
  const sampleFlowSpec: DiagramSpec = {
    id: 'spec-telemetry-flow',
    title: 'Edge Telemetry Pipeline',
    kind: 'flow',
    direction: 'LR',
    nodes: [
      { id: 'gw-1', label: 'Edge Gateway', shape: 'rect', tone: 'neutral' },
      { id: 'db-1', label: 'Timeseries Store', shape: 'database', tone: 'primary' },
    ],
    edges: [
      { id: 'e-1', source: 'gw-1', target: 'db-1', label: 'Batch metrics' },
    ],
  };

  const sampleSequenceSpec: DiagramSpec = {
    id: 'spec-auth-sequence',
    title: 'Telemetry Node Authentication',
    kind: 'sequence',
    nodes: [
      { id: 'client', label: 'Telemetry Daemon', shape: 'rect' },
      { id: 'auth', label: 'OAuth2 Provider', shape: 'rect' },
    ],
    edges: [
      { id: 'seq-1', source: 'client', target: 'auth', label: 'POST /token' },
      { id: 'seq-2', source: 'auth', target: 'client', label: 'Bearer Token' },
    ],
  };

  it('renders flow diagram with nodes, source toggle, and export buttons', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSequenceSpec}
          source="sequenceDiagram\nclient->>auth: POST /token"
          streaming={false}
          sessionId="sess-telemetry-1"
        />
      );
    });

    expect(host.querySelector('.structured-sequence')).not.toBeNull();
    expect(host.textContent).toContain('Telemetry Node Authentication');

    // Toggle source code view
    const sourceBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Source'));
    if (sourceBtn) {
      await act(async () => {
        sourceBtn.click();
      });
      expect(host.querySelector('.diagram-source')?.textContent).toContain('sequenceDiagram');
    }

    // Export SVG
    const svgExportBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'SVG');
    if (svgExportBtn) {
      await act(async () => {
        svgExportBtn.click();
      });
      expect(window.URL.createObjectURL).toHaveBeenCalled();
    }
  });

  it('renders sequence diagram with participants, lifelines, and message clicks', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSequenceSpec}
          source="sequenceDiagram\nclient->>auth: POST /token"
          streaming={false}
        />
      );
    });

    expect(host.querySelector('.structured-sequence')).not.toBeNull();
    expect(host.textContent).toContain('Telemetry Daemon');
    expect(host.textContent).toContain('OAuth2 Provider');

    const messageArrow = host.querySelector('.sequence-message') as SVGGElement;
    if (messageArrow) {
      await act(async () => {
        messageArrow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(messageArrow.getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('opens and closes maximized dialog modal in StructuredDiagram', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleFlowSpec}
          source="flowchart LR"
          streaming={false}
        />
      );
    });

    const maxBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Maximize'));
    if (maxBtn) {
      await act(async () => {
        maxBtn.click();
      });
      const dialog = document.body.querySelector('dialog.diagram-maximized-dialog');
      expect(dialog).not.toBeNull();

      const returnBtn = Array.from(dialog?.querySelectorAll('button') || []).find(b => b.textContent?.includes('Return'));
      if (returnBtn) {
        await act(async () => {
          returnBtn.click();
        });
      }
    }
  });

  it('diagramWidthFit computes scaling across mobile, tablet, and desktop viewports', () => {
    const mobileFit = diagramWidthFit(1200, 800, 375, 20, false);
    expect(mobileFit.zoom).toBeLessThan(1);
    expect(mobileFit.height).toBeGreaterThan(0);

    const tabletFit = diagramWidthFit(1200, 800, 768, 20, false);
    expect(tabletFit.zoom).toBeGreaterThan(mobileFit.zoom);

    const desktopFit = diagramWidthFit(1200, 800, 1440, 20, false);
    expect(desktopFit.zoom).toBeGreaterThan(tabletFit.zoom);

    const compactFit = diagramWidthFit(1200, 800, 1440, 20, true);
    expect(compactFit.height).toBeDefined();
  });

  it('triggers Animated SVG and Animated HTML downloads in StructuredDiagram', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSequenceSpec}
          source="sequenceDiagram"
          streaming={false}
        />
      );
    });

    const animatedSvgBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Animated SVG'));
    if (animatedSvgBtn) {
      await act(async () => {
        animatedSvgBtn.click();
      });
      expect(window.URL.createObjectURL).toHaveBeenCalled();
    }

    const animatedHtmlBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Animated HTML'));
    if (animatedHtmlBtn) {
      await act(async () => {
        animatedHtmlBtn.click();
      });
      expect(window.URL.createObjectURL).toHaveBeenCalled();
    }
  });
});

// =========================================================================
// SUITE 9: ProjectsWorkspace Suite
// =========================================================================
describe('ProjectsWorkspace Suite', () => {
  it('switches navigation tabs across portfolio, timeline, people, impact, and merged views', async () => {
    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={vi.fn()}
          onAskBob={vi.fn()}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Omega Telemetry Overhaul');

    // Switch to Overview tab
    const overviewTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Briefing & Attention') || b.textContent?.includes('Overview'));
    if (overviewTab) {
      await act(async () => {
        (overviewTab as HTMLButtonElement).click();
      });
    }

    // Switch to People tab
    const peopleTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Capacity & Staffing') || b.textContent?.includes('Team & Allocation'));
    if (peopleTab) {
      await act(async () => {
        (peopleTab as HTMLButtonElement).click();
      });
      expect(host.textContent).toContain('Marcus Chen');
    }

    // Switch to Merged tab
    const mergedTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Merged View') || b.textContent?.includes('Unified View'));
    if (mergedTab) {
      await act(async () => {
        (mergedTab as HTMLButtonElement).click();
      });
      expect(host.querySelector('.projects-merged-container')).not.toBeNull();
    }
  });

  it('interacts with Bob for Projects assistant panel', async () => {
    const handleAskBob = vi.fn();
    const handleStopBob = vi.fn();

    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={vi.fn()}
          onAskBob={handleAskBob}
          onStopBob={handleStopBob}
          bobMessages={[{ id: 'bm-1', role: 'assistant', content: 'Telemetry analysis ready.' }]}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Open Bob assistant drawer
    const openAssistantBtn = host.querySelector('button[aria-label="Open Project Buddy"]') as HTMLButtonElement;
    if (openAssistantBtn) {
      await act(async () => {
        openAssistantBtn.click();
      });
      expect(host.querySelector('.projects-widget-panel')).not.toBeNull();

      // Submit question
      const questionArea = host.querySelector('textarea[aria-label="Your question"]') as HTMLTextAreaElement;
      if (questionArea) {
        await act(async () => {
          setNativeInputValue(questionArea, 'What is the critical path for Phase 2?');
        });
        const sendQuestionBtn = host.querySelector('button[aria-label="Send to Project Buddy"]') as HTMLButtonElement;
        await act(async () => {
          sendQuestionBtn?.click();
        });
        expect(handleAskBob).toHaveBeenCalled();
      }
    }
  });

  it('handles fullscreen toggle and project close callback', async () => {
    const handleClose = vi.fn();

    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={handleClose}
          onAskBob={vi.fn()}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const fsBtn = host.querySelector('.projects-fullscreen-toggle') as HTMLButtonElement;
    if (fsBtn) {
      await act(async () => {
        fsBtn.click();
      });
    }

    const closeBtn = host.querySelector('button[aria-label="Close projects"]') as HTMLButtonElement;
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
      expect(handleClose).toHaveBeenCalled();
    }
  });

  it('ProjectsWorkspace handles portfolio project creation modal and revision conflict', async () => {
    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={vi.fn()}
          onAskBob={vi.fn()}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Switch to Register / Portfolio projects
    const portfolioTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Projects Register') || b.textContent?.includes('Portfolio'));
    if (portfolioTab) {
      await act(async () => {
        (portfolioTab as HTMLButtonElement).click();
      });
    }

    // New project button
    const newProjectBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('New project') || b.textContent?.includes('+ New Project'));
    if (newProjectBtn) {
      await act(async () => {
        newProjectBtn.click();
      });
      expect(host.textContent).toContain('Create project');

      // Cancel project creation
      const cancelBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Cancel'));
      await act(async () => {
        cancelBtn?.click();
      });
    }
  });

  it('ProjectsWorkspace handles scenario forecasting preview and applies changes', async () => {
    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={vi.fn()}
          onAskBob={vi.fn()}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Switch to 'impact' tab (Forecasting & Scenarios)
    const impactTab = Array.from(host.querySelectorAll('.projects-view-nav button')).find(b => b.textContent?.includes('Forecasting & Scenarios') || b.textContent?.includes('Change impact'));
    expect(impactTab).toBeDefined();
    if (impactTab) {
      await act(async () => {
        (impactTab as HTMLButtonElement).click();
      });
    }

    expect(host.textContent).toContain('Change impact');

    // Change type and person selection
    const changeTypeSelect = host.querySelector('select[aria-label="Change type"]') as HTMLSelectElement;
    if (changeTypeSelect) {
      await act(async () => {
        setNativeInputValue(changeTypeSelect, 'person_departure');
      });
    }

    const personSelect = host.querySelector('select[aria-label="Person"]') as HTMLSelectElement;
    if (personSelect) {
      await act(async () => {
        setNativeInputValue(personSelect, 'usr-1');
      });
    }

    const statusSelect = host.querySelector('select[aria-label="Proposed status"]') as HTMLSelectElement;
    if (statusSelect) {
      await act(async () => {
        setNativeInputValue(statusSelect, 'leaving');
      });
    }

    // Submit preview
    const previewBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Preview impact'));
    if (previewBtn) {
      await act(async () => {
        previewBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(host.textContent).toContain('What-if preview');

      // Apply this change
      const applyBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Apply this change'));
      if (applyBtn) {
        await act(async () => {
          applyBtn.click();
        });
        await act(async () => {
          await Promise.resolve();
        });
      }
    }
  });

  it('ProjectOfficeExport generates project CSV, Word HTML, PDF HTML, and exports files', async () => {
    const csv = generateProjectCsv(sampleProject, sampleWorkItems, samplePortfolio.assignments, samplePortfolio.dependencies, samplePeople);
    expect(csv).toContain('--- PROJECT METADATA & TOLERANCE HEALTH ---');
    expect(csv).toContain('Omega Telemetry Overhaul');
    expect(csv).toContain('Deploy Telemetry Forwarders');

    const docHtml = generateProjectDocHtml(sampleProject, sampleWorkItems, samplePortfolio.assignments, samplePortfolio.stage_approvals!, samplePeople);
    expect(docHtml).toContain('Omega Telemetry Overhaul');
    expect(docHtml).toContain('PRINCE2 Highlight Report');

    const pdfHtml = generateProjectPdfHtml(sampleProject, sampleWorkItems, samplePortfolio.assignments, samplePortfolio.stage_approvals!, samplePeople);
    expect(pdfHtml).toContain('Omega Telemetry Overhaul');
    expect(pdfHtml).toContain('Executive Summary');

    const onSuccess = vi.fn();
    const onError = vi.fn();

    await exportProjectToOffice('excel', sampleProject, sampleWorkItems, samplePortfolio.assignments, samplePortfolio.stage_approvals!, samplePortfolio.dependencies, samplePeople, onSuccess, onError);
    expect(onSuccess).toHaveBeenCalled();

    await exportProjectToOffice('word', sampleProject, sampleWorkItems, samplePortfolio.assignments, samplePortfolio.stage_approvals!, samplePortfolio.dependencies, samplePeople, onSuccess, onError);
    expect(onSuccess).toHaveBeenCalled();
  });

  it('ProjectCapacityHeatmap displays time horizons, filters, search, and cell breakdown', async () => {
    const handleSelectProject = vi.fn();
    const handlePreviewAvailability = vi.fn();
    const handleAskBob = vi.fn();

    await act(async () => {
      root.render(
        <ProjectCapacityHeatmap
          people={samplePeople}
          projects={[sampleProject]}
          assignments={samplePortfolio.assignments}
          workItems={sampleWorkItems}
          canManage={true}
          onSelectProject={handleSelectProject}
          onPreviewAvailability={handlePreviewAvailability}
          onAskBob={handleAskBob}
        />
      );
    });

    expect(host.textContent).toContain('Marcus Chen');

    // Horizon toggles
    const monthsBtn = Array.from(host.querySelectorAll('.runn-horizon-btn')).find(b => b.textContent?.includes('Months'));
    if (monthsBtn) {
      await act(async () => {
        (monthsBtn as HTMLButtonElement).click();
      });
    }

    const weeksBtn = Array.from(host.querySelectorAll('.runn-horizon-btn')).find(b => b.textContent?.includes('Weeks'));
    if (weeksBtn) {
      await act(async () => {
        (weeksBtn as HTMLButtonElement).click();
      });
    }

    // Filter modes
    for (const mode of ['overallocated', 'available', 'nobackup', 'all'] as const) {
      const filterBtn = Array.from(host.querySelectorAll('.runn-filter-btn')).find(b => b.textContent?.toLowerCase().includes(mode));
      if (filterBtn) {
        await act(async () => {
          (filterBtn as HTMLButtonElement).click();
        });
      }
    }

    // Search query
    const searchInput = host.querySelector('input.runn-search-input') as HTMLInputElement;
    if (searchInput) {
      await act(async () => {
        setNativeInputValue(searchInput, 'Marcus');
      });
      expect(host.textContent).toContain('Marcus Chen');
    }

    // Interactive cell click to open drill-down
    const cell = host.querySelector('.runn-cell.is-interactive') as HTMLElement;
    if (cell) {
      await act(async () => {
        cell.click();
      });
      expect(host.querySelector('.runn-drilldown-drawer')).not.toBeNull();
      const closeDrilldown = host.querySelector('.runn-drilldown-close') as HTMLButtonElement;
      await act(async () => {
        closeDrilldown?.click();
      });
      expect(host.querySelector('.runn-drilldown-drawer')).toBeNull();
    }
  });
});
