import { brandText } from '../lib/brand';
import { useMemo, useState } from 'react';
import { Button, TextInput } from '@carbon/react';
import type { Person, Project, WorkItem } from './ProjectsWorkspace';
import { formatIsoDate } from './ProjectDateUtils';
import './ProjectCapacityHeatmap.scss';

interface Assignment {
  id: string;
  project_id: string;
  person_id: string;
  responsibility: string;
  role: string;
  backup_person_id: string | null;
  allocation: number;
}

interface Props {
  people: Person[];
  projects: Project[];
  assignments: Assignment[];
  workItems?: WorkItem[];
  canManage?: boolean;
  onSelectProject: (id: string) => void;
  onPreviewAvailability?: (personId: string) => void;
  onAskBob?: (label: string, prompt: string) => void;
}

type TimeHorizon = 'weeks' | 'months';

interface TimeBucket {
  key: string;
  label: string;
  sublabel: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export function ProjectCapacityHeatmap({
  people,
  projects,
  assignments,
  workItems = [],
  canManage = false,
  onSelectProject,
  onPreviewAvailability,
  onAskBob,
}: Props) {
  const [horizon, setHorizon] = useState<TimeHorizon>('weeks');
  const [filterMode, setFilterMode] = useState<'all' | 'overallocated' | 'available' | 'nobackup'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCell, setSelectedCell] = useState<{
    personId: string;
    bucketKey: string;
    bucketLabel: string;
    total: number;
    breakdown: Array<{ projectName: string; projectId: string; role: string; allocation: number }>;
  } | null>(null);

  // Generate 8 time buckets (weeks or months) starting from current week/month
  const buckets: TimeBucket[] = useMemo(() => {
    const list: TimeBucket[] = [];
    const now = new Date();
    const todayStr = formatIsoDate(now);

    if (horizon === 'weeks') {
      // Find Monday of current week
      const currentMonday = new Date(now);
      const day = currentMonday.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      currentMonday.setDate(currentMonday.getDate() + diff);

      for (let i = 0; i < 8; i++) {
        const start = new Date(currentMonday);
        start.setDate(start.getDate() + i * 7);
        const end = new Date(start);
        end.setDate(end.getDate() + 6);

        const startStr = formatIsoDate(start);
        const endStr = formatIsoDate(end);
        const isCurrent = todayStr >= startStr && todayStr <= endStr;

        const label = start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const sublabel = `W${getWeekNumber(start)}`;

        list.push({
          key: `week-${startStr}`,
          label,
          sublabel,
          startDate: startStr,
          endDate: endStr,
          isCurrent,
        });
      }
    } else {
      // 6 Months starting from current month
      const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      for (let i = 0; i < 6; i++) {
        const start = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + i, 1);
        const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);

        const startStr = formatIsoDate(start);
        const endStr = formatIsoDate(end);
        const isCurrent = todayStr >= startStr && todayStr <= endStr;

        const label = start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
        const sublabel = `M${i + 1}`;

        list.push({
          key: `month-${startStr}`,
          label,
          sublabel,
          startDate: startStr,
          endDate: endStr,
          isCurrent,
        });
      }
    }

    return list;
  }, [horizon]);

  // Map projects for fast lookup
  const projectMap = useMemo(() => {
    return new Map(projects.map(p => [p.id, p]));
  }, [projects]);

  // Compute workload for each person per bucket
  const peopleData = useMemo(() => {
    return people.map(person => {
      const personAssignments = assignments.filter(a => a.person_id === person.id);
      const openItemsCount = workItems.filter(
        w => w.owner_id === person.id && w.status !== 'completed' && w.status !== 'done' && w.status !== 'resolved'
      ).length;

      // Calculate total static recorded allocation
      const totalRecordedAllocation = personAssignments.reduce((acc, curr) => {
        const proj = projectMap.get(curr.project_id);
        if (proj && proj.status !== 'completed') return acc + curr.allocation;
        return acc;
      }, 0);

      // Calculate allocation per bucket
      const bucketAllocations = buckets.map(bucket => {
        const activeInBucket: Array<{ projectName: string; projectId: string; role: string; allocation: number }> = [];

        personAssignments.forEach(a => {
          const proj = projectMap.get(a.project_id);
          if (!proj || proj.status === 'completed') return;

          const pStart = proj.start_date || bucket.startDate;
          const pDue = proj.due_date || bucket.endDate;

          // Check interval overlap: max(start1, start2) <= min(end1, end2)
          if (pStart <= bucket.endDate && pDue >= bucket.startDate) {
            activeInBucket.push({
              projectName: proj.name,
              projectId: proj.id,
              role: a.role,
              allocation: a.allocation,
            });
          }
        });

        const totalBucketAllocation = activeInBucket.reduce((acc, curr) => acc + curr.allocation, 0);

        return {
          bucketKey: bucket.key,
          total: totalBucketAllocation,
          breakdown: activeInBucket,
        };
      });

      const maxBucketAllocation = Math.max(0, ...bucketAllocations.map(b => b.total));
      const hasMissingBackup = personAssignments.some(
        a => !a.backup_person_id && projectMap.get(a.project_id)?.status !== 'completed'
      );

      return {
        person,
        totalRecordedAllocation,
        maxBucketAllocation,
        openItemsCount,
        hasMissingBackup,
        bucketAllocations,
        assignmentsCount: personAssignments.length,
      };
    });
  }, [people, assignments, workItems, projectMap, buckets]);

  // Filter people
  const filteredPeople = useMemo(() => {
    return peopleData.filter(item => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = item.person.name.toLowerCase().includes(q);
        const matchesEmail = (item.person.email || '').toLowerCase().includes(q);
        if (!matchesName && !matchesEmail) return false;
      }

      if (filterMode === 'overallocated') {
        return item.totalRecordedAllocation > 100 || item.maxBucketAllocation > 100;
      }
      if (filterMode === 'available') {
        return item.totalRecordedAllocation < 80;
      }
      if (filterMode === 'nobackup') {
        return item.hasMissingBackup;
      }
      return true;
    });
  }, [peopleData, searchQuery, filterMode]);

  // Overall Organization Capacity Statistics per bucket
  const orgSummary = useMemo(() => {
    if (!people.length) return [];
    return buckets.map(bucket => {
      let totalDemand = 0;
      let overbookedCount = 0;

      peopleData.forEach(p => {
        const b = p.bucketAllocations.find(item => item.bucketKey === bucket.key);
        const alloc = b?.total || 0;
        totalDemand += alloc;
        if (alloc > 100) overbookedCount++;
      });

      const avgUtilization = Math.round(totalDemand / people.length);

      return {
        bucketKey: bucket.key,
        avgUtilization,
        overbookedCount,
      };
    });
  }, [people, buckets, peopleData]);

  // Total summary metrics
  const overallocatedCount = peopleData.filter(p => p.totalRecordedAllocation > 100 || p.maxBucketAllocation > 100).length;
  const availableCount = peopleData.filter(p => p.totalRecordedAllocation < 80).length;
  const avgTeamUtilization = people.length
    ? Math.round(peopleData.reduce((acc, curr) => acc + curr.totalRecordedAllocation, 0) / people.length)
    : 0;

  return (
    <div className="runn-capacity-view">
      {/* Runn KPI Metric Bar */}
      <div className="runn-kpi-bar">
        <div className="runn-kpi-card">
          <span className="runn-kpi-label">Team Capacity</span>
          <strong className={`runn-kpi-value ${avgTeamUtilization > 100 ? 'is-danger' : avgTeamUtilization > 75 ? 'is-optimal' : ''}`}>
            {avgTeamUtilization}%
          </strong>
          <span className="runn-kpi-sub">Portfolio Average</span>
        </div>

        <div className="runn-kpi-card">
          <span className="runn-kpi-label">Active Team Pool</span>
          <strong className="runn-kpi-value">{people.length}</strong>
          <span className="runn-kpi-sub">Total Keycloak Staff</span>
        </div>

        <div className="runn-kpi-card">
          <span className="runn-kpi-label">Burnout Risks</span>
          <strong className={`runn-kpi-value ${overallocatedCount > 0 ? 'is-danger' : 'is-success'}`}>
            {overallocatedCount}
          </strong>
          <span className="runn-kpi-sub">Allocated &gt; 100%</span>
        </div>

        <div className="runn-kpi-card">
          <span className="runn-kpi-label">Available Capacity</span>
          <strong className="runn-kpi-value is-info">{availableCount}</strong>
          <span className="runn-kpi-sub">Bench / Slack &lt; 80%</span>
        </div>
      </div>

      {/* Control bar */}
      <div className="runn-controls-bar">
        <div className="runn-filters-row">
          <div className="runn-search-input">
            <TextInput
              id="capacity-search"
              labelText=""
              placeholder="Search people by name or email…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              size="md"
            />
          </div>

          <div className="runn-segmented-pills">
            <button
              type="button"
              className={`runn-pill ${filterMode === 'all' ? 'is-active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              All Staff ({people.length})
            </button>
            <button
              type="button"
              className={`runn-pill ${filterMode === 'overallocated' ? 'is-active is-danger' : ''}`}
              onClick={() => setFilterMode('overallocated')}
            >
              Over-allocated ({overallocatedCount})
            </button>
            <button
              type="button"
              className={`runn-pill ${filterMode === 'available' ? 'is-active' : ''}`}
              onClick={() => setFilterMode('available')}
            >
              Available ({availableCount})
            </button>
            <button
              type="button"
              className={`runn-pill ${filterMode === 'nobackup' ? 'is-active' : ''}`}
              onClick={() => setFilterMode('nobackup')}
            >
              No Backup
            </button>
          </div>
        </div>

        <div className="runn-horizon-switcher">
          <span className="runn-horizon-label">Time horizon:</span>
          <div className="runn-horizon-toggle">
            <button
              type="button"
              className={horizon === 'weeks' ? 'is-active' : ''}
              onClick={() => setHorizon('weeks')}
            >
              Weeks (8w)
            </button>
            <button
              type="button"
              className={horizon === 'months' ? 'is-active' : ''}
              onClick={() => setHorizon('months')}
            >
              Months (6m)
            </button>
          </div>
        </div>
      </div>

      {/* Heatmap Legend */}
      <div className="runn-heatmap-legend">
        <span className="runn-legend-title">Utilization Scale:</span>
        <div className="runn-legend-item">
          <span className="runn-color-swatch cell-zero" />
          <span>0% Free</span>
        </div>
        <div className="runn-legend-item">
          <span className="runn-color-swatch cell-light" />
          <span>1-50% Light</span>
        </div>
        <div className="runn-legend-item">
          <span className="runn-color-swatch cell-moderate" />
          <span>51-85% Moderate</span>
        </div>
        <div className="runn-legend-item">
          <span className="runn-color-swatch cell-optimal" />
          <span>86-100% Optimal</span>
        </div>
        <div className="runn-legend-item">
          <span className="runn-color-swatch cell-over" />
          <span>&gt;100% Over-allocated</span>
        </div>
        {onAskBob && (
          <div className="runn-legend-action">
            <Button
              kind="tertiary"
              size="sm"
              type="button"
              onClick={() =>
                onAskBob(
                  'capacity optimization',
                  'Analyze current team capacity and workload balance. Highlight individuals over 100%, recommend workload rebalancing, and identify available staff for upcoming projects.'
                )
              }
            >
              ✨ Ask {brandText("Buddy")} to balance workload
            </Button>
          </div>
        )}
      </div>

      {/* Heatmap Matrix Table */}
      <div className="runn-matrix-container">
        <table className="runn-heatmap-table">
          <thead>
            <tr>
              <th className="runn-col-person">Staff Member &amp; Roles</th>
              <th className="runn-col-alloc">Recorded Total</th>
              {buckets.map(b => (
                <th key={b.key} className={`runn-col-bucket ${b.isCurrent ? 'is-today' : ''}`}>
                  <div className="runn-bucket-header">
                    <span className="runn-bucket-label">{b.label}</span>
                    <span className="runn-bucket-sub">{b.sublabel}</span>
                  </div>
                </th>
              ))}
            </tr>

            {/* Org-wide Capacity Summary Row */}
            <tr className="runn-row-org">
              <td className="runn-col-person">
                <strong>⚡ Team Demand vs Supply</strong>
                <span className="runn-person-sub">Average portfolio utilization</span>
              </td>
              <td className="runn-col-alloc">
                <strong>{avgTeamUtilization}%</strong>
              </td>
              {orgSummary.map(os => {
                const toneClass =
                  os.avgUtilization > 100
                    ? 'cell-over'
                    : os.avgUtilization >= 75
                    ? 'cell-optimal'
                    : os.avgUtilization >= 40
                    ? 'cell-moderate'
                    : os.avgUtilization > 0
                    ? 'cell-light'
                    : 'cell-zero';
                return (
                  <td key={os.bucketKey} className={`runn-cell-summary ${toneClass}`}>
                    <span className="runn-cell-val">{os.avgUtilization}%</span>
                    {os.overbookedCount > 0 && (
                      <span className="runn-cell-alert" title={`${os.overbookedCount} staff members over 100%`}>
                        ⚠️ {os.overbookedCount}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {filteredPeople.map(item => {
              const isOver = item.totalRecordedAllocation > 100;
              return (
                <tr key={item.person.id} className="runn-person-row">
                  <td className="runn-col-person">
                    <div className="runn-person-info">
                      <div className="runn-person-avatar">
                        {item.person.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="runn-person-details">
                        <strong className="runn-person-name">{item.person.name}</strong>
                        <span className="runn-person-sub">
                          {item.person.email || item.person.id} · {item.assignmentsCount} projects ·{' '}
                          {item.openItemsCount} work items
                        </span>
                        {item.hasMissingBackup && (
                          <span className="runn-badge-warn">Needs backup</span>
                        )}
                      </div>
                      {canManage && onPreviewAvailability && (
                        <button
                          type="button"
                          className="runn-btn-sim"
                          title="Simulate departure or availability change"
                          onClick={() => onPreviewAvailability(item.person.id)}
                        >
                          Simulate
                        </button>
                      )}
                    </div>
                  </td>

                  <td className="runn-col-alloc">
                    <span
                      className={`runn-alloc-badge ${
                        isOver ? 'is-danger' : item.totalRecordedAllocation >= 75 ? 'is-optimal' : ''
                      }`}
                    >
                      {item.totalRecordedAllocation}%
                    </span>
                  </td>

                  {item.bucketAllocations.map(ba => {
                    const total = ba.total;
                    const tone =
                      total > 100
                        ? 'cell-over'
                        : total >= 80
                        ? 'cell-optimal'
                        : total >= 50
                        ? 'cell-moderate'
                        : total > 0
                        ? 'cell-light'
                        : 'cell-zero';

                    return (
                      <td
                        key={ba.bucketKey}
                        className={`runn-matrix-cell ${tone}`}
                        onClick={() => {
                          const bucketMeta = buckets.find(b => b.key === ba.bucketKey);
                          setSelectedCell({
                            personId: item.person.id,
                            bucketKey: ba.bucketKey,
                            bucketLabel: bucketMeta?.label || ba.bucketKey,
                            total,
                            breakdown: ba.breakdown,
                          });
                        }}
                      >
                        <span className="runn-cell-val">{total > 0 ? `${total}%` : '—'}</span>
                        {total > 100 && <span className="runn-cell-warn-dot" title="Over capacity" />}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Selected Cell Modal / Drawer Breakdown */}
      {selectedCell && (
        <div className="runn-cell-drawer" role="dialog" aria-label="Workload breakdown">
          <div className="runn-cell-drawer-header">
            <div>
              <strong>
                Workload Breakdown: {people.find(p => p.id === selectedCell.personId)?.name}
              </strong>
              <p>
                Period: {selectedCell.bucketLabel} · Total Scheduled:{' '}
                <span className={selectedCell.total > 100 ? 'text-danger' : ''}>{selectedCell.total}%</span>
              </p>
            </div>
            <button
              type="button"
              className="runn-btn-close"
              onClick={() => setSelectedCell(null)}
              aria-label="Close details"
            >
              ✕
            </button>
          </div>

          <div className="runn-breakdown-list">
            {selectedCell.breakdown.length === 0 ? (
              <p className="runn-empty-msg">No project commitments scheduled for this time frame.</p>
            ) : (
              selectedCell.breakdown.map((b, idx) => (
                <div key={idx} className="runn-breakdown-item">
                  <div className="runn-breakdown-info">
                    <button
                      type="button"
                      className="runn-link-btn"
                      onClick={() => onSelectProject(b.projectId)}
                    >
                      {b.projectName}
                    </button>
                    <span className="runn-breakdown-role">Role: {b.role}</span>
                  </div>
                  <strong className="runn-breakdown-alloc">{b.allocation}%</strong>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
