import { brandText } from '../lib/brand';
import { useState, useMemo } from 'react';
import type { FormEvent } from 'react';
import { Button, Stack, TextArea, TextInput } from '@carbon/react';
import type { Project, ProjectStage } from './ProjectsWorkspace';
import {
  addDaysToDate,
  addMonthsToDate,
  calculateDurationSummary,
  getNextMondayIso,
  getTodayIso,
} from './ProjectDateUtils';

interface ProjectFormProps {
  project: Project | null;
  busy: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onAsk: () => void;
  onPreviewChange?: () => void;
}

type TailoringLevel = 'simple' | 'standard' | 'corporate';
type ExceptionStatus = 'within_tolerance' | 'threatened' | 'breached';
type SettingsCategory = 'general' | 'stages' | 'schedule' | 'products' | 'actions' | 'all';

export const STAGES: Array<{ id: ProjectStage; step: number; name: string; subtitle: string; icon: string }> = [
  { id: 'initiation', step: 1, name: 'Initiation', subtitle: 'Starting Up & Brief', icon: '🌱' },
  { id: 'planning', step: 2, name: 'Planning', subtitle: 'Stage Plan & WBS', icon: '📐' },
  { id: 'delivery', step: 3, name: 'Delivery', subtitle: 'Executing Work Packages', icon: '⚡' },
  { id: 'closing', step: 4, name: 'Closing', subtitle: 'Handover & Lessons', icon: '🏁' },
  { id: 'operational', step: 5, name: 'Operational', subtitle: 'Value Realization', icon: '🔄' },
];

const STATUSES: Array<{ id: string; label: string; icon: string; tone: string }> = [
  { id: 'planned', label: 'Planned', icon: '📋', tone: 'neutral' },
  { id: 'active', label: 'Active', icon: '⚡', tone: 'active' },
  { id: 'paused', label: 'Paused', icon: '⏸', tone: 'warning' },
  { id: 'completed', label: 'Completed', icon: '✅', tone: 'success' },
];

const PRIORITIES: Array<{ id: string; label: string; icon: string; tone: string }> = [
  { id: 'low', label: 'Low', icon: '🟢', tone: 'low' },
  { id: 'medium', label: 'Medium', icon: '🟡', tone: 'medium' },
  { id: 'high', label: 'High (Critical)', icon: '🔴', tone: 'high' },
];

const TAILORING_OPTIONS: Array<{ id: TailoringLevel; title: string; badge: string; desc: string }> = [
  {
    id: 'simple',
    title: 'Lightweight / Agile',
    badge: 'Fast Flow',
    desc: 'Lean stage gates and lightweight controls suitable for sprints or small initiatives.',
  },
  {
    id: 'standard',
    title: 'Standard PRINCE2',
    badge: 'Recommended',
    desc: 'Balanced governance with stage plans, work package management, and board controls.',
  },
  {
    id: 'corporate',
    title: 'Corporate / Formal',
    badge: 'Enterprise',
    desc: 'Strict audit trails, formal stage approvals, exception reporting, and board sign-offs.',
  },
];

const EXCEPTION_OPTIONS: Array<{ id: ExceptionStatus; label: string; icon: string; tone: string }> = [
  { id: 'within_tolerance', label: 'Within tolerance', icon: '🟢', tone: 'success' },
  { id: 'threatened', label: 'Tolerance threatened', icon: '🟡', tone: 'warning' },
  { id: 'breached', label: 'Tolerance breached (Exception)', icon: '🔴', tone: 'error' },
];

export function ProjectForm({ project, busy, onSave, onCancel, onAsk, onPreviewChange }: ProjectFormProps) {
  const [activeTab, setActiveTab] = useState<SettingsCategory>('general');
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [stage, setStage] = useState<ProjectStage>(project?.stage || 'initiation');
  const [status, setStatus] = useState(project?.status || 'planned');
  const [priority, setPriority] = useState(project?.priority || 'medium');
  const [tailoringLevel, setTailoringLevel] = useState<TailoringLevel>(project?.tailoring_level || 'standard');
  const [startDate, setStartDate] = useState(project?.start_date || '');
  const [dueDate, setDueDate] = useState(project?.due_date || '');
  const [toleranceDays, setToleranceDays] = useState<number>(project?.tolerance_days ?? 0);
  const [exceptionStatus, setExceptionStatus] = useState<ExceptionStatus>(project?.exception_status || 'within_tolerance');
  const [milestone, setMilestone] = useState(project?.milestone || '');
  const [productDescription, setProductDescription] = useState(project?.product_description || '');
  const [businessCase, setBusinessCase] = useState(project?.business_case || '');

  const durationText = calculateDurationSummary(startDate, dueDate);

  const isDirty = useMemo(() => {
    if (!project) return name.trim().length > 0;
    return (
      name !== (project.name || '') ||
      description !== (project.description || '') ||
      stage !== (project.stage || 'initiation') ||
      status !== (project.status || 'planned') ||
      priority !== (project.priority || 'medium') ||
      tailoringLevel !== (project.tailoring_level || 'standard') ||
      startDate !== (project.start_date || '') ||
      dueDate !== (project.due_date || '') ||
      toleranceDays !== (project.tolerance_days ?? 0) ||
      exceptionStatus !== (project.exception_status || 'within_tolerance') ||
      milestone !== (project.milestone || '') ||
      productDescription !== (project.product_description || '') ||
      businessCase !== (project.business_case || '')
    );
  }, [project, name, description, stage, status, priority, tailoringLevel, startDate, dueDate, toleranceDays, exceptionStatus, milestone, productDescription, businessCase]);

  const resetForm = () => {
    if (!project) {
      setName('');
      setDescription('');
      setStage('initiation');
      setStatus('planned');
      setPriority('medium');
      setTailoringLevel('standard');
      setStartDate('');
      setDueDate('');
      setToleranceDays(0);
      setExceptionStatus('within_tolerance');
      setMilestone('');
      setProductDescription('');
      setBusinessCase('');
      return;
    }
    setName(project.name || '');
    setDescription(project.description || '');
    setStage(project.stage || 'initiation');
    setStatus(project.status || 'planned');
    setPriority(project.priority || 'medium');
    setTailoringLevel(project.tailoring_level || 'standard');
    setStartDate(project.start_date || '');
    setDueDate(project.due_date || '');
    setToleranceDays(project.tolerance_days ?? 0);
    setExceptionStatus(project.exception_status || 'within_tolerance');
    setMilestone(project.milestone || '');
    setProductDescription(project.product_description || '');
    setBusinessCase(project.business_case || '');
  };

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

  const tabs: Array<{ id: SettingsCategory; label: string; icon: string }> = [
    { id: 'general', label: 'Identity & Scope', icon: '🏷️' },
    { id: 'stages', label: 'Stages & Governance', icon: '🎯' },
    { id: 'schedule', label: 'Schedule & Tolerances', icon: '⏱️' },
    { id: 'products', label: 'Products & ROI', icon: '📦' },
    ...(project ? [{ id: 'actions' as SettingsCategory, label: 'Lifecycle & Actions', icon: '🛡️' }] : []),
    { id: 'all', label: 'All Sections', icon: '📄' },
  ];

  return (
    <form className="projects-card pm-project-form pm-settings-shell" onSubmit={onSave}>
      {/* Hidden inputs keep all form values present regardless of active category tab */}
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="description" value={description} />
      <input type="hidden" name="stage" value={stage} />
      <input type="hidden" name="status" value={status} />
      <input type="hidden" name="priority" value={priority} />
      <input type="hidden" name="tailoring_level" value={tailoringLevel} />
      <input type="hidden" name="exception_status" value={exceptionStatus} />
      <input type="hidden" name="start_date" value={startDate} />
      <input type="hidden" name="due_date" value={dueDate} />
      <input type="hidden" name="tolerance_days" value={toleranceDays} />
      <input type="hidden" name="milestone" value={milestone} />
      <input type="hidden" name="product_description" value={productDescription} />
      <input type="hidden" name="business_case" value={businessCase} />

      <Stack gap={6}>
        {/* Top Header Card */}
        <div className="pm-form-header pm-settings-header">
          <div className="pm-settings-header-main">
            <div className="pm-settings-eyebrow">
              <span className="pm-form-badge">{project ? 'Project Settings' : 'New Project Initiation'}</span>
              {project && (
                <span className="pm-revision-tag is-current">Revision #{project.revision}</span>
              )}
              {isDirty ? (
                <span className="pm-settings-dirty-pill">● Unsaved changes</span>
              ) : (
                <span className="pm-settings-clean-pill">✓ Saved</span>
              )}
            </div>
            <h3 className="pm-form-title">{project ? project.name : 'Create a New Project'}</h3>
            <p className="pm-form-subtitle">
              {project
                ? 'Configure project identity, PRINCE2 management stages, schedule tolerances, and continued business justification.'
                : 'Define core objectives, lifecycle stages, schedule baselines, and executive business case.'}
            </p>

            {/* Quick Context Pills */}
            {project && (
              <div className="pm-settings-pills">
                <span className="pm-tag-pill">Stage: <strong>{stage}</strong></span>
                <span className="pm-tag-pill">Status: <strong>{status}</strong></span>
                <span className="pm-tag-pill">Priority: <strong>{priority}</strong></span>
                <span className="pm-tag-pill">Tolerances: <strong>±{toleranceDays}d</strong></span>
              </div>
            )}
          </div>

          <div className="pm-form-header-actions pm-settings-header-actions">
            <Button kind="tertiary" size="md" type="button" onClick={onAsk}>
              ✨ Plan with Project {brandText("Buddy")}
            </Button>
            <Button kind="secondary" size="md" type="button" onClick={onCancel}>
              {project ? 'Close' : 'Cancel'}
            </Button>
            <Button kind="primary" size="md" type="submit" disabled={busy || (project ? !isDirty : !name.trim())}>
              {busy ? 'Saving…' : project ? 'Save settings' : 'Create project'}
            </Button>
          </div>
        </div>

        {/* Category Navigation Bar */}
        <nav className="pm-settings-nav" aria-label="Project Settings sections">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              className={`pm-settings-nav-item ${activeTab === t.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              <span className="pm-settings-nav-icon" aria-hidden="true">{t.icon}</span>
              <span className="pm-settings-nav-label">{t.label}</span>
            </button>
          ))}
        </nav>

        {/* SECTION 1: Objective & Scope */}
        {(activeTab === 'general' || activeTab === 'all') && (
          <div className="pm-section-card">
            <div className="pm-section-header">
              <div>
                <h4>1. Objective &amp; Scope</h4>
                <p className="pm-section-desc">Core naming, strategic scope summary, and PRINCE2 governance tailoring scale.</p>
              </div>
              <span className="pm-section-tag">Identity</span>
            </div>

            <Stack gap={6}>
              <TextInput
                id="project-name"
                labelText="Project name"
                name="name_input"
                required
                maxLength={180}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g., Enterprise Cloud Migration &amp; Compliance Overhaul"
              />

              <TextArea
                id="project-description"
                labelText="Executive summary &amp; scope description"
                name="description_input"
                maxLength={10000}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Summarize the core purpose, target problem, and high-level deliverables..."
                rows={4}
              />

              <div>
                <span className="pm-input-label">Governance &amp; Tailoring Level (PRINCE2 Principle 7)</span>
                <div className="pm-tailoring-grid" role="group" aria-label="Governance and Tailoring Level">
                  {TAILORING_OPTIONS.map(opt => {
                    const isSelected = tailoringLevel === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className={`pm-tailoring-card ${isSelected ? 'is-selected' : ''}`}
                        onClick={() => setTailoringLevel(opt.id)}
                      >
                        <div className="pm-tailoring-card-top">
                          <strong className="pm-tailoring-title">{opt.title}</strong>
                          <span className="pm-tailoring-pill">{opt.badge}</span>
                        </div>
                        <p className="pm-tailoring-desc">{opt.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </Stack>
          </div>
        )}

        {/* SECTION 2: Lifecycle Stage & Governance */}
        {(activeTab === 'stages' || activeTab === 'all') && (
          <div className="pm-section-card">
            <div className="pm-section-header">
              <div>
                <h4>2. Lifecycle Stage &amp; Governance</h4>
                <p className="pm-section-desc">Manage by stages: project execution checkpoints, operational health, and milestone boundaries.</p>
              </div>
              <span className="pm-section-tag">PRINCE2 Stages</span>
            </div>

            <Stack gap={6}>
              <div>
                <span className="pm-input-label">Project Management Stage (Principle 4)</span>
                <div className="pm-stage-stepper" role="radiogroup" aria-label="Project Management Stage">
                  {STAGES.map((s, idx) => {
                    const isSelected = stage === s.id;
                    const isPast = STAGES.findIndex(item => item.id === stage) > idx;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        className={`pm-stage-step ${isSelected ? 'is-active' : ''} ${isPast ? 'is-completed' : ''}`}
                        onClick={() => setStage(s.id)}
                      >
                        <div className="pm-step-num">{isPast ? '✓' : s.step}</div>
                        <div className="pm-step-content">
                          <div className="pm-step-name">
                            <span className="pm-step-icon">{s.icon}</span> {s.name}
                          </div>
                          <div className="pm-step-sub">{s.subtitle}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pm-grid-2col">
                <div>
                  <span className="pm-input-label">Operational Status</span>
                  <div className="pm-pill-group" role="radiogroup" aria-label="Project Status">
                    {STATUSES.map(st => (
                      <button
                        key={st.id}
                        type="button"
                        role="radio"
                        aria-checked={status === st.id}
                        className={`pm-pill-btn pm-tone-${st.tone} ${status === st.id ? 'is-active' : ''}`}
                        onClick={() => setStatus(st.id)}
                      >
                        <span>{st.icon}</span> {st.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="pm-input-label">Priority</span>
                  <div className="pm-pill-group" role="radiogroup" aria-label="Project Priority">
                    {PRIORITIES.map(pr => (
                      <button
                        key={pr.id}
                        type="button"
                        role="radio"
                        aria-checked={priority === pr.id}
                        className={`pm-pill-btn pm-tone-${pr.tone} ${priority === pr.id ? 'is-active' : ''}`}
                        onClick={() => setPriority(pr.id)}
                      >
                        <span>{pr.icon}</span> {pr.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <TextInput
                id="project-milestone"
                labelText="Next milestone / Stage gate checkpoint"
                name="milestone_input"
                maxLength={500}
                value={milestone}
                onChange={e => setMilestone(e.target.value)}
                placeholder="e.g., Stage 2 Board Approval (End of Planning) or MVP Readiness Review"
              />
            </Stack>
          </div>
        )}

        {/* SECTION 3: Schedule & Tolerances */}
        {(activeTab === 'schedule' || activeTab === 'all') && (
          <div className="pm-section-card">
            <div className="pm-section-header">
              <div>
                <h4>3. Schedule &amp; Tolerances</h4>
                <p className="pm-section-desc">Manage by Exception: schedule boundaries and allowable variance before escalating to the Board.</p>
              </div>
              <span className="pm-section-tag">Principle 5: Tolerances</span>
            </div>

            <Stack gap={6}>
              <div className="pm-grid-2col">
                <div className="pm-date-field-group">
                  <TextInput
                    id="project-start_date"
                    labelText="Project start date"
                    type="date"
                    name="start_date_input"
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
                    id="project-due_date"
                    labelText="Target completion / Due date"
                    type="date"
                    name="due_date_input"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                  />
                  <div className="pm-quick-chips">
                    <span className="pm-chips-label">Presets:</span>
                    <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(7)}>
                      +1w
                    </button>
                    <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(14)}>
                      +2w
                    </button>
                    <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(undefined, 1)}>
                      +1m
                    </button>
                    <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(undefined, 3)}>
                      +1q
                    </button>
                    <button type="button" className="pm-chip-btn" onClick={() => applyDueOffset(undefined, 6)}>
                      +6m
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

              <div className="pm-grid-2col">
                <div>
                  <TextInput
                    id="project-tolerance_days"
                    labelText="Time tolerance (± days allowable variance)"
                    type="number"
                    min="0"
                    max="365"
                    name="tolerance_days_input"
                    value={toleranceDays}
                    onChange={e => setToleranceDays(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                    title="Allowed variance before escalating an Exception Report to Project Board"
                  />
                  <div className="pm-quick-chips">
                    <span className="pm-chips-label">Quick presets:</span>
                    {[
                      { days: 0, label: '±0d Strict' },
                      { days: 7, label: '±7d (1w)' },
                      { days: 14, label: '±14d (2w)' },
                      { days: 30, label: '±30d (1m)' },
                    ].map(p => (
                      <button
                        key={p.days}
                        type="button"
                        className={`pm-chip-btn ${toleranceDays === p.days ? 'is-active' : ''}`}
                        onClick={() => setToleranceDays(p.days)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="pm-input-label">Exception &amp; Tolerance Health</span>
                  <div className="pm-pill-group" role="radiogroup" aria-label="Exception status">
                    {EXCEPTION_OPTIONS.map(exc => (
                      <button
                        key={exc.id}
                        type="button"
                        role="radio"
                        aria-checked={exceptionStatus === exc.id}
                        className={`pm-pill-btn pm-tone-${exc.tone} ${exceptionStatus === exc.id ? 'is-active' : ''}`}
                        onClick={() => setExceptionStatus(exc.id)}
                      >
                        <span>{exc.icon}</span> {exc.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Stack>
          </div>
        )}

        {/* SECTION 4: Products & Business Case */}
        {(activeTab === 'products' || activeTab === 'all') && (
          <div className="pm-section-card">
            <div className="pm-section-header">
              <div>
                <h4>4. Products &amp; Business Case</h4>
                <p className="pm-section-desc">Principle 1 &amp; 6: Continued business justification and product-focused deliverables.</p>
              </div>
              <span className="pm-section-tag">Justification &amp; Products</span>
            </div>

            <Stack gap={6}>
              <TextArea
                id="project-product_description"
                labelText="Product description &amp; quality acceptance criteria"
                name="product_description_input"
                maxLength={10000}
                placeholder="Define tangible deliverables, technical specifications, quality standards, and customer acceptance thresholds..."
                value={productDescription}
                onChange={e => setProductDescription(e.target.value)}
                rows={4}
              />

              <TextArea
                id="project-business_case"
                labelText="Continued business justification &amp; expected ROI"
                name="business_case_input"
                maxLength={10000}
                placeholder="Outline executive justification, cost/benefit balance, strategic alignment, and expected business benefits..."
                value={businessCase}
                onChange={e => setBusinessCase(e.target.value)}
                rows={4}
              />
            </Stack>
          </div>
        )}

        {/* SECTION 5: Lifecycle & Actions (Only when project exists) */}
        {project && (activeTab === 'actions' || activeTab === 'all') && (
          <div className="pm-section-card pm-danger-zone-card">
            <div className="pm-section-header">
              <div>
                <h4>5. Lifecycle Actions &amp; Impact Analysis</h4>
                <p className="pm-section-desc">Operational transitions, what-if dependency simulations, and immutable audit metadata.</p>
              </div>
              <span className="pm-section-tag">Governance Actions</span>
            </div>

            <Stack gap={5}>
              <div className="pm-lifecycle-actions-grid">
                <div className="pm-action-tile">
                  <div className="pm-action-tile-info">
                    <strong>⚡ What-If Impact Simulation</strong>
                    <p>Preview how current or proposed project date/status shifts propagate downstream before saving.</p>
                  </div>
                  {onPreviewChange && (
                    <Button kind="tertiary" size="md" type="button" onClick={onPreviewChange}>
                      Preview Project Change
                    </Button>
                  )}
                </div>

                <div className="pm-action-tile">
                  <div className="pm-action-tile-info">
                    <strong>Project State Quick Toggle</strong>
                    <p>Transition project operational state without leaving settings.</p>
                  </div>
                  <div className="pm-action-tile-buttons">
                    {status !== 'active' && (
                      <Button kind="tertiary" size="sm" type="button" onClick={() => setStatus('active')}>
                        Activate Project
                      </Button>
                    )}
                    {status !== 'paused' && (
                      <Button kind="tertiary" size="sm" type="button" onClick={() => setStatus('paused')}>
                        Pause Project
                      </Button>
                    )}
                    {status !== 'completed' && (
                      <Button kind="tertiary" size="sm" type="button" onClick={() => setStatus('completed')}>
                        Mark Completed
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Audit Metadata Info */}
              <div className="pm-audit-metadata">
                <span className="pm-audit-item">Project ID: <code>{project.id}</code></span>
                <span className="pm-audit-item">Current Revision: <code>#{project.revision}</code></span>
                <span className="pm-audit-item">Stage: <code>{project.stage || 'initiation'}</code></span>
                <span className="pm-audit-item">Status: <code>{project.status}</code></span>
              </div>
            </Stack>
          </div>
        )}

        {/* Bottom Sticky Action Footer */}
        <div className="pm-form-footer pm-settings-footer">
          <div className="pm-settings-footer-left">
            {isDirty ? (
              <span className="pm-settings-dirty-text">
                ● You have unsaved changes. Remember to save to update the portfolio revision.
              </span>
            ) : (
              <span className="pm-settings-clean-text">
                All settings match the current project revision (#{project?.revision ?? 1}).
              </span>
            )}
          </div>
          <div className="pm-actions-row">
            {isDirty && (
              <Button kind="ghost" size="md" type="button" onClick={resetForm}>
                Discard changes
              </Button>
            )}
            <Button kind="secondary" size="md" type="button" onClick={onCancel}>
              {project ? 'Close settings' : 'Cancel'}
            </Button>
            <Button
              kind="primary"
              size="md"
              type="submit"
              disabled={busy || (project ? !isDirty : !name.trim())}
            >
              {busy ? 'Saving...' : project ? 'Save settings' : 'Create project'}
            </Button>
          </div>
        </div>
      </Stack>
    </form>
  );
}
