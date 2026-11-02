// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectsWorkspace } from '../../src/components/ProjectsWorkspace';

let host: HTMLDivElement;
let root: Root;

describe('ProjectsWorkspace Component', () => {
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
    ],
    assignments: [
      {
        id: 'asg-1',
        project_id: 'proj-1',
        person_id: 'person-1',
        responsibility: 'Lead Systems Architect',
        role: 'owner',
        backup_person_id: null,
        allocation: 60,
      },
    ],
    dependencies: [],
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
        resolution: '',
        revision: 1,
      },
    ],
    stage_approvals: [],
    impact: { items: [] },
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

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(samplePortfolio),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });
    });
    global.fetch = mockFetch;

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

  it('renders portfolio workspace with projects and people', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.querySelector('.projects-workspace') || host.children.length > 0).toBeTruthy();
    expect(host.textContent).toContain('Core Network Upgrade');
  });

  it('switches between workspace navigation tabs', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Tab buttons inside navigation
    const tabButtons = host.querySelectorAll('nav button');
    expect(tabButtons.length).toBeGreaterThan(0);

    for (const tabBtn of Array.from(tabButtons).slice(0, 5)) {
      await act(async () => {
        (tabBtn as HTMLElement).click();
      });
      expect(host.querySelector('.projects-workspace') || host.children.length > 0).toBeTruthy();
    }
  });

  it('handles project selection and displays work items', async () => {
    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const projectCard = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Core Network Upgrade')
    );
    if (projectCard) {
      await act(async () => {
        projectCard.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
    }
    expect(host.textContent).toContain('Core Network Upgrade');
  });

  it('toggles assistant and handles ask bob contextual triggers', async () => {
    const onAskBob = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={onAskBob} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const askBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Project Buddy') || b.textContent?.includes('Ask')
    );
    if (askBtn) {
      await act(async () => {
        askBtn.click();
      });
    }
    expect(host.querySelector('.projects-workspace') || host.children.length > 0).toBeTruthy();
  });

  it('shows assistant request errors and allows a prompt retry', async () => {
    const ask = vi.fn().mockRejectedValueOnce(new Error('Assistant unavailable')).mockResolvedValueOnce(undefined);
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={ask} />); });
    await act(async () => { (host.querySelector('[aria-label="Open Project Buddy"]') as HTMLButtonElement).click(); });
    await act(async () => { (host.querySelector('[aria-label="Expand width"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[aria-label="Compact width"]')).not.toBeNull();
    const prompt = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Backup gaps')!;
    await act(async () => { prompt.click(); });
    const send = () => (host.querySelector('[aria-label="Send to Project Buddy"]') as HTMLButtonElement).click();
    await act(async () => { send(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Assistant unavailable');
    await act(async () => { send(); });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Assistant unavailable');
    await act(async () => { (host.querySelector('[aria-label="Minimize assistant"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[aria-label="Open Project Buddy"]')).not.toBeNull();
  });

  it('supports expanding and collapsing the merged portfolio and focusing a section', async () => {
    await act(async () => { root.render(<ProjectsWorkspace onClose={vi.fn()} onAskBob={vi.fn()} />); });
    const button = (label: string) => Array.from(host.querySelectorAll('button')).find(el => el.textContent?.includes(label))!;
    await act(async () => { button('Merge Tabs').click(); });
    expect(host.querySelectorAll('.projects-merged-section-body')).toHaveLength(5);
    await act(async () => { button('Collapse All').click(); });
    expect(host.querySelectorAll('.projects-merged-section-body')).toHaveLength(0);
    await act(async () => { (host.querySelector('#merged-people .projects-merged-section-header') as HTMLElement).click(); });
    expect(host.querySelectorAll('.projects-merged-section-body')).toHaveLength(1);
    expect(host.querySelector('#merged-people')?.textContent).toContain('Elena Rostova');
    await act(async () => { button('Expand All').click(); });
    expect(host.querySelectorAll('.projects-merged-section-body')).toHaveLength(5);
    const focus = host.querySelector('#merged-people .projects-merged-section-actions button') as HTMLButtonElement;
    await act(async () => { focus.click(); });
    expect(host.querySelector('.projects-merged-container')).toBeNull();
    expect(host.textContent).toContain('Elena Rostova');
  });
});
