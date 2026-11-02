// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { KnowledgeDocuments } from '../../src/components/KnowledgeDocuments';
import { ResearchReport, type ReportSource } from '../../src/components/ResearchReport';
import {
  ApprovalPolicyPicker,
  ApprovalCard,
  ApprovalSettingsMenu,
  RuntimeApprovalSettings,
  ApprovalGuide,
} from '../../src/components/ApprovalControls';
import { ArtifactEditor, type Artifact } from '../../src/components/ArtifactEditor';
import {
  CatalogIcon,
  MCPCatalog,
  MCPServerCatalog,
} from '../../src/components/MCPCatalog';
import { Sidebar } from '../../src/components/Sidebar';
import { PresentationTemplateStudio } from '../../src/components/PresentationTemplateStudio';
import {
  QuizGradingState,
  QuizReport,
  QuizStatistics,
  type QuizSubmission,
} from '../../src/components/LearningQuizResults';
import { AdministrationPage } from '../../src/components/AdministrationPage';
import { IntelligentAnswer } from '../../src/components/IntelligentAnswer';
import { ConversationSharing } from '../../src/components/ConversationSharing';
import { AgentCatalog } from '../../src/components/AgentCatalog';
import type { ApprovalPolicy, ActionApproval, User, Project, SessionItem, Skill, Mode, A2AAgent, WorkspacePage, PresentationTemplate } from '../../src/types';

vi.mock('@carbon/charts', () => {
  class MockChart {
    update = vi.fn();
    destroy = vi.fn();
    dispose = vi.fn();
  }
  return {
    SimpleBarChart: MockChart,
    GroupedBarChart: MockChart,
    StackedBarChart: MockChart,
    LineChart: MockChart,
    AreaChart: MockChart,
    StackedAreaChart: MockChart,
    PieChart: MockChart,
    DonutChart: MockChart,
    ScatterChart: MockChart,
    BubbleChart: MockChart,
    HeatmapChart: MockChart,
    TreemapChart: MockChart,
    AlluvialChart: MockChart,
    HistogramChart: MockChart,
    BoxplotChart: MockChart,
    RadarChart: MockChart,
    MeterChart: MockChart,
    GaugeChart: MockChart,
    TreeChart: MockChart,
    CirclePackChart: MockChart,
    LollipopChart: MockChart,
    transitions: { default: { duration: 0 }, setupTransition: vi.fn() },
  };
});

vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../carbon-charts', () => ({
  create: vi.fn(() => ({
    update: vi.fn(),
    dispose: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>Mocked diagram</text></svg>' }),
  },
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
  window.scrollTo = vi.fn();

  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent || '';
    },
    configurable: true,
  });

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

  if (typeof globalThis.DragEvent === 'undefined') {
    class MockDragEvent extends Event {
      dataTransfer: any;
      constructor(type: string, init?: any) {
        super(type, init);
        this.dataTransfer = init?.dataTransfer || null;
      }
    }
    vi.stubGlobal('DragEvent', MockDragEvent);
  }

  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    font: '',
    measureText: vi.fn().mockReturnValue({ width: 50 }),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(),
    putImageData: vi.fn(),
    createImageData: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    fillText: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
  }) as any;

  HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,mock');

  window.open = vi.fn();
  window.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
  window.URL.revokeObjectURL = vi.fn();

  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve() },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });

  host = document.createElement('div');
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
// 1. KnowledgeDocuments Component
// =========================================================================
describe('KnowledgeDocuments Component', () => {
  const mockDocs = [
    {
      id: 'doc-ready-1',
      filename: 'company-handbook.pdf',
      description: 'Employee guidelines and policies',
      status: 'ready' as const,
      error: null,
      chunk_count: 14,
      uploaded_by: 'admin',
      created_at: '2026-10-25T10:00:00Z',
      size: 204800,
      can_manage: true,
      knowledge_base: 'company' as const,
      audience: 'both' as const,
      owner: 'Alice Admin',
      review_due: '2026-12-01',
      review_overdue: false,
      reviewed_at: '2026-10-25T10:00:00Z',
    },
    {
      id: 'doc-prep-2',
      filename: 'regional-network-specs.docx',
      description: 'Technical topology reference',
      status: 'indexing' as const,
      error: null,
      chunk_count: 0,
      uploaded_by: 'engineer',
      created_at: '2026-10-26T11:00:00Z',
      size: 512000,
      can_manage: true,
      knowledge_base: 'company' as const,
      audience: 'buddy' as const,
      owner: 'Bob Engineer',
      review_due: null,
      review_overdue: false,
    },
    {
      id: 'doc-fail-3',
      filename: 'corrupted-scan.pdf',
      description: 'Broken scan',
      status: 'failed' as const,
      error: 'OCR parser error: invalid header',
      chunk_count: 0,
      uploaded_by: 'admin',
      created_at: '2026-10-27T08:00:00Z',
      size: 10240,
      can_manage: true,
      knowledge_base: 'company' as const,
      audience: 'both' as const,
      review_overdue: true,
    },
  ];

  it('renders compact indicator and dispatches buddy-open-knowledge on click', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockDocs,
    }));

    const eventListener = vi.fn();
    window.addEventListener('buddy-open-knowledge', eventListener);

    await act(async () => {
      root.render(
        <KnowledgeDocuments
          compact={true}
          isStreaming={false}
          hasExternalAgent={false}
        />
      );
    });

    const button = host.querySelector('button.knowledge-chat-indicator');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Knowledge base');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(eventListener).toHaveBeenCalled();
    window.removeEventListener('buddy-open-knowledge', eventListener);
  });

  it('renders expanded documents list, filters by library and status, and performs search', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/knowledge') {
        return Promise.resolve({ ok: true, json: async () => mockDocs });
      }
      if (url === '/knowledge/search') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 'doc-ready-1',
              filename: 'company-handbook.pdf',
              location: 'Page 3, Paragraph 2',
              text: 'Standard policy applies to all staff members.',
              citation_id: 'cit-1',
            },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <KnowledgeDocuments
          compact={false}
          isAdmin={true}
          isStreaming={false}
          hasExternalAgent={false}
        />
      );
    });

    // Check header and document rendering
    expect(host.textContent).toContain('company-handbook.pdf');
    expect(host.textContent).toContain('corrupted-scan.pdf');

    // Filter by status: 'Needs attention'
    const failedFilterBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Needs attention')
    );
    await act(async () => {
      failedFilterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('corrupted-scan.pdf');
    expect(host.textContent).not.toContain('company-handbook.pdf');

    // Reset filter to 'All sources'
    const allFilterBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('All sources')
    );
    await act(async () => {
      allFilterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Search contents
    const searchInput = host.querySelector('form.knowledge-search input') as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    await act(async () => {
      setNativeInputValue(searchInput, 'handbook');
    });

    const searchSubmitBtn = host.querySelector('form.knowledge-search button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      searchSubmitBtn.click();
    });

    expect(mockFetch).toHaveBeenCalledWith('/knowledge/search', expect.objectContaining({ method: 'POST' }));
    expect(host.textContent).toContain('Standard policy applies to all staff members.');

    // Clear search results
    const backBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Back to sources')
    );
    await act(async () => {
      backBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const clearBtn = host.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement;
    if (clearBtn) {
      await act(async () => {
        clearBtn.click();
      });
    }
    expect(host.textContent).toContain('company-handbook.pdf');
  });

  it('handles document actions: mark reviewed, edit classification, and remove source', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/knowledge') {
        return Promise.resolve({ ok: true, json: async () => mockDocs });
      }
      if (url.includes('/freshness') && opts?.method === 'PATCH') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes('/knowledge/') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <KnowledgeDocuments
          compact={false}
          isAdmin={true}
          isStreaming={false}
          hasExternalAgent={false}
        />
      );
    });

    // Mark reviewed
    const markReviewedBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Mark reviewed')
    );
    await act(async () => {
      markReviewedBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/freshness'),
      expect.objectContaining({ method: 'PATCH' })
    );

    // Edit classification & description
    const editBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Edit classification & description')
    );
    await act(async () => {
      editBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('.knowledge-description-field textarea')).not.toBeNull();

    // Cancel edit
    const cancelBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel'
    );
    await act(async () => {
      cancelBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Remove source
    const removeBtn = host.querySelector('button.knowledge-remove') as HTMLButtonElement;
    await act(async () => {
      removeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge/'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('handles drag and drop and review of pending upload files', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/knowledge' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url === '/knowledge') {
        return Promise.resolve({ ok: true, json: async () => mockDocs });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <KnowledgeDocuments
          compact={false}
          isAdmin={true}
          isStreaming={false}
          hasExternalAgent={false}
        />
      );
    });

    const dropzone = host.querySelector('.knowledge-dropzone');
    expect(dropzone).not.toBeNull();

    const file = new File(['sample policy content'], 'network-policy.pdf', { type: 'application/pdf' });
    const dataTransfer = {
      types: ['Files'],
      files: [file],
      dropEffect: 'copy',
    };

    await act(async () => {
      dropzone?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dataTransfer as any }));
      dropzone?.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dataTransfer as any }));
      dropzone?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dataTransfer as any }));
    });

    expect(host.textContent).toContain('Prepare your documents');
    expect(host.textContent).toContain('network-policy.pdf');

    // Click Upload 1 document button
    const uploadDocBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Upload 1 document')
    );
    await act(async () => {
      uploadDocBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith('/knowledge', expect.objectContaining({ method: 'POST' }));
  });
});

// =========================================================================
// 2. ResearchReport Component
// =========================================================================
describe('ResearchReport Component', () => {
  const mockSources: ReportSource[] = [
    {
      id: 'S1',
      title: 'Infrastructure Modernization Brief',
      url: 'https://example.com/reports/infra.pdf',
      excerpt: 'Significant performance gains were recorded across edge points.',
      text: 'Significant performance gains were recorded across edge points in the fourth quarter evaluation.',
      fetched_at: '2026-10-28T14:30:00Z',
    },
    {
      id: 'S2',
      title: 'Internal Architecture Reference',
      url: '/knowledge/12345678-1234-1234-1234-123456789abc/file',
      excerpt: 'Internal routing follows protocol standard.',
      text: 'Internal routing follows protocol standard guidelines for resilient clusters.',
      fetched_at: '2026-10-28T15:00:00Z',
    },
  ];

  it('renders report title, citations, visuals, and source appendix', async () => {
    const content = '# Executive Overview\n\nPerformance metrics increased significantly [S1]. The architecture adheres to [S2].';
    const visuals = [
      {
        path: 'chart1.png',
        url: 'https://example.com/chart1.png',
        title: 'Throughput Graph',
        captured_at: '2026-10-28T12:00:00Z',
        source_id: 'S1',
      },
    ];

    await act(async () => {
      root.render(
        <ResearchReport
          title="Quarterly Technical Report"
          content={content}
          sources={mockSources}
          visuals={visuals}
          sessionId="session-res-1"
          canSaveToOffice={true}
        />
      );
    });

    expect(host.textContent).toContain('Quarterly Technical Report');
    expect(host.textContent).toContain('Throughput Graph');
    expect(host.textContent).toContain('Infrastructure Modernization Brief');
    expect(host.textContent).toContain('Internal Architecture Reference');

    // Citations are processed into anchors
    const citationLink = host.querySelector('a.research-citation-trigger');
    expect(citationLink).not.toBeNull();
    expect(citationLink?.getAttribute('href')).toBe('https://example.com/reports/infra.pdf');
  });

  it('handles Save to Office and Export PDF buttons', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/office')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'doc-office-1', name: 'Saved Report.pdf' }),
        });
      }
      if (url.includes('/rooms') || url.includes('/members')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <ResearchReport
          title="Executive Summary"
          content="Standard report body [S1]."
          sources={mockSources}
          sessionId="session-res-2"
          canSaveToOffice={true}
        />
      );
    });

    const savePdfBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Save PDF to Office Suite')
    );
    expect(savePdfBtn).toBeDefined();

    // Toggle evidence checkbox
    const evidenceCheckbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      evidenceCheckbox.checked = true;
      evidenceCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(evidenceCheckbox.checked).toBe(true);

    // Share to people trigger
    const shareBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Share to people')
    );
    await act(async () => {
      shareBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('.people-share-dialog')).not.toBeNull();
  });
});

// =========================================================================
// 3. ApprovalControls Component Suite
// =========================================================================
describe('ApprovalControls Components', () => {
  it('ApprovalPolicyPicker renders mode selector and process checkboxes', async () => {
    const onChange = vi.fn();
    const policy: ApprovalPolicy = { mode: 'selected', actions: ['write_file'] };

    await act(async () => {
      root.render(
        <ApprovalPolicyPicker
          policy={policy}
          onChange={onChange}
          disabled={false}
          unavailableReason="Review required by workspace admin"
        />
      );
    });

    expect(host.textContent).toContain('Approval settings');
    expect(host.textContent).toContain('Review required by workspace admin');

    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('selected');

    await act(async () => {
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ mode: 'auto', actions: ['write_file'] });

    // Check process checkbox interaction
    const checkboxes = host.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThan(0);
    await act(async () => {
      (checkboxes[0] as HTMLInputElement).click();
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('ApprovalCard handles approve and reject actions', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const pendingApproval: ActionApproval = {
      approval_id: 'appr-1',
      job_id: 'job-1',
      title: 'Update config.json file',
      detail: { path: '/etc/app/config.json', changes: '+port=8080' },
      status: 'pending',
    };

    await act(async () => {
      root.render(
        <ApprovalCard
          approval={pendingApproval}
          onDecide={onDecide}
          disabled={false}
        />
      );
    });

    expect(host.textContent).toContain('Your approval is needed');
    expect(host.textContent).toContain('Update config.json file');

    // Click Approve once
    const approveBtn = host.querySelector('button.approval-approve') as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
    });
    expect(onDecide).toHaveBeenCalledWith(pendingApproval, 'approve');

    // Click Reject
    const rejectBtn = host.querySelector('button.approval-reject') as HTMLButtonElement;
    await act(async () => {
      rejectBtn.click();
    });
    expect(onDecide).toHaveBeenCalledWith(pendingApproval, 'reject');
  });

  it('ApprovalSettingsMenu opens panel and supports inline mode', async () => {
    const onChange = vi.fn();
    const policy: ApprovalPolicy = { mode: 'auto', actions: [] };

    // Test dropdown menu trigger
    await act(async () => {
      root.render(
        <ApprovalSettingsMenu
          policy={policy}
          onChange={onChange}
          disabled={false}
          inline={false}
        />
      );
    });

    const trigger = host.querySelector('button.approval-settings-trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.click();
    });
    expect(document.body.querySelector('.approval-settings-panel')).not.toBeNull();

    // Test inline mode
    await act(async () => {
      root.render(
        <ApprovalSettingsMenu
          policy={policy}
          onChange={onChange}
          disabled={false}
          inline={true}
        />
      );
    });
    expect(host.querySelector('.approval-inline')).not.toBeNull();
    const presetBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Ask before all processes')
    );
    await act(async () => {
      presetBtn?.click();
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('RuntimeApprovalSettings loads runtime policy and updates on policy events', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/jobs/job-runtime-1/approval-policy')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            policy: { mode: 'auto', actions: [] },
            revision: 1,
            mutable: true,
            reason: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const onPolicyChange = vi.fn();

    await act(async () => {
      root.render(
        <RuntimeApprovalSettings
          jobId="job-runtime-1"
          onPolicyChange={onPolicyChange}
          inline={true}
        />
      );
    });

    expect(host.textContent).toContain('Approval settings');
    expect(onPolicyChange).toHaveBeenCalledWith({ mode: 'auto', actions: [] });

    // Dispatches buddy-approval-policy event
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('buddy-approval-policy', {
          detail: {
            job_id: 'job-runtime-1',
            policy: { mode: 'selected', actions: ['write_file'] },
            revision: 3,
            mutable: true,
            reason: null,
          },
        })
      );
    });

    expect(onPolicyChange).toHaveBeenCalledWith({ mode: 'selected', actions: ['write_file'] });
  });

  it('ApprovalGuide renders dialog and triggers onClose on click and escape', async () => {
    const onClose = vi.fn();
    const policy: ApprovalPolicy = { mode: 'auto', actions: [] };

    await act(async () => {
      root.render(
        <ApprovalGuide
          policy={policy}
          onClose={onClose}
          tutorialSaving={false}
        />
      );
    });

    expect(host.textContent).toContain('You control approvals');

    // Got it button
    const gotItBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Got it'
    );
    await act(async () => {
      gotItBtn?.click();
    });
    expect(onClose).toHaveBeenCalled();

    // Escape key
    const section = host.querySelector('section.approval-guide') as HTMLElement;
    await act(async () => {
      section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// 4. ArtifactEditor Component
// =========================================================================
describe('ArtifactEditor Component', () => {
  const mockArtifact: Artifact = {
    path: 'reports/overview.html',
    content: '<h1>System Status</h1><p>All subsystems online.</p>',
    sha256: 'sha-overview-1',
    kind: 'html',
    live: false,
  };

  it('loads artifact, switches between Code and Visual tabs, and saves edits', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith('/artifacts')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ path: 'reports/overview.html', kind: 'html' }],
        });
      }
      if (url.includes('/source?path=')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockArtifact,
        });
      }
      if (url.includes('/history?path=')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'sha-overview-1', created: '2026-10-28T12:00:00Z' },
          ],
        });
      }
      if (url.includes('/artifact-comments')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [], has_more: false }),
        });
      }
      if (url.endsWith('/source') && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...mockArtifact, content: '<h1>Updated</h1>' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <ArtifactEditor
          sessionId="sess-art-1"
          initialPath="reports/overview.html"
        />
      );
    });

    expect(host.textContent).toContain('Artifacts');

    // Switch to Code tab
    const codeTab = host.querySelector('#artifact-code-tab') as HTMLButtonElement;
    await act(async () => {
      codeTab.click();
    });
    const textarea = host.querySelector('textarea.artifact-source') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Edit textarea
    await act(async () => {
      setNativeInputValue(textarea, '<h1>Updated System Status</h1>');
    });

    // Save button becomes enabled and click saves
    const saveBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save'
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/source'),
      expect.objectContaining({ method: 'PUT' })
    );

    // Switch back to Visual tab
    const visualTab = host.querySelector('#artifact-visual-tab') as HTMLButtonElement;
    await act(async () => {
      visualTab.click();
    });
    expect(host.querySelector('#artifact-visual-panel')).not.toBeNull();
  });

  it('ArtifactEditor creates new artifact, downloads source, and renders compare view', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith('/artifacts')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ path: 'notes.md', kind: 'markdown' }],
        });
      }
      if (url.includes('/source?path=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ path: 'notes.md', content: '# Initial Notes', sha256: 'sha-rev-1', kind: 'markdown' }),
        });
      }
      if (url.includes('/history?path=')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'sha-rev-1', created: '2026-10-28T10:00:00Z' },
            { id: 'sha-rev-2', created: '2026-10-27T09:00:00Z' },
          ],
        });
      }
      if (url.includes('/artifact-comments')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [], has_more: false }) });
      }
      if (url.endsWith('/source') && opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ path: 'new-doc.md', content: '', sha256: 'sha-new', kind: 'markdown' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(<ArtifactEditor sessionId="sess-test-2" initialPath="notes.md" />);
    });

    // Download button
    const downloadBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Download'
    );
    expect(downloadBtn).toBeDefined();
    await act(async () => {
      downloadBtn?.click();
    });
    expect(window.URL.createObjectURL).toHaveBeenCalled();

    // Create artifact input
    const createInput = host.querySelector('input[aria-label="New artifact filename"]') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(createInput, 'new-doc.md');
    });
    const createBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create'
    );
    await act(async () => {
      createBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/source'),
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('redirects when artifact is a presentation file', async () => {
    const presArtifact: Artifact = {
      path: 'deck.bobdeck',
      content: '{"slides":[]}',
      sha256: 'sha-pres-1',
      kind: 'bobdeck',
      is_presentation: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/artifacts')) {
        return Promise.resolve({ ok: true, json: async () => [presArtifact] });
      }
      return Promise.resolve({ ok: true, json: async () => presArtifact });
    }));

    const listener = vi.fn();
    window.addEventListener('buddy-open-artifact', listener);

    await act(async () => {
      root.render(
        <ArtifactEditor
          sessionId="sess-art-pres"
          initialPath="deck.bobdeck"
          liveArtifact={presArtifact}
        />
      );
    });

    expect(host.textContent).toContain('Presentations open in Presentation Studio');
    const openBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Open Presentation Studio')
    );
    await act(async () => {
      openBtn?.click();
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('buddy-open-artifact', listener);
  });
});

// =========================================================================
// 5. MCPCatalog and MCPServerCatalog Components
// =========================================================================
describe('MCPCatalog Components', () => {
  it('CatalogIcon renders monograms and SVG icons correctly', async () => {
    await act(async () => {
      root.render(
        <div>
          <CatalogIcon kind="microsoft" />
          <CatalogIcon kind="github" />
          <CatalogIcon kind="plug" />
          <CatalogIcon kind="unknown-custom" />
        </div>
      );
    });

    expect(host.querySelector('.catalog-provider-icon')?.textContent).toBe('M');
    expect(host.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('MCPCatalog loads items, filters by search, and connects using credentials', async () => {
    const mockTemplates = [
      {
        id: 'github-server',
        name: 'GitHub Integration',
        description: 'Connect repository issues and pull requests',
        icon: 'github',
        transport: 'http' as const,
        url: 'https://api.github.com/mcp',
        command: '',
        args: [],
        fields: [
          { key: 'token', label: 'Personal Access Token', location: 'header' as const, target: 'Authorization', prefix: 'Bearer ', required: true },
        ],
        knowledge_base: 'company',
        audience: 'both',
        access_mode: 'grants' as const,
        groups: ['company'],
        users: [],
        enabled: true,
        connected: false,
        allowed: true,
        category: 'development',
      },
      {
        id: 'search-server',
        name: 'Knowledge Web Search',
        description: 'Public documentation index',
        icon: 'search',
        transport: 'http' as const,
        url: 'https://search.example.com',
        command: '',
        args: [],
        fields: [],
        knowledge_base: 'company',
        audience: 'both',
        access_mode: 'grants' as const,
        groups: ['company'],
        users: [],
        enabled: true,
        connected: true,
        allowed: true,
        auth_mode: 'none' as const,
        category: 'search',
      },
    ];

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/mcp-catalog') {
        return Promise.resolve({ ok: true, json: async () => mockTemplates });
      }
      if (url === '/admin/users') {
        return Promise.resolve({ ok: true, json: async () => ({ users: [{ username: 'dev1', display_name: 'Dev User' }] }) });
      }
      if (url.includes('/check')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'working',
            message: 'Online and operational',
            tools: ['search'],
            checked_at: '2026-10-28T12:00:00Z',
          }),
        });
      }
      if (url.includes('/connect') && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const onChanged = vi.fn();
    await act(async () => {
      root.render(
        <MCPCatalog
          isAdmin={true}
          onChanged={onChanged}
          standalone={false}
        />
      );
    });

    expect(host.textContent).toContain('GitHub Integration');
    expect(host.textContent).toContain('Knowledge Web Search');

    // Filter by search
    const searchInput = host.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(searchInput, 'GitHub');
    });
    expect(host.textContent).toContain('GitHub Integration');

    // Connect button opens credentials form
    const connectBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Connect'
    );
    await act(async () => {
      connectBtn?.click();
    });
    expect(host.textContent).toContain('Connect GitHub Integration');

    // Submit credentials form
    const form = host.querySelector('form.catalog-form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/connect'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('MCPServerCatalog modal handles Close button and Escape key', async () => {
    const onClose = vi.fn();
    const onChanged = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    await act(async () => {
      root.render(
        <MCPServerCatalog
          isAdmin={false}
          onChanged={onChanged}
          onClose={onClose}
          servers={[]}
        />
      );
    });

    expect(host.textContent).toContain('MCP server catalogue');

    // Close button
    const closeBtn = host.querySelector('button.feature-close') as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();

    // Escape key
    const dialog = host.querySelector('section.feature-dialog') as HTMLElement;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// 6. Sidebar Component
// =========================================================================
describe('Sidebar Component', () => {
  const mockUser: User = { username: 'testuser', display_name: 'Test Operator', is_admin: true };
  const mockProjects: Project[] = [{ id: 'proj-1', name: 'Alpha Infrastructure' }];
  const mockSessions: SessionItem[] = [
    { id: 'sess-1', title: 'Network Audit Planning', updated_at: 1700000000 },
    { id: 'legacy', title: 'Legacy Logs', updated_at: 1690000000 },
  ];
  const mockSkills: Skill[] = [{ name: 'packet_analyzer', description: 'Analyze pcap dumps' }];
  const mockModes: Mode[] = [{ slug: 'architect', name: 'Architect', description: 'System design' }];
  const mockAgents: A2AAgent[] = [{ slug: 'sec-agent', name: 'Security Reviewer', endpoint: 'http://localhost:8001' }];
  const mockPages: WorkspacePage[] = [{ path: 'audit.html', name: 'audit.html', is_presentation: false }];
  const mockFiles = [{ name: 'topology.pdf', size: 1048576 }];

  it('renders branding, navigation, and handles section toggles and clicks', async () => {
    const onNewChat = vi.fn();
    const onOpenTasks = vi.fn();
    const onOpenNotes = vi.fn();
    const onOpenKnowledge = vi.fn();
    const onOpenWorkflows = vi.fn();
    const onOpenTemplateStudio = vi.fn();
    const onSelectSession = vi.fn();
    const onDeleteSession = vi.fn();
    const onSelectProject = vi.fn();
    const onSelectMode = vi.fn();
    const onSelectAgent = vi.fn();
    const onEditAgent = vi.fn();
    const onEditSkill = vi.fn();
    const onDeleteSkill = vi.fn();
    const onOpenCreate = vi.fn();
    const onSignOut = vi.fn();

    await act(async () => {
      root.render(
        <Sidebar
          isOpen={true}
          user={mockUser}
          projects={mockProjects}
          selectedProjectId="proj-1"
          sessions={mockSessions}
          selectedSessionId="sess-1"
          skills={mockSkills}
          modes={mockModes}
          selectedMode="architect"
          agents={mockAgents}
          selectedAgent="sec-agent"
          pages={mockPages}
          files={mockFiles}
          taskCount={3}
          activeView="chat"
          onNewChat={onNewChat}
          onOpenTasks={onOpenTasks}
          onOpenNotes={onOpenNotes}
          onOpenKnowledge={onOpenKnowledge}
          onOpenWorkflows={onOpenWorkflows}
          onOpenTemplateStudio={onOpenTemplateStudio}
          onSelectSession={onSelectSession}
          onDeleteSession={onDeleteSession}
          onSelectProject={onSelectProject}
          onSelectMode={onSelectMode}
          onSelectAgent={onSelectAgent}
          onEditAgent={onEditAgent}
          onEditSkill={onEditSkill}
          onDeleteSkill={onDeleteSkill}
          onOpenCreate={onOpenCreate}
          onSignOut={onSignOut}
          onDeleteFile={vi.fn()}
          onDeleteProject={vi.fn()}
          onRefreshPages={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Buddy');
    expect(host.textContent).toContain('Test Operator');

    // Navigation buttons
    const newChatBtn = host.querySelector('button.new-chat') as HTMLButtonElement;
    await act(async () => {
      newChatBtn.click();
    });
    expect(onNewChat).toHaveBeenCalled();

    const tasksBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Tasks')
    );
    await act(async () => {
      tasksBtn?.click();
    });
    expect(onOpenTasks).toHaveBeenCalled();

    // Template Studio trigger
    const studioBtn = host.querySelector('button.sidebar-template-studio') as HTMLButtonElement;
    await act(async () => {
      studioBtn.click();
    });
    expect(onOpenTemplateStudio).toHaveBeenCalled();

    // Category filter tabs
    const chatsTab = Array.from(host.querySelectorAll('button.filter-tab')).find(
      (b) => b.textContent?.includes('Chats')
    );
    await act(async () => {
      chatsTab?.click();
    });
    expect(host.textContent).toContain('CONVERSATIONS');

    // Select session click
    const sessionItem = Array.from(host.querySelectorAll('button.mode-item')).find(
      (b) => b.textContent?.includes('Network Audit Planning')
    );
    await act(async () => {
      sessionItem?.click();
    });
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');

    // Delete session
    const delSessionBtn = host.querySelector('button.conversation-delete') as HTMLButtonElement;
    await act(async () => {
      delSessionBtn.click();
    });
    expect(onDeleteSession).toHaveBeenCalledWith(mockSessions[0]);

    // Width preset buttons
    const wideWidthBtn = Array.from(host.querySelectorAll('button.sidebar-width-btn')).find(
      (b) => b.textContent?.includes('Wide')
    );
    await act(async () => {
      wideWidthBtn?.click();
    });
    expect(localStorage.getItem('bob_sidebar_width')).toBe('460');
  });

  it('Sidebar handles project actions, file opening, and Microsoft 365 connected state', async () => {
    const onDeleteProject = vi.fn();
    const onSelectProject = vi.fn();
    const onOpenFile = vi.fn();
    const onDisconnectMicrosoft = vi.fn();

    await act(async () => {
      root.render(
        <Sidebar
          isOpen={true}
          user={{ username: 'op1', is_admin: true }}
          projects={[{ id: 'p1', name: 'Alpha' }]}
          selectedProjectId="p1"
          sessions={[{ id: 's1', title: 'Session 1' }]}
          selectedSessionId="s1"
          skills={[]}
          modes={[]}
          selectedMode=""
          agents={[]}
          selectedAgent=""
          pages={[]}
          files={[{ name: 'network-plan.docx', size: 2048 }]}
          taskCount={1}
          activeView="chat"
          msStatus={{
            connected: true,
            name: 'Microsoft 365 Enterprise',
            account: 'user@example.com',
            scopes: ['Sites.Read.All', 'Chat.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All'],
          }}
          onDisconnectMicrosoft={onDisconnectMicrosoft}
          onDeleteFile={vi.fn()}
          onDeleteProject={onDeleteProject}
          onSelectProject={onSelectProject}
          onSelectSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onNewChat={vi.fn()}
          onSelectMode={vi.fn()}
          onSelectAgent={vi.fn()}
          onEditAgent={vi.fn()}
          onEditSkill={vi.fn()}
          onDeleteSkill={vi.fn()}
          onOpenCreate={vi.fn()}
          onRefreshPages={vi.fn()}
          onOpenFile={onOpenFile}
          onSignOut={vi.fn()}
          onOpenTasks={vi.fn()}
          onOpenNotes={vi.fn()}
          onOpenKnowledge={vi.fn()}
          onOpenWorkflows={vi.fn()}
        />
      );
    });

    // Expand Microsoft 365 section
    const msHeading = Array.from(host.querySelectorAll('.section-heading')).find((el) =>
      el.textContent?.includes('MICROSOFT 365')
    );
    if (msHeading) {
      await act(async () => {
        (msHeading as HTMLElement).click();
      });
    }

    expect(host.textContent).toContain('Microsoft 365 Enterprise');

    // Disconnect Microsoft
    const disconnectBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.getAttribute('title')?.includes('Disconnect Microsoft account')
    );
    await act(async () => {
      disconnectBtn?.click();
    });
    expect(onDisconnectMicrosoft).toHaveBeenCalled();

    // Expand PROJECTS section
    const projectsHeading = Array.from(host.querySelectorAll('.section-heading')).find((el) =>
      el.textContent?.includes('PROJECTS')
    );
    if (projectsHeading) {
      await act(async () => {
        (projectsHeading as HTMLElement).click();
      });
    }

    // Project selector change
    const projectSelect = host.querySelector('select.project-select') as HTMLSelectElement;
    await act(async () => {
      projectSelect.value = '';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSelectProject).toHaveBeenCalledWith('');

    // File click preview
    const fileBtn = Array.from(host.querySelectorAll('button.mode-item')).find(
      (b) => b.textContent?.includes('network-plan.docx')
    );
    await act(async () => {
      fileBtn?.click();
    });
    expect(onOpenFile).toHaveBeenCalledWith('network-plan.docx');
  });
});

// =========================================================================
// 7. PresentationTemplateStudio Component
// =========================================================================
describe('PresentationTemplateStudio Component', () => {
  const mockTemplates: PresentationTemplate[] = [
    {
      id: 'tpl-corp',
      title: 'Corporate Standard',
      brand: 'Company A Software',
      themeId: 'theme-1',
      fonts: { heading: 'Arial', body: 'Arial' },
      colors: {
        primary: '#0f62fe',
        secondary: '#393939',
        accent: '#0f62fe',
        background: '#ffffff',
        text: '#161616',
        chartPalette: ['#0f62fe'],
      },
      slidesCount: 4,
      slidePreviews: [],
    },
  ];

  it('renders layout controls, slide tabs, and handles save and cancel', async () => {
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const onAskBob = vi.fn();

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/presentation/templates' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ template: { id: 'tpl-new', title: 'New Template' } }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <PresentationTemplateStudio
          templates={mockTemplates}
          onSaved={onSaved}
          onCancel={onCancel}
          onAskBob={onAskBob}
          sessionId="sess-studio-1"
        />
      );
    });

    expect(host.textContent).toContain('Template Studio');
    expect(host.textContent).toContain('Design with Bob');

    // Slide preview tab navigation
    const slideTabs = host.querySelectorAll('.template-studio-preview [role="tab"]');
    expect(slideTabs.length).toBeGreaterThan(0);
    await act(async () => {
      (slideTabs[1] as HTMLButtonElement).click();
    });
    expect(slideTabs[1].getAttribute('aria-selected')).toBe('true');

    // Update template title
    const titleInput = host.querySelector('input[aria-label="Template name"]') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(titleInput, 'Enterprise Presentation Deck');
    });

    // Save template
    const saveBtn = Array.from(host.querySelectorAll('footer button')).find(
      (b) => b.textContent === 'Save template'
    );
    await act(async () => {
      saveBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/presentation/templates',
      expect.objectContaining({ method: 'POST' })
    );
    expect(onSaved).toHaveBeenCalled();

    // Cancel button
    const cancelBtn = Array.from(host.querySelectorAll('footer button')).find(
      (b) => b.textContent === 'Cancel'
    );
    await act(async () => {
      cancelBtn?.click();
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('handles Bob design brief, refreshing drafts, and HTML template download', async () => {
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const onAskBob = vi.fn();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/presentation/template-drafts')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ path: 'draft-1.json', config: { title: 'AI Draft Deck', brand: 'AI Brand', colors: {}, fonts: {}, design: {} } }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <PresentationTemplateStudio
          templates={mockTemplates}
          onSaved={onSaved}
          onCancel={onCancel}
          onAskBob={onAskBob}
          sessionId="sess-studio-2"
        />
      );
    });

    // Enter brief and click Ask Bob
    const briefInput = host.querySelector('.template-studio-assist textarea') as HTMLTextAreaElement;
    await act(async () => {
      setNativeInputValue(briefInput, 'Modern teal presentation layout');
    });
    const askBobBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Ask Bob to design')
    );
    await act(async () => {
      askBobBtn?.click();
    });
    expect(onAskBob).toHaveBeenCalledWith('Modern teal presentation layout');

    // Refresh drafts
    const refreshDraftsBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Refresh drafts'
    );
    await act(async () => {
      refreshDraftsBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/presentation/template-drafts'),
      expect.anything()
    );

    // Download HTML
    const downloadHtmlBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Download HTML'
    );
    await act(async () => {
      downloadHtmlBtn?.click();
    });
    expect(window.URL.createObjectURL).toHaveBeenCalled();
  });
});

// =========================================================================
// 8. LearningQuizResults Component Suite
// =========================================================================
describe('LearningQuizResults Components', () => {
  it('QuizGradingState renders active grading vs saved report status', async () => {
    await act(async () => {
      root.render(<QuizGradingState saved={false} />);
    });
    expect(host.textContent).toContain('FINISHING YOUR ATTEMPT');
    expect(host.textContent).toContain('Preparing your results');

    await act(async () => {
      root.render(<QuizGradingState saved={true} />);
    });
    expect(host.textContent).toContain('ANSWERS SAVED');
    expect(host.textContent).toContain('Loading your results');
  });

  it('QuizReport displays scores, metrics, improvement plan, and feedback card', async () => {
    const mockSubmission: QuizSubmission = {
      id: 'sub-1',
      username: 'student1',
      display_name: 'Alex Learner',
      submitted_at: '2026-10-28T16:00:00Z',
      score: 15,
      max_score: 20,
      pending_manual: false,
      quiz_version: 1,
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: 'What is API Autonomous System Number?',
          options: ['Routing identifier', 'Cable connector', 'Subnet mask'],
          answer: [0],
          points: 10,
          explanation: 'An ASN uniquely identifies an autonomous system on the global internet.',
          study_topic: 'API Fundamentals',
        },
        {
          id: 'q2',
          type: 'single',
          question: 'Which protocol is connection-oriented?',
          options: ['UDP', 'TCP', 'ICMP'],
          answer: [1],
          points: 10,
          explanation: 'TCP establishes a three-way handshake.',
          study_topic: 'Transport Protocols',
        },
      ],
      answers: {
        q1: [0],
        q2: [0], // Incorrect choice
      },
      grades: {
        q1: { score: 10, outcome: 'Correct', feedback: 'Accurate.' },
        q2: { score: 5, outcome: 'Partially correct', feedback: 'UDP is connectionless.' },
      },
    };

    await act(async () => {
      root.render(<QuizReport submission={mockSubmission} administrator={false} />);
    });

    // Score display
    expect(host.textContent).toContain('75%');
    expect(host.textContent).toContain('15 / 20 points');

    // Next steps improvement plan
    expect(host.textContent).toContain('A study plan based on your answers');
    expect(host.textContent).toContain('Transport Protocols');

    // Answer review filters
    const reviewFilterBtn = Array.from(host.querySelectorAll('.learning-report-filters button')).find(
      (b) => b.textContent?.includes('Needs improvement')
    );
    await act(async () => {
      reviewFilterBtn?.click();
    });
    expect(host.textContent).toContain('UDP is connectionless.');
  });

  it('QuizStatistics renders overview metrics, version select, and answer distributions', async () => {
    const mockSubmissions: QuizSubmission[] = [
      {
        id: 'sub-1',
        username: 's1',
        submitted_at: '2026-10-28T10:00:00Z',
        score: 20,
        max_score: 20,
        pending_manual: false,
        quiz_version: 1,
        questions: [{ id: 'q1', type: 'single', question: 'Concept Q', points: 10, options: ['A', 'B'], answer: [0] }],
        answers: { q1: [0] },
        grades: { q1: { score: 10 } },
      },
      {
        id: 'sub-2',
        username: 's2',
        submitted_at: '2026-10-28T11:00:00Z',
        score: 10,
        max_score: 20,
        pending_manual: false,
        quiz_version: 1,
        questions: [{ id: 'q1', type: 'single', question: 'Concept Q', points: 10, options: ['A', 'B'], answer: [0] }],
        answers: { q1: [1] },
        grades: { q1: { score: 0 } },
      },
    ];

    await act(async () => {
      root.render(<QuizStatistics submissions={mockSubmissions} />);
    });

    expect(host.textContent).toContain('ASSESSMENT INSIGHTS');
    expect(host.textContent).toContain('Submitted attempts');
    expect(host.textContent).toContain('75%'); // (100% + 50%) / 2 = 75%
  });
});

// =========================================================================
// 9. AdministrationPage Component
// =========================================================================
describe('AdministrationPage Component', () => {
  const currentUser: User = { username: 'admin1', display_name: 'Chief Administrator', is_admin: true };
  const mockAdminData = {
    users: [
      { username: 'admin1', display_name: 'Chief Administrator', email: 'admin@example.com', employer: 'buddy' as const, project_team: true, is_admin: true },
      { username: 'member2', display_name: 'Field Engineer', email: 'field@example.com', employer: 'company_b' as const, project_team: false, is_admin: false },
    ],
    pending_admins: ['invited@example.com'],
  };

  it('renders user directory, supports filters, pagination, and tabs', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/admin/users') {
        return Promise.resolve({ ok: true, json: async () => mockAdminData });
      }
      if (url.includes('/admin/audit')) {
        return Promise.resolve({ ok: true, json: async () => ({ events: [], next_before_id: null }) });
      }
      if (url.includes('/admin/feedback/quality')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            days: 30,
            totals: { reports: 0, open: 0, reviewed: 0, resolved: 0, reporters: 0 },
            categories: [],
            sources: [],
            trend: [],
          }),
        });
      }
      if (url.includes('/admin/feedback')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [], next_before_id: null }) });
      }
      if (url.includes('/admin/smtp')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            enabled: false,
            host: 'smtp.example.com',
            port: 587,
            security: 'starttls',
            username: '',
            from_address: '',
            from_name: '',
            password_configured: false,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const onBack = vi.fn();

    await act(async () => {
      root.render(<AdministrationPage currentUser={currentUser} onBack={onBack} />);
    });

    expect(host.textContent).toContain('User groups & administrators');
    expect(host.textContent).toContain('Chief Administrator');
    expect(host.textContent).toContain('Field Engineer');

    // Back to chat button
    const backBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Back to chat'
    );
    await act(async () => {
      backBtn?.click();
    });
    expect(onBack).toHaveBeenCalled();

    // Switch tab to Administrators
    const adminTab = host.querySelector('#administration-tab-administrators') as HTMLButtonElement;
    await act(async () => {
      adminTab.click();
    });
    expect(host.textContent).toContain('Add an administrator');
    expect(host.textContent).toContain('invited@example.com');

    // Switch back to Users tab
    const usersTab = host.querySelector('#administration-tab-users') as HTMLButtonElement;
    await act(async () => {
      usersTab.click();
    });

    // Search filter
    const searchInput = host.querySelector('.directory-search input') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(searchInput, 'Field');
    });
    expect(host.textContent).toContain('Field Engineer');
  });

  it('AdministrationPage handles adding an administrator and removing a pending administrator', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/admin/users') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            users: [
              { username: 'admin1', display_name: 'Admin One', email: 'admin1@example.com', employer: 'buddy' as const, project_team: true, is_admin: true },
            ],
            pending_admins: ['pending@example.com'],
          }),
        });
      }
      if (url === '/admin/administrators' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes('/admin/administrators/') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes('/admin/audit')) return Promise.resolve({ ok: true, json: async () => ({ events: [], next_before_id: null }) });
      if (url.includes('/admin/feedback/quality')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            days: 30,
            totals: { reports: 0, open: 0, reviewed: 0, resolved: 0, reporters: 0 },
            categories: [],
            sources: [],
            trend: [],
          }),
        });
      }
      if (url.includes('/admin/feedback')) return Promise.resolve({ ok: true, json: async () => ({ items: [], next_before_id: null }) });
      if (url.includes('/admin/smtp')) return Promise.resolve({ ok: true, json: async () => ({ enabled: false }) });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(
        <AdministrationPage
          currentUser={{ username: 'admin1', is_admin: true }}
          onBack={vi.fn()}
        />
      );
    });

    // Switch to administrators tab
    const adminTab = host.querySelector('#administration-tab-administrators') as HTMLButtonElement;
    await act(async () => {
      adminTab.click();
    });

    // Add an administrator
    const emailInput = host.querySelector('#administrator-grant-email') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(emailInput, 'newadmin@example.com');
    });
    const form = host.querySelector('form.administration-invite') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/admin/administrators',
      expect.objectContaining({ method: 'POST' })
    );

    // Remove pending administrator
    const removePendingBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove'
    );
    await act(async () => {
      removePendingBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/admin/administrators/'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

// =========================================================================
// 10. IntelligentAnswer Component
// =========================================================================
describe('IntelligentAnswer Component', () => {
  it('renders pending spinner and fallback raw source', async () => {
    // Pending
    await act(async () => {
      root.render(<IntelligentAnswer source="" pending={true} />);
    });
    expect(host.textContent).toContain('Generating interactive answer…');

    // Fallback without spec
    await act(async () => {
      root.render(<IntelligentAnswer source="Raw unparsed model JSON" pending={false} />);
    });
    expect(host.textContent).toContain('Interactive answer source');
    expect(host.textContent).toContain('Raw unparsed model JSON');
  });

  it('keeps explore topics in a selectable grid and elaborates on the selection', async () => {
    const spec = {
      kind: 'explore' as const,
      title: 'Cloud Topologies',
      description: 'Review architecture options',
      items: [
        { title: 'Multi-Region Mesh', body: 'Distributed across 3 continents', facts: [{ label: 'Latency', value: '45ms' }] },
        { title: 'Hub-and-Spoke', body: 'Centralized egress point', facts: [{ label: 'Throughput', value: '100 Gbps' }] },
      ],
      actions: [{ label: 'Explain Latency', prompt: 'Elaborate on multi-region latency mitigation' }],
    };

    const onPrompt = vi.fn();

    await act(async () => {
      root.render(
        <IntelligentAnswer
          spec={spec}
          source='{"kind":"explore"}'
          pending={false}
          onPrompt={onPrompt}
        />
      );
    });

    expect(host.textContent).toContain('Cloud Topologies');
    expect(host.textContent).toContain('Multi-Region Mesh');
    expect(host.textContent).toContain('Hub-and-Spoke');

    const topics = host.querySelectorAll('.ia-topic-title');
    expect(topics.length).toBe(2);
    expect(host.textContent).not.toContain('View details');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    await act(async () => {
      (topics[1] as HTMLButtonElement).click();
    });
    expect(topics[1].getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('100 Gbps');
    const elaborate = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Elaborate on selected topic'))!;
    await act(async () => { elaborate.click(); });
    expect(onPrompt).toHaveBeenCalledWith('Please elaborate on Hub-and-Spoke in the context of Cloud Topologies.');

    // Action button prompt trigger
    const actionBtn = host.querySelector('.ia-action-btn') as HTMLButtonElement;
    await act(async () => {
      actionBtn.click();
    });
    expect(onPrompt).toHaveBeenCalled();
  });

  it('renders split calculator mode and updates amount per person', async () => {
    const spec = {
      kind: 'split' as const,
      title: 'Shared Resource Cost Allocation',
      description: 'Calculate monthly cost per department',
      total: 1000,
      people: 4,
      tip: 10,
      unit: '€',
    };

    await act(async () => {
      root.render(
        <IntelligentAnswer
          spec={spec}
          source='{"kind":"split"}'
          pending={false}
        />
      );
    });

    expect(host.textContent).toContain('Shared Resource Cost Allocation');
    expect(host.textContent).toContain('Amount Per Person');
    // Formula: 1000 + 10% = 1100 / 4 = 275.00
    expect(host.textContent).toContain('275.00');

    // Click 20% quick tip preset button
    const tip20Btn = Array.from(host.querySelectorAll('button.ia-preset-btn')).find(
      (b) => b.textContent?.includes('20%')
    );
    await act(async () => {
      tip20Btn?.click();
    });
    // Formula: 1000 + 20% = 1200 / 4 = 300.00
    expect(host.textContent).toContain('300.00');
  });

  it('renders steps mode and tracks checklist progress', async () => {
    const spec = {
      kind: 'steps' as const,
      title: 'Disaster Recovery Drill',
      description: 'Follow sequentially',
      items: [
        { title: 'Validate Secondary Gateway', body: 'Ping heartbeat port' },
        { title: 'Switch DNS Records', body: 'Update TTL and route' },
      ],
    };

    await act(async () => {
      root.render(
        <IntelligentAnswer
          spec={spec}
          source='{"kind":"steps"}'
          pending={false}
        />
      );
    });

    expect(host.textContent).toContain('Disaster Recovery Drill');
    expect(host.textContent).toContain('0 / 2 completed');

    // Toggle step 1 checkbox
    const checkboxes = host.querySelectorAll('input.ia-step-checkbox');
    expect(checkboxes.length).toBe(2);
    await act(async () => {
      (checkboxes[0] as HTMLInputElement).click();
    });
    expect(host.textContent).toContain('1 / 2 completed (50%)');
  });
});

// =========================================================================
// 11. ConversationSharing Component
// =========================================================================
describe('ConversationSharing Component', () => {
  it('handles export format buttons, share link creation, and PDF preview', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/share') && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ url: 'https://example.com/share/abc-123' }),
        });
      }
      if (url.includes('/share') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes('/export?format=json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            title: 'Audit Log Session',
            messages: [{ role: 'user', content: 'Inquire on subnet.' }],
          }),
        });
      }
      if (url.includes('/export?format=docx')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'Content-Disposition': 'attachment; filename="chat.docx"' }),
          blob: async () => new Blob(['dummy docx'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(<ConversationSharing sessionId="sess-share-1" />);
    });

    expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Export and share conversation');
    expect(host.textContent).toContain('Download Markdown');

    // Create share link
    const shareBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create share link'
    );
    await act(async () => {
      shareBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/sessions/sess-share-1/share',
      expect.objectContaining({ method: 'POST' })
    );
    expect(host.querySelector('input[readOnly]')).not.toBeNull();

    // Copy link
    const copyBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Copy link')
    );
    await act(async () => {
      copyBtn?.click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalled();

    // PDF preview
    const pdfPreviewBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'PDF preview'
    );
    await act(async () => {
      pdfPreviewBtn?.click();
    });
    expect(host.querySelector('.conversation-pdf-preview')).not.toBeNull();
    expect(host.textContent).toContain('Audit Log Session');

    // Close PDF preview
    const closePreviewBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Close PDF preview'
    );
    await act(async () => {
      closePreviewBtn?.click();
    });
    expect(host.querySelector('.conversation-pdf-preview')).toBeNull();

    // Revoke share links
    const revokeBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Revoke all links'
    );
    await act(async () => {
      revokeBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/sessions/sess-share-1/share',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('ConversationSharing handles Word and PDF direct downloads', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/export?format=docx')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'Content-Disposition': 'attachment; filename="chat.docx"' }),
          blob: async () => new Blob(['docx binary'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        });
      }
      if (url.includes('/export?format=pdf')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'Content-Disposition': 'attachment; filename="chat.pdf"' }),
          blob: async () => new Blob(['pdf binary'], { type: 'application/pdf' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await act(async () => {
      root.render(<ConversationSharing sessionId="sess-dl-1" />);
    });

    const wordBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Download Word'
    );
    await act(async () => {
      wordBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('format=docx')
    );
    expect(window.URL.createObjectURL).toHaveBeenCalled();

    const pdfBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Download PDF'
    );
    await act(async () => {
      pdfBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('format=pdf')
    );
  });
});

// =========================================================================
// 12. AgentCatalog Component
// =========================================================================
describe('AgentCatalog Component', () => {
  const mockAgents = [
    {
      id: 'agent-software',
      slug: 'software-analyzer',
      name: 'Software Signal Analyzer',
      description: 'Autonomous diagnosis of interface drops and latency anomalies',
      card_url: 'https://software.example/.well-known/agent-card.json',
      endpoint: 'https://software.example/a2a',
      protocol_version: '1.0',
      capabilities: { streaming: true },
      skills: [{ id: 'latency', name: 'Latency Health Check', description: 'Calculates signal ratio' }],
      groups: ['buddy'],
      users: [],
      enabled: true,
      allowed: true,
      activated: false,
    },
  ];

  it('renders modal dialog, lists agents, and handles activate credentials form', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/agent-catalog') {
        return Promise.resolve({ ok: true, json: async () => mockAgents });
      }
      if (url === '/admin/users') {
        return Promise.resolve({ ok: true, json: async () => ({ users: [] }) });
      }
      if (url.includes('/activation') && opts?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const onChanged = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <AgentCatalog
          isAdmin={true}
          onChanged={onChanged}
          onClose={onClose}
        />
      );
    });

    expect(host.textContent).toContain('A2A agent catalogue');
    expect(host.textContent).toContain('Software Signal Analyzer');

    // Click Activate button
    const activateBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Activate'
    );
    await act(async () => {
      activateBtn?.click();
    });
    expect(host.textContent).toContain('Activate · Software Signal Analyzer');

    // Submit private credentials form
    const form = host.querySelector('form.agent-catalog-form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/activation'),
      expect.objectContaining({ method: 'PUT' })
    );

    // Close button
    const closeBtn = host.querySelector('button.feature-close') as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('AgentCatalog handles defining a new agent and deactivating an active agent', async () => {
    const activeAgent = {
      id: 'agent-active',
      slug: 'network-monitor',
      name: 'Network Monitor',
      description: 'API telemetry tracker',
      card_url: 'https://monitor.example/.well-known/agent-card.json',
      endpoint: 'https://monitor.example/a2a',
      protocol_version: '1.0',
      capabilities: {},
      groups: ['buddy'],
      users: [],
      enabled: true,
      allowed: true,
      activated: true,
    };

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/agent-catalog') {
        return Promise.resolve({ ok: true, json: async () => [activeAgent] });
      }
      if (url === '/admin/users') {
        return Promise.resolve({ ok: true, json: async () => ({ users: [] }) });
      }
      if (url.includes('/activation') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes('/admin/agent-catalog') && opts?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const onChanged = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <AgentCatalog
          isAdmin={true}
          onChanged={onChanged}
          onClose={onClose}
        />
      );
    });

    // Deactivate active agent
    const deactivateBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Deactivate'
    );
    await act(async () => {
      deactivateBtn?.click();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/activation'),
      expect.objectContaining({ method: 'DELETE' })
    );

    // Define A2A agent
    const defineBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Define A2A agent')
    );
    await act(async () => {
      defineBtn?.click();
    });
    expect(host.textContent).toContain('Define an agent');

    const idInput = host.querySelector('input[placeholder="research-assistant"]') as HTMLInputElement;
    const cardUrlInput = host.querySelector('input[placeholder="https://agent.example/.well-known/agent-card.json"]') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(idInput, 'api-agent');
      setNativeInputValue(cardUrlInput, 'https://api.example/agent-card.json');
    });

    const form = host.querySelector('form.agent-catalog-form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/admin/agent-catalog/api-agent'),
      expect.objectContaining({ method: 'PUT' })
    );
  });
});
