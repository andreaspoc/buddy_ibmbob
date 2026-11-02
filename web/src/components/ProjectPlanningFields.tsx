import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, MultiSelect, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import type { Person, Project, StageApproval, WorkItem, WorkKind } from './ProjectsWorkspace';
import { statuses, words } from './ProjectPlanningModel';
import {
  addDaysToDate,
  addMonthsToDate,
  calculateDurationSummary,
  getNextMondayIso,
  getTodayIso,
} from './ProjectDateUtils';
import './ProjectPlanningFields.scss';

const KIND_METADATA: Record<WorkKind, { label: string; icon: string; subtitle: string }> = {
  task: {
    label: 'Work Package Task',
    icon: '📋',
    subtitle: 'Operational action item or sprint deliverable assigned to an owner.',
  },
  milestone: {
    label: 'Milestone / Stage Gate',
    icon: '🚩',
    subtitle: 'Critical delivery checkpoint, stage boundary, or contract deliverable date.',
  },
  deliverable: {
    label: 'Product Deliverable',
    icon: '📦',
    subtitle: 'Tangible work product with defined quality acceptance criteria and sign-off.',
  },
  risk: {
    label: 'Risk Register Item',
    icon: '🛡️',
    subtitle: 'Potential threat or uncertainty requiring assessment, probability rating, and mitigation.',
  },
  issue: {
    label: 'Issue / Impediment',
    icon: '🚨',
    subtitle: 'Live impediment or tolerance breach requiring immediate resolution or escalation.',
  },
  decision: {
    label: 'Key Decision Record',
    icon: '💡',
    subtitle: 'Architectural, scope, or board decision with trade-offs and rationale recorded.',
  },
  lesson: {
    label: 'Lesson Learned Log',
    icon: '📖',
    subtitle: 'Experience or retrospective insight to avoid repetition and improve future delivery.',
  },
};

const STATUS_ICONS: Record<string, { icon: string; tone: string }> = {
  todo: { icon: '⏳', tone: 'neutral' },
  in_progress: { icon: '⚡', tone: 'active' },
  blocked: { icon: '🛑', tone: 'error' },
  done: { icon: '✅', tone: 'success' },
  open: { icon: '⚠️', tone: 'warning' },
  mitigating: { icon: '🛡️', tone: 'active' },
  resolved: { icon: '✅', tone: 'success' },
  proposed: { icon: '📝', tone: 'neutral' },
  approved: { icon: '✅', tone: 'success' },
  declined: { icon: '❌', tone: 'error' },
  draft: { icon: '📝', tone: 'neutral' },
  in_development: { icon: '⚡', tone: 'active' },
  quality_review: { icon: '🔍', tone: 'warning' },
  accepted: { icon: '🏆', tone: 'success' },
  identified: { icon: '💡', tone: 'neutral' },
  logged: { icon: '📑', tone: 'active' },
  applied: { icon: '⭐', tone: 'success' },
};

const PRIORITIES = [
  { id: 'low', label: 'Low', icon: '🟢', tone: 'low' },
  { id: 'medium', label: 'Medium', icon: '🟡', tone: 'medium' },
  { id: 'high', label: 'High (Critical)', icon: '🔴', tone: 'high' },
];

export function WorkItemForm({
  item,
  kind,
  people,
  workItems,
  busy,
  onSave,
  onCancel,
}: {
  item: WorkItem | null;
  kind: WorkKind;
  people: Person[];
  workItems: WorkItem[];
  busy: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const [predecessors, setPredecessors] = useState<WorkItem[]>(
    workItems.filter(work => item?.predecessor_ids?.includes(work.id))
  );
  const candidates = workItems.filter(work => work.id !== item?.id);
  const id = `work-${item?.id || kind}`;

  const [priority, setPriority] = useState<string>(item?.priority || 'medium');
  const [status, setStatus] = useState<string>(item?.status || statuses[kind][0]);
  const [startDate, setStartDate] = useState<string>(item?.start_date || '');
  const [dueDate, setDueDate] = useState<string>(item?.due_date || '');

  const meta = KIND_METADATA[kind] || { label: words(kind), icon: '📋', subtitle: '' };
  const durationText = calculateDurationSummary(startDate, dueDate);

  const applyStartDate = (val: string) => {
    setStartDate(val);
  };

  const applyDueOffset = (offsetDays?: number, offsetMonths?: number) => {
    const base = startDate || getTodayIso();
    let computed = '';
    if (offsetMonths) {
      computed = addMonthsToDate(base, offsetMonths);
    } else if (offsetDays !== undefined) {
      computed = addDaysToDate(base, offsetDays);
    }
    if (computed) {
      if (!startDate) setStartDate(base);
      setDueDate(computed);
    }
  };

  return (
    <form className="projects-card pm-workitem-form" onSubmit={onSave} aria-label={`${item ? 'Edit' : 'New'} ${kind}`}>
      <input type="hidden" name="priority" value={priority} />
      <input type="hidden" name="status" value={status} />

      <Stack gap={6}>
        {/* Header */}
        <div className="pm-form-header">
          <div>
            <div className="pm-kind-pill">
              <span>{meta.icon}</span> {meta.label}
            </div>
            <h3 className="pm-form-title">{item ? `Edit: ${item.title}` : `New ${meta.label}`}</h3>
            <p className="pm-form-subtitle">{meta.subtitle}</p>
          </div>
        </div>

        {/* Section 1: Item Details */}
        <div className="pm-section-card">
          <div className="pm-section-header">
            <h4>Work Item Information</h4>
            <span className="pm-section-tag">Identity</span>
          </div>

          <Stack gap={5}>
            <TextInput
              id={`${id}-title`}
              name="title"
              labelText="Title"
              required
              maxLength={200}
              defaultValue={item?.title || ''}
              placeholder={
                kind === 'milestone'
                  ? 'e.g., Stage 2 Gateway Review Sign-off'
                  : kind === 'deliverable'
                  ? 'e.g., Architecture Blueprints & Security Specification'
                  : kind === 'risk'
                  ? 'e.g., Vendor API migration delayed by upstream dependency'
                  : 'e.g., Implement OAuth2 token refresh workflow'
              }
            />

            <TextArea
              id={`${id}-description`}
              name="description"
              labelText="Scope &amp; Description"
              maxLength={10000}
              defaultValue={item?.description || ''}
              placeholder="Detail the work package requirements, expected deliverables, or context..."
            />

            <div className="pm-grid-2col">
              <Select
                id={`${id}-owner`}
                name="owner_id"
                labelText="Assigned Owner"
                defaultValue={item?.owner_id || ''}
              >
                <SelectItem value="" text="Unassigned" />
                {people
                  .filter(person => person.status !== 'departed' || person.id === item?.owner_id)
                  .map(person => (
                    <SelectItem key={person.id} value={person.id} text={`${person.name} (${person.email || person.id})`} />
                  ))}
              </Select>

              <Select
                id={`${id}-parent`}
                name="parent_id"
                labelText="Parent Work Package or Hierarchy"
                helperText="Link to a parent deliverable or task in this project."
                defaultValue={item?.parent_id || ''}
              >
                <SelectItem value="" text="No parent (Top-level)" />
                {candidates.map(work => (
                  <SelectItem key={work.id} value={work.id} text={`${words(work.kind)}: ${work.title}`} />
                ))}
              </Select>
            </div>
          </Stack>
        </div>

        {/* Section 2: Priority & Status Segmented Selectors */}
        <div className="pm-section-card">
          <div className="pm-section-header">
            <h4>Execution State &amp; Priority</h4>
            <span className="pm-section-tag">Status Controls</span>
          </div>

          <div className="pm-grid-2col">
            <div>
              <span className="pm-input-label">Status</span>
              <div className="pm-pill-group" role="radiogroup" aria-label="Work item status">
                {statuses[kind].map(val => {
                  const sMeta = STATUS_ICONS[val] || { icon: '•', tone: 'neutral' };
                  const isSelected = status === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={`pm-pill-btn pm-tone-${sMeta.tone} ${isSelected ? 'is-active' : ''}`}
                      onClick={() => setStatus(val)}
                    >
                      <span>{sMeta.icon}</span> {words(val)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="pm-input-label">Priority</span>
              <div className="pm-pill-group" role="radiogroup" aria-label="Work item priority">
                {PRIORITIES.map(pr => {
                  const isSelected = priority === pr.id;
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={`pm-pill-btn pm-tone-${pr.tone} ${isSelected ? 'is-active' : ''}`}
                      onClick={() => setPriority(pr.id)}
                    >
                      <span>{pr.icon}</span> {pr.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Section 3: Schedule & Presets */}
        <div className="pm-section-card">
          <div className="pm-section-header">
            <h4>Schedule &amp; Target Dates</h4>
            <span className="pm-section-tag">Timeline</span>
          </div>

          <Stack gap={5}>
            <div className="pm-grid-2col">
              <div className="pm-date-field-group">
                <TextInput
                  id={`${id}-start`}
                  type="date"
                  name="start_date"
                  labelText="Start date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                />
                <div className="pm-quick-chips">
                  <span className="pm-chips-label">Presets:</span>
                  <button type="button" className="pm-chip-btn" onClick={() => applyStartDate(getTodayIso())}>
                    Today
                  </button>
                  <button type="button" className="pm-chip-btn" onClick={() => applyStartDate(getNextMondayIso())}>
                    Next Mon
                  </button>
                  {startDate && (
                    <button type="button" className="pm-chip-btn pm-chip-clear" onClick={() => setStartDate('')}>
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="pm-date-field-group">
                <TextInput
                  id={`${id}-due`}
                  type="date"
                  name="due_date"
                  labelText={kind === 'milestone' ? 'Milestone target date (required)' : 'Due date'}
                  required={kind === 'milestone'}
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                />
                <div className="pm-quick-chips">
                  <span className="pm-chips-label">Presets:</span>
                  <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(3)}>
                    +3d
                  </button>
                  <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(7)}>
                    +1w
                  </button>
                  <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(14)}>
                    +2w
                  </button>
                  <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(undefined, 1)}>
                    +1m
                  </button>
                  {dueDate && (
                    <button type="button" className="pm-chip-btn pm-chip-clear" onClick={() => setDueDate('')}>
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>

            {durationText && <div className="pm-duration-banner">{durationText}</div>}
          </Stack>
        </div>

        {/* Section 4: Dependencies */}
        <div className="pm-section-card">
          <div className="pm-section-header">
            <h4>Predecessor Dependencies</h4>
            <span className="pm-section-tag">Critical Path</span>
          </div>

          <MultiSelect<WorkItem>
            id={`${id}-predecessors`}
            titleText="Work that must finish before this item"
            label="Choose predecessor items..."
            helperText="Predecessors define delivery sequencing and calculate critical path delays."
            items={candidates}
            itemToString={work => work?.title || ''}
            initialSelectedItems={predecessors}
            onChange={({ selectedItems }) => setPredecessors(selectedItems || [])}
          />
          {predecessors.map(work => (
            <input key={work.id} type="hidden" name="predecessor_ids" value={work.id} />
          ))}
        </div>

        {/* Section 5: Kind-Specific Panels (Deliverables or RAID/Outcomes) */}
        {kind === 'deliverable' && (
          <div className="pm-section-card pm-deliverable-card">
            <div className="pm-section-header">
              <h4>📦 Quality Acceptance &amp; Gate Sign-off</h4>
              <span className="pm-section-tag">Quality Criteria</span>
            </div>

            <Stack gap={5}>
              <TextArea
                id={`${id}-criteria`}
                name="acceptance_criteria"
                labelText="Acceptance Criteria &amp; Quality Tolerance"
                maxLength={10000}
                placeholder="What specific tests, metrics, documentation, or standards must be satisfied to accept this deliverable?"
                defaultValue={item?.acceptance_criteria || ''}
              />

              <Select
                id={`${id}-reviewer`}
                name="reviewer_id"
                labelText="Quality Reviewer / Sign-off Authority"
                defaultValue={item?.reviewer_id || ''}
              >
                <SelectItem value="" text="Unassigned" />
                {people
                  .filter(person => person.status !== 'departed' || person.id === item?.reviewer_id)
                  .map(person => (
                    <SelectItem key={person.id} value={person.id} text={person.name} />
                  ))}
              </Select>

              <TextArea
                id={`${id}-evidence`}
                name="acceptance_evidence"
                labelText="Acceptance Review Evidence"
                helperText="Record test results, sign-off notes, or links to test certificates."
                maxLength={10000}
                defaultValue={item?.acceptance_evidence || ''}
              />
            </Stack>
          </div>
        )}

        <div className="pm-section-card">
          <div className="pm-section-header">
            <h4>
              {kind === 'risk'
                ? '🛡️ Mitigation & Contingency Strategy'
                : kind === 'issue'
                ? '🚨 Resolution & Corrective Actions'
                : kind === 'decision'
                ? '💡 Decision Context & Board Rationale'
                : kind === 'lesson'
                ? '📖 Lesson Recommendation & Future Impact'
                : '🎯 Outcome & Resolution Notes'}
            </h4>
            <span className="pm-section-tag">Outcome</span>
          </div>

          <TextArea
            id={`${id}-resolution`}
            name="resolution"
            labelText={
              kind === 'risk'
                ? 'Proactive mitigation plan, contingency triggers, and fallbacks'
                : kind === 'decision'
                ? 'Alternatives considered, trade-offs, and final rationale'
                : kind === 'lesson'
                ? 'What happened, root cause, and recommendations for other projects'
                : 'Resolution status, outcome summary, or closure notes'
            }
            maxLength={10000}
            defaultValue={item?.resolution || ''}
            placeholder={
              kind === 'risk'
                ? 'e.g., Secondary vendor contracted as backup; failover automated if SLA < 99.9%.'
                : kind === 'issue'
                ? 'e.g., Applied hotfix patch in staging; rolling out to production off-peak.'
                : kind === 'decision'
                ? 'e.g., Selected PostgreSQL over MongoDB due to relational compliance requirements.'
                : 'Record outcome details, resolutions, or notes...'
            }
          />
        </div>

        {/* Footer actions */}
        <div className="pm-form-footer">
          <div className="pm-governance-hint">
            <strong>PM Delivery Tip:</strong> Maintain clear predecessor links and ensure every deliverable has a named
            acceptance reviewer.
          </div>
          <div className="pm-actions-row">
            <Button size="md" type="button" kind="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button kind="primary" size="md" type="submit" disabled={busy}>
              {busy ? 'Saving...' : `Save ${words(kind)}`}
            </Button>
          </div>
        </div>
      </Stack>
    </form>
  );
}

export function StageApprovals({
  project,
  people,
  records,
  canManage,
  busy,
  onSave,
}: {
  project: Project;
  people: Person[];
  records: StageApproval[];
  canManage: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [approverId, setApproverId] = useState('');
  const [evidence, setEvidence] = useState('');

  const activePeople = people.filter(person => person.status === 'active');
  const stageName = words(project.stage || 'initiation');

  return (
    <section className="projects-module pm-approval-section" aria-label="Stage approvals">
      <div className="pm-form-header">
        <div>
          <span className="pm-form-badge">PRINCE2 Governance · Stage Boundary Checkpoint</span>
          <h3 className="pm-form-title">Stage Approval History</h3>
          <p className="pm-form-subtitle">
            Formal stage boundary gate decisions attributed to project board approvers. Decisions remain in the permanent revision audit trail.
          </p>
        </div>
      </div>

      {canManage && (
        <form
          className="pm-approval-form"
          onSubmit={async event => {
            event.preventDefault();
            if (!approverId || !evidence.trim()) return;
            const success = await onSave({
              stage: project.stage || 'initiation',
              approver_id: approverId,
              decision,
              evidence: evidence.trim(),
              expected_revision: project.revision,
            });
            if (success) {
              setApproverId('');
              setEvidence('');
              setDecision('approved');
            }
          }}
        >
          <div className="pm-section-header">
            <h4>Record Stage Boundary Decision</h4>
            <span className="pm-section-tag">Project Rev #{project.revision}</span>
          </div>

          <div className="pm-approval-grid">
            <div className="pm-approval-field">
              <label className="pm-input-label" htmlFor={`approval-${project.id}-stage`}>
                Stage under review
              </label>
              <div className="pm-approval-stage-box" id={`approval-${project.id}-stage`}>
                <span className="pm-stage-icon" aria-hidden="true">🏁</span>
                <div className="pm-stage-text">
                  <strong className="pm-stage-name">{stageName} Stage</strong>
                  <span className="pm-stage-rev">Rev {project.revision} checkpoint</span>
                </div>
              </div>
            </div>

            <div className="pm-approval-field">
              <Select
                id={`approval-${project.id}-approver`}
                name="approver_id"
                labelText="Attributed board approver"
                value={approverId}
                onChange={event => setApproverId(event.target.value)}
                required
              >
                <SelectItem value="" text="Select an active approver…" />
                {activePeople.map(person => (
                  <SelectItem key={person.id} value={person.id} text={person.name} />
                ))}
              </Select>
            </div>

            <div className="pm-approval-field">
              <span className="pm-input-label">Governance decision</span>
              <div className="pm-decision-pills" role="radiogroup" aria-label="Governance decision">
                <button
                  type="button"
                  className={`pm-decision-pill is-approved ${decision === 'approved' ? 'is-selected' : ''}`}
                  onClick={() => setDecision('approved')}
                  role="radio"
                  aria-checked={decision === 'approved'}
                >
                  <span className="pm-decision-icon" aria-hidden="true">✓</span>
                  <span>Approved</span>
                </button>
                <button
                  type="button"
                  className={`pm-decision-pill is-rejected ${decision === 'rejected' ? 'is-selected' : ''}`}
                  onClick={() => setDecision('rejected')}
                  role="radio"
                  aria-checked={decision === 'rejected'}
                >
                  <span className="pm-decision-icon" aria-hidden="true">✕</span>
                  <span>Rejected</span>
                </button>
              </div>
            </div>
          </div>

          <div className="pm-approval-evidence-row">
            <TextArea
              id={`approval-${project.id}-evidence`}
              name="evidence"
              labelText="Decision evidence & review minutes (required)"
              placeholder="Record stage boundary review minutes, key deliverable quality criteria sign-offs, and board directives..."
              value={evidence}
              onChange={event => setEvidence(event.target.value)}
              required
              maxLength={10000}
              rows={3}
            />
          </div>

          <div className="pm-form-footer">
            <p className="pm-governance-hint">
              This creates an administrative audit record for governance compliance. Stage decisions do not automatically advance stage without board consensus.
            </p>
            <Button
              kind="primary"
              size="md"
              type="submit"
              disabled={busy || !activePeople.length || !approverId || !evidence.trim()}
            >
              {busy ? 'Recording…' : 'Record stage decision'}
            </Button>
          </div>
        </form>
      )}

      <div className="pm-approval-history">
        <div className="pm-section-header" style={{ marginTop: canManage ? '1.5rem' : '0' }}>
          <h4>Historical Stage Gate Audit Trail</h4>
          <span className="pm-section-tag">{records.length} {records.length === 1 ? 'Record' : 'Records'}</span>
        </div>

        {records.length ? (
          <ol className="pm-approval-history-list">
            {records.map(record => {
              const approver = people.find(person => person.id === record.approver_id);
              const isApproved = record.decision === 'approved';
              const isCurrentRev = record.project_revision === project.revision;
              return (
                <li key={record.id} className={`pm-approval-card ${isApproved ? 'is-approved' : 'is-rejected'}`}>
                  <div className="pm-approval-card-top">
                    <div className="pm-approval-badges">
                      <span className={`pm-approval-decision-tag ${isApproved ? 'is-approved' : 'is-rejected'}`}>
                        {isApproved ? '✓ APPROVED' : '✕ REJECTED'}
                      </span>
                      <span className="pm-approval-stage-tag">
                        {words(record.stage)} Stage Gate
                      </span>
                    </div>
                    <div className="pm-approval-card-meta">
                      <span className={`pm-revision-tag ${isCurrentRev ? 'is-current' : 'is-history'}`}>
                        Rev {record.project_revision} {isCurrentRev ? '(Current)' : '(Historical)'}
                      </span>
                      <time className="pm-approval-time" dateTime={record.created_at}>
                        {new Date(record.created_at).toLocaleString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                  </div>

                  <div className="pm-approval-actors">
                    <span className="pm-approval-actor-pill">
                      <span className="pm-actor-icon" aria-hidden="true">👤</span>
                      <span><strong>Approver:</strong> {approver?.name || record.approver_id}</span>
                    </span>
                    <span className="pm-approval-actor-pill">
                      <span className="pm-actor-icon" aria-hidden="true">✍️</span>
                      <span><strong>Recorded by:</strong> {record.actor || 'Administrator'}</span>
                    </span>
                  </div>

                  <div className="pm-approval-evidence">
                    <strong>Supporting Evidence:</strong>
                    <p>{record.evidence}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="pm-approval-empty">
            <span style={{ fontSize: '2rem' }} aria-hidden="true">🛡️</span>
            <strong style={{ color: 'var(--cds-text-primary, #161616)' }}>No Stage Approvals Recorded</strong>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              When stage reviews occur, board approvals or rejections recorded here provide an immutable PRINCE2 governance audit trail.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function OwnerWorkUpdate({
  item,
  busy,
  onSave,
}: {
  item: WorkItem;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <details className="projects-own-update">
      <summary>Update my work</summary>
      <form
        className="projects-planning-form"
        onSubmit={async event => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          await onSave({
            expected_revision: Number(fields.get('expected_revision')),
            status: fields.get('status'),
            resolution: fields.get('resolution'),
          });
        }}
      >
        <Stack gap={7}>
          <input type="hidden" name="expected_revision" defaultValue={item.revision} />
          <Select
            id={`owner-${item.id}-status`}
            name="status"
            labelText={`Status for ${item.title}`}
            defaultValue={item.status}
          >
            {statuses[item.kind].map(status => (
              <SelectItem key={status} value={status} text={words(status)} />
            ))}
          </Select>
          <TextArea
            id={`owner-${item.id}-resolution`}
            name="resolution"
            labelText={`Resolution for ${item.title}`}
            maxLength={10000}
            defaultValue={item.resolution}
          />
          <Button kind="primary" size="md" type="submit" disabled={busy}>
            Save my update
          </Button>
        </Stack>
      </form>
    </details>
  );
}
