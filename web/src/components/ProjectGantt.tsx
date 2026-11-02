import { useMemo, useState } from 'react';
import './ProjectGantt.css';
import { isClosedStatus } from './projectStatus';

export type GanttProject = {
  id: string;
  name: string;
  status: string;
  priority?: string;
  start_date?: string | null;
  due_date: string | null;
  milestone?: string;
  description?: string;
  business_case?: string;
  product_description?: string;
  stage?: string;
  tolerance_days?: number;
  exception_status?: string;
  tailoring_level?: string;
};

export type GanttWorkItem = {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  status: string;
  owner_id: string | null;
  parent_id?: string | null;
  predecessor_ids?: string[];
  start_date?: string | null;
  due_date: string | null;
  priority?: string;
};

export type GanttDependency = {
  id: string;
  source_project_id: string;
  target_project_id: string;
  description: string;
};

export type GanttAssignment = {
  id: string;
  project_id: string;
  person_id: string;
  responsibility: string;
  role: string;
  backup_person_id: string | null;
  allocation: number;
};

export type GanttFocus = {projectId: string; workItemId?: string; label: string; kind: string};

type Row = GanttFocus & {
  key: string;
  status: string;
  owner: string | null;
  start: string | null;
  due: string | null;
  startDay: number | null;
  dueDay: number | null;
  isOverdue: boolean;
  parentLabel?: string;
  predecessorLabels?: string[];
  stage?: string;
  tolerance_days?: number;
  exception_status?: string;
};

const DAY = 86400000;

function day(value?: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / DAY : null;
}

function iso(value: number) {
  return new Date(value * DAY).toISOString().slice(0, 10);
}

function schedule(row: Row) {
  if (row.kind === 'milestone' && row.dueDay !== null) return `Milestone due ${row.due}`;
  if (row.startDay !== null && row.dueDay !== null) return `${row.start} to ${row.due}`;
  if (row.dueDay !== null) return `Due ${row.due} · duration unknown`;
  if (row.startDay !== null) return `Starts ${row.start} · deadline unknown`;
  return 'Unscheduled';
}

function getStatusStyle(status: string, isOverdue: boolean) {
  if (isOverdue) return 'status-overdue';
  if (isClosedStatus(status)) return 'status-completed';
  switch (status.toLowerCase()) {
    case 'active':
    case 'in_progress':
      return 'status-active';
    case 'completed':
    case 'done':
    case 'approved':
    case 'resolved':
      return 'status-completed';
    case 'paused':
    case 'mitigating':
      return 'status-paused';
    case 'blocked':
      return 'status-blocked';
    case 'planned':
    case 'todo':
    case 'proposed':
    default:
      return 'status-planned';
  }
}

export function ProjectGantt({
  projects,
  workItems,
  dependencies = [],
  assignments = [],
  people = [],
  canManage = false,
  onOpenProject,
  onEditProject,
  onAskBob,
  onAddProject,
  onAddTask,
}: {
  projects: GanttProject[];
  workItems: GanttWorkItem[];
  dependencies?: GanttDependency[];
  assignments?: GanttAssignment[];
  people?: Array<{id: string; name: string; email?: string}>;
  canManage?: boolean;
  onOpenProject: (id: string) => void;
  onEditProject?: (id: string) => void;
  onAskBob: (row: GanttFocus) => void;
  onAddProject?: () => void;
  onAddTask?: (projectId: string) => void;
}) {
  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [zoom, setZoom] = useState<'week' | 'month'>('week');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [today] = useState(() => Math.floor(Date.now() / DAY));
  const [inspectedProjectId, setInspectedProjectId] = useState<string | null>(null);

  const projectName = (id: string) => projects.find(p => p.id === id)?.name || `Project #${id}`;
  const personName = (id: string | null) => people.find(p => p.id === id)?.name || id || 'Unassigned';

  const allRows = useMemo(() => {
    return projects
      .filter(project => projectFilter === 'all' || project.id === projectFilter)
      .flatMap(project => {
        const startDay = day(project.start_date);
        const dueDay = day(project.due_date);
        const isOverdue = Boolean(dueDay !== null && dueDay < today && !isClosedStatus(project.status));
        const projectRow: Row = {
          key: 'project-' + project.id,
          projectId: project.id,
          label: project.name,
          kind: 'project',
          status: project.status,
          owner: null,
          start: project.start_date || null,
          due: project.due_date,
          startDay,
          dueDay,
          isOverdue,
          stage: project.stage,
          tolerance_days: project.tolerance_days,
          exception_status: project.exception_status,
        };

        const itemRows: Row[] = workItems
          .filter(item => item.project_id === project.id)
          .map(item => {
            const itemStart = day(item.start_date);
            const itemDue = day(item.due_date);
            const itemOverdue = Boolean(
              !isClosedStatus(project.status) &&
                itemDue !== null &&
                itemDue < today &&
                !isClosedStatus(item.status)
            );
            return {
              key: 'work-' + item.id,
              projectId: project.id,
              workItemId: item.id,
              label: item.title,
              kind: item.kind,
              status: item.status,
              owner: item.owner_id,
              start: item.start_date || null,
              due: item.due_date,
              startDay: itemStart,
              dueDay: itemDue,
              isOverdue: itemOverdue,
              parentLabel: workItems.find(parent => parent.id === item.parent_id)?.title,
              predecessorLabels: (item.predecessor_ids || []).map(id => workItems.find(predecessor => predecessor.id === id)?.title || id),
            };
          });

        return [projectRow, ...itemRows];
      });
  }, [projects, workItems, projectFilter, today]);

  // Apply search query and status filter
  const filteredRows = useMemo(() => {
    return allRows.filter(row => {
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        if (!row.label.toLowerCase().includes(query)) return false;
      }
      if (statusFilter === 'all') return true;
      if (statusFilter === 'active') return ['active', 'in_progress'].includes(row.status.toLowerCase());
      if (statusFilter === 'blocked') return row.status.toLowerCase() === 'blocked';
      if (statusFilter === 'overdue') return row.isOverdue;
      if (statusFilter === 'planned') return ['planned', 'todo', 'proposed'].includes(row.status.toLowerCase());
      if (statusFilter === 'completed') return isClosedStatus(row.status);
      return row.status.toLowerCase() === statusFilter.toLowerCase();
    });
  }, [allRows, searchQuery, statusFilter]);

  const scheduled = filteredRows.filter(row => row.startDay !== null || row.dueDay !== null);
  const dates = scheduled.flatMap(row => [row.startDay, row.dueDay].filter((value): value is number => value !== null));
  const first = dates.length ? Math.min(...dates) - 3 : today - 3;
  const last = dates.length ? Math.max(...dates) + 7 : today + 7;
  const days = Math.max(last - first + 1, zoom === 'month' ? 60 : 14);

  const pixelsPerDay = Math.min(zoom === 'week' ? 32 : 12, 30000 / days);
  const width = Math.max(640, days * pixelsPerDay);
  const actualScale = width / days;

  const rows = filteredRows.filter(row => row.kind === 'project' || !collapsed.has(row.projectId));

  const ticks: Array<{value: number; label: string}> = [];
  if (zoom === 'month') {
    const tickDate = new Date(first * DAY);
    tickDate.setUTCDate(1);
    if (tickDate.getTime() / DAY < first) tickDate.setUTCMonth(tickDate.getUTCMonth() + 1);
    const monthStep = Math.max(1, Math.ceil((days / 365) * (12 / 120)));
    while (tickDate.getTime() / DAY <= first + days) {
      ticks.push({
        value: tickDate.getTime() / DAY,
        label: tickDate.toLocaleDateString('en-GB', {month: 'short', year: 'numeric', timeZone: 'UTC'}),
      });
      tickDate.setUTCMonth(tickDate.getUTCMonth() + monthStep);
    }
  } else {
    const firstDate = new Date(first * DAY);
    const monday = first + ((8 - firstDate.getUTCDay()) % 7);
    const tickStep = 7 * Math.max(1, Math.ceil(days / 7 / 120));
    for (let value = monday; value <= first + days; value += tickStep) {
      ticks.push({
        value,
        label: new Date(value * DAY).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          ...(days > 300 ? {year: 'numeric'} : {}),
          timeZone: 'UTC',
        }),
      });
    }
  }

  const unscheduled = filteredRows.filter(row => row.startDay === null && row.dueDay === null);
  const todayVisible = today >= first && today <= first + days;

  function toggle(id: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeCount = projects.filter(p => p.status === 'active').length;
  const overdueCount = allRows.filter(r => r.isOverdue).length;
  const flowCount = dependencies.length;

  const inspectedProject = inspectedProjectId ? projects.find(p => p.id === inspectedProjectId) : null;
  const inspectedAssignments = inspectedProject ? assignments.filter(a => a.project_id === inspectedProject.id) : [];
  const inspectedWorkItems = inspectedProject ? workItems.filter(w => w.project_id === inspectedProject.id) : [];
  const inspectedUpstream = inspectedProject ? dependencies.filter(d => d.target_project_id === inspectedProject.id) : [];
  const inspectedDownstream = inspectedProject ? dependencies.filter(d => d.source_project_id === inspectedProject.id) : [];

  if (!projects.length) {
    return (
      <section className="projects-card gantt-empty" aria-label="No projects">
        <h3>Your portfolio timeline starts with a project</h3>
        <p>Add your projects with start and due dates to establish workflow timelines and track dependencies.</p>
        {canManage && onAddProject && (
          <div className="projects-actions" style={{marginTop: '16px'}}>
            <button type="button" className="feature-primary" onClick={onAddProject}>
              + Create your first project
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="project-gantt" aria-label="Project timeline and flows">
      <div className="projects-heading">
        <div>
          <h3>Portfolio timeline & project flows</h3>
          <p className="projects-hint">
            Direct schedule tracking with real-time dependency flow. Click any project or timeline bar to inspect people involved and details.
          </p>
        </div>
        <div className="projects-actions">
          {canManage && onAddProject && (
            <button type="button" className="feature-primary" onClick={onAddProject} aria-label="Add new project">
              + New project
            </button>
          )}
        </div>
      </div>

      <div className="gantt-flow-metrics">
        <div className="gantt-metric-badge">
          <strong>{projects.length}</strong>
          <span>Projects</span>
        </div>
        <div className="gantt-metric-badge">
          <strong className="text-active">{activeCount}</strong>
          <span>Active</span>
        </div>
        <div className="gantt-metric-badge">
          <strong className={overdueCount > 0 ? 'text-overdue' : ''}>{overdueCount}</strong>
          <span>Overdue</span>
        </div>
        <div className="gantt-metric-badge">
          <strong>{flowCount}</strong>
          <span>Dependency links</span>
        </div>
      </div>

      <div className="gantt-controls">
        <label>
          Project
          <select
            aria-label="Filter timeline by project"
            value={projectFilter}
            onChange={event => setProjectFilter(event.target.value)}
          >
            <option value="all">All projects ({projects.length})</option>
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Status
          <select
            aria-label="Filter timeline by status"
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="active">Active / In progress</option>
            <option value="blocked">Blocked</option>
            <option value="overdue">Overdue</option>
            <option value="planned">Planned</option>
            <option value="completed">Completed / Closed</option>
          </select>
        </label>

        <label>
          Filter items
          <input
            type="search"
            aria-label="Search timeline items"
            placeholder="Search project or task…"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
          />
        </label>

        <div role="group" aria-label="Timeline zoom level">
          <button type="button" aria-pressed={zoom === 'week'} onClick={() => setZoom('week')}>
            Weeks
          </button>
          <button type="button" aria-pressed={zoom === 'month'} onClick={() => setZoom('month')}>
            Months
          </button>
        </div>
      </div>

      <div className="gantt-legend" aria-label="Gantt chart legend">
        <span>
          <i className="gantt-legend-color status-active" aria-hidden="true" />
          Active
        </span>
        <span>
          <i className="gantt-legend-color status-completed" aria-hidden="true" />
          Completed
        </span>
        <span>
          <i className="gantt-legend-color status-paused" aria-hidden="true" />
          Paused
        </span>
        <span>
          <i className="gantt-legend-color status-blocked" aria-hidden="true" />
          Blocked
        </span>
        <span>
          <i className="gantt-legend-color status-overdue" aria-hidden="true" />
          Overdue
        </span>
        <span>
          <i className="gantt-legend-color status-planned" aria-hidden="true" />
          Planned
        </span>
        <span>
          <i className="gantt-legend-marker" aria-hidden="true" />
          Single date / milestone
        </span>
        <span>
          Today: {iso(today)} {todayVisible ? '' : '(outside range)'}
        </span>
      </div>

      {scheduled.length === 0 && (
        <p className="projects-empty">
          No dates have been recorded for the selected projects and work items. Set a start date or due date to position
          them on the Gantt chart.
        </p>
      )}

      {scheduled.length > 0 && (
        <div className="gantt-scroll" tabIndex={0} role="region" aria-label="Gantt chart timeline">
          <table className="gantt-table">
            <caption className="gantt-sr-only">
              Projects, work items, and dependency flows with recorded dates in UTC. Click any project or timeline bar to inspect.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="gantt-name-column">
                  Project / Flow item
                </th>
                <th scope="col">
                  <div className="gantt-axis" style={{width}}>
                    <span className="gantt-sr-only">Date axis in UTC</span>
                    {ticks.map(tick => (
                      <span key={tick.value} style={{left: (tick.value - first) * actualScale}}>
                        {tick.label}
                      </span>
                    ))}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const start = row.startDay;
                const due = row.dueDay;
                const both = start !== null && due !== null;
                const point = due ?? start;
                const milestone = ['decision', 'milestone'].includes(row.kind) && due !== null;
                const childCount = workItems.filter(item => item.project_id === row.projectId).length;
                const statusStyle = getStatusStyle(row.status, row.isOverdue);

                const upstream =
                  row.kind === 'project'
                    ? dependencies.filter(dep => dep.target_project_id === row.projectId)
                    : [];
                const downstream =
                  row.kind === 'project'
                    ? dependencies.filter(dep => dep.source_project_id === row.projectId)
                    : [];

                const projectDeliverables = workItems.filter(item => item.project_id === row.projectId && item.kind === 'deliverable');
                const acceptedCount = projectDeliverables.filter(item => item.status === 'accepted').length;
                const projectTasks = workItems.filter(item => item.project_id === row.projectId && ['task', 'milestone'].includes(item.kind));
                const doneTasksCount = projectTasks.filter(item => item.status === 'done' || item.status === 'completed').length;
                const totalWork = projectDeliverables.length + projectTasks.length;
                const progressPercent = totalWork > 0 ? Math.round(((acceptedCount + doneTasksCount) / totalWork) * 100) : 0;
                const projectStaff = assignments.filter(a => a.project_id === row.projectId);

                return (
                  <tr key={row.key} className={row.kind === 'project' ? 'gantt-project-row' : 'gantt-work-row'}>
                    <th scope="row" className="gantt-name-column">
                      <div className="gantt-row-heading">
                        {row.kind === 'project' && childCount > 0 && (
                          <button
                            type="button"
                            className="gantt-expand"
                            aria-label={`${collapsed.has(row.projectId) ? 'Show' : 'Hide'} work items for ${row.label}`}
                            aria-expanded={!collapsed.has(row.projectId)}
                            onClick={() => toggle(row.projectId)}
                          >
                            {collapsed.has(row.projectId) ? '+' : '−'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="projects-text-button gantt-item-title"
                          onClick={() => {
                            if (row.kind === 'project') {
                              setInspectedProjectId(row.projectId);
                            } else {
                              onOpenProject(row.projectId);
                            }
                          }}
                          title={row.kind === 'project' ? 'Click to inspect project details & team' : 'Click to open project'}
                        >
                          {row.label}
                        </button>
                        {row.kind === 'project' && (
                          <button
                            type="button"
                            className="gantt-info-btn"
                            aria-label={`Inspect ${row.label} team & details`}
                            title="Inspect project details & people"
                            onClick={() => setInspectedProjectId(row.projectId)}
                          >
                            ℹ Info
                          </button>
                        )}
                      </div>

                      {row.parentLabel && <p className="projects-hint">Work package: {row.parentLabel}</p>}
                      {Boolean(row.predecessorLabels?.length) && <p className="projects-hint">Predecessors: {row.predecessorLabels!.join(', ')}</p>}
                      <div className="gantt-badges-line">
                        <span className={`gantt-status-tag ${statusStyle}`}>
                          {row.isOverdue ? 'Overdue' : row.status.replaceAll('_', ' ')}
                        </span>
                        {row.stage && (
                          <span className="gantt-stage-tag">
                            {row.stage}
                          </span>
                        )}
                        {row.exception_status && row.exception_status !== 'within_tolerance' && (
                          <span className={`gantt-exception-tag ${row.exception_status}`}>
                            {row.exception_status === 'breached' ? '⚠ Breached' : '⚠ Threatened'}
                          </span>
                        )}
                        {row.kind === 'project' && Boolean(row.tolerance_days) && (
                          <span className="gantt-tolerance-tag" title="Agreed time tolerance">
                            ±{row.tolerance_days}d tol
                          </span>
                        )}
                        <span className="gantt-kind-tag">{row.kind}</span>
                        {row.owner && (
                          <span className="gantt-owner-tag">
                            {people.find(p => p.id === row.owner)?.name || row.owner}
                          </span>
                        )}
                      </div>

                      {/* Runn-style Progress & Staff Avatars for Project Rows */}
                      {row.kind === 'project' && (
                        <div className="runn-gantt-project-meta">
                          {totalWork > 0 && (
                            <div
                              className="runn-gantt-progress-wrap"
                              title={`${acceptedCount}/${projectDeliverables.length} deliverables, ${doneTasksCount}/${projectTasks.length} tasks`}
                            >
                              <div className="runn-gantt-progress-track">
                                <div className="runn-gantt-progress-bar" style={{ width: `${progressPercent}%` }} />
                              </div>
                              <span className="runn-gantt-progress-pct">{progressPercent}%</span>
                            </div>
                          )}
                          {projectStaff.length > 0 && (
                            <div className="runn-gantt-staff-avatars" aria-label="Assigned team">
                              {projectStaff.slice(0, 4).map(st => {
                                const person = people.find(p => p.id === st.person_id);
                                const initials = (person?.name || st.person_id).slice(0, 2).toUpperCase();
                                return (
                                  <span
                                    key={st.id}
                                    className="runn-gantt-avatar"
                                    title={`${person?.name || st.person_id} (${st.role}) · ${st.allocation}%`}
                                  >
                                    {initials} <small>{st.allocation}%</small>
                                  </span>
                                );
                              })}
                              {projectStaff.length > 4 && (
                                <span className="runn-gantt-avatar-more">+{projectStaff.length - 4}</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Display dependency links for project rows */}
                      {row.kind === 'project' && (upstream.length > 0 || downstream.length > 0) && (
                        <div className="gantt-flow-links" aria-label="Project flow links">
                          {upstream.map(dep => {
                            const upProject = projects.find(p => p.id === dep.source_project_id);
                            const hasConflict =
                              upProject?.due_date &&
                              row.start &&
                              upProject.due_date > row.start;
                            return (
                              <button
                                key={dep.id}
                                type="button"
                                className={`gantt-flow-badge upstream ${hasConflict ? 'conflict' : ''}`}
                                onClick={() => setInspectedProjectId(dep.source_project_id)}
                                title={`Depends on: ${projectName(dep.source_project_id)}. Click to inspect.`}
                              >
                                ↳ Depends on: {projectName(dep.source_project_id)}
                                {hasConflict && <span className="conflict-tag">⚠ Conflict</span>}
                              </button>
                            );
                          })}
                          {downstream.map(dep => (
                            <button
                              key={dep.id}
                              type="button"
                              className="gantt-flow-badge downstream"
                              onClick={() => setInspectedProjectId(dep.target_project_id)}
                              title={`Blocks: ${projectName(dep.target_project_id)}. Click to inspect.`}
                            >
                              → Blocks: {projectName(dep.target_project_id)}
                            </button>
                          ))}
                        </div>
                      )}

                      <small className="gantt-schedule-text">{schedule(row)}</small>

                      <div className="gantt-row-actions">
                        <button
                          type="button"
                          className="gantt-bob"
                          aria-label={`Ask Bob about timeline for ${row.label}`}
                          onClick={() => onAskBob(row)}
                        >
                          Ask Bob
                        </button>
                        {row.kind === 'project' && canManage && onAddTask && (
                          <button
                            type="button"
                            className="gantt-add-task-btn"
                            aria-label={`Add task to ${row.label}`}
                            onClick={() => onAddTask(row.projectId)}
                          >
                            + Task
                          </button>
                        )}
                      </div>
                    </th>
                    <td>
                      <div
                        className="gantt-track"
                        style={{width}}
                        role="group"
                        aria-label={`${row.label}: ${schedule(row)}${milestone ? ' · Milestone' : ''}`}
                      >
                        {ticks.map(tick => (
                          <span
                            key={tick.value}
                            className="gantt-grid-line"
                            style={{left: (tick.value - first) * actualScale}}
                          />
                        ))}
                        {todayVisible && (
                          <span
                            className="gantt-today"
                            style={{left: (today - first) * actualScale}}
                            title={`Today ${iso(today)} UTC`}
                          />
                        )}
                        {both && !milestone ? (
                          <div
                            role="button"
                            tabIndex={0}
                            className={`gantt-bar gantt-bar-${row.kind} ${statusStyle} gantt-bar-clickable ${row.kind === 'project' && row.stage ? `stage-${row.stage}` : ''}`}
                            style={{
                              left: (start - first) * actualScale,
                              width: Math.max(12, (due - start + 1) * actualScale),
                            }}
                            title={`Click to inspect ${row.label} (${row.status}): ${schedule(row)}`}
                            onClick={() => {
                              if (row.kind === 'project') setInspectedProjectId(row.projectId);
                              else onOpenProject(row.projectId);
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                if (row.kind === 'project') setInspectedProjectId(row.projectId);
                                else onOpenProject(row.projectId);
                              }
                            }}
                          >
                            {row.kind === 'project' && progressPercent > 0 && (
                              <div className="runn-bar-progress-overlay" style={{ width: `${progressPercent}%` }} />
                            )}
                            <div className="runn-bar-content">
                              {row.kind === 'project' && row.stage && (
                                <span className="runn-bar-stage-pill">
                                  {row.stage === 'initiation' ? '🌱' : row.stage === 'planning' ? '📐' : row.stage === 'delivery' ? '⚡' : row.stage === 'closing' ? '🏁' : '🔄'} {row.stage}
                                </span>
                              )}
                              <span className="gantt-bar-label">{row.label}</span>
                              <span className="runn-bar-days">{due - start + 1}d</span>
                            </div>
                          </div>
                        ) : point !== null ? (
                          <div
                            role="button"
                            tabIndex={0}
                            className={`gantt-marker ${statusStyle} gantt-bar-clickable`}
                            style={{left: (point - first) * actualScale}}
                            title={`Click to inspect ${row.label}: ${schedule(row)}`}
                            onClick={() => {
                              if (row.kind === 'project') setInspectedProjectId(row.projectId);
                              else onOpenProject(row.projectId);
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                if (row.kind === 'project') setInspectedProjectId(row.projectId);
                                else onOpenProject(row.projectId);
                              }
                            }}
                          />
                        ) : (
                          <span className="gantt-no-date">Unscheduled</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {unscheduled.length > 0 && (
        <details className="projects-disclosure" open={scheduled.length === 0}>
          <summary>Unscheduled records ({unscheduled.length})</summary>
          <ul className="gantt-unscheduled">
            {unscheduled.map(row => (
              <li key={row.key}>
                <div>
                  <strong>{row.label}</strong>
                  <span>
                    {row.kind} · {row.status.replaceAll('_', ' ')}
                  </span>
                </div>
                <div className="projects-actions">
                  <button
                    type="button"
                    onClick={() => {
                      if (row.kind === 'project') setInspectedProjectId(row.projectId);
                      else onOpenProject(row.projectId);
                    }}
                  >
                    {row.kind === 'project' ? 'Inspect details' : 'Open project'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Ask Bob about timeline for unscheduled ${row.label}`}
                    onClick={() => onAskBob(row)}
                  >
                    Ask Bob
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Project Details Inspection Drawer / Modal */}
      {inspectedProject && (
        <div
          className="gantt-inspect-overlay"
          onClick={() => setInspectedProjectId(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="gantt-inspect-title"
        >
          <aside className="gantt-inspect-drawer" onClick={e => e.stopPropagation()}>
            <div className="gantt-inspect-header">
              <div>
                <span className="gantt-inspect-eyebrow">Project details & workflow</span>
                <h3 id="gantt-inspect-title">{inspectedProject.name}</h3>
              </div>
              <button
                type="button"
                className="gantt-inspect-close"
                onClick={() => setInspectedProjectId(null)}
                aria-label="Close project details"
              >
                ✕
              </button>
            </div>

            <div className="gantt-inspect-badges">
              <span className={`gantt-status-tag ${getStatusStyle(inspectedProject.status, Boolean(inspectedProject.due_date && inspectedProject.due_date < iso(today) && inspectedProject.status !== 'completed'))}`}>
                {inspectedProject.status}
              </span>
              {inspectedProject.stage && (
                <span className="gantt-stage-tag">Stage: {inspectedProject.stage}</span>
              )}
              {inspectedProject.exception_status && (
                <span className={`gantt-exception-tag ${inspectedProject.exception_status}`}>
                  {inspectedProject.exception_status === 'breached' ? '⚠ Tolerance Breached' : inspectedProject.exception_status === 'threatened' ? '⚠ Tolerance Threatened' : '✓ Within tolerance'}
                </span>
              )}
              {Boolean(inspectedProject.tolerance_days) && (
                <span className="gantt-tolerance-tag">±{inspectedProject.tolerance_days}d tolerance</span>
              )}
              <span className="projects-badge">{inspectedProject.priority || 'medium'} priority</span>
              {inspectedProject.due_date && inspectedProject.due_date < iso(today) && !isClosedStatus(inspectedProject.status) && (
                <span className="gantt-status-tag status-overdue">⚠ Overdue</span>
              )}
            </div>

            {inspectedProject.description ? (
              <p className="gantt-inspect-description">{inspectedProject.description}</p>
            ) : (
              <p className="gantt-inspect-description muted">No project description provided.</p>
            )}

            {/* PRINCE2 Principles 1 & 6: Business Justification & Product Focus */}
            {(inspectedProject.business_case || inspectedProject.product_description) && (
              <div className="gantt-inspect-section">
                <h4>PRINCE2 Governance & Justification</h4>
                {inspectedProject.business_case && (
                  <div className="gantt-prince2-box">
                    <strong>Business Case & Benefits:</strong>
                    <p>{inspectedProject.business_case}</p>
                  </div>
                )}
                {inspectedProject.product_description && (
                  <div className="gantt-prince2-box">
                    <strong>Product Description & Acceptance Criteria:</strong>
                    <p>{inspectedProject.product_description}</p>
                  </div>
                )}
              </div>
            )}

            <div className="gantt-inspect-section">
              <h4>Schedule & Milestones</h4>
              <div className="gantt-inspect-grid">
                <div>
                  <small>Start date</small>
                  <strong>{inspectedProject.start_date || 'Not recorded'}</strong>
                </div>
                <div>
                  <small>Due date</small>
                  <strong>{inspectedProject.due_date || 'No deadline'}</strong>
                </div>
                <div>
                  <small>Next milestone</small>
                  <strong>{inspectedProject.milestone || 'None recorded'}</strong>
                </div>
              </div>
            </div>

            {/* People Involved & Responsibilities */}
            <div className="gantt-inspect-section">
              <div className="gantt-inspect-section-head">
                <h4>People involved & roles ({inspectedAssignments.length})</h4>
              </div>
              {inspectedAssignments.length === 0 ? (
                <p className="gantt-inspect-empty">No team members assigned yet. Assign an owner and contributors in the project workspace.</p>
              ) : (
                <div className="gantt-inspect-people-list">
                  {inspectedAssignments.map(assignment => (
                    <div key={assignment.id} className="gantt-inspect-person-card">
                      <div className="person-card-top">
                        <strong>{personName(assignment.person_id)}</strong>
                        <span className="gantt-role-pill">{assignment.role}</span>
                        <span className="gantt-alloc-pill">{assignment.allocation}% alloc</span>
                      </div>
                      <p className="person-responsibility">{assignment.responsibility}</p>
                      <small className="person-backup">
                        Backup: {assignment.backup_person_id ? personName(assignment.backup_person_id) : 'None assigned'}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Connected Dependencies Flow */}
            <div className="gantt-inspect-section">
              <h4>Project dependency flow</h4>
              {inspectedUpstream.length === 0 && inspectedDownstream.length === 0 ? (
                <p className="gantt-inspect-empty">No dependencies recorded. This project currently operates independently.</p>
              ) : (
                <div className="gantt-inspect-flow-list">
                  {inspectedUpstream.map(dep => (
                    <div key={dep.id} className="gantt-inspect-dep-item upstream">
                      <div>
                        <span className="dep-tag">↳ Depends on:</span>
                        <button
                          type="button"
                          className="projects-text-button"
                          onClick={() => setInspectedProjectId(dep.source_project_id)}
                        >
                          {projectName(dep.source_project_id)}
                        </button>
                      </div>
                      {dep.description && <p>{dep.description}</p>}
                    </div>
                  ))}
                  {inspectedDownstream.map(dep => (
                    <div key={dep.id} className="gantt-inspect-dep-item downstream">
                      <div>
                        <span className="dep-tag">→ Blocks:</span>
                        <button
                          type="button"
                          className="projects-text-button"
                          onClick={() => setInspectedProjectId(dep.target_project_id)}
                        >
                          {projectName(dep.target_project_id)}
                        </button>
                      </div>
                      {dep.description && <p>{dep.description}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tasks and Work Items Summary */}
            <div className="gantt-inspect-section">
              <h4>Tasks & Work items ({inspectedWorkItems.length})</h4>
              {inspectedWorkItems.length === 0 ? (
                <p className="gantt-inspect-empty">No tasks or work items recorded yet.</p>
              ) : (
                <ul className="gantt-inspect-tasks-list">
                  {inspectedWorkItems.slice(0, 8).map(item => (
                    <li key={item.id}>
                      <span className={`gantt-status-tag ${getStatusStyle(item.status, false)}`}>
                        {item.status.replaceAll('_', ' ')}
                      </span>
                      <span className="task-title">{item.title}</span>
                      {item.owner_id && <small className="task-owner">{personName(item.owner_id)}</small>}
                      {item.due_date && <small className="task-due">Due {item.due_date}</small>}
                    </li>
                  ))}
                  {inspectedWorkItems.length > 8 && (
                    <li className="task-more">+{inspectedWorkItems.length - 8} more work items</li>
                  )}
                </ul>
              )}
            </div>

            <div className="gantt-inspect-actions">
              <button
                type="button"
                className="feature-primary"
                onClick={() => {
                  setInspectedProjectId(null);
                  onOpenProject(inspectedProject.id);
                }}
              >
                Open full project
              </button>
              {canManage && onEditProject && (
                <button
                  type="button"
                  onClick={() => {
                    setInspectedProjectId(null);
                    onEditProject(inspectedProject.id);
                  }}
                >
                  Edit project
                </button>
              )}
              {canManage && onAddTask && (
                <button
                  type="button"
                  onClick={() => {
                    setInspectedProjectId(null);
                    onAddTask(inspectedProject.id);
                  }}
                >
                  + Add task
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setInspectedProjectId(null);
                  onAskBob({
                    projectId: inspectedProject.id,
                    label: inspectedProject.name,
                    kind: 'project',
                  });
                }}
              >
                Ask Bob
              </button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
