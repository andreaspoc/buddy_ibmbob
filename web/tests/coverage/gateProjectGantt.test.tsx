// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectGantt, type GanttProject, type GanttWorkItem } from '../../src/components/ProjectGantt';

const NOW = Date.parse('2026-06-15T12:00:00Z');
let host: HTMLDivElement;
let root: Root;
const handlers = {
  onOpenProject: vi.fn(),
  onEditProject: vi.fn(),
  onAskBob: vi.fn(),
  onAddProject: vi.fn(),
  onAddTask: vi.fn(),
};

const project = (over: Partial<GanttProject> = {}): GanttProject => ({
  id: 'p1', name: 'Alpha', status: 'active', start_date: '2026-06-01', due_date: '2026-07-01', ...over,
});
const item = (over: Partial<GanttWorkItem> = {}): GanttWorkItem => ({
  id: 'w1', project_id: 'p1', kind: 'task', title: 'Task one', status: 'todo', owner_id: null,
  start_date: '2026-06-02', due_date: '2026-06-20', ...over,
});

function render(props: Partial<React.ComponentProps<typeof ProjectGantt>> = {}) {
  act(() => {
    root.render(<ProjectGantt projects={[project()]} workItems={[]} {...handlers} {...props} />);
  });
}
const byLabel = <T extends Element = HTMLElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;
const buttonNamed = (text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const press = (el: Element, key: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const rowTitles = () => Array.from(host.querySelectorAll('.gantt-item-title')).map(b => b.textContent);
const dialog = () => host.querySelector('[role="dialog"]');
const inspect = (name = 'Alpha') => click(byLabel(`Inspect ${name} team & details`));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  Object.values(handlers).forEach(h => h.mockReset());
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProjectGantt empty portfolio', () => {
  it('offers project creation only to managers', () => {
    render({ projects: [], canManage: true });
    click(buttonNamed('+ Create your first project'));
    expect(handlers.onAddProject).toHaveBeenCalledTimes(1);
    render({ projects: [], canManage: false });
    expect(host.textContent).toContain('Your portfolio timeline starts with a project');
    expect(buttonNamed('+ Create your first project')).toBeUndefined();
  });
});

describe('ProjectGantt filters', () => {
  const mixed = [
    item({ id: 'a', title: 'Active item', status: 'in_progress' }),
    item({ id: 'b', title: 'Blocked item', status: 'blocked' }),
    item({ id: 'c', title: 'Late item', status: 'todo', due_date: '2026-06-01', start_date: null }),
    item({ id: 'd', title: 'Done item', status: 'done' }),
    item({ id: 'e', title: 'Proposed item', status: 'proposed' }),
  ];
  it.each([
    ['active', ['Alpha', 'Active item']],
    ['blocked', ['Blocked item']],
    ['overdue', ['Late item']],
    ['planned', ['Late item', 'Proposed item']],
    ['completed', ['Done item']],
    ['all', ['Alpha', 'Active item', 'Blocked item', 'Late item', 'Done item', 'Proposed item']],
  ])('status filter %s shows the matching rows', (status, expected) => {
    render({ workItems: mixed });
    setValue(byLabel<HTMLSelectElement>('Filter timeline by status'), status);
    expect(rowTitles()).toEqual(expected);
  });
  it('searches rows case-insensitively and reports nothing scheduled when no row matches', () => {
    render({ workItems: mixed });
    setValue(byLabel<HTMLInputElement>('Search timeline items'), 'BLOCKED');
    expect(rowTitles()).toEqual(['Blocked item']);
    setValue(byLabel<HTMLInputElement>('Search timeline items'), 'no such thing');
    expect(host.textContent).toContain('No dates have been recorded');
  });
  it('filters by project', () => {
    render({ projects: [project(), project({ id: 'p2', name: 'Beta' })] });
    setValue(byLabel<HTMLSelectElement>('Filter timeline by project'), 'p2');
    expect(rowTitles()).toEqual(['Beta']);
  });
});

describe('ProjectGantt rows', () => {
  it('collapses and expands a project work items', () => {
    render({ workItems: [item()] });
    const toggle = byLabel('Hide work items for Alpha');
    expect(toggle.textContent).toBe('−');
    click(toggle);
    expect(rowTitles()).toEqual(['Alpha']);
    expect(byLabel('Show work items for Alpha').textContent).toBe('+');
    click(byLabel('Show work items for Alpha'));
    expect(rowTitles()).toEqual(['Alpha', 'Task one']);
  });
  it('describes each schedule shape', () => {
    render({
      projects: [project({ start_date: null, due_date: null })],
      workItems: [
        item({ id: 'm', kind: 'milestone', title: 'Gate', start_date: null, due_date: '2026-06-20' }),
        item({ id: 's', title: 'Start only', start_date: '2026-06-03', due_date: null }),
        item({ id: 'd', title: 'Due only', start_date: null, due_date: '2026-06-21' }),
        item({ id: 'bad', title: 'Bad dates', start_date: 'soon', due_date: '2026-02-31' }),
      ],
    });
    const text = host.textContent!;
    expect(text).toContain('Milestone due 2026-06-20');
    expect(text).toContain('Starts 2026-06-03 · deadline unknown');
    expect(text).toContain('Due 2026-06-21 · duration unknown');
    expect(host.querySelector('[aria-label="Gate: Milestone due 2026-06-20 · Milestone"]')).not.toBeNull();
    expect(host.textContent).toContain('Unscheduled records (2)');
  });
  it('labels work package parents and predecessors, falling back to raw ids', () => {
    render({ workItems: [
      item({ id: 'parent', title: 'Package' }),
      item({ id: 'child', title: 'Child', parent_id: 'parent', predecessor_ids: ['parent', 'ghost'] }),
    ] });
    expect(host.textContent).toContain('Work package: Package');
    expect(host.textContent).toContain('Predecessors: Package, ghost');
  });
  it.each([
    ['breached', '⚠ Breached'],
    ['threatened', '⚠ Threatened'],
  ])('tags a %s exception', (exception_status, text) => {
    render({ projects: [project({ exception_status, tolerance_days: 5 })] });
    expect(host.querySelector('.gantt-exception-tag')!.textContent).toBe(text);
    expect(host.querySelector('.gantt-tolerance-tag')!.textContent).toBe('±5d tol');
  });
  it('hides the tag for within tolerance projects', () => {
    render({ projects: [project({ exception_status: 'within_tolerance' })] });
    expect(host.querySelector('.gantt-exception-tag')).toBeNull();
  });
  it.each([
    ['initiation', '🌱'], ['planning', '📐'], ['delivery', '⚡'], ['closing', '🏁'], ['custom', '🔄'],
  ])('shows the %s stage on the bar', (stage, emoji) => {
    render({ projects: [project({ stage })] });
    expect(host.querySelector('.runn-bar-stage-pill')!.textContent).toBe(`${emoji} ${stage}`);
    expect(host.querySelector(`.gantt-bar.stage-${stage}`)).not.toBeNull();
  });
  it.each([
    ['active', 'status-active'], ['in_progress', 'status-active'], ['completed', 'status-completed'],
    ['paused', 'status-paused'], ['mitigating', 'status-paused'], ['blocked', 'status-blocked'],
    ['planned', 'status-planned'], ['something_else', 'status-planned'],
  ])('styles status %s as %s', (status, expected) => {
    render({ projects: [project({ status, due_date: '2026-12-01' })] });
    expect(host.querySelector('.gantt-project-row .gantt-status-tag')!.classList.contains(expected)).toBe(true);
  });
  it('flags overdue projects and items and counts them', () => {
    render({
      projects: [project({ due_date: '2026-06-01', start_date: '2026-05-01' })],
      workItems: [item({ due_date: '2026-06-02', start_date: null })],
    });
    expect(host.querySelector('.text-overdue')!.textContent).toBe('2');
    expect(host.querySelector('.gantt-project-row .gantt-status-tag')!.textContent).toBe('Overdue');
  });
  it.each(['done', 'resolved', 'approved', 'declined', 'accepted', 'applied'])('does not call a past-due %s project overdue', status => {
    render({ projects: [project({ status, due_date: '2026-06-01', start_date: '2026-05-01' })] });
    expect(host.querySelector('.text-overdue')).toBeNull();
    expect(host.querySelector('.gantt-project-row .gantt-status-tag')!.textContent).not.toBe('Overdue');
  });
  it('does not call work overdue under a completed project', () => {
    render({
      projects: [project({ status: 'completed', due_date: '2026-06-01', start_date: '2026-05-01' })],
      workItems: [item({ due_date: '2026-06-02', start_date: null })],
    });
    expect(host.querySelector('.text-overdue')).toBeNull();
  });
  it('computes delivery progress from accepted deliverables and finished tasks', () => {
    render({ workItems: [
      item({ id: 'd1', kind: 'deliverable', status: 'accepted' }),
      item({ id: 'd2', kind: 'deliverable', status: 'draft' }),
      item({ id: 't1', status: 'done' }),
      item({ id: 'm1', kind: 'milestone', status: 'completed' }),
      item({ id: 'r1', kind: 'risk', status: 'open' }),
    ] });
    expect(host.querySelector('.runn-gantt-progress-pct')!.textContent).toBe('75%');
    expect((host.querySelector('.runn-gantt-progress-wrap') as HTMLElement).title).toBe('1/2 deliverables, 2/2 tasks');
    expect((host.querySelector('.runn-bar-progress-overlay') as HTMLElement).style.width).toBe('75%');
  });
  it('shows up to four staff avatars plus an overflow, using ids for unknown people', () => {
    const assignments = ['a', 'b', 'c', 'd', 'e'].map(id => ({
      id, project_id: 'p1', person_id: id === 'a' ? 'known' : `u${id}`, responsibility: 'r', role: 'owner', backup_person_id: null, allocation: 50,
    }));
    render({ assignments, people: [{ id: 'known', name: 'Kim Lee' }] });
    const avatars = host.querySelectorAll<HTMLElement>('.runn-gantt-avatar');
    expect(avatars).toHaveLength(4);
    expect(avatars[0].title).toBe('Kim Lee (owner) · 50%');
    expect(avatars[1].title).toBe('ub (owner) · 50%');
    expect(host.querySelector('.runn-gantt-avatar-more')!.textContent).toBe('+1');
  });
  it('names the owner, falling back to the raw id', () => {
    render({
      workItems: [item({ owner_id: 'known' }), item({ id: 'w2', owner_id: 'stranger' })],
      people: [{ id: 'known', name: 'Kim Lee' }],
    });
    expect(Array.from(host.querySelectorAll('.gantt-owner-tag')).map(t => t.textContent)).toEqual(['Kim Lee', 'stranger']);
  });
  it('opens the owning project when a work item title is clicked', () => {
    render({ workItems: [item()] });
    click(buttonNamed('Task one'));
    expect(handlers.onOpenProject).toHaveBeenCalledWith('p1');
    expect(dialog()).toBeNull();
  });
  it('asks Bob about a row and adds tasks for managers', () => {
    render({ canManage: true, workItems: [item()] });
    click(byLabel('Ask Bob about timeline for Task one'));
    expect(handlers.onAskBob.mock.calls[0][0]).toMatchObject({ projectId: 'p1', workItemId: 'w1', label: 'Task one' });
    click(byLabel('Add task to Alpha'));
    expect(handlers.onAddTask).toHaveBeenCalledWith('p1');
    click(byLabel('Add new project'));
    expect(handlers.onAddProject).toHaveBeenCalled();
  });
});

describe('ProjectGantt timeline interactions', () => {
  it.each(['Enter', ' '])('opens a work bar with key %j and ignores others', key => {
    render({ workItems: [item()] });
    const bar = host.querySelector('.gantt-bar-task')!;
    press(bar, 'x');
    expect(handlers.onOpenProject).not.toHaveBeenCalled();
    press(bar, key);
    expect(handlers.onOpenProject).toHaveBeenCalledWith('p1');
  });
  it.each(['Enter', ' '])('inspects a project bar with key %j', key => {
    render();
    press(host.querySelector('.gantt-bar-project')!, key);
    expect(dialog()).not.toBeNull();
  });
  it('clicking bars inspects projects and opens work items', () => {
    render({ workItems: [item()] });
    click(host.querySelector('.gantt-bar-task')!);
    expect(handlers.onOpenProject).toHaveBeenCalledTimes(1);
    click(host.querySelector('.gantt-bar-project')!);
    expect(dialog()).not.toBeNull();
  });
  it('single-date markers respond to click and keyboard for both row types', () => {
    render({
      projects: [project({ start_date: null })],
      workItems: [item({ start_date: null, due_date: '2026-06-20' })],
    });
    const [projectMarker, itemMarker] = Array.from(host.querySelectorAll('.gantt-marker'));
    click(itemMarker);
    press(itemMarker, 'q');
    expect(handlers.onOpenProject).toHaveBeenCalledTimes(1);
    press(itemMarker, 'Enter');
    expect(handlers.onOpenProject).toHaveBeenCalledTimes(2);
    click(projectMarker);
    expect(dialog()).not.toBeNull();
    click(byLabel('Close project details'));
    press(projectMarker, ' ');
    expect(dialog()).not.toBeNull();
  });
  it('switches to monthly ticks, with today shown on the track', () => {
    render();
    expect(host.querySelector('.gantt-axis')!.textContent).toMatch(/\d+ Jun/);
    click(buttonNamed('Months'));
    expect(buttonNamed('Months').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.gantt-axis')!.textContent).toContain('Jun 2026');
    expect(host.querySelector('.gantt-today')).not.toBeNull();
    click(buttonNamed('Weeks'));
    expect(buttonNamed('Weeks').getAttribute('aria-pressed')).toBe('true');
  });
  it('widens tick spacing and adds years on very long timelines', () => {
    render({ projects: [project({ start_date: '2010-01-01', due_date: '2040-01-01' })] });
    expect(host.querySelector('.gantt-axis')!.textContent).toMatch(/20\d\d/);
    click(buttonNamed('Months'));
    const ticks = host.querySelectorAll('.gantt-axis span:not(.gantt-sr-only)');
    expect(ticks.length).toBeLessThan(365);
    expect(ticks.length).toBeGreaterThan(1);
  });
  it('marks today as out of range when every date is historic', () => {
    render({ projects: [project({ start_date: '2020-01-01', due_date: '2020-02-01' })] });
    expect(host.textContent).toContain('Today: 2026-06-15 (outside range)');
    expect(host.querySelector('.gantt-today')).toBeNull();
  });
});

describe('ProjectGantt unscheduled records', () => {
  it('opens the list when nothing has dates, and each action routes correctly', () => {
    render({
      projects: [project({ start_date: null, due_date: null })],
      workItems: [item({ start_date: null, due_date: null })],
    });
    expect(host.querySelector('details')!.hasAttribute('open')).toBe(true);
    expect(host.textContent).toContain('No dates have been recorded');
    click(buttonNamed('Open project'));
    expect(handlers.onOpenProject).toHaveBeenCalledWith('p1');
    click(byLabel('Ask Bob about timeline for unscheduled Task one'));
    expect(handlers.onAskBob.mock.calls[0][0].label).toBe('Task one');
    click(buttonNamed('Inspect details'));
    expect(dialog()!.textContent).toContain('Alpha');
    expect(dialog()!.textContent).toContain('Not recorded');
    expect(dialog()!.textContent).toContain('No deadline');
  });
});

describe('ProjectGantt dependency flows', () => {
  const projects = [
    project({ id: 'up', name: 'Upstream', due_date: '2026-06-10', start_date: '2026-05-01' }),
    project({ id: 'p1', name: 'Alpha', start_date: '2026-06-01' }),
    project({ id: 'down', name: 'Downstream', start_date: '2026-07-10', due_date: '2026-08-01' }),
  ];
  const dependencies = [
    { id: 'd1', source_project_id: 'up', target_project_id: 'p1', description: 'Needs API' },
    { id: 'd2', source_project_id: 'p1', target_project_id: 'down', description: '' },
    { id: 'd3', source_project_id: 'ghost', target_project_id: 'p1', description: 'Orphan' },
  ];
  it('flags schedule conflicts and names missing projects', () => {
    render({ projects, dependencies });
    const badges = Array.from(host.querySelectorAll('.gantt-project-row:nth-child(2) .gantt-flow-badge'));
    expect(badges[0].classList.contains('conflict')).toBe(true);
    expect(badges[0].textContent).toContain('⚠ Conflict');
    expect(badges[1].textContent).toContain('Project #ghost');
    expect(badges[1].classList.contains('conflict')).toBe(false);
    expect(host.querySelector('.gantt-flow-metrics')!.textContent).toContain('3Dependency links');
  });
  it('navigates from row badges into the inspector', () => {
    render({ projects, dependencies });
    click(host.querySelector('.gantt-flow-badge.downstream')!);
    expect(dialog()!.textContent).toContain('Alpha');
    click(byLabel('Close project details'));
    click(host.querySelector('.gantt-project-row:nth-child(2) .gantt-flow-badge.upstream')!);
    expect(host.querySelector('#gantt-inspect-title')!.textContent).toBe('Upstream');
  });
  it('walks dependencies inside the inspector and shows descriptions only when present', () => {
    render({ projects, dependencies });
    inspect('Alpha');
    const items = host.querySelectorAll('.gantt-inspect-dep-item');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Needs API');
    expect(items[2].querySelector('p')).toBeNull();
    click(items[2].querySelector('button')!);
    expect(host.querySelector('#gantt-inspect-title')!.textContent).toBe('Downstream');
    click(host.querySelector('.gantt-inspect-dep-item.upstream button')!);
    expect(host.querySelector('#gantt-inspect-title')!.textContent).toBe('Alpha');
  });
});

describe('ProjectGantt inspector', () => {
  it('shows empty states and defaults for a sparse project', () => {
    render();
    inspect();
    const text = dialog()!.textContent!;
    expect(text).toContain('No project description provided.');
    expect(text).toContain('medium priority');
    expect(text).toContain('None recorded');
    expect(text).toContain('No team members assigned yet');
    expect(text).toContain('No dependencies recorded');
    expect(text).toContain('No tasks or work items recorded yet.');
    expect(text).not.toContain('PRINCE2');
  });
  it.each([
    ['breached', '⚠ Tolerance Breached'],
    ['threatened', '⚠ Tolerance Threatened'],
    ['within_tolerance', '✓ Within tolerance'],
  ])('summarises %s tolerance state', (exception_status, label) => {
    render({ projects: [project({ exception_status })] });
    inspect();
    expect(dialog()!.querySelector('.gantt-exception-tag')!.textContent).toBe(label);
  });
  it('shows rich governance, people, backups and truncates long work lists', () => {
    const workItems = Array.from({ length: 10 }, (_, i) => item({
      id: `w${i}`, title: `T${i}`, status: 'in_progress', owner_id: i === 0 ? 'p-a' : null, due_date: i === 0 ? '2026-08-01' : null, start_date: null,
    }));
    render({
      projects: [project({
        description: 'Why it matters', business_case: 'Saves money', product_description: 'Must pass QA', stage: 'delivery',
        tolerance_days: 3, priority: 'high', milestone: 'Beta',
      })],
      workItems,
      people: [{ id: 'p-a', name: 'Ana Ruiz' }, { id: 'p-b', name: 'Ben Ito' }],
      assignments: [
        { id: 'as1', project_id: 'p1', person_id: 'p-a', responsibility: 'Lead', role: 'owner', backup_person_id: 'p-b', allocation: 80 },
        { id: 'as2', project_id: 'p1', person_id: 'unknown', responsibility: 'Help', role: 'contributor', backup_person_id: null, allocation: 20 },
      ],
    });
    inspect();
    const text = dialog()!.textContent!;
    for (const expected of ['Why it matters', 'Saves money', 'Must pass QA', 'Stage: delivery', '±3d tolerance', 'high priority', 'Beta',
      'People involved & roles (2)', 'Backup: Ben Ito', 'Backup: None assigned', 'unknown', '+2 more work items', 'Due 2026-08-01', 'Ana Ruiz']) {
      expect(text).toContain(expected);
    }
    expect(dialog()!.querySelectorAll('.gantt-inspect-tasks-list .task-title')).toHaveLength(8);
  });
  it('flags an overdue project in the inspector', () => {
    render({ projects: [project({ due_date: '2026-06-01', start_date: '2026-05-01' })] });
    inspect();
    expect(dialog()!.textContent).toContain('⚠ Overdue');
  });
  it('closes from the overlay but not from clicks inside the drawer', () => {
    render();
    inspect();
    click(host.querySelector('.gantt-inspect-drawer')!);
    expect(dialog()).not.toBeNull();
    click(dialog()!);
    expect(dialog()).toBeNull();
  });
  it.each([
    ['Open full project', 'onOpenProject', 'p1'],
    ['Edit project', 'onEditProject', 'p1'],
    ['+ Add task', 'onAddTask', 'p1'],
  ] as const)('%s closes the inspector and calls through', (name, handler, arg) => {
    render({ canManage: true });
    inspect();
    click(buttonNamed(name));
    expect(handlers[handler]).toHaveBeenCalledWith(arg);
    expect(dialog()).toBeNull();
  });
  it('asks Bob about the inspected project', () => {
    render();
    inspect();
    const ask = Array.from(dialog()!.querySelectorAll('button')).find(b => b.textContent === 'Ask Bob')!;
    click(ask);
    expect(handlers.onAskBob).toHaveBeenCalledWith({ projectId: 'p1', label: 'Alpha', kind: 'project' });
    expect(dialog()).toBeNull();
  });
  it('hides manager actions from viewers', () => {
    render({ canManage: false });
    inspect();
    expect(buttonNamed('Edit project')).toBeUndefined();
    expect(buttonNamed('+ Add task')).toBeUndefined();
  });
});
