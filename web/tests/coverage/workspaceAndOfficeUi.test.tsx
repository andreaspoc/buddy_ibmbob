// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ProjectsWorkspace } from '../../src/components/ProjectsWorkspace';
import { OfficeSuite } from '../../src/components/OfficeSuite';
import { HtmlDeckViewer } from '../../src/components/HtmlDeckViewer';
import type { ChatMessage } from '../../src/types';

vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/api', () => ({
  saveSessionFile: vi.fn().mockResolvedValue({ ok: true }),
  fetchDeckByPath: vi.fn().mockResolvedValue({ slides: [] }),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mocked diagram</text></svg>' }),
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

// Standard sample portfolio fixture
const samplePortfolio = {
  can_manage: true,
  projects: [
    {
      id: 'proj-1',
      name: 'Core Network Upgrade',
      description: 'Upgrade core routers and backbones',
      status: 'active',
      priority: 'high',
      revision: 1,
      milestone: 'Phase 1 Complete',
      due_date: '2026-11-15',
      start_date: '2026-10-01',
      stage: 'delivery',
      tolerance_days: 7,
      exception_status: 'within_tolerance',
      tailoring_level: 'corporate',
      business_case: 'Modernize backbone infrastructure',
      product_description: 'High availability redundant mesh',
    },
    {
      id: 'proj-2',
      name: 'Cloud Gateway Migration',
      description: 'Migrate on-prem traffic to cloud',
      status: 'completed',
      priority: 'medium',
      revision: 2,
      milestone: 'Cutover complete',
      due_date: '2026-09-01',
      start_date: '2026-05-01',
      stage: 'operational',
      tolerance_days: 0,
      exception_status: 'within_tolerance',
    },
  ],
  people: [
    {
      id: 'person-1',
      name: 'Elena Rostova',
      email: 'elena@example.com',
      status: 'active',
      departure_date: null,
    },
    {
      id: 'person-2',
      name: 'Marcus Vance',
      email: 'marcus@example.com',
      status: 'active',
      departure_date: null,
    },
  ],
  assignments: [
    {
      id: 'asg-1',
      project_id: 'proj-1',
      person_id: 'person-1',
      responsibility: 'Lead Systems Architect',
      role: 'owner',
      backup_person_id: 'person-2',
      allocation: 60,
    },
    {
      id: 'asg-2',
      project_id: 'proj-1',
      person_id: 'person-2',
      responsibility: 'Infrastructure Engineer',
      role: 'team_manager',
      backup_person_id: null,
      allocation: 50,
    },
  ],
  dependencies: [
    {
      id: 'dep-1',
      source_project_id: 'proj-2',
      target_project_id: 'proj-1',
      description: 'Cloud routing rules',
    },
  ],
  work_items: [
    {
      id: 'work-1',
      project_id: 'proj-1',
      kind: 'task',
      title: 'Provision Edge Routers',
      description: 'Deploy hardware and configure API',
      owner_id: 'person-1',
      due_date: '2026-11-05',
      priority: 'high',
      status: 'in_progress',
      resolution: '',
      revision: 1,
    },
    {
      id: 'work-2',
      project_id: 'proj-1',
      kind: 'risk',
      title: 'Hardware Delivery Lead Time',
      description: 'Vendor delay risk',
      owner_id: 'person-1',
      due_date: null,
      priority: 'medium',
      status: 'open',
      resolution: 'Secondary supply contract',
      revision: 1,
    },
    {
      id: 'work-3',
      project_id: 'proj-1',
      kind: 'deliverable',
      title: 'Backbone Acceptance Test Report',
      description: 'PRINCE2 quality verification',
      owner_id: 'person-1',
      due_date: '2026-11-20',
      priority: 'critical',
      status: 'quality_review',
      reviewer_id: 'person-2',
      acceptance_criteria: 'Zero packet loss under 40Gbps load',
      acceptance_evidence: 'Test Lab Report #42',
      resolution: 'Meets latency specifications',
      revision: 1,
    },
    {
      id: 'work-4',
      project_id: 'proj-1',
      kind: 'task',
      title: 'Fiber attenuation in sector 4',
      description: 'High optical signal loss',
      owner_id: 'person-2',
      due_date: '2026-10-25',
      priority: 'high',
      status: 'blocked',
      resolution: '',
      revision: 1,
    },
    {
      id: 'work-5',
      project_id: 'proj-1',
      kind: 'decision',
      title: 'Select API routing daemon',
      description: 'FRR vs BIRD evaluation',
      owner_id: 'person-1',
      due_date: '2026-11-01',
      priority: 'medium',
      status: 'proposed',
      resolution: '',
      revision: 1,
    },
    {
      id: 'work-6',
      project_id: 'proj-1',
      kind: 'lesson',
      title: 'Dual redundant power feeds',
      description: 'Always deploy A+B feed circuits',
      owner_id: 'person-1',
      due_date: null,
      priority: 'low',
      status: 'captured',
      resolution: 'Include in rack build checklist',
      revision: 1,
    },
  ],
  stage_approvals: [
    {
      id: 'appr-1',
      project_id: 'proj-1',
      stage: 'planning',
      project_revision: 1,
      approver_id: 'person-1',
      decision: 'approved',
      evidence: 'Project brief signed off by sponsor',
      actor: 'Elena Rostova',
      created_at: '2026-10-10T10:00:00Z',
    },
  ],
  impact: {
    items: [
      {
        project_id: 'proj-1',
        level: 'confirmed',
        reason: 'Key architect departure threatens milestone',
        evidence: { origin: 'Upstream delay' },
        path: ['proj-2', 'proj-1'],
      },
    ],
  },
};

// Sample deck HTML
const sampleCompleteDeckHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Enterprise Network Architecture</title>
  <style>
    :root {
      --brand-primary: #a63bff;
      --brand-secondary: #ff7a1a;
      --brand-blue: #5b8def;
      --bg: #0d0818;
      --surface: #1c1030;
      --text: #eef3fa;
    }
  </style>
</head>
<body>
  <div id="deck">
    <section class="slide active" id="slide-1">
      <div class="kicker">Strategic Overview</div>
      <h1 class="title">Enterprise Network Architecture</h1>
      <p class="lede">Q4 Core Network Transformation & Readiness</p>
      <div class="stat">
        <span class="label">Backbone Throughput</span>
        <span class="num">100Gbps</span>
      </div>
      <div class="stat">
        <span class="label">Availability SLA</span>
        <span class="num">99.99%</span>
      </div>
    </section>
    <section class="slide" id="slide-2">
      <div class="kicker">Delivery Milestones</div>
      <h2 class="title">Router Deployment Status</h2>
      <p class="lede">Hardware provisioning across core datacenters</p>
      <p class="item-desc">All primary nodes connected to redundant transit</p>
    </section>
  </div>
</body>
</html>`;

beforeEach(() => {
  window.history.pushState({}, '', '/');
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
  window.scrollTo = vi.fn();
  window.open = vi.fn();
  window.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
  window.URL.revokeObjectURL = vi.fn();

  if (document.documentElement) {
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
  }
  document.exitFullscreen = vi.fn().mockResolvedValue(undefined);

  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();

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

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
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

// =========================================================================
// SECTION 1: ProjectsWorkspace Tests
// =========================================================================

describe('ProjectsWorkspace UI Component', () => {
  it('restores the previous favicon on unmount and handles fullscreen changes', async () => {
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = '/original.ico';
    document.head.appendChild(icon);
    global.fetch = setupProjectsFetch();
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    expect(icon.getAttribute('href')).toContain('project-buddy.svg');
    const workspace = host.querySelector<HTMLElement>('.projects-workspace')!;
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    workspace.requestFullscreen = requestFullscreen;
    await act(async () => { host.querySelector<HTMLButtonElement>('.projects-fullscreen-btn')!.click(); });
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(workspace.classList.contains('is-fullscreen')).toBe(true);
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(workspace.classList.contains('is-fullscreen')).toBe(false);
    await act(async () => { root.unmount(); });
    expect(icon.getAttribute('href')).toBe('/original.ico');
    icon.remove();
    root = createRoot(host);
  });

  it('displays validation messages returned by the projects service', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 422,
      text: async () => JSON.stringify({ detail: [{ msg: 'Name is required' }, { msg: 'Invalid date' }] }),
    });
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    expect(host.textContent).toContain('Name is required; Invalid date');
  });

  function setupProjectsFetch(customPortfolio = samplePortfolio, shouldFail = false) {
    return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method || 'GET';

      if (shouldFail) {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ detail: 'Internal server error in project service' }),
        };
      }

      if (path.includes('/api/projects/impact/preview')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            items: [
              { project_id: 'proj-1', level: 'risk', reason: 'Simulated departure increases risk', evidence: {}, path: [] },
            ],
          }),
        };
      }

      if (path.includes('/api/projects/impact/apply')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true }),
        };
      }

      if (path.includes('/api/projects/assignments') || path.includes('/api/projects/dependencies') || path.includes('/api/projects/work-items') || path.includes('/api/projects')) {
        if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ id: 'new-id', revision: 2, impact: { items: [] } }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(customPortfolio),
        };
      }

      if (path.includes('/api/office/files')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'office-file-123', name: 'Export.docx' }),
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      };
    });
  }

  it('handles API loading failure and presents error notification', async () => {
    global.fetch = setupProjectsFetch(samplePortfolio, true);

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Internal server error in project service');
  });

  it('renders portfolio workspace with project cards, tolerance badges, and full header actions', async () => {
    global.fetch = setupProjectsFetch();
    const onClose = vi.fn();
    const onAskBob = vi.fn();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={onClose} onAskBob={onAskBob} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Core Network Upgrade');

    // Switch to Projects Register tab
    const registerTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Projects Register'));
    expect(registerTab).toBeTruthy();
    await act(async () => {
      registerTab?.click();
    });

    expect(host.textContent).toContain('Project portfolio');

    // Test fullscreen button
    const fullscreenBtn = host.querySelector('.projects-fullscreen-btn') as HTMLButtonElement;
    if (fullscreenBtn) {
      await act(async () => {
        fullscreenBtn.click();
      });
    }

    // Test workspace close button
    const closeBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Back to Buddy'));
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      closeBtn?.click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('switches between all main workspace tabs: overview, timeline, people, impact, and merged', async () => {
    global.fetch = setupProjectsFetch();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Overview Tab (Briefing & Attention)
    const overviewTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Briefing & Attention'));
    if (overviewTab) {
      await act(async () => {
        overviewTab.click();
      });
      expect(host.textContent).toContain('Needs attention');
      expect(host.textContent).toContain('Waiting decisions');
      expect(host.textContent).toContain('Due in the next 7 days');

      // Click attention filter item (Blocked tasks)
      const blockedBtn = Array.from(host.querySelectorAll('.projects-attention-list button')).find((b) => b.textContent?.includes('Blocked tasks'));
      if (blockedBtn) {
        await act(async () => {
          blockedBtn.click();
        });
        expect(host.textContent).toContain('Fiber attenuation in sector 4');
      }
    }

    // Timeline Tab (Planner (Timeline))
    const timelineTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Planner (Timeline)'));
    if (timelineTab) {
      await act(async () => {
        timelineTab.click();
      });
      expect(host.querySelector('.projects-workspace')).not.toBeNull();
    }

    // People Tab (Capacity & Staffing)
    const peopleTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Capacity & Staffing'));
    if (peopleTab) {
      await act(async () => {
        peopleTab.click();
      });
      expect(host.textContent).toContain('Elena Rostova');

      // Toggle between heatmap and directory mode
      const dirModeBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Directory') || b.textContent?.includes('List'));
      if (dirModeBtn) {
        await act(async () => {
          dirModeBtn.click();
        });
      }
    }

    // Impact Tab (Forecasting & Scenarios)
    const impactTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Forecasting & Scenarios'));
    if (impactTab) {
      await act(async () => {
        impactTab.click();
      });
      expect(host.textContent).toContain('Current portfolio impact');
    }

    // Merged Tab
    const mergedTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Merged View'));
    if (mergedTab) {
      await act(async () => {
        mergedTab.click();
      });
      expect(host.querySelector('.projects-workspace')).not.toBeNull();
    }
  });

  it('navigates into project details and exercises sub-tabs: products, governance, raid, lessons, team, and settings', async () => {
    global.fetch = setupProjectsFetch();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Switch to Projects Register
    const registerTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Projects Register'));
    expect(registerTab).toBeTruthy();
    await act(async () => {
      registerTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Select proj-1
    const openProjBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Core Network Upgrade' || b.textContent === 'Open project');
    expect(openProjBtn).toBeTruthy();
    await act(async () => {
      openProjBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Core Network Upgrade');
    expect(host.textContent).toContain('Back to portfolio');

    // Sub-tab: Products & Tasks (work)
    const workSubTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Products & Tasks'));
    if (workSubTab) {
      await act(async () => {
        workSubTab.click();
      });
      expect(host.textContent).toContain('Provision Edge Routers');
      expect(host.textContent).toContain('Backbone Acceptance Test Report');
      // Deliverable review gate
      expect(host.textContent).toContain('Acceptance Review & Quality Gate');
      expect(host.textContent).toContain('Zero packet loss under 40Gbps load');
    }

    // Sub-tab: Governance & Stages
    const govSubTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Governance & Stages'));
    if (govSubTab) {
      await act(async () => {
        govSubTab.click();
      });
      expect(host.textContent).toContain('Project brief signed off by sponsor');
    }

    // Sub-tab: RAID Register
    const raidSubTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('RAID Register'));
    if (raidSubTab) {
      await act(async () => {
        raidSubTab.click();
      });
      expect(host.textContent).toContain('Hardware Delivery Lead Time');
      expect(host.textContent).toContain('Select API routing daemon');
    }

    // Sub-tab: Lessons Log
    const lessonSubTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Lessons Log'));
    if (lessonSubTab) {
      await act(async () => {
        lessonSubTab.click();
      });
      expect(host.textContent).toContain('Dual redundant power feeds');
    }

    // Sub-tab: Board & Dependencies (team)
    const teamSubTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Board & Dependencies'));
    if (teamSubTab) {
      await act(async () => {
        teamSubTab.click();
      });
      expect(host.textContent).toContain('Lead Systems Architect');
      expect(host.textContent).toContain('Cloud routing rules');

      // Test remove assignment
      const removeAsgBtn = host.querySelector('button[aria-label*="Remove assignment"]') as HTMLButtonElement;
      if (removeAsgBtn) {
        await act(async () => {
          removeAsgBtn.click();
        });
      }
    }

    // Sub-tab: Settings
    const settingsSubTab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Settings'));
    if (settingsSubTab) {
      await act(async () => {
        settingsSubTab.click();
      });
      expect(host.querySelector('form.pm-project-form, form.pm-settings-shell')).not.toBeNull();
    }
  });

  it('handles project export to Word, Excel, and PDF formats', async () => {
    global.fetch = setupProjectsFetch();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const registerTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Projects Register'));
    await act(async () => {
      registerTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Select project to enter details
    const openProjBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Core Network Upgrade' || b.textContent === 'Open project');
    await act(async () => {
      openProjBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Word Export button
    const wordExportBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Highlight Report (.docx)'));
    if (wordExportBtn) {
      await act(async () => {
        wordExportBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/office/files'),
        expect.objectContaining({ method: 'POST' })
      );
    }

    // Excel Export button
    const excelExportBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Tracker (.csv / .xlsx)'));
    if (excelExportBtn) {
      await act(async () => {
        excelExportBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    }

    // PDF Export button
    const pdfExportBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Export PDF'));
    if (pdfExportBtn) {
      await act(async () => {
        pdfExportBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    }
  });

  it('handles new project creation form and revision conflict banner', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method || 'GET';

      if (path.includes('/api/projects') && method === 'POST') {
        // Return 409 revision conflict
        return {
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ detail: { code: 'revision_conflict' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(samplePortfolio),
      };
    });
    global.fetch = fetchMock;

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const registerTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Projects Register'));
    await act(async () => {
      registerTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const newProjectBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'New project');
    expect(newProjectBtn).toBeTruthy();
    await act(async () => {
      newProjectBtn?.click();
    });

    const form = host.querySelector('form.pm-project-form') as HTMLFormElement;
    expect(form).not.toBeNull();

    // Fill form and submit to trigger conflict
    const nameInput = form.querySelector('input[name="name"]') as HTMLInputElement;
    if (nameInput) {
      await act(async () => {
        setNativeInputValue(nameInput, 'NextGen Datacenter');
      });
    }

    await act(async () => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('This record changed');
  });

  it('replaces a conflicted draft only after the user reloads the latest records', async () => {
    const latest = { ...samplePortfolio, projects: samplePortfolio.projects.map(p => p.id === 'proj-1' ? { ...p, name: 'Updated project', revision: 2 } : p) };
    let reads = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return { ok: false, status: 409, text: async () => JSON.stringify({ detail: { code: 'revision_conflict' } }) };
      reads++;
      return { ok: true, status: 200, text: async () => JSON.stringify(reads > 1 ? latest : samplePortfolio) };
    });
    global.fetch = fetchMock;
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const click = async (label: string) => {
      const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label);
      expect(button, label).toBeTruthy();
      await act(async () => { button!.click(); });
    };
    await click('Projects Register');
    await click('Core Network Upgrade');
    await click('⚙️ Settings');
    let form = host.querySelector('form.pm-project-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    await act(async () => { setNativeInputValue(form.querySelector('input[name="name_input"]')!, 'My unsaved draft'); });
    await act(async () => { form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); });
    expect(host.textContent).toContain('This record changed');
    expect((form.querySelector('input[name="name_input"]') as HTMLInputElement).value).toBe('My unsaved draft');
    await click('Reload latest and replace draft');
    expect(host.textContent).not.toContain('This record changed');
    form = host.querySelector('form.pm-project-form') as HTMLFormElement;
    expect((form.querySelector('input[name="name_input"]') as HTMLInputElement).value).toBe('Updated project');
    expect(reads).toBe(2);
  });

  it('restricts management actions for a read-only portfolio', async () => {
    const fetchMock = setupProjectsFetch({ ...samplePortfolio, can_manage: false });
    global.fetch = fetchMock;
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const click = async (label: string) => {
      const button = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find(b => b.textContent?.trim() === label);
      expect(button, label).toBeTruthy();
      await act(async () => { button!.click(); });
    };
    await click('Projects Register');
    expect(host.textContent).not.toContain('New project');
    await click('Forecasting & Scenarios');
    expect(host.textContent).toContain('An administrator can preview and apply changes');
    expect(host.textContent).not.toContain('Preview impact');
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('filters staff without backups and restores an inactive person to active', async () => {
    const portfolio = { ...samplePortfolio, people: samplePortfolio.people.map(p => p.id === 'person-2' ? { ...p, status: 'departed' } : p) };
    const fetchMock = setupProjectsFetch(portfolio);
    global.fetch = fetchMock;
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const click = async (label: string) => {
      const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(label));
      expect(button, label).toBeTruthy();
      await act(async () => { button!.click(); });
    };
    await click('Capacity & Staffing');
    await click('People Directory');
    const filter = host.querySelector('select[aria-label="People filter"]') as HTMLSelectElement;
    await act(async () => { setNativeInputValue(filter, 'backup'); });
    const directory = host.querySelector('.projects-people-grid')!;
    expect(directory.textContent).toContain('Elena Rostova');
    expect(directory.textContent).toContain('Marcus Vance');
    expect(directory.textContent).toContain('No backup');
    const search = host.querySelector('label.projects-search input[type="search"]') as HTMLInputElement;
    await act(async () => { setNativeInputValue(search, 'marcus'); });
    expect(directory.textContent).not.toContain('Elena Rostova');
    expect(directory.textContent).toContain('Marcus Vance');
    await click('Mark active');
    const update = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/people/person-2') && init?.method === 'PATCH');
    expect(update).toBeTruthy();
    expect(JSON.parse(update![1].body as string)).toEqual({ status: 'active', departure_date: null });
    expect(host.textContent).toContain('Changes saved.');
  });

  it('adds a project responsibility and an upstream dependency with the selected project', async () => {
    const fetchMock = setupProjectsFetch();
    global.fetch = fetchMock;
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const click = async (text: string) => {
      const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(text));
      expect(button, text).toBeTruthy();
      await act(async () => { button!.click(); });
    };
    await click('Projects Register');
    await click('Core Network Upgrade');
    await click('Board & Dependencies');
    const assignmentForm = host.querySelector('section[aria-label="People & responsibilities"] form') as HTMLFormElement;
    expect(assignmentForm).toBeTruthy();
    await act(async () => {
      setNativeInputValue(assignmentForm.querySelector('[name="person_id"]')!, 'person-1');
      setNativeInputValue(assignmentForm.querySelector('[name="responsibility"]')!, 'Manage release');
      setNativeInputValue(assignmentForm.querySelector('[name="role"]')!, 'project_manager');
      setNativeInputValue(assignmentForm.querySelector('[name="allocation"]')!, '45');
      assignmentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const assignment = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/assignments') && init?.method === 'POST');
    expect(assignment).toBeTruthy();
    expect(JSON.parse(assignment![1].body as string)).toMatchObject({ project_id: 'proj-1', person_id: 'person-1', responsibility: 'Manage release', role: 'project_manager', allocation: 45, backup_person_id: null });
    const dependencyForm = host.querySelector('.projects-module-dependencies form') as HTMLFormElement;
    expect(dependencyForm).toBeTruthy();
    await act(async () => {
      setNativeInputValue(dependencyForm.querySelector('[name="source_project_id"]')!, 'proj-2');
      setNativeInputValue(dependencyForm.querySelector('[name="description"]')!, 'Cloud readiness');
      dependencyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const dependency = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/dependencies') && init?.method === 'POST');
    expect(dependency).toBeTruthy();
    expect(JSON.parse(dependency![1].body as string)).toMatchObject({ target_project_id: 'proj-1', source_project_id: 'proj-2', description: 'Cloud readiness' });
  });

  it('expands and collapses sections in merged view', async () => {
    global.fetch = setupProjectsFetch();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const mergedTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Merged View'));
    await act(async () => {
      mergedTab?.click();
    });

    // Check merged view rendered
    expect(host.querySelector('.projects-merged-container, .projects-merged-view, .projects-workspace')).not.toBeNull();
  });

  it('triggers Project Buddy contextual assistant and handles message exchanges', async () => {
    global.fetch = setupProjectsFetch();
    const onAskBob = vi.fn().mockResolvedValue(undefined);
    const onStopBob = vi.fn();

    const sampleBobMessages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Review the upcoming deadline, remaining recorded tasks and required decisions for this project.',
        timestamp: 1730000000,
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'Here is your PRINCE2 Briefing: All Phase 1 deliverables are on track with zero tolerance breaches.',
        timestamp: 1730000010,
      },
    ];

    await act(async () => {
      root.render(
        <ProjectsWorkspace
          onClose={vi.fn()}
          onAskBob={onAskBob}
          bobMessages={sampleBobMessages}
          bobBusy={false}
          onStopBob={onStopBob}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Toggle assistant drawer
    const toggleAssistantBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Ask Project Buddy') || b.textContent?.includes('Project Buddy'));
    if (toggleAssistantBtn) {
      await act(async () => {
        toggleAssistantBtn.click();
      });
    }

    // Check Bob messages rendered
    expect(host.textContent).toContain('Here is your PRINCE2 Briefing');

    // Type a question in the assistant textarea and submit
    const textarea = host.querySelector('.projects-bob-drawer textarea, textarea[name="question"]') as HTMLTextAreaElement;
    if (textarea) {
      await act(async () => {
        setNativeInputValue(textarea, 'What are the main risks for this sprint?');
      });
      const sendBtn = host.querySelector('.projects-bob-drawer button[type="submit"]') as HTMLButtonElement;
      if (sendBtn) {
        await act(async () => {
          sendBtn.click();
        });
        expect(onAskBob).toHaveBeenCalled();
      }
    }
  });

  it('switches people view mode between heatmap and directory', async () => {
    global.fetch = setupProjectsFetch();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const peopleTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('People'));
    if (peopleTab) {
      await act(async () => {
        peopleTab.click();
      });
      const directoryBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Directory'));
      if (directoryBtn) {
        await act(async () => {
          directoryBtn.click();
        });
        expect(host.textContent).toContain('Elena Rostova');
      }
    }
  });

  it('runs scenario change impact analysis and applies changes', async () => {
    global.fetch = setupProjectsFetch();

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const impactTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find((b) => b.textContent?.includes('Change impact') || b.textContent?.includes('Impact'));
    if (impactTab) {
      await act(async () => {
        impactTab.click();
      });

      const simulateForm = host.querySelector('form.projects-change-form, form');
      if (simulateForm) {
        await act(async () => {
          simulateForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
      }
      expect(host.children.length).toBeGreaterThan(0);
    }
  });

  it('previews a project change, discards stale results, and applies the renewed preview', async () => {
    const fetchMock = setupProjectsFetch();
    global.fetch = fetchMock;
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const impactTab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find(b => b.textContent?.includes('Forecasting'))!;
    expect(impactTab).toBeDefined();
    await act(async () => { impactTab.click(); });
    const type = host.querySelector<HTMLSelectElement>('select[aria-label="Change type"]')!;
    await act(async () => { setNativeInputValue(type, 'project_change'); });
    const target = host.querySelector<HTMLSelectElement>('select[aria-label="Project"]')!;
    await act(async () => { setNativeInputValue(target, 'proj-1'); });
    const status = host.querySelector<HTMLSelectElement>('select[aria-label="Proposed status"]')!;
    await act(async () => { setNativeInputValue(status, 'paused'); });
    const form = type.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(host.querySelector('[aria-label="What-if results"]')?.textContent).toContain('Simulated departure increases risk');
    const previewCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/impact/preview'))!;
    expect(JSON.parse(previewCall[1].body)).toEqual({ kind: 'project_change', project_id: 'proj-1', expected_revision: 1, status: 'paused' });
    await act(async () => { setNativeInputValue(status, 'completed'); });
    expect(host.querySelector('[aria-label="What-if results"]')).toBeNull();
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const apply = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Apply this change')!;
    expect(apply).toBeDefined();
    await act(async () => { apply.click(); });
    const applyCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/impact/apply'))!;
    expect(JSON.parse(applyCall[1].body).status).toBe('completed');
    expect(host.textContent).toContain('Change applied. Portfolio impact updated.');
    expect(host.querySelector('[aria-label="What-if results"]')).toBeNull();
  });

  it('reports a preview failure and permits retry without applying a change', async () => {
    const normalFetch = setupProjectsFetch();
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/impact/preview')) return { ok: false, status: 503, text: async () => JSON.stringify({ detail: 'Forecast unavailable' }) };
      return normalFetch(url, init);
    });
    global.fetch = fetchMock;
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const tab = Array.from(host.querySelectorAll('nav.projects-view-nav button')).find(b => b.textContent?.includes('Forecasting'))!;
    await act(async () => { tab.click(); });
    const person = host.querySelector<HTMLSelectElement>('select[aria-label="Person"]')!;
    await act(async () => { setNativeInputValue(person, 'person-1'); });
    const submit = person.closest('form')!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => { submit.click(); });
    expect(host.textContent).toContain('Forecast unavailable');
    expect(submit.disabled).toBe(false);
    expect(host.querySelector('[aria-label="What-if results"]')).toBeNull();
    const previewCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/impact/preview'))!;
    expect(JSON.parse(previewCall[1].body)).toEqual({kind: 'person_departure', person_id: 'person-1', status: 'leaving', departure_date: null});
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/impact/apply'))).toBe(false);
  });
});

// =========================================================================
// SECTION 2: OfficeSuite Tests
// =========================================================================

describe('OfficeSuite UI Component', () => {
  const mockFiles = [
    {
      id: 'a1111111-1111-4111-8111-111111111111',
      name: 'Project Plan.docx',
      extension: 'docx',
      size: 15420,
      revision: 1,
      save_sequence: 1,
      saved_at: '2026-10-28T12:00:00Z',
      is_owner: true,
      access: 'owner',
    },
    {
      id: 'b2222222-2222-4222-8222-222222222222',
      name: 'Budget 2027.xlsx',
      extension: 'xlsx',
      size: 45200,
      revision: 2,
      save_sequence: 3,
      saved_at: '2026-10-28T14:30:00Z',
      is_owner: false,
      access: 'write',
    },
    {
      id: 'c3333333-3333-4333-8333-333333333333',
      name: 'Architecture Deck.html',
      extension: 'html',
      size: 8200,
      revision: 1,
      save_sequence: 1,
      saved_at: '2026-10-28T16:00:00Z',
      is_owner: true,
      access: 'owner',
    },
  ];

  const mockFolders = [{ id: 'f-1', name: 'Workflows', parent_id: null }];
  const mockUsers = [{ username: 'bob', display_name: 'Bob Admin', email: 'bob@example.com', online: true }];
  const mockShares = [{ username: 'bob', display_name: 'Bob Admin', permission: 'read', online: true }];

  function setupOfficeFetch() {
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method || 'GET';

      if (path.includes('/api/office/status')) {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'ready' }) });
      }
      if (path.includes('/content')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            html: '<!DOCTYPE html><html><head><title>Architecture Deck</title></head><body><section class="slide"><h1>Architecture</h1></section></body></html>',
            revision: 1,
          }),
        });
      }
      if (path.includes('/shares')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: mockShares }) });
      }
      if (path.includes('/api/office/files/') && method === 'GET' && !path.endsWith('/files')) {
        const found = mockFiles.find((f) => path.includes(f.id)) || mockFiles[0];
        return Promise.resolve({ ok: true, json: async () => found });
      }
      if (path.includes('/api/office/files') && method === 'GET') {
        return Promise.resolve({ ok: true, json: async () => ({ items: mockFiles }) });
      }
      if (path.includes('/api/office/folders')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: mockFolders }) });
      }
      if (path.includes('/api/office/users')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: mockUsers }) });
      }
      if (path.includes('/create') && method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 'd4444444-4444-4444-8444-444444444444',
            name: 'New Document.docx',
            extension: 'docx',
            size: 1024,
            revision: 1,
            save_sequence: 1,
            saved_at: '2026-10-29T10:00:00Z',
            is_owner: true,
            access: 'owner',
          }),
        });
      }
      if (path.includes('/name') && method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...mockFiles[0], name: 'Renamed Project Plan.docx' }),
        });
      }
      if (path.includes('/folder') && method === 'PATCH') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (path.includes('/editor')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ script_url: '/mock/docs-api.js', config: {}, file: mockFiles[0] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });
  }

  it('renders office workspace, storage status, and filters by category', async () => {
    global.fetch = setupOfficeFetch();
    const onClose = vi.fn();

    await act(async () => {
      root.render(<OfficeSuite onClose={onClose} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Office Suite storage');
    expect(host.textContent).toContain('Project Plan.docx');
    expect(host.textContent).toContain('Budget 2027.xlsx');

    // Filter by Word documents
    const wordFilterBtn = Array.from(host.querySelectorAll('.office-sidebar button, .office-library-tools button')).find((b) =>
      b.textContent?.includes('Word documents') || b.textContent?.includes('Documents')
    );
    if (wordFilterBtn) {
      await act(async () => {
        wordFilterBtn.click();
      });
      expect(host.textContent).toContain('Project Plan.docx');
    }

    // Filter by Shared with me
    const sharedFilterBtn = Array.from(host.querySelectorAll('.office-sidebar button, .office-library-tools button')).find((b) =>
      b.textContent?.includes('Shared with me')
    );
    if (sharedFilterBtn) {
      await act(async () => {
        sharedFilterBtn.click();
      });
      expect(host.textContent).toContain('Budget 2027.xlsx');
    }
  });

  it('searches office library files using search input', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const searchInput = host.querySelector('input[aria-label="Search office files"]') as HTMLInputElement;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      setNativeInputValue(searchInput, 'Budget');
    });

    expect(host.textContent).toContain('Budget 2027.xlsx');
    expect(host.textContent).not.toContain('Project Plan.docx');
  });

  it('opens create file dialog and handles new document creation', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Click Word document creation card
    const createWordBtn = Array.from(host.querySelectorAll('.office-create button')).find((b) => b.textContent?.includes('Word document'));
    expect(createWordBtn).toBeTruthy();

    await act(async () => {
      createWordBtn?.click();
    });

    expect(host.textContent).toContain('New document');
    const nameInput = host.querySelector('.office-new-name input') as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    await act(async () => {
      setNativeInputValue(nameInput, 'Quarterly Network Review');
    });

    const submitBtn = host.querySelector('.office-upload form button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/create'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('handles upload modal open, close, and file drag-drop validation', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const uploadBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Upload files'));
    expect(uploadBtn).toBeTruthy();

    await act(async () => {
      uploadBtn?.click();
    });

    expect(host.textContent).toContain('Upload to your office');

    // Test drag & drop invalid file type
    const dropzone = host.querySelector('.office-dropzone') as HTMLDivElement;
    expect(dropzone).not.toBeNull();

    const badFile = new File(['executable'], 'malicious.exe', { type: 'application/x-msdownload' });
    const dragEvent = new Event('drop', { bubbles: true }) as any;
    dragEvent.dataTransfer = { files: [badFile] };

    await act(async () => {
      dropzone.dispatchEvent(dragEvent);
    });

    expect(host.textContent).toContain('Choose DOCX, XLSX, PPTX, CSV, PDF, or HTML.');

    // Close upload modal
    const closeUploadBtn = host.querySelector('.office-upload-close') as HTMLButtonElement;
    if (closeUploadBtn) {
      await act(async () => {
        closeUploadBtn.click();
      });
    }
  });

  it('opens file item menu to trigger rename, share modal, and deletion', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Open context menu (⋯ button) on first file
    const menuBtn = host.querySelector('button[aria-label*="Actions: Project Plan.docx"]') as HTMLButtonElement;
    expect(menuBtn).toBeTruthy();

    await act(async () => {
      menuBtn.click();
    });

    // Click Rename
    const renameAction = Array.from(document.querySelectorAll('.office-item-menu button')).find((b) => b.textContent?.includes('Rename'));
    expect(renameAction).toBeTruthy();

    await act(async () => {
      renameAction?.click();
    });

    expect(host.textContent).toContain('Rename file');
    const renameInput = host.querySelector('.office-folder-dialog input') as HTMLInputElement;
    if (renameInput) {
      await act(async () => {
        setNativeInputValue(renameInput, 'Renamed Project Plan.docx');
      });
      const saveRenameBtn = host.querySelector('.office-folder-dialog button[type="submit"]') as HTMLButtonElement;
      await act(async () => {
        saveRenameBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    }

    // Open context menu again and click Share
    const menuBtn2 = host.querySelector('button[aria-label*="Actions: Project Plan.docx"]') as HTMLButtonElement;
    if (menuBtn2) {
      await act(async () => {
        menuBtn2.click();
      });
      const shareAction = Array.from(document.querySelectorAll('.office-item-menu button')).find((b) => b.textContent?.includes('Share'));
      if (shareAction) {
        await act(async () => {
          shareAction.click();
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
        expect(host.textContent).toContain('ACCESS & PERMISSIONS');
        expect(host.textContent).toContain('PEOPLE WITH ACCESS');

        // Submit grant access
        const grantBtn = host.querySelector('.office-share-form button[type="submit"]') as HTMLButtonElement;
        if (grantBtn) {
          await act(async () => {
            grantBtn.click();
          });
          await act(async () => {
            await new Promise((r) => setTimeout(r, 40));
          });
        }

        // Click remove share button
        const removeShareBtn = host.querySelector('.office-share-item-actions button') as HTMLButtonElement;
        if (removeShareBtn) {
          await act(async () => {
            removeShareBtn.click();
          });
          await act(async () => {
            await new Promise((r) => setTimeout(r, 40));
          });
        }

        // Close share modal
        const closeShare = host.querySelector('.office-share-dialog .office-upload-close') as HTMLButtonElement;
        if (closeShare) {
          await act(async () => {
            closeShare.click();
          });
        }
      }
    }
  });

  it('opens Word document in OfficeEditor with DocsAPI integration', async () => {
    (window as any).DocsAPI = {
      DocEditor: class {
        destroyEditor = vi.fn();
        constructor(_id: string, config: any) {
          setTimeout(() => {
            config.events?.onAppReady?.();
          }, 10);
        }
      },
    };
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Click file name to open editor
    const fileBtn = Array.from(host.querySelectorAll('button.office-file-name')).find((b) => b.textContent?.includes('Project Plan.docx'));
    expect(fileBtn).toBeTruthy();

    await act(async () => {
      fileBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    expect(host.querySelector('.office-content-editing, .office-editor-frame')).not.toBeNull();
  });

  it('opens HTML document in OfficeHtmlEditor', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const htmlFileBtn = Array.from(host.querySelectorAll('button.office-file-name')).find((b) => b.textContent?.includes('Architecture Deck.html'));
    expect(htmlFileBtn).toBeTruthy();

    await act(async () => {
      htmlFileBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.querySelector('.office-content-editing')).not.toBeNull();
  });

  it('handles file move dialog and destination folder selection', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const menuBtn = host.querySelector('button[aria-label*="Actions: Project Plan.docx"]') as HTMLButtonElement;
    await act(async () => {
      menuBtn?.click();
    });

    const moveAction = Array.from(document.querySelectorAll('.office-item-menu button')).find((b) => b.textContent?.includes('Move'));
    expect(moveAction).toBeTruthy();

    await act(async () => {
      moveAction?.click();
    });

    expect(host.textContent).toContain('Move file');
    const moveForm = host.querySelector('form.office-folder-dialog') as HTMLFormElement;
    expect(moveForm).not.toBeNull();

    await act(async () => {
      moveForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/folder'),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('handles file deletion after user confirmation', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const menuBtn = host.querySelector('button[aria-label*="Actions: Project Plan.docx"]') as HTMLButtonElement;
    await act(async () => {
      menuBtn?.click();
    });

    const deleteAction = Array.from(document.querySelectorAll('.office-item-menu button')).find((b) => b.textContent?.includes('Delete'));
    expect(deleteAction).toBeTruthy();

    await act(async () => {
      deleteAction?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/files/a1111111-1111-4111-8111-111111111111'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('handles keyboard Escape key to dismiss modals', async () => {
    global.fetch = setupOfficeFetch();

    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Open upload modal
    const uploadBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Upload files'));
    await act(async () => {
      uploadBtn?.click();
    });
    expect(host.textContent).toContain('Upload to your office');

    // Press Escape
    const dialog = host.querySelector('.office-suite') as HTMLElement;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(host.textContent).not.toContain('Upload to your office');
  });
});

// =========================================================================
// SECTION 3: HtmlDeckViewer Tests
// =========================================================================

describe('HtmlDeckViewer UI Component', () => {
  function populateIframeDocument(iframe: HTMLIFrameElement, html: string) {
    if (iframe.contentDocument) {
      iframe.contentDocument.documentElement.innerHTML = html;
      iframe.dispatchEvent(new Event('load'));
    }
  }

  it('renders presentation incomplete fallback when content is incomplete or below threshold', async () => {
    const incompleteHtml = `<!DOCTYPE html><html><body><section class="slide"><h1>WIP</h1></section></body></html>`;

    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={incompleteHtml} filename="deck.html" />);
    });

    expect(host.textContent).toContain('Presentation Generation Incomplete');
    expect(host.textContent).toContain('Check Again');
  });

  it('renders loading placeholder when only filename is provided and content is loading', async () => {
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})); // Never resolves

    await act(async () => {
      root.render(<HtmlDeckViewer filename="pending_presentation.html" />);
    });

    expect(host.textContent).toContain('Loading presentation:pending_presentation.html…');
  });

  it('renders complete presentation studio with header, title, slide counter, and navigation buttons', async () => {
    await act(async () => {
      root.render(
        <HtmlDeckViewer
          htmlContent={sampleCompleteDeckHtml}
          filename="network_architecture.html"
          title="Enterprise Network Architecture"
        />
      );
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();

    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    expect(host.textContent).toContain('⚡ PRESENTATION STUDIO');
    expect(host.textContent).toContain('Enterprise Network Architecture');
    expect(host.textContent).toContain('Slide2 / 2');

    // Slide navigation: Previous and Next
    const prevBtn = host.querySelector('button[title*="Previous slide"]') as HTMLButtonElement;
    const nextBtn = host.querySelector('button[title*="Next slide"]') as HTMLButtonElement;

    expect(prevBtn).toBeTruthy();
    expect(nextBtn).toBeTruthy();

    await act(async () => {
      prevBtn.click();
    });
    await act(async () => {
      nextBtn.click();
    });
  });

  it('toggles slide filmstrip sidebar and provides slide management controls', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    // Toggle Filmstrip
    const filmstripToggle = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Show Slides'));
    expect(filmstripToggle).toBeTruthy();

    await act(async () => {
      filmstripToggle?.click();
    });

    expect(host.textContent).toContain('SLIDES (');
    expect(host.textContent).toContain('Strategic Overview');
    expect(host.textContent).toContain('Delivery Milestones');

    // Add new slide button in filmstrip
    const addSlideBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '+ Add' || b.textContent?.includes('Add Slide'));
    if (addSlideBtn) {
      await act(async () => {
        addSlideBtn.click();
      });
    }

    // Move slide button
    const moveSlideDown = host.querySelector('button[title="Move slide down"]') as HTMLButtonElement;
    if (moveSlideDown) {
      await act(async () => {
        moveSlideDown.click();
      });
    }

    // Duplicate slide button
    const dupSlideBtn = host.querySelector('button[title="Duplicate slide"]') as HTMLButtonElement;
    if (dupSlideBtn) {
      await act(async () => {
        dupSlideBtn.click();
      });
    }

    // Delete slide button
    const deleteSlideBtn = host.querySelector('button[title="Delete slide"]') as HTMLButtonElement;
    if (deleteSlideBtn) {
      await act(async () => {
        deleteSlideBtn.click();
      });
    }
  });

  it('toggles in-place text editing mode and provides editing banner', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    const editTextBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit Text'));
    expect(editTextBtn).toBeTruthy();

    await act(async () => {
      editTextBtn?.click();
    });

    expect(host.textContent).toContain('Text Edit Mode is Active');
    expect(host.textContent).toContain('Done Editing');

    // Exit text editing
    const doneBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Done Editing'));
    await act(async () => {
      doneBtn?.click();
    });

    expect(host.textContent).not.toContain('Text Edit Mode is Active');
  });

  it('activates object selection mode and exercises parent frame and undo removal', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    const selectObjBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Select objects'));
    expect(selectObjBtn).toBeTruthy();

    await act(async () => {
      selectObjBtn?.click();
    });

    expect(host.textContent).toContain('Click text, a frame, image, or chart');
    expect(host.textContent).toContain('Select parent frame');
    expect(host.textContent).toContain('Delete object');

    // Click an element inside iframe to select it
    const ledeEl = iframe.contentDocument?.querySelector('.lede');
    if (ledeEl) {
      await act(async () => {
        ledeEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      // Click delete object button if enabled
      const deleteBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Delete object'));
      if (deleteBtn && !deleteBtn.hasAttribute('disabled')) {
        await act(async () => {
          deleteBtn.click();
        });
        // Click undo deletion button if present
        const undoBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Undo'));
        if (undoBtn) {
          await act(async () => {
            undoBtn.click();
          });
        }
      }
    }

    // Toggle off
    await act(async () => {
      selectObjBtn?.click();
    });
  });

  it('handles buddy-presentation-raster postMessage event and paints images', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });
    const iframes = host.querySelectorAll('iframe');
    const liveIframe = iframes[1] || iframes[0];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: liveIframe?.contentWindow,
          data: {
            type: 'buddy-presentation-raster',
            images: [
              { index: 0, png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
            ],
          },
        })
      );
    });
    expect(host.children.length).toBeGreaterThan(0);
  });

  it('opens color palette studio, selects theme presets, and adjusts color pickers', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    const colorsBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Colors'));
    expect(colorsBtn).toBeTruthy();

    await act(async () => {
      colorsBtn?.click();
    });

    expect(host.textContent).toContain('Visual Theme & Colors');
    expect(host.textContent).toContain('Quick Themes:');

    // Click a theme preset: Emerald & Lime Modern
    const emeraldPreset = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Emerald & Lime Modern'));
    if (emeraldPreset) {
      await act(async () => {
        emeraldPreset.click();
      });
      // Should mark as dirty and show Unsaved changes
      expect(host.textContent).toContain('Unsaved changes');
    }

    // Close color panel
    await act(async () => {
      colorsBtn?.click();
    });
  });

  it('opens edit chart data modal, detects KPI metrics, and updates values', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    const editDataBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit Data'));
    expect(editDataBtn).toBeTruthy();

    await act(async () => {
      editDataBtn?.click();
    });

    expect(host.textContent).toContain('Edit Presentation Numbers & Charts');
    expect(host.textContent).toContain('Executive Key Metrics');

    // Apply changes in chart modal
    const applyChangesBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Apply Changes'));
    if (applyChangesBtn) {
      await act(async () => {
        applyChangesBtn.click();
      });
    }

    expect(host.textContent).not.toContain('Edit Presentation Numbers & Charts');
  });

  it('triggers save HTML, save PPTX to Office Suite, download, and fullscreen actions', async () => {
    const onSaveHtml = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/office/files')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'office-pres-123', name: 'Presentation.pptx' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await act(async () => {
      root.render(
        <HtmlDeckViewer
          htmlContent={sampleCompleteDeckHtml}
          filename="deck.html"
          title="Enterprise Network Architecture"
          onSaveHtml={onSaveHtml}
        />
      );
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    // Save HTML
    const saveBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Save'));
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(onSaveHtml).toHaveBeenCalled();

    // Save PPTX to Office Suite
    const savePptxBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Save PPTX to Office Suite'));
    if (savePptxBtn) {
      await act(async () => {
        savePptxBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/office/files'),
        expect.objectContaining({ method: 'POST' })
      );
    }

    // Download HTML
    const downloadBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.getAttribute('title')?.includes('Download') || b.textContent?.trim() === '📥HTML'
    );
    expect(downloadBtn).toBeTruthy();
    if (downloadBtn) {
      await act(async () => {
        downloadBtn.click();
      });
      expect(window.URL.createObjectURL).toHaveBeenCalled();
    }

    // Open in New Tab
    const newTabBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '↗');
    if (newTabBtn) {
      await act(async () => {
        newTabBtn.click();
      });
      expect(window.open).toHaveBeenCalled();
    }

    // Fullscreen Toggle
    const fullscreenBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('FULLSCREEN'));
    if (fullscreenBtn) {
      await act(async () => {
        fullscreenBtn.click();
      });
    }

    // Live preview toggle
    const livePreviewBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Open live presentation'));
    if (livePreviewBtn) {
      await act(async () => {
        livePreviewBtn.click();
      });
      expect(host.textContent).toContain('Return to editor');

      const returnEditorBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Return to editor'));
      await act(async () => {
        returnEditorBtn?.click();
      });
      expect(host.textContent).toContain('Open live presentation');
    }
  });

  it('reverts unsaved modifications back to clean state', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    // Open colors and select a preset to make dirty
    const colorsBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Colors'));
    await act(async () => {
      colorsBtn?.click();
    });

    const preset = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Emerald & Lime Modern'));
    await act(async () => {
      preset?.click();
    });

    expect(host.textContent).toContain('Unsaved changes');

    // Click Reset button
    const resetBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Reset'));
    expect(resetBtn).toBeTruthy();

    await act(async () => {
      resetBtn?.click();
    });

    expect(host.textContent).not.toContain('Unsaved changes');
  });

  it('handles keyboard shortcuts for fullscreen toggling', async () => {
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={sampleCompleteDeckHtml} filename="deck.html" />);
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    // Press 'f' key on window
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    });

    expect(host.querySelector('.bobdeck-viewer.fullscreen')).not.toBeNull();

    // Press 'Escape' key on window
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(host.querySelector('.bobdeck-viewer.fullscreen')).toBeNull();
  });

  it('respects restrictedScripts prop and officeFileId prop', async () => {
    await act(async () => {
      root.render(
        <HtmlDeckViewer
          htmlContent={sampleCompleteDeckHtml}
          filename="deck.html"
          restrictedScripts={true}
          officeFileId="office-doc-99"
        />
      );
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
      populateIframeDocument(iframe, sampleCompleteDeckHtml);
    });

    // Live presentation toggle should be hidden when restrictedScripts is true
    expect(host.textContent).not.toContain('Open live presentation');

    // Save HTML to Office Suite button should not be displayed when officeFileId is provided
    expect(host.textContent).not.toContain('Save HTML to Office Suite');
  });
});
