import { brandText } from '../lib/brand';
import { scrollBehavior } from '../lib/motion';
import { AppCollaborationActivity, collaborationFromWorkLog } from './AppCollaborationActivity';
import { TaskTools } from '@carbon/icons-react';
import { Button, InlineNotification } from '@carbon/react';
import { words } from './ProjectPlanningModel';
import { WorkItemForm, StageApprovals, OwnerWorkUpdate } from './ProjectPlanningFields';
import { ProjectForm, STAGES } from './ProjectForm';
import { getDueBadge } from './ProjectDateUtils';
import { ProjectCapacityHeatmap } from './ProjectCapacityHeatmap';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MarkdownView } from './MarkdownView';
import type { ChatMessage } from '../types';
import { parseClarifications, parseNextQuestions } from '../lib/clarification';
import './ProjectsWorkspace.css';
import { ProjectGantt } from './ProjectGantt';
import { isClosedStatus } from './projectStatus';
import { exportProjectToOffice } from './ProjectOfficeExport';

export type ProjectStage = 'initiation' | 'planning' | 'delivery' | 'closing' | 'operational';
type ExceptionStatus = 'within_tolerance' | 'threatened' | 'breached';
type TailoringLevel = 'simple' | 'standard' | 'corporate';

export type Project = {
  revision: number;
  id: string;
  name: string;
  description: string;
  status: string;
  priority: string;
  due_date: string | null;
  start_date?: string | null;
  milestone: string;
  business_case?: string;
  product_description?: string;
  stage?: ProjectStage;
  tolerance_days?: number;
  exception_status?: ExceptionStatus;
  tailoring_level?: TailoringLevel;
};
export type Person = { id: string; name: string; email: string; status: string; departure_date: string | null };
type Assignment = { id: string; project_id: string; person_id: string; responsibility: string; role: string; backup_person_id: string | null; allocation: number };
type Dependency = { id: string; source_project_id: string; target_project_id: string; description: string };
export type WorkKind = 'milestone' | 'task' | 'risk' | 'issue' | 'decision' | 'deliverable' | 'lesson';
export type WorkItem = { revision: number; parent_id?: string | null; predecessor_ids?: string[]; acceptance_criteria?: string; acceptance_evidence?: string; reviewer_id?: string | null; id: string; project_id: string; kind: WorkKind; title: string; description: string; owner_id: string | null; due_date: string | null; start_date?: string | null; priority: string; status: string; resolution: string; can_update?: boolean };
type Finding = { project_id: string; level: string; reason: string; evidence: unknown; path: string[] };
type Impact = { items: Finding[] };
export type StageApproval = { id: string; project_id: string; stage: ProjectStage; project_revision: number; approver_id: string; decision: string; evidence: string; actor?: string; created_at: string };
type Portfolio = { stage_approvals?: StageApproval[]; can_manage?: boolean; projects: Project[]; people: Person[]; assignments: Assignment[]; dependencies: Dependency[]; work_items?: WorkItem[]; impact?: Impact; recent_change_impacts?: Array<{event_id: string; created_at: string; project_id: string; impact: Impact}> };
export type ProjectsBobFocus = { source: string; projectId?: string; personId?: string; workItemId?: string; assignmentId?: string; dependencyId?: string; scenario?: Record<string, unknown> };
type Props = { onClose: () => void; onAskBob: (context: string, question: string, focus?: ProjectsBobFocus) => Promise<void> | void; bobMessages?: ChatMessage[]; bobBusy?: boolean; onStopBob?: () => void; bobError?: string; bobUnavailableReason?: string };
const empty: Portfolio = { projects: [], people: [], assignments: [], dependencies: [], work_items: [] };

const isOpen = (item: WorkItem) => !isClosedStatus(item.status);
function dateKey(value: Date) { return value.toISOString().slice(0,10); }
async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/projects' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = JSON.parse(await response.text(), (key, value) => typeof value === 'number' && ['id','project_id','source_project_id','target_project_id','work_item_id','assignment_id','dependency_id','parent_id'].includes(key) ? String(value) : ['path','predecessor_ids'].includes(key) && Array.isArray(value) ? value.map(String) : value);
  if (!response.ok) { if (response.status === 409 && data.detail?.code === 'revision_conflict') throw new Error('revision_conflict'); throw new Error(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((item: {msg?: string}) => item.msg || 'Invalid value').join('; ') : 'Projects request failed. Please try again.'); }
  return data as T;
}
function PeopleOptions({people}: {people: Person[]}) { return <>{people.map(person => <option key={person.id} value={person.id}>{person.name} ({person.id})</option>)}</>; }

export function ProjectsWorkspace({ onClose, onAskBob, bobMessages = [], bobBusy = false, onStopBob, bobError = '', bobUnavailableReason = '' }: Props) {
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    const previous = icon.getAttribute('href');
    const projectIcon = '/static/project-buddy.svg?v=1';
    icon.setAttribute('href', projectIcon);
    return () => {
      if (icon.getAttribute('href') !== projectIcon) return;
      if (previous === null) icon.removeAttribute('href');
      else icon.setAttribute('href', previous);
    };
  }, []);

  const [portfolio, setPortfolio] = useState<Portfolio>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const [tab, setTab] = useState<'overview' | 'portfolio' | 'timeline' | 'people' | 'impact' | 'merged'>('timeline');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const workspaceRef = useRef<HTMLElement>(null);

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      if (workspaceRef.current && workspaceRef.current.requestFullscreen) {
        workspaceRef.current.requestFullscreen().catch(() => {});
      }
      setIsFullscreen(true);
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleMergedSection = (key: string) => {
    setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: scrollBehavior() });
  };
  const [peopleViewMode, setPeopleViewMode] = useState<'heatmap' | 'directory'>('heatmap');
  const [selected, setSelected] = useState(() => { try { return decodeURIComponent(/^\/projects\/view\/([^/]+)/.exec(window.location.pathname)?.[1] || ''); } catch { return ''; } });
  const projectRouteApplying = useRef(false);
  useEffect(() => {
    const sync = () => {
      projectRouteApplying.current = true;
      const match = /^\/projects\/view\/([^/]+)/.exec(window.location.pathname);
      try { setSelected(match ? decodeURIComponent(match[1]) : ''); } catch { setSelected(''); }
      const section = /^\/projects\/tabs\/(overview|portfolio|timeline|people|impact|merged)/.exec(window.location.pathname)?.[1];
      if (match) setTab('portfolio');
      else if (section) setTab(section as typeof tab);
    };
    sync(); window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => {
    if (!window.location.pathname.startsWith('/projects')) return;
    if (projectRouteApplying.current) { projectRouteApplying.current = false; return; }
    const url = new URL(window.location.href);
    const path = selected && tab === 'portfolio' ? `/projects/view/${encodeURIComponent(selected)}` : `/projects/tabs/${tab}`;
    if (url.pathname !== path) { url.pathname=path; window.history.pushState({...window.history.state}, '', url); }
  }, [selected, tab]);
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [workEditing, setWorkEditing] = useState<WorkItem | null>(null);
  const [workCreating, setWorkCreating] = useState<WorkKind | null>(null);
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [peopleFilter, setPeopleFilter] = useState('all');
  const [attentionView, setAttentionView] = useState('');
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [assistant, setAssistant] = useState(false);
  const [question, setQuestion] = useState('');
  const [focus, setFocus] = useState<ProjectsBobFocus>({source:'overview'});
  const [focusLabel, setFocusLabel] = useState('Portfolio overview');
  const [widgetExpanded, setWidgetExpanded] = useState(false);
  const [bobRequesting, setBobRequesting] = useState(false);
  const [bobRequestError, setBobRequestError] = useState('');
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const followAssistantRef = useRef(true);

  useEffect(() => {
    const scroller = messagesEndRef.current?.parentElement;
    if (assistant && scroller && followAssistantRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [bobMessages, assistant]);

  useEffect(() => { if (!assistant) followAssistantRef.current = true; }, [assistant]);

  function cleanUserPrompt(content: string, displayPrompt?: string): string {
    if (displayPrompt && displayPrompt.trim()) return displayPrompt.trim();
    if (content.includes('User question:')) {
      const parts = content.split('User question:');
      const questionText = parts[parts.length - 1].trim();
      if (questionText) return questionText;
    }
    if (content.startsWith('Authorized portfolio snapshot:') || content.startsWith('You are Bob, the project manager') || content.startsWith(brandText('You are Project Buddy, the project manager'))) {
      return 'Project briefing request';
    }
    return content;
  }
  const [changeKind, setChangeKind] = useState('person_departure');
  const [changeTarget, setChangeTarget] = useState('');
  const [changeStatus, setChangeStatus] = useState('leaving');
  const [changeDate, setChangeDate] = useState('');
  const [preview, setPreview] = useState<Impact | null>(null);
  const [previewPayload, setPreviewPayload] = useState<Record<string, unknown> | null>(null);
  const canManage = portfolio.can_manage === true;
  const workItems = portfolio.work_items || [];
  const project = portfolio.projects.find(item => item.id === selected);
  const liveProjects = portfolio.projects.filter(item => item.status !== 'completed');
  const liveProjectIds = new Set(liveProjects.map(item => item.id));
  const operationalWork = workItems.filter(item => liveProjectIds.has(item.project_id));
  const projectName = (id: string) => portfolio.projects.find(item => item.id === id)?.name || id;
  const personName = (id: string | null) => portfolio.people.find(item => item.id === id)?.name || id || 'Unassigned';
  const today = new Date().toISOString().slice(0,10);
  const nextWeek = new Date(); nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  const upcomingProjects = liveProjects.filter(item => item.due_date && item.due_date >= today && item.due_date <= dateKey(nextWeek)).sort((a,b) => (a.due_date || '').localeCompare(b.due_date || ''));
  const upcoming = operationalWork.filter(item => isOpen(item) && item.due_date && item.due_date >= today && item.due_date <= dateKey(nextWeek)).sort((a,b) => (a.due_date || '').localeCompare(b.due_date || ''));
  const overdue = operationalWork.filter(item => isOpen(item) && item.due_date && item.due_date < today);
  const blocked = operationalWork.filter(item => item.kind === 'task' && item.status === 'blocked');
  const waiting = operationalWork.filter(item => item.kind === 'decision' && item.status === 'proposed');
  const missingOwner = liveProjects.filter(item => !portfolio.assignments.some(assignment => assignment.project_id === item.id && assignment.role === 'owner' && portfolio.people.some(person => person.id === assignment.person_id && person.status === 'active')));
  const noBackup = portfolio.assignments.filter(assignment => liveProjects.some(item => item.id === assignment.project_id) && !portfolio.people.some(person => person.id === assignment.backup_person_id && person.status === 'active'));
  const allocation = (personId: string) => portfolio.assignments.filter(item => item.person_id === personId && liveProjects.some(projectItem => projectItem.id === item.project_id)).reduce((sum,item) => sum + item.allocation, 0);
  const overallocated = portfolio.people.filter(person => allocation(person.id) > 100);
  const affectedIds = new Set(portfolio.impact?.items.map(item => item.project_id) || []);
  const [projectSection, setProjectSection] = useState<'overview' | 'work' | 'governance' | 'raid' | 'lesson' | 'team' | 'settings' | 'all'>('overview');

  function selectProject(id: string, detail: 'overview' | 'work' | 'governance' | 'raid' | 'lesson' | 'team' | 'settings' | 'task' | 'people' | 'dependencies' | 'all' = 'overview') {
    setSelected(id);
    setTab('portfolio');
    const mapped: 'overview' | 'work' | 'governance' | 'raid' | 'lesson' | 'team' | 'settings' | 'all' =
      detail === 'task' ? 'work' :
      detail === 'people' || detail === 'dependencies' ? 'team' :
      detail === 'raid' ? 'raid' :
      detail === 'lesson' ? 'lesson' :
      detail === 'governance' ? 'governance' :
      detail === 'settings' ? 'settings' :
      detail === 'all' ? 'all' :
      (detail as 'overview' | 'work' | 'governance' | 'raid' | 'lesson' | 'team' | 'settings' | 'all') || 'overview';
    setProjectSection(mapped);
    setWorkCreating(null);
    setWorkEditing(null);
    setCreating(false);
    setEditing(null);
  }
  function toggleAssistant() {
    const next = !assistant;
    setAssistant(next);
    if (next) {
      window.setTimeout(() => {
        questionRef.current?.focus();
      }, 60);
    }
  }
  function contextualAsk(label: string, context: ProjectsBobFocus, prompt: string) {
    setFocus(context);
    setFocusLabel(label);
    setQuestion(prompt);
    setAssistant(true);
    setBobRequestError('');
    window.setTimeout(() => {
      questionRef.current?.focus();
    }, 60);
  }
  function bobAction(label: string, context: ProjectsBobFocus, prompt: string, buttonLabel = brandText('Ask Project Buddy')) { return <button type="button" className="projects-bob-action" aria-label={brandText(`Ask Project Buddy about ${label}`)} onClick={() => contextualAsk(label, context, prompt)}>{buttonLabel}</button>; }
  async function load() { setPortfolio(await request<Portfolio>()); }
  useEffect(() => { let active = true; request<Portfolio>().then(data => { if (active) setPortfolio(data); }).catch(reason => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await request<{impact?: Impact}>(path, method, body); await load(); invalidatePreview(); setNotice(result?.impact ? 'Changes saved. View Change impact for recorded effects.' : 'Changes saved.'); return true; } catch (reason) { if ((reason as Error).message === 'revision_conflict') setConflict(true); else setError((reason as Error).message); return false; } finally { setBusy(false); }
  }
  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const currentProj = editing || (selected ? portfolio.projects.find(p => p.id === selected) : null);
    const body: Record<string, unknown> = {
      ...Object.fromEntries(fields),
      ...(currentProj ? {expected_revision: currentProj.revision} : {}),
      start_date: fields.get('start_date') || null,
      due_date: fields.get('due_date') || null,
      tolerance_days: fields.get('tolerance_days') ? Number(fields.get('tolerance_days')) : 0,
    };
    if (await mutate(currentProj ? '/projects/' + encodeURIComponent(currentProj.id) : '/projects', currentProj ? 'PATCH' : 'POST', body)) {
      setCreating(false);
      setEditing(null);
      if (currentProj) {
        setNotice(`Project settings for “${currentProj.name}” saved successfully.`);
      }
    }
  }
  async function saveWorkItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget); const values = {...Object.fromEntries(fields), ...(workEditing ? {expected_revision: workEditing.revision} : {}), parent_id: fields.get('parent_id') || null, predecessor_ids: fields.getAll('predecessor_ids'), reviewer_id: fields.get('reviewer_id') || null, start_date: fields.get('start_date') || null, owner_id: fields.get('owner_id') || null, due_date: fields.get('due_date') || null};
    if (await mutate(workEditing ? '/work-items/' + encodeURIComponent(workEditing.id) : '/work-items', workEditing ? 'PATCH' : 'POST', workEditing ? values : {...values, project_id: selected, kind: workCreating})) { setWorkCreating(null); setWorkEditing(null); }
  }
  async function addAssignment(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); if (await mutate('/assignments','POST',{...Object.fromEntries(fields),project_id:selected,allocation:Number(fields.get('allocation')),backup_person_id:fields.get('backup_person_id') || null})) form.reset(); }
  async function addDependency(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; if (await mutate('/dependencies','POST',{...Object.fromEntries(new FormData(form)),target_project_id:selected})) form.reset(); }
  function invalidatePreview() { setPreview(null); setPreviewPayload(null); if (focus.source === 'scenario') {setFocus({source:'overview'});setFocusLabel('Portfolio overview');} }
  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); invalidatePreview();
    const payload = changeKind === 'person_departure' ? {kind:changeKind,person_id:changeTarget,status:changeStatus,departure_date:changeDate || null} : {kind:changeKind,project_id:changeTarget,expected_revision:portfolio.projects.find(item => item.id === changeTarget)?.revision,status:changeStatus,...(changeDate ? {due_date:changeDate} : {})};
    try { setPreview(await request<Impact>('/impact/preview','POST',payload)); setPreviewPayload(payload); } catch (reason) { if ((reason as Error).message === 'revision_conflict') setConflict(true); else setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function applyPreview() { if (!previewPayload) return; setBusy(true); setError(''); try { await request('/impact/apply','POST',previewPayload); await load(); invalidatePreview(); setNotice('Change applied. Portfolio impact updated.'); } catch (reason) { if ((reason as Error).message === 'revision_conflict') setConflict(true); else setError((reason as Error).message); } finally { setBusy(false); } }
  async function askBob(value: string, nextFocus = focus) {
    if (bobBusy || bobRequesting) return; setBobRequesting(true); setBobRequestError('');
    try { await onAskBob('', value, nextFocus); setQuestion(current => current === value ? '' : current); } catch (reason) { setBobRequestError((reason as Error).message); } finally { setBobRequesting(false); }
  }
  function evidenceText(value: unknown): string {
    if (!value || typeof value !== 'object') return String(value || '');
    return Object.entries(value as Record<string, unknown>).filter(([key]) => !['assignment_id','dependency_id','work_item_id'].includes(key)).map(([key,detail]) => key === 'origin' ? 'Original impact: ' + evidenceText(detail) : ['person_id','backup_person_id','owner_id'].includes(key) ? words(key).replace(' id','') + ': ' + personName(detail ? String(detail) : null) : key === 'source_project_id' ? 'Upstream: ' + projectName(String(detail)) : words(key) + ': ' + (detail === null ? 'Not set' : String(detail))).join(' · ');
  }
  function renderImpact(impact?: Impact | null, source = 'impact') {
    return !impact ? <p className="projects-empty">No impact analysis is available yet.</p> : <div className="projects-impact-results"><p className="projects-hint">Confirmed items describe recorded states or changes. Potential risks require review and do not establish delivery delays.</p>{impact.items.length === 0 ? <p className="projects-empty">No impacts found in recorded relationships. Add owners, work items and dependencies to improve coverage.</p> : impact.items.map((item,index) => <article className="projects-impact-item" key={`${item.project_id}-${index}`}><div><span className="projects-badge" data-level={item.level}>{item.level === 'confirmed' ? 'Confirmed impact' : 'Potential risk'}</span><button type="button" className="projects-text-button" onClick={() => selectProject(item.project_id)}>{projectName(item.project_id)}</button></div><p>{item.reason}</p>{Boolean(item.evidence) && <small>Evidence: {evidenceText(item.evidence)}</small>}{item.path?.length > 0 && <small>Dependency path: {item.path.map(projectName).join(' → ')}</small>}{bobAction(`impact on ${projectName(item.project_id)}: ${item.reason}`,{source,projectId:item.project_id,...(source === 'scenario' && previewPayload ? {scenario:previewPayload} : {})},`Explain this finding and propose next actions: ${item.reason}`)}</article>)}</div>;
  }
  function workRow(item: WorkItem, showProject = false) {
    const isQualityReview = item.kind === 'deliverable' && item.status === 'quality_review';
    const isAccepted = item.kind === 'deliverable' && item.status === 'accepted';
    const kindLabel = item.kind === 'deliverable' ? '📦 Product' : item.kind === 'lesson' ? '💡 Lesson' : item.kind === 'task' ? '⚡ Task' : item.kind === 'milestone' ? '🚩 Milestone' : item.kind === 'risk' ? '🛡️ Risk' : item.kind === 'issue' ? '🚨 Issue' : '⚖️ Decision';
    const resolutionTitle = item.kind === 'decision' ? 'Decision & Board Rationale' : item.kind === 'deliverable' ? 'Quality Criteria & Acceptance Specification' : item.kind === 'lesson' ? 'Lesson Takeaway & Triggers' : 'Resolution & Mitigation Strategy';
    const effectiveCriteria = item.acceptance_criteria || (item.kind === 'deliverable' && item.resolution ? item.resolution : '');

    return (
      <article className={`projects-work-item pm-work-${item.kind}`} key={`${item.id}-${formVersion}`}>
        <div className="projects-work-item-copy">
          <div className="projects-item-tags">
            <span className="projects-badge" data-kind={item.kind}>
              {kindLabel}
            </span>
            <span className="projects-badge" data-status={item.status} data-level={item.status === 'blocked' ? 'confirmed' : isQualityReview ? 'risk' : isAccepted ? 'completed' : undefined}>
              {words(item.status)}
            </span>
            <span className="projects-badge" data-priority={item.priority}>
              {item.priority} priority
            </span>
          </div>

          <h4>{item.title}</h4>

          {showProject && (
            <button type="button" className="projects-text-button" onClick={() => selectProject(item.project_id, item.kind === 'task' ? 'task' : 'raid')}>
              {projectName(item.project_id)}
            </button>
          )}

          <p className="projects-small">
            {personName(item.owner_id)} · {item.due_date ? `Due ${item.due_date}` : 'No due date'}
            {item.due_date && item.due_date < today && isOpen(item) ? ' · ⚠️ Overdue' : ''}
          </p>

          {item.description && <p className="projects-item-desc">{item.description}</p>}

          {item.parent_id && (
            <p className="projects-small">
              <strong>Parent:</strong> {workItems.find(work => work.id === item.parent_id)?.title || item.parent_id}
            </p>
          )}

          {Boolean(item.predecessor_ids?.length) && (
            <p className="projects-small">
              <strong>Predecessors:</strong> {item.predecessor_ids?.map(id => workItems.find(work => work.id === id)?.title || id).join(', ')}
            </p>
          )}

          {/* Branded Product Quality & Acceptance Review Gate */}
          {item.kind === 'deliverable' && (
            <div className="pm-deliverable-gate">
              <div className="pm-gate-banner">
                <div className="pm-gate-title">
                  <span className="pm-gate-icon" aria-hidden="true">🏁</span>
                  <div>
                    <strong>Acceptance Review &amp; Quality Gate</strong>
                    <span className="pm-gate-subtitle">PRINCE2 Product Quality Standard</span>
                  </div>
                </div>
                <span className={`pm-gate-status-pill ${isAccepted ? 'is-accepted' : isQualityReview ? 'is-review' : item.reviewer_id ? 'is-assigned' : 'is-unassigned'}`}>
                  {isAccepted ? '✓ Accepted' : isQualityReview ? '⏱ Quality Review' : item.reviewer_id ? 'Ready for Review' : '⚠️ Reviewer Unassigned'}
                </span>
              </div>

              <div className="pm-gate-grid">
                <div className="pm-gate-field">
                  <span className="pm-gate-field-label">📋 Acceptance Criteria:</span>
                  <div className="pm-gate-field-val">
                    {effectiveCriteria ? (
                      <span className="pm-criteria-text">{effectiveCriteria}</span>
                    ) : (
                      <span className="pm-not-recorded-tag">Not recorded</span>
                    )}
                  </div>
                </div>

                <div className="pm-gate-field">
                  <span className="pm-gate-field-label">👤 Quality Reviewer:</span>
                  <div className="pm-gate-field-val">
                    {item.reviewer_id ? (
                      <span className="pm-reviewer-badge">👤 {personName(item.reviewer_id)}</span>
                    ) : (
                      <span className="pm-unassigned-badge">⚠️ Unassigned</span>
                    )}
                  </div>
                </div>

                <div className="pm-gate-field">
                  <span className="pm-gate-field-label">🔍 Review Evidence:</span>
                  <div className="pm-gate-field-val">
                    {item.acceptance_evidence ? (
                      <span className="pm-evidence-badge">📄 {item.acceptance_evidence}</span>
                    ) : (
                      <span className="pm-not-recorded-tag">Not recorded</span>
                    )}
                  </div>
                </div>

                {item.resolution && item.resolution !== effectiveCriteria && (
                  <div className="pm-gate-field pm-gate-field-full">
                    <span className="pm-gate-field-label">🎯 Reviewer &amp; Architect Assessment:</span>
                    <div className="pm-gate-field-val">
                      <span className="pm-criteria-text">{item.resolution}</span>
                    </div>
                  </div>
                )}
              </div>

              {canManage && (
                <div className="pm-gate-footer">
                  <button
                    type="button"
                    className="pm-gate-quick-edit"
                    onClick={() => {
                      selectProject(item.project_id, 'work');
                      setWorkEditing(item);
                    }}
                  >
                    ✏️ Edit Quality Criteria &amp; Acceptance Details
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Branded Resolution Callout for non-deliverable items */}
          {item.kind !== 'deliverable' && item.resolution && (
            <div className={`pm-resolution-callout pm-callout-${item.kind}`}>
              <div className="pm-callout-header">
                <span className="pm-callout-icon" aria-hidden="true">
                  {item.kind === 'risk' ? '🛡️' : item.kind === 'issue' ? '🚨' : item.kind === 'decision' ? '💡' : item.kind === 'lesson' ? '📖' : '🎯'}
                </span>
                <strong>{resolutionTitle}</strong>
              </div>
              <p className="pm-callout-text">{item.resolution}</p>
            </div>
          )}
        </div>

        <div className="projects-actions">
          {bobAction(item.title, { source: 'work_item', projectId: item.project_id, workItemId: item.id }, `Help me with this ${item.kind}: ${item.title}. Suggest clear next steps based on its recorded owner, due date and status.`)}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                selectProject(item.project_id, item.kind === 'task' ? 'task' : 'raid');
                setWorkEditing(item);
              }}
            >
              Edit
            </button>
          )}
          {!canManage && item.can_update && (
            <OwnerWorkUpdate item={item} busy={busy} onSave={body => mutate('/work-items/' + encodeURIComponent(item.id), 'PATCH', body)} />
          )}
        </div>
      </article>
    );
  }
  const visibleProjects = portfolio.projects.filter(item => (ownerFilter === 'all' || portfolio.assignments.some(assignment => assignment.project_id === item.id && (assignment.role === 'owner' || assignment.role === 'executive') && assignment.person_id === ownerFilter)) && (item.name + ' ' + item.description).toLowerCase().includes(query.toLowerCase()) && (projectFilter === 'all' || projectFilter === 'attention' && affectedIds.has(item.id) || projectFilter === 'no_owner' && missingOwner.some(p => p.id === item.id) || projectFilter === 'due' && Boolean(item.due_date && item.due_date <= dateKey(nextWeek) && item.status !== 'completed') || item.status === projectFilter));
  function workModule(category: 'deliverable' | 'task' | 'raid' | 'lesson') {
    if (!project) return null;
    const isDeliverable = category === 'deliverable';
    const isLesson = category === 'lesson';
    const isTask = category === 'task';
    const isRaid = category === 'raid';
    const records = workItems.filter(item => {
      if (item.project_id !== selected) return false;
      if (isDeliverable) return item.kind === 'deliverable';
      if (isLesson) return item.kind === 'lesson';
      if (isTask) return ['task', 'milestone'].includes(item.kind);
      if (isRaid) return ['risk', 'issue', 'decision'].includes(item.kind);
      return false;
    });
    const title = isDeliverable ? 'Products & Deliverables (Principle: Focus on Products)' : isLesson ? 'Lessons Learned Log (Principle: Learn from Experience)' : isTask ? 'Work Plan & Tasks' : 'Risks, Issues & Decisions (RAID Register)';
    const hint = isDeliverable ? 'Deliverables and work packages defined by quality criteria and acceptance sign-offs.' : isLesson ? 'Lessons identified, logged and applied across management stages to learn from experience.' : isTask ? 'Operational tasks, assigned ownership and delivery dates.' : 'Track project uncertainty, active problems and management board decisions.';
    const kindsToAdd: WorkKind[] = isDeliverable ? ['deliverable'] : isLesson ? ['lesson'] : isTask ? ['task', 'milestone'] : ['risk', 'issue', 'decision'];
    const formKind = workEditing?.kind || workCreating;
    const formMatches = Boolean(formKind && kindsToAdd.includes(formKind));

    return <section className={`projects-module projects-module-${category}`} aria-label={title}>
      <div className="projects-heading"><div><h4>{title} <span className="projects-badge">{records.length}</span></h4><p className="projects-hint">{hint}</p></div><div className="projects-actions">{canManage && kindsToAdd.map(kind => <Button kind="tertiary" size="md" type="button" key={kind} onClick={() => { setWorkCreating(kind); setWorkEditing(null); }}>Add {kind === 'deliverable' ? 'deliverable' : kind === 'lesson' ? 'lesson' : kind}</Button>)}{bobAction(`${project.name} ${title}`, {source: category, projectId: project.id}, isDeliverable ? 'Review product deliverables, quality criteria and acceptance criteria for this project.' : isLesson ? 'Review lessons learned and recommend process improvements based on recorded project experience.' : isTask ? 'Propose a practical work breakdown for this project without inventing dates.' : 'Review project risks, issues and decisions, and suggest mitigations and next actions.', isDeliverable ? 'Review Deliverables' : isLesson ? 'Review Lessons' : isTask ? brandText('Plan with Project Buddy') : 'Review RAID')}</div></div>
      {canManage && formMatches && formKind && <WorkItemForm key={`${workEditing?.id || workCreating}-${formVersion}`} item={workEditing} kind={formKind} people={portfolio.people} workItems={workItems.filter(item => item.project_id === selected)} busy={busy} onSave={saveWorkItem} onCancel={() => { setWorkCreating(null); setWorkEditing(null); }} />}
      {records.length ? <div className="projects-work-list">{records.map(item => workRow(item))}</div> : <p className="projects-empty">{isDeliverable ? 'No product deliverables recorded. Add key deliverables to maintain a focus on products.' : isLesson ? 'No lessons logged yet. Record lessons learned to improve throughout project stages.' : isTask ? 'No tasks recorded yet. Add operational tasks with an owner and a due date.' : 'No risks, issues or decisions recorded.'}</p>}
    </section>;
  }

  const portfolioAvgAlloc = portfolio.people.length
    ? Math.round(portfolio.people.reduce((sum, p) => sum + allocation(p.id), 0) / portfolio.people.length)
    : 0;
  const milestonesDueCount = operationalWork.filter(
    item => item.kind === 'milestone' && isOpen(item) && item.due_date && item.due_date >= today
  ).length;
  const atRiskCount = liveProjects.filter(
    p => p.exception_status && p.exception_status !== 'within_tolerance'
  ).length;

  return <section ref={workspaceRef} className={`projects-workspace ${isFullscreen ? 'is-fullscreen' : ''}`} aria-label="Projects portfolio" aria-busy={loading || busy}>
    <header className="projects-header">
      <div className="projects-header-title">
        <span>{brandText("Buddy")}</span>
        <h2>Projects &amp; Portfolio</h2>
      </div>
      <nav className="projects-view-nav" aria-label="Projects views">
        {([
          ['timeline','Planner (Timeline)'],
          ['portfolio','Projects Register'],
          ['people','Capacity & Staffing'],
          ['overview','Briefing & Attention'],
          ['impact','Forecasting & Scenarios'],
          ['merged','⊞ Merged View'],
        ] as const).map(([value,label]) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => {
              setTab(value);
              setQuery('');
              if (value === 'portfolio') setSelected('');
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="projects-header-actions">
        <button
          type="button"
          className={`projects-merge-tabs-btn ${tab === 'merged' ? 'is-active' : ''}`}
          onClick={() => setTab(tab === 'merged' ? 'timeline' : 'merged')}
          title={tab === 'merged' ? 'Split back into individual tabs' : 'Merge all tabs into a unified executive view'}
        >
          {tab === 'merged' ? '📑 Split Tabs' : '⊞ Merge Tabs'}
        </button>
        <button
          type="button"
          className={`projects-fullscreen-btn ${isFullscreen ? 'is-active' : ''}`}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Workspace'}
        >
          {isFullscreen ? '⤓ Exit Fullscreen' : '⛶ Fullscreen'}
        </button>
        <button type="button" aria-label="Toggle project assistant" aria-expanded={assistant} onClick={toggleAssistant}>
          {assistant ? brandText('Hide Project Buddy') : brandText('Project Buddy')}
        </button>
        <button type="button" onClick={onClose}>
          Back to {brandText("Buddy")}
        </button>
      </div>
    </header>

    {!loading && (
      <div className="runn-portfolio-strip" role="region" aria-label="Portfolio KPIs">
        <div className="runn-strip-item" onClick={() => { setTab('portfolio'); setSelected(''); setProjectFilter('all'); }}>
          <span className="runn-strip-label">Portfolio Projects</span>
          <div className="runn-strip-val">
            <strong>{liveProjects.length}</strong>
            <span className="runn-strip-stages">
              🌱{liveProjects.filter(p => p.stage === 'initiation').length} · 📐{liveProjects.filter(p => p.stage === 'planning').length} · ⚡{liveProjects.filter(p => p.stage === 'delivery').length} · 🏁{liveProjects.filter(p => p.stage === 'closing').length}
            </span>
          </div>
        </div>

        <button type="button" className="runn-strip-item" onClick={() => { setTab('people'); setPeopleViewMode('heatmap'); }}>
          <span className="runn-strip-label">Team Capacity</span>
          <span className="runn-strip-val">
            <strong className={portfolioAvgAlloc > 100 ? 'is-danger' : portfolioAvgAlloc >= 75 ? 'is-optimal' : ''}>
              {portfolioAvgAlloc}%
            </strong>
            <span className="runn-strip-sub">{portfolio.people.length} active staff</span>
          </span>
        </button>

        <div className="runn-strip-item" onClick={() => { setTab('people'); setPeopleViewMode('heatmap'); }}>
          <span className="runn-strip-label">Burnout Risks</span>
          <div className="runn-strip-val">
            <strong className={overallocated.length > 0 ? 'is-danger' : 'is-success'}>
              {overallocated.length}
            </strong>
            <span className="runn-strip-sub">{overallocated.length > 0 ? 'Allocated > 100%' : 'All within capacity'}</span>
          </div>
        </div>

        <div className="runn-strip-item" onClick={() => { setTab('timeline'); }}>
          <span className="runn-strip-label">Milestones (30d)</span>
          <div className="runn-strip-val">
            <strong>{milestonesDueCount}</strong>
            <span className="runn-strip-sub">Upcoming stage gates</span>
          </div>
        </div>

        <div className="runn-strip-item" onClick={() => { setTab('portfolio'); setSelected(''); setProjectFilter('attention'); }}>
          <span className="runn-strip-label">Tolerances &amp; Risks</span>
          <div className="runn-strip-val">
            <strong className={atRiskCount > 0 ? 'is-danger' : 'is-success'}>{atRiskCount}</strong>
            <span className="runn-strip-sub">{atRiskCount > 0 ? 'Tolerance threatened' : 'Within tolerances'}</span>
          </div>
        </div>
      </div>
    )}

    {conflict && <div className="projects-planning-conflict"><InlineNotification kind="warning" title="This record changed" subtitle="Your draft is preserved. Reload the latest records before editing again; reloading replaces your current draft." hideCloseButton /><Button kind="tertiary" size="md" disabled={busy} onClick={async () => {setBusy(true);try {const latest = await request<Portfolio>();setPortfolio(latest);setEditing(current => current ? latest.projects.find(item => item.id === current.id) || null : null);setWorkEditing(current => current ? latest.work_items?.find(item => item.id === current.id) || null : null);setFormVersion(value => value + 1);invalidatePreview();setConflict(false);} catch (reason) {setError((reason as Error).message);} finally {setBusy(false);}}}>Reload latest and replace draft</Button></div>}{error && <p className="projects-error" role="alert">{error}</p>}{notice && <p className="projects-notice" role="status">{notice}</p>}
    {loading ? <p role="status" className="projects-empty">Loading projects…</p> : <div className="projects-layout"><div className="projects-content">
      {tab === 'overview' && <><div className="projects-heading"><div><h3>Your project briefing</h3><p className="projects-hint">PRINCE2 Governance: stage management, tolerance exceptions, and Project Board oversight.</p></div>{bobAction('portfolio briefing',{source:'overview'},'Give me a daily project briefing: immediate actions, stage gate reviews, tolerance status, ownership gaps and downstream risks. Separate confirmed facts from risks.','Prepare my project review')}</div>
        <div className="projects-metrics">
          <button type="button" className="projects-metric-tile" onClick={() => {setTab('portfolio');setSelected('');setProjectFilter('all');}}>
            <div className="projects-metric-head">
              <span className="projects-metric-icon" aria-hidden="true">🚀</span>
              <span className="projects-metric-tag">Portfolio</span>
            </div>
            <strong>{liveProjects.length}</strong>
            <span>Active projects</span>
          </button>
          <button type="button" className={`projects-metric-tile ${affectedIds.size > 0 ? 'is-warning' : ''}`} onClick={() => {setTab('portfolio');setSelected('');setProjectFilter('attention');}}>
            <div className="projects-metric-head">
              <span className="projects-metric-icon" aria-hidden="true">⚠️</span>
              <span className="projects-metric-tag">{affectedIds.size > 0 ? 'Review Needed' : 'Nominal'}</span>
            </div>
            <strong>{affectedIds.size}</strong>
            <span>Projects with impact</span>
          </button>
          <button type="button" className="projects-metric-tile" onClick={() => {setTab('people');}}>
            <div className="projects-metric-head">
              <span className="projects-metric-icon" aria-hidden="true">👥</span>
              <span className="projects-metric-tag">Keycloak</span>
            </div>
            <strong>{portfolio.people.length}</strong>
            <span>Team members</span>
          </button>
          <button type="button" className="projects-metric-tile" onClick={() => {setTab('impact');}}>
            <div className="projects-metric-head">
              <span className="projects-metric-icon" aria-hidden="true">🔗</span>
              <span className="projects-metric-tag">Network</span>
            </div>
            <strong>{portfolio.dependencies.length}</strong>
            <span>Dependencies</span>
          </button>
        </div>

        {/* Portfolio Health & Governance Radar Banner */}
        <div className="projects-governance-radar" role="region" aria-label="Portfolio Governance Summary">
          <div className="projects-radar-col">
            <span className="projects-radar-label">Management Stages (PRINCE2 Principle 4)</span>
            <div className="projects-radar-stages">
              {STAGES.map(s => {
                const count = liveProjects.filter(p => (p.stage || 'initiation') === s.id).length;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="projects-radar-stage-chip"
                    title={`${s.name} Stage: ${count} project(s)`}
                    onClick={() => { setTab('portfolio'); setSelected(''); setQuery(s.id); }}
                  >
                    <span className="projects-radar-dot" data-stage={s.id} />
                    <strong>{s.name}</strong> <small>({count})</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="projects-radar-col">
            <span className="projects-radar-label">Tolerance Health (PRINCE2 Principle 5)</span>
            <div className="projects-radar-tolerance">
              {(() => {
                const breachedCount = liveProjects.filter(p => p.exception_status === 'breached').length;
                const threatenedCount = liveProjects.filter(p => p.exception_status === 'threatened').length;
                const withinCount = liveProjects.length - breachedCount - threatenedCount;
                return (
                  <div className="projects-radar-tolerance-tags">
                    <span className="projects-radar-tag is-nominal" title={`${withinCount} projects within schedule tolerance`}>
                      ✓ {withinCount} Within Tolerance
                    </span>
                    {threatenedCount > 0 && (
                      <span className="projects-radar-tag is-threatened" title={`${threatenedCount} projects with schedule tolerance threatened`}>
                        ⚠ {threatenedCount} Threatened
                      </span>
                    )}
                    {breachedCount > 0 && (
                      <span className="projects-radar-tag is-breached" title={`${breachedCount} projects breached tolerance (Exception Report required)`}>
                        🚨 {breachedCount} Breached
                      </span>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="projects-radar-col">
            <span className="projects-radar-label">Deliverables & Quality (Principle 6)</span>
            <div className="projects-radar-products">
              {(() => {
                const allDelivs = workItems.filter(w => w.kind === 'deliverable');
                const accepted = allDelivs.filter(w => w.status === 'accepted').length;
                const allTasks = workItems.filter(w => ['task', 'milestone'].includes(w.kind));
                const doneTasks = allTasks.filter(w => w.status === 'done' || w.status === 'completed').length;
                const pct = allDelivs.length ? Math.round((accepted / allDelivs.length) * 100) : 100;
                return (
                  <div className="projects-radar-product-info">
                    <div className="projects-radar-progress-wrap">
                      <div className="projects-radar-progress-bar" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="projects-radar-progress-text">
                      <strong>{accepted}/{allDelivs.length}</strong> products accepted · <strong>{doneTasks}/{allTasks.length}</strong> tasks done
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
        {portfolio.projects.length === 0 && <section className="projects-card projects-onboarding"><h3>Start with one real project</h3><p>Add the project, assign its Executive and Project Manager from Keycloak, set tolerances, and capture deliverables. Your briefing builds from those records.</p><div className="projects-actions">{canManage && <button type="button" className="feature-primary" onClick={() => {setTab('portfolio');setCreating(true);}}>Create your first project</button>}{bobAction('starting a project',{source:'project_creation'},'Help me structure my first project according to PRINCE2 principles: business justification, deliverables, stages, tolerances and roles.',brandText('Plan with Project Buddy'))}</div></section>}
        <div className="projects-dashboard-grid"><section className="projects-card"><div className="projects-heading"><h3>Needs attention</h3>{bobAction('today’s priorities',{source:'overview'},'Which recorded issues should I address first today, and why?')}</div><div className="projects-attention-list"><button type="button" onClick={() => setAttentionView('blocked')}><span>Blocked tasks</span><strong>{blocked.length}</strong></button><button type="button" onClick={() => setAttentionView('overdue')}><span>Overdue work items</span><strong>{overdue.length}</strong></button><button type="button" onClick={() => {setTab('portfolio');setSelected('');setProjectFilter('no_owner');}}><span>Projects without an active owner</span><strong>{missingOwner.length}</strong></button><button type="button" onClick={() => {setTab('people');setPeopleFilter('backup');}}><span>Responsibilities without active backup</span><strong>{noBackup.length}</strong></button><button type="button" onClick={() => {setTab('people');setPeopleFilter('allocation');}}><span>People with allocation over 100%</span><strong>{overallocated.length}</strong></button></div><p className="projects-hint">Counts come from saved records. Dates are compared using today in UTC. Missing backup and high allocation indicate review needs, rather than a confirmed delivery delay.</p>{attentionView && <div><h4>{attentionView === 'blocked' ? 'Blocked tasks' : 'Overdue work items'}</h4>{(attentionView === 'blocked' ? blocked : overdue).length ? (attentionView === 'blocked' ? blocked : overdue).map(item => workRow(item,true)) : <p className="projects-empty">No matching records.</p>}</div>}</section>
        <section className="projects-card"><div className="projects-heading"><h3>Waiting decisions</h3>{bobAction('waiting decisions',{source:'decisions'},'Summarize pending decisions, who owns each, and which next steps need a decision.')}</div>{waiting.length ? waiting.slice(0,4).map(item => workRow(item,true)) : <p className="projects-empty">No proposed decisions recorded. Capture decisions inside a project so they have an owner and a date.</p>}</section>
        <section className="projects-card"><div className="projects-heading"><h3>Due in the next 7 days</h3>{bobAction('upcoming work',{source:'upcoming'},'Review the next seven days of due work and recommend follow-ups, without inventing completion estimates.')}</div>{upcomingProjects.map(item => <article className="projects-work-item" key={item.id}><div><span className="projects-badge">Project deadline</span><h4><button type="button" className="projects-text-button" onClick={() => selectProject(item.id)}>{item.name}</button></h4><p className="projects-small">Due {item.due_date}</p></div>{bobAction(item.name,{source:'project',projectId:item.id},'Review the upcoming deadline, remaining recorded tasks and required decisions for this project.')}</article>)}{upcoming.slice(0,5).map(item => workRow(item,true))}{!upcoming.length && !upcomingProjects.length && <p className="projects-empty">No projects or open work items have a due date in the next seven days.</p>}</section><section className="projects-card"><h3>Current portfolio impact</h3>{renderImpact(portfolio.impact)}</section></div>
      </>}
      {tab === 'portfolio' && <>{project && <div className="projects-breadcrumb"><button type="button" onClick={()=>{setSelected('');setEditing(null);setCreating(false);}}>Back to portfolio</button><span aria-hidden="true">/</span><span>{project.name}</span></div>}{!project && <div className="projects-heading"><h3>Project portfolio <span className="projects-badge">{portfolio.projects.length}</span></h3>{canManage && <button type="button" className="feature-primary" onClick={() => {setEditing(null);setCreating(true);}}>New project</button>}<button type="button" disabled={busy} onClick={()=>{setBusy(true);load().catch(reason=>setError(reason.message)).finally(()=>setBusy(false));}}>Refresh</button></div>}
        {canManage && creating && !project && <ProjectForm key={`new-${formVersion}`} project={null} busy={busy} onSave={saveProject} onCancel={() => {setCreating(false);setEditing(null);}} onAsk={() => contextualAsk('New project',{source:'project_creation'},'Help me plan a new project under PRINCE2: clarify business justification, product breakdown, management stages and board roles.')} />}
        {!project && <><div className="projects-portfolio-filters"><label>Find a project<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Show<select aria-label="Project filter" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>{[['all','All projects'],['attention','With impact findings'],['no_owner','Missing active owner'],['due','Due soon or overdue'],['active','Active'],['planned','Planned'],['paused','Paused'],['completed','Completed']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Project owner<select aria-label="Owner filter" value={ownerFilter} onChange={event => setOwnerFilter(event.target.value)}><option value="all">All owners</option><PeopleOptions people={portfolio.people} /></select></label></div>
        <div className="projects-project-grid">{visibleProjects.map(item => {
          const owners = portfolio.assignments.filter(a => a.project_id === item.id && (a.role === 'owner' || a.role === 'executive' || a.role === 'project_manager'));
          const findings = portfolio.impact?.items.filter(finding => finding.project_id === item.id) || [];
          const delivs = workItems.filter(work => work.project_id === item.id && work.kind === 'deliverable');
          const accDelivs = delivs.filter(work => work.status === 'accepted').length;
          const projTasks = workItems.filter(work => work.project_id === item.id && ['task', 'milestone'].includes(work.kind));
          const tasksDone = projTasks.filter(work => work.status === 'done' || work.status === 'completed').length;
          const totalWork = delivs.length + projTasks.length;
          const progressPct = totalWork > 0 ? Math.round(((accDelivs + tasksDone) / totalWork) * 100) : 0;
          const projStaff = portfolio.assignments.filter(a => a.project_id === item.id);
          const dueBadge = getDueBadge(item.due_date);

          return <article className={`projects-project-card${selected === item.id ? ' is-selected' : ''}`} key={item.id}>
            <div className="projects-heading">
              <button type="button" className="projects-project-name" onClick={() => selectProject(item.id)}>{item.name}</button>
              <div className="projects-planning-tags">
                {item.stage && <span className="projects-stage-badge" data-stage={item.stage}>{item.stage}</span>}
                <span className="projects-badge" data-status={item.status}>{item.status}</span>
                <span className="projects-badge" data-priority={item.priority}>{item.priority}</span>
                {dueBadge && <span className={`projects-due-chip is-${dueBadge.tone}`}>{dueBadge.label}</span>}
                {item.exception_status && item.exception_status !== 'within_tolerance' && (
                  <span className="projects-badge" data-exception={item.exception_status} data-level={item.exception_status === 'breached' ? 'confirmed' : 'risk'}>
                    {item.exception_status === 'breached' ? 'Breached' : 'Threatened'}
                  </span>
                )}
              </div>
            </div>

            <p className="projects-small">{owners.length ? owners.map(owner => `${personName(owner.person_id)} (${words(owner.role)})`).join(', ') : 'Board / PM needed'} · {item.priority} priority</p>
            <p className="projects-small">{item.due_date ? `Due ${item.due_date}` : 'No due date'} · Tolerance: ±{item.tolerance_days ?? 0}d · {findings.length} findings</p>
            <p className="projects-small">Milestone: {item.milestone || 'Not recorded'}</p>

            {/* Runn Progress Bar */}
            <div className="runn-card-progress" title={`${accDelivs}/${delivs.length} deliverables, ${tasksDone}/${projTasks.length} tasks`}>
              <div className="runn-card-track">
                <div className="runn-card-bar" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="runn-card-pct">{progressPct}%</span>
            </div>

            <p className="projects-small">{accDelivs} / {delivs.length} deliverables accepted · {tasksDone} / {projTasks.length} tasks done</p>

            {/* Runn Staff Avatars */}
            {projStaff.length > 0 && (
              <div className="runn-gantt-staff-avatars" style={{ margin: '6px 0' }} aria-label="Assigned team">
                {projStaff.slice(0, 5).map(st => {
                  const person = portfolio.people.find(p => p.id === st.person_id);
                  const initials = (person?.name || st.person_id).slice(0, 2).toUpperCase();
                  return (
                    <span key={st.id} className="runn-gantt-avatar" title={`${person?.name || st.person_id} (${st.role}) · ${st.allocation}%`}>
                      {initials} <small>{st.allocation}%</small>
                    </span>
                  );
                })}
                {projStaff.length > 5 && (
                  <span className="runn-gantt-avatar-more">+{projStaff.length - 5}</span>
                )}
              </div>
            )}

            <div className="runn-card-actions">
              <button type="button" className="feature-primary" onClick={() => selectProject(item.id)}>Open project</button>
              <button
                type="button"
                className="runn-export-chip"
                title="Open Highlight Report in Word"
                onClick={() =>
                  exportProjectToOffice(
                    'word',
                    item,
                    workItems.filter(w => w.project_id === item.id),
                    portfolio.assignments.filter(a => a.project_id === item.id),
                    (portfolio.stage_approvals || []).filter(sa => sa.project_id === item.id),
                    portfolio.dependencies.filter(d => d.source_project_id === item.id || d.target_project_id === item.id),
                    portfolio.people,
                    setNotice,
                    setError
                  )
                }
              >
                📄 Word
              </button>
              <button
                type="button"
                className="runn-export-chip"
                title="Open Tracker in Excel"
                onClick={() =>
                  exportProjectToOffice(
                    'excel',
                    item,
                    workItems.filter(w => w.project_id === item.id),
                    portfolio.assignments.filter(a => a.project_id === item.id),
                    (portfolio.stage_approvals || []).filter(sa => sa.project_id === item.id),
                    portfolio.dependencies.filter(d => d.source_project_id === item.id || d.target_project_id === item.id),
                    portfolio.people,
                    setNotice,
                    setError
                  )
                }
              >
                📊 Excel
              </button>
              <button
                type="button"
                className="runn-export-chip"
                title="Export Executive PDF"
                onClick={() =>
                  exportProjectToOffice(
                    'pdf',
                    item,
                    workItems.filter(w => w.project_id === item.id),
                    portfolio.assignments.filter(a => a.project_id === item.id),
                    (portfolio.stage_approvals || []).filter(sa => sa.project_id === item.id),
                    portfolio.dependencies.filter(d => d.source_project_id === item.id || d.target_project_id === item.id),
                    portfolio.people,
                    setNotice,
                    setError
                  )
                }
              >
                🖨️ PDF
              </button>
              {bobAction(item.name,{source:'project',projectId:item.id},'Give me a PRINCE2 project briefing: business case, board governance, stage status, deliverables, tolerances and dependencies.')}
            </div>
          </article>;
        })}</div>{!visibleProjects.length && <p className="projects-empty">{portfolio.projects.length ? 'No projects match this filter. Choose All projects or change your search.' : 'No projects yet. Create a project to start planning real work.'}</p>}</>}
        {project && (() => {
          const projectDeliverables = workItems.filter(item => item.project_id === project.id && item.kind === 'deliverable');
          const acceptedDeliverables = projectDeliverables.filter(item => item.status === 'accepted');
          const projectTasks = workItems.filter(item => item.project_id === project.id && ['task', 'milestone'].includes(item.kind));
          const doneTasks = projectTasks.filter(item => item.status === 'done');
          const blockedTasks = projectTasks.filter(item => item.status === 'blocked');
          const projectRaid = workItems.filter(item => item.project_id === project.id && ['risk', 'issue', 'decision'].includes(item.kind));
          const activeIssues = projectRaid.filter(item => item.kind === 'issue' && item.status !== 'resolved');
          const openRisks = projectRaid.filter(item => item.kind === 'risk' && item.status !== 'resolved');
          const projectLessons = workItems.filter(item => item.project_id === project.id && item.kind === 'lesson');
          const projectAssignments = portfolio.assignments.filter(item => item.project_id === project.id);
          const projectDependencies = portfolio.dependencies.filter(item => item.source_project_id === project.id || item.target_project_id === project.id);
          const stageApprovals = (portfolio.stage_approvals || []).filter(item => item.project_id === project.id);

          const projectSubTabs: { id: 'overview' | 'work' | 'governance' | 'raid' | 'lesson' | 'team' | 'settings' | 'all'; label: string; count?: number }[] = [
            { id: 'overview', label: '📊 Overview' },
            { id: 'work', label: '📦 Products & Tasks', count: projectDeliverables.length + projectTasks.length },
            { id: 'governance', label: '🏁 Governance & Stages', count: stageApprovals.length },
            { id: 'raid', label: '🛡️ RAID Register', count: projectRaid.length },
            { id: 'lesson', label: '💡 Lessons Log', count: projectLessons.length },
            { id: 'team', label: '👥 Board & Dependencies', count: projectAssignments.length + projectDependencies.length },
            { id: 'settings', label: '⚙️ Settings' },
            { id: 'all', label: '📑 All Modules' },
          ];

          const boardSection = (
            <section className="projects-module" aria-label="People & responsibilities">
              <div className="projects-heading">
                <div>
                  <h4>Project Board & Responsibilities (Principle 3)</h4>
                  <p className="projects-hint">PRINCE2 Defined Roles: Executive (Sponsor), Senior User, Senior Supplier, and Project Manager.</p>
                </div>
              </div>
              {projectAssignments.length > 0 ? (
                <div className="projects-assignment-grid">
                  {projectAssignments.map(item => {
                    const isBoard = ['executive','senior_user','senior_supplier','project_manager','team_manager','project_assurance'].includes(item.role);
                    return (
                      <article className="projects-assignment" key={item.id}>
                        <div className="projects-assignment-head">
                          <div>
                            <strong>{personName(item.person_id)}</strong>
                            <span className={isBoard ? 'projects-board-badge' : 'projects-badge'} data-role={item.role}>{words(item.role)}</span>
                          </div>
                          <span className="projects-assignment-alloc">{item.allocation}% allocation</span>
                        </div>
                        <p className="projects-assignment-resp">{item.responsibility}</p>
                        <small className="projects-assignment-backup">Backup: {item.backup_person_id ? personName(item.backup_person_id) : 'Not assigned'}</small>
                        <div className="projects-actions">
                          {bobAction(item.responsibility,{source:'responsibility',projectId:selected,personId:item.person_id,assignmentId:item.id},'Review this responsibility, backup coverage and handover needs.')}
                          {canManage && <Button kind="tertiary" size="sm" type="button" disabled={busy} onClick={() => void mutate('/assignments/'+encodeURIComponent(item.id),'DELETE')} aria-label={'Remove assignment for '+personName(item.person_id)}>Remove</Button>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="projects-empty">No responsibilities assigned. Start with an accountable Executive / Project Owner.</p>
              )}
              {!projectAssignments.some(item => ['executive','owner'].includes(item.role)) && (
                <p className="projects-notice projects-planning-handover">⚠ Governance notice: Project has no assigned PRINCE2 Executive (Sponsor). Assign an executive to ensure business accountability.</p>
              )}
              {portfolio.people.length === 0 ? (
                <p className="projects-empty">No eligible Keycloak users are available. People appear after signing in to this platform with Keycloak.</p>
              ) : canManage && (
                <details className="projects-disclosure">
                  <summary>Add responsibility / Project Board member</summary>
                  <form className="projects-form" onSubmit={addAssignment}>
                    <label>Find a Keycloak user<input type="search" value={directoryQuery} onChange={event => setDirectoryQuery(event.target.value)} placeholder="Search name, username or email" /></label>
                    <label>Person<select aria-label="Person" name="person_id" required><option value="">Select a Keycloak user</option><PeopleOptions people={portfolio.people.filter(person => person.status !== 'departed' && `${person.name} ${person.id} ${person.email}`.toLowerCase().includes(directoryQuery.toLowerCase()))} /></select></label>
                    <label>Responsibility<input name="responsibility" required maxLength={500} placeholder="Key responsibility or authority" /></label>
                    <div className="projects-form-grid">
                      <label>Role (PRINCE2 / Standard)
                        <select aria-label="Role" name="role">
                          <optgroup label="PRINCE2 Project Board">
                            <option value="executive">Executive (Project Sponsor)</option>
                            <option value="senior_user">Senior User (Requirements)</option>
                            <option value="senior_supplier">Senior Supplier (Delivery/Vendors)</option>
                            <option value="project_manager">Project Manager (Day-to-day)</option>
                            <option value="team_manager">Team Manager (Work Packages)</option>
                            <option value="project_assurance">Project Assurance (Governance)</option>
                          </optgroup>
                          <optgroup label="Standard Roles">
                            <option value="owner">Project Owner</option>
                            <option value="contributor">Contributor</option>
                            <option value="approver">Approver</option>
                          </optgroup>
                        </select>
                      </label>
                      <label>Allocation (%)<input name="allocation" type="number" min="0" max="100" defaultValue="0" required /></label>
                    </div>
                    <label>Backup person<select aria-label="Backup person" name="backup_person_id"><option value="">No backup</option><PeopleOptions people={portfolio.people.filter(person => person.status === 'active')} /></select></label>
                    <Button kind="primary" size="md" type="submit" disabled={busy}>Add role / responsibility</Button>
                  </form>
                </details>
              )}
            </section>
          );

          const dependenciesSection = (
            <section className="projects-module projects-module-dependencies" aria-label="Dependencies">
              <div className="projects-heading">
                <h4>Dependencies</h4>
              </div>
              <p className="projects-hint">An upstream project provides something this project needs. Changes can flow downstream through these links.</p>
              {projectDependencies.length > 0 ? (
                <div className="projects-dependency-grid">
                  {projectDependencies.map(item => (
                    <article className="projects-assignment" key={item.id}>
                      <div className="projects-dependency-head">
                        <span className="projects-badge" data-role="contributor">{item.source_project_id === selected ? 'Downstream Impact' : 'Upstream Requirement'}</span>
                        <strong>{projectName(item.source_project_id)} → {projectName(item.target_project_id)}</strong>
                      </div>
                      <p className="projects-dependency-desc">{item.description}</p>
                      <div className="projects-actions">
                        {bobAction(`dependency from ${projectName(item.source_project_id)} to ${projectName(item.target_project_id)}`,{source:'dependency',projectId:selected,dependencyId:item.id},'Explain this dependency and which follow-ups could reduce its delivery risk.')}
                        {canManage && <Button kind="tertiary" size="sm" type="button" disabled={busy} onClick={() => void mutate('/dependencies/'+encodeURIComponent(item.id),'DELETE')}>Remove dependency</Button>}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="projects-empty">No dependencies recorded. Link any project whose deliverable this work needs.</p>
              )}
              {canManage && portfolio.projects.length > 1 && (
                <details className="projects-disclosure">
                  <summary>Add upstream dependency</summary>
                  <form className="projects-form" onSubmit={addDependency}>
                    <label>This project depends on
                      <select aria-label="Upstream project" name="source_project_id" required>
                        <option value="">Select upstream project</option>
                        {portfolio.projects.filter(item => item.id !== selected).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label>Required deliverable or reason<input name="description" required maxLength={1000} /></label>
                    <Button kind="primary" size="md" type="submit" disabled={busy}>Add dependency</Button>
                  </form>
                </details>
              )}
            </section>
          );

          const prince2Cards = (
            <div className="projects-prince2-overview">
              <div className="projects-prince2-card">
                <div className="projects-prince2-card-head">
                  <strong>Business Case & Expected Benefits (Principle 1)</strong>
                  {bobAction(`${project.name} business case`,{source:'business_case',projectId:project.id},'Evaluate the project business case: justify return on investment, benefits, and strategic alignment according to PRINCE2 Continued Business Justification.','Review Business Case')}
                </div>
                {project.business_case ? <p>{project.business_case}</p> : <p className="projects-hint">No business case recorded. Record business reasons and expected benefits to satisfy PRINCE2 Continued Business Justification.</p>}
              </div>
              <div className="projects-prince2-card">
                <div className="projects-prince2-card-head">
                  <strong>Project Product Description (Principle 6)</strong>
                  {bobAction(`${project.name} product description`,{source:'product_description',projectId:project.id},'Draft or refine the Project Product Description: purpose, composition, quality criteria, and acceptance methods.','Review Product Criteria')}
                </div>
                {project.product_description ? <p>{project.product_description}</p> : <p className="projects-hint">No product description recorded. Define final deliverables and acceptance criteria to maintain PRINCE2 Product Focus.</p>}
              </div>
            </div>
          );

          const detailDueBadge = getDueBadge(project.due_date);

          return (
            <section className="projects-detail" aria-label="Project details">
              <div className="projects-heading">
                <div>
                  <div className="projects-detail-title-row">
                    <h3>{project.name}</h3>
                    {project.stage && <span className="projects-stage-badge" data-stage={project.stage}>Stage: {project.stage}</span>}
                    <span className="projects-badge" data-status={project.status}>{project.status}</span>
                    <span className="projects-badge" data-priority={project.priority}>{project.priority} priority</span>
                    {detailDueBadge && (
                      <span className={`projects-due-chip is-${detailDueBadge.tone}`}>
                        {detailDueBadge.label}
                      </span>
                    )}
                    {project.exception_status && project.exception_status !== 'within_tolerance' && (
                      <span className="projects-badge" data-exception={project.exception_status} data-level={project.exception_status === 'breached' ? 'confirmed' : 'risk'}>
                        {project.exception_status === 'breached' ? '⚠ Tolerance Breached' : '⚠ Tolerance Threatened'}
                      </span>
                    )}
                  </div>
                  <p className="projects-small">
                    {project.priority} priority · {project.due_date ? `Due ${project.due_date}` : 'No due date'} · Tolerance: ±{project.tolerance_days ?? 0} days · Tailoring: {project.tailoring_level || 'standard'}
                  </p>
                </div>
                <div className="projects-actions">
                  <Button kind="tertiary" size="md" type="button" title="Generate and open PRINCE2 Highlight Report in OnlyOffice Word editor" onClick={() => exportProjectToOffice('word', project, workItems, portfolio.assignments, stageApprovals, portfolio.dependencies, portfolio.people, setNotice, setError)}>
                    📄 Highlight Report (.docx)
                  </Button>
                  <Button kind="tertiary" size="md" type="button" title="Generate and open live RAID & Work Tracker in OnlyOffice Spreadsheet editor" onClick={() => exportProjectToOffice('excel', project, workItems, portfolio.assignments, stageApprovals, portfolio.dependencies, portfolio.people, setNotice, setError)}>
                    📊 Tracker (.csv / .xlsx)
                  </Button>
                  <Button kind="tertiary" size="md" type="button" title="Export branded print-ready Executive PDF Report" onClick={() => exportProjectToOffice('pdf', project, workItems, portfolio.assignments, stageApprovals, portfolio.dependencies, portfolio.people, setNotice, setError)}>
                    📑 Export PDF
                  </Button>
                  {bobAction(project.name,{source:'project',projectId:project.id},'Summarize this project and recommend the next three management actions.')}
                  {bobAction(`${project.name} highlight report`,{source:'project_update',projectId:project.id},'Draft a PRINCE2 Highlight Report for the Project Board: stage status, tolerances, product progress, risks, and next work packages.','Draft Highlight Report')}
                  {bobAction(`${project.name} stage gate review`,{source:'project_stage',projectId:project.id},`Review current management stage (${project.stage || 'initiation'}) progress against stage plan, tolerance, deliverables, and open risks before progressing to the next stage.`,'Stage Gate Review')}
                  {canManage && <Button kind="tertiary" size="md" type="button" onClick={() => setProjectSection('settings')}>⚙️ Project Settings</Button>}
                </div>
              </div>
              <p className="projects-detail-desc">{project.description || 'Add a description so everyone understands the project goal.'}</p>

              {/* Interactive PRINCE2 Stage Progression Strip */}
              <div className="projects-stage-tracker" role="region" aria-label="PRINCE2 Management Stage Progress">
                {STAGES.map((s, idx) => {
                  const currentStageId = project.stage || 'initiation';
                  const currentIdx = STAGES.findIndex(item => item.id === currentStageId);
                  const isCurrent = currentStageId === s.id;
                  const isCompleted = currentIdx > idx;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`projects-stage-node ${isCurrent ? 'is-current' : ''} ${isCompleted ? 'is-completed' : ''}`}
                      title={`${s.name} Stage (${s.subtitle}) - ${isCurrent ? 'Active Stage' : isCompleted ? 'Completed Stage' : 'Upcoming Stage'}. Click to view Governance & Stage Approvals.`}
                      onClick={() => setProjectSection('governance')}
                    >
                      <span className="projects-stage-node-icon" aria-hidden="true">
                        {isCompleted ? '✓' : s.icon}
                      </span>
                      <span className="projects-stage-node-text">
                        <strong className="projects-stage-node-name">{s.name}</strong>
                        <small className="projects-stage-node-sub">{isCurrent ? 'Active Stage' : isCompleted ? 'Completed' : s.subtitle}</small>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Carbon-aligned Project Subnav */}
              <nav className="projects-subnav" aria-label="Project sections">
                {projectSubTabs.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`projects-subnav-btn ${projectSection === item.id ? 'is-active' : ''}`}
                    aria-current={projectSection === item.id ? 'page' : undefined}
                    onClick={() => setProjectSection(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.count !== undefined && item.count > 0 && <span className="projects-subnav-badge">{item.count}</span>}
                  </button>
                ))}
              </nav>

              {/* Section: Overview (Dashboard) */}
              {projectSection === 'overview' && (
                <div className="projects-overview-tab">
                  {/* KPI Metric Summary Tiles Row */}
                  <div className="projects-kpi-grid" role="region" aria-label="Project KPI summary">
                    <div className="projects-kpi-card" onClick={() => setProjectSection('governance')} style={{ cursor: 'pointer' }} title="Click to view Stage Gate & Governance">
                      <div className="projects-kpi-head">
                        <span className="projects-kpi-label">Stage & Milestone</span>
                        <span className="projects-kpi-icon" aria-hidden="true">🏁</span>
                      </div>
                      <div className="projects-kpi-value">
                        {project.stage ? <span className="projects-stage-badge" data-stage={project.stage}>{project.stage} Stage</span> : <span className="projects-badge">Initiation</span>}
                      </div>
                      <span className="projects-kpi-subtext" title={project.milestone || 'No milestone set'}>
                        {project.milestone ? `Gate: ${project.milestone}` : 'No gate milestone recorded'}
                      </span>
                    </div>

                    <div className={`projects-kpi-card ${project.exception_status && project.exception_status !== 'within_tolerance' ? (project.exception_status === 'breached' ? 'is-breached-card' : 'is-threatened-card') : ''}`}>
                      <div className="projects-kpi-head">
                        <span className="projects-kpi-label">Tolerance Health</span>
                        <span className="projects-kpi-icon" aria-hidden="true">⏱️</span>
                      </div>
                      <div className="projects-kpi-value">
                        ±{project.tolerance_days ?? 0}d
                      </div>
                      <div className="projects-kpi-subtext">
                        {project.exception_status && project.exception_status !== 'within_tolerance' ? (
                          <span className="projects-badge" data-exception={project.exception_status} data-level={project.exception_status === 'breached' ? 'confirmed' : 'risk'}>
                            {project.exception_status === 'breached' ? '⚠ Breached' : '⚠ Threatened'}
                          </span>
                        ) : (
                          <span className="projects-badge" data-status="within_tolerance">✓ Within tolerance</span>
                        )}
                      </div>
                    </div>

                    <div className="projects-kpi-card" onClick={() => setProjectSection('work')} style={{ cursor: 'pointer' }} title="Click to view Product Deliverables">
                      <div className="projects-kpi-head">
                        <span className="projects-kpi-label">Products (Principle 6)</span>
                        <span className="projects-kpi-icon" aria-hidden="true">📦</span>
                      </div>
                      <div className="projects-kpi-value">
                        {acceptedDeliverables.length} / {projectDeliverables.length}
                      </div>
                      <span className="projects-kpi-subtext">
                        {projectDeliverables.length ? `${Math.round((acceptedDeliverables.length / projectDeliverables.length) * 100)}% accepted` : 'No deliverables recorded'}
                      </span>
                    </div>

                    <div className="projects-kpi-card" onClick={() => setProjectSection('work')} style={{ cursor: 'pointer' }} title="Click to view Work Package Tasks">
                      <div className="projects-kpi-head">
                        <span className="projects-kpi-label">Tasks Progress</span>
                        <span className="projects-kpi-icon" aria-hidden="true">📋</span>
                      </div>
                      <div className="projects-kpi-value">
                        {doneTasks.length} / {projectTasks.length}
                      </div>
                      <span className="projects-kpi-subtext">
                        {blockedTasks.length > 0 ? (
                          <span className="projects-badge" data-status="blocked">{blockedTasks.length} blocked</span>
                        ) : (
                          projectTasks.length ? `${Math.round((doneTasks.length / projectTasks.length) * 100)}% complete` : 'No tasks recorded'
                        )}
                      </span>
                    </div>

                    <div className="projects-kpi-card" onClick={() => setProjectSection('raid')} style={{ cursor: 'pointer' }} title="Click to view RAID Register">
                      <div className="projects-kpi-head">
                        <span className="projects-kpi-label">RAID Uncertainty</span>
                        <span className="projects-kpi-icon" aria-hidden="true">🛡️</span>
                      </div>
                      <div className="projects-kpi-value">
                        {activeIssues.length + openRisks.length}
                      </div>
                      <span className="projects-kpi-subtext">
                        {activeIssues.length} active {activeIssues.length === 1 ? 'issue' : 'issues'} · {openRisks.length} open {openRisks.length === 1 ? 'risk' : 'risks'}
                      </span>
                    </div>
                  </div>

                  {/* 2-Column Responsive Dashboard Layout */}
                  <div className="projects-detail-dashboard">
                    <div className="projects-detail-main">
                      {prince2Cards}

                      {/* Work Packages Preview Card */}
                      <section className="projects-card">
                        <div className="projects-heading">
                          <div>
                            <h4>Work Packages & Priority Tasks</h4>
                            <p className="projects-hint">Immediate operational tasks and product deliverables.</p>
                          </div>
                          <div className="projects-actions">
                            <Button kind="tertiary" size="md" type="button" onClick={() => setProjectSection('work')}>
                              View all ({projectDeliverables.length + projectTasks.length}) →
                            </Button>
                          </div>
                        </div>
                        {projectDeliverables.length === 0 && projectTasks.length === 0 ? (
                          <p className="projects-empty">No deliverables or tasks recorded yet. Switch to Products & Tasks to add work packages.</p>
                        ) : (
                          <div className="projects-work-list">
                            {[...projectDeliverables, ...projectTasks].slice(0, 4).map(item => workRow(item))}
                          </div>
                        )}
                      </section>

                      {/* Stage Approvals Preview Card */}
                      <section className="projects-card">
                        <div className="projects-heading">
                          <div>
                            <h4>Stage Approvals & Stage Gate History</h4>
                            <p className="projects-hint">PRINCE2 Manage by Stages: stage gate reviews and recorded approver decisions.</p>
                          </div>
                          <div className="projects-actions">
                            <Button kind="tertiary" size="md" type="button" onClick={() => setProjectSection('governance')}>
                              Governance & Stages ({stageApprovals.length}) →
                            </Button>
                          </div>
                        </div>
                        {stageApprovals.length > 0 ? (
                          <div className="projects-approval-preview-list">
                            {stageApprovals.slice(-2).map(record => {
                              const isApproved = record.decision === 'approved';
                              return (
                                <div key={record.id} className={`pm-approval-card ${isApproved ? 'is-approved' : 'is-rejected'}`} style={{ margin: '8px 0' }}>
                                  <div className="pm-approval-card-top">
                                    <div className="pm-approval-badges">
                                      <span className={`pm-approval-decision-tag ${isApproved ? 'is-approved' : 'is-rejected'}`}>
                                        {isApproved ? '✓ APPROVED' : '✕ REJECTED'}
                                      </span>
                                      <span className="pm-approval-stage-tag">
                                        {words(record.stage)} Stage Gate
                                      </span>
                                    </div>
                                    <span className="pm-revision-tag is-current">Rev #{record.project_revision}</span>
                                  </div>
                                  <div className="pm-approval-evidence" style={{ margin: '6px 0 0' }}>
                                    <p>{record.evidence}</p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="projects-empty">No stage approvals recorded yet. Use Governance & Stages to record stage boundary decisions.</p>
                        )}
                      </section>
                    </div>

                    <aside className="projects-detail-side">
                      {/* Project Board Summary Card */}
                      <section className="projects-card">
                        <div className="projects-heading">
                          <div>
                            <h4>Project Board</h4>
                            <p className="projects-hint">PRINCE2 defined roles</p>
                          </div>
                          <Button kind="ghost" size="sm" type="button" onClick={() => setProjectSection('team')}>
                            Manage →
                          </Button>
                        </div>
                        {projectAssignments.length === 0 ? (
                          <p className="projects-empty">No board members assigned yet.</p>
                        ) : (
                          <div className="projects-side-board-list">
                            {projectAssignments.slice(0, 5).map(item => {
                              const isBoard = ['executive','senior_user','senior_supplier','project_manager','team_manager','project_assurance'].includes(item.role);
                              return (
                                <div className="projects-side-board-item" key={item.id}>
                                  <div>
                                    <strong>{personName(item.person_id)}</strong>
                                    <span className={isBoard ? 'projects-board-badge' : 'projects-badge'} data-role={item.role}>
                                      {words(item.role)}
                                    </span>
                                  </div>
                                  <small>{item.responsibility}</small>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!projectAssignments.some(item => ['executive','owner'].includes(item.role)) && (
                          <p className="projects-notice projects-planning-handover">⚠ No PRINCE2 Executive assigned.</p>
                        )}
                      </section>

                      {/* Dependencies Summary Card */}
                      <section className="projects-card">
                        <div className="projects-heading">
                          <div>
                            <h4>Dependencies</h4>
                            <p className="projects-hint">Upstream & downstream</p>
                          </div>
                          <Button kind="ghost" size="sm" type="button" onClick={() => setProjectSection('team')}>
                            Manage →
                          </Button>
                        </div>
                        {projectDependencies.length === 0 ? (
                          <p className="projects-empty">No dependencies linked.</p>
                        ) : (
                          <div className="projects-side-dep-list">
                            {projectDependencies.slice(0, 4).map(item => (
                              <div className="projects-side-dep-item" key={item.id}>
                                <strong>{projectName(item.source_project_id)} → {projectName(item.target_project_id)}</strong>
                                <small>{item.description}</small>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>

                      {/* Office Suite & Live Stakeholder Deliverables */}
                      <section className="projects-card">
                        <div className="projects-heading">
                          <div>
                            <h4>Office Suite & Reports</h4>
                            <p className="projects-hint">One-click live document & spreadsheet generation</p>
                          </div>
                        </div>
                        <div className="projects-side-actions">
                          <Button kind="tertiary" size="md" type="button" onClick={() => exportProjectToOffice('word', project, workItems, portfolio.assignments, stageApprovals, portfolio.dependencies, portfolio.people, setNotice, setError)}>
                            📄 Open Highlight Report (.docx)
                          </Button>
                          <Button kind="tertiary" size="md" type="button" onClick={() => exportProjectToOffice('excel', project, workItems, portfolio.assignments, stageApprovals, portfolio.dependencies, portfolio.people, setNotice, setError)}>
                            📊 Open RAID Tracker (.csv / .xlsx)
                          </Button>
                          <Button kind="tertiary" size="md" type="button" onClick={() => exportProjectToOffice('pdf', project, workItems, portfolio.assignments, stageApprovals, portfolio.dependencies, portfolio.people, setNotice, setError)}>
                            📑 Export Executive PDF Report
                          </Button>
                          {bobAction(`${project.name} office report`,{source:'project_update',projectId:project.id},'Draft a detailed project status summary with executive commentary, product quality metrics, and tolerance recommendations ready to insert into my Office report.',brandText('Extend with Project Buddy'))}
                        </div>
                      </section>

                      {/* Governance Tools Card */}
                      <section className="projects-card">
                        <h4>PRINCE2 Governance Tools</h4>
                        <div className="projects-side-actions">
                          {bobAction(`${project.name} highlight report`,{source:'project_update',projectId:project.id},'Draft a PRINCE2 Highlight Report for the Project Board: stage status, tolerances, product progress, risks, and next work packages.','Draft Highlight Report')}
                          {bobAction(`${project.name} stage gate review`,{source:'project_stage',projectId:project.id},`Review current management stage (${project.stage || 'initiation'}) progress against stage plan, tolerance, deliverables, and open risks before progressing to the next stage.`,'Stage Gate Review')}
                          {canManage && <Button kind="tertiary" size="md" type="button" className="projects-impact-link" onClick={() => {setTab('impact');setChangeKind('project_change');setChangeTarget(selected);setChangeStatus(project.status);setChangeDate(project.due_date || '');invalidatePreview();}}>Preview project change</Button>}
                        </div>
                      </section>
                    </aside>
                  </div>
                </div>
              )}

              {/* Section: Products & Tasks */}
              {projectSection === 'work' && (
                <div className="projects-section-work">
                  {workModule('deliverable')}
                  {workModule('task')}
                </div>
              )}

              {/* Section: Governance & Stages */}
              {projectSection === 'governance' && (
                <div className="projects-section-governance">
                  {prince2Cards}
                  <StageApprovals key={`${project.id}-${project.revision}-${formVersion}`} project={project} people={portfolio.people} records={stageApprovals} canManage={canManage} busy={busy} onSave={async body => mutate('/projects/' + encodeURIComponent(project.id) + '/stage-approvals', 'POST', body)} />
                </div>
              )}

              {/* Section: RAID Register */}
              {projectSection === 'raid' && (
                <div className="projects-section-raid">
                  {workModule('raid')}
                </div>
              )}

              {/* Section: Lessons Log */}
              {projectSection === 'lesson' && (
                <div className="projects-section-lesson">
                  {workModule('lesson')}
                </div>
              )}

              {/* Section: Board & Dependencies */}
              {projectSection === 'team' && (
                <div className="projects-section-team">
                  {boardSection}
                  {dependenciesSection}
                  {canManage && <Button kind="tertiary" size="md" type="button" className="projects-impact-link" onClick={() => {setTab('impact');setChangeKind('project_change');setChangeTarget(selected);setChangeStatus(project.status);setChangeDate(project.due_date || '');invalidatePreview();}}>Preview a project change</Button>}
                </div>
              )}

              {/* Section: Project Settings */}
              {projectSection === 'settings' && (
                <div className="projects-section-settings">
                  <ProjectForm
                    key={`${project.id}-${project.revision}-${formVersion}`}
                    project={project}
                    busy={busy}
                    onSave={saveProject}
                    onCancel={() => setProjectSection('overview')}
                    onAsk={() => contextualAsk(project.name, { source: 'project_creation', projectId: project.id }, 'Help me improve this PRINCE2 project plan: check stage plan, business justification, product deliverables, tolerances and board roles.')}
                    onPreviewChange={() => {
                      setTab('impact');
                      setChangeKind('project_change');
                      setChangeTarget(project.id);
                      setChangeStatus(project.status);
                      setChangeDate(project.due_date || '');
                      invalidatePreview();
                    }}
                  />
                </div>
              )}

              {/* Section: All Modules */}
              {projectSection === 'all' && (
                <div className="projects-modules">
                  {prince2Cards}
                  <StageApprovals key={`${project.id}-${project.revision}-${formVersion}`} project={project} people={portfolio.people} records={stageApprovals} canManage={canManage} busy={busy} onSave={async body => mutate('/projects/' + encodeURIComponent(project.id) + '/stage-approvals', 'POST', body)} />
                  {workModule('deliverable')}
                  {workModule('task')}
                  {workModule('raid')}
                  {workModule('lesson')}
                  {boardSection}
                  {dependenciesSection}
                  {canManage && <Button kind="tertiary" size="md" type="button" className="projects-impact-link" onClick={() => {setTab('impact');setChangeKind('project_change');setChangeTarget(selected);setChangeStatus(project.status);setChangeDate(project.due_date || '');invalidatePreview();}}>Preview a project change</Button>}
                </div>
              )}
            </section>
          );
        })()}
      </>}
      {tab === 'timeline' && <>
        {canManage && creating && !project && <ProjectForm key={`new-${formVersion}`} project={null} busy={busy} onSave={saveProject} onCancel={() => {setCreating(false);setEditing(null);}} onAsk={() => contextualAsk('New project',{source:'project_creation'},'Help me plan a new project under PRINCE2: clarify business justification, product breakdown, management stages and board roles.')} />}
        {canManage && project && workCreating && <WorkItemForm key={`${workCreating}-${formVersion}`} item={null} kind={workCreating} people={portfolio.people} workItems={workItems.filter(item => item.project_id === selected)} busy={busy} onSave={saveWorkItem} onCancel={()=>{setWorkCreating(null);setWorkEditing(null);}} />}
        <ProjectGantt
          projects={portfolio.projects}
          workItems={workItems}
          dependencies={portfolio.dependencies}
          assignments={portfolio.assignments}
          people={portfolio.people}
          canManage={canManage}
          onOpenProject={id => selectProject(id)}
          onEditProject={id => selectProject(id, 'settings')}
          onAddProject={() => { setSelected(''); setEditing(null); setCreating(true); }}
          onAddTask={(projectId) => { setSelected(projectId); setWorkCreating('task'); setWorkEditing(null); }}
          onAskBob={row => contextualAsk(`${row.label} timeline`,{source:'timeline',projectId:row.projectId,...(row.workItemId ? {workItemId:row.workItemId} : {})},`Review the recorded schedule for ${row.label}. Explain its dates, missing schedule information, dependency flow, and connected risks without inventing durations or progress.`)}
        />
      </>}
      {tab === 'people' && <>
        <div className="projects-heading">
          <div>
            <h3>Capacity &amp; Staff Utilization</h3>
            <p className="projects-hint">Runn-style staff allocation heatmaps, capacity forecasting, and workload balance powered by Carbon design.</p>
          </div>
          <div className="projects-actions">
            <div className="runn-view-mode-toggle">
              <button
                type="button"
                className={`runn-mode-btn ${peopleViewMode === 'heatmap' ? 'is-active' : ''}`}
                onClick={() => setPeopleViewMode('heatmap')}
              >
                📊 Capacity Heatmap
              </button>
              <button
                type="button"
                className={`runn-mode-btn ${peopleViewMode === 'directory' ? 'is-active' : ''}`}
                onClick={() => setPeopleViewMode('directory')}
              >
                📇 People Directory
              </button>
            </div>
            {bobAction('people and capacity',{source:'people'},'Review ownership and backup gaps, departures and recorded allocation over 100%. Distinguish recorded commitments from actual workload.')}
          </div>
        </div>

        {peopleViewMode === 'heatmap' ? (
          <ProjectCapacityHeatmap
            people={portfolio.people}
            projects={portfolio.projects}
            assignments={portfolio.assignments}
            workItems={workItems}
            canManage={canManage}
            onSelectProject={id => selectProject(id)}
            onPreviewAvailability={personId => {
              setTab('impact');
              setChangeKind('person_departure');
              setChangeTarget(personId);
              setChangeStatus('leaving');
              setChangeDate(portfolio.people.find(p => p.id === personId)?.departure_date || '');
              invalidatePreview();
            }}
            onAskBob={(label, prompt) => contextualAsk(label, { source: 'people' }, prompt)}
          />
        ) : (
          <>
            <p className="projects-hint">Keycloak users who have signed in to the platform. Allocation is the sum of recorded commitments on open projects; it does not measure actual workload.</p>
            <label className="projects-search">People filter<select aria-label="People filter" value={peopleFilter} onChange={event => setPeopleFilter(event.target.value)}><option value="all">All people</option><option value="backup">Without active backup</option><option value="allocation">Recorded allocation over 100%</option></select></label>
            <label className="projects-search">Find a person<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
            {portfolio.people.length === 0 && <p className="projects-empty">No signed-in Keycloak users are available yet. Users must sign in before they can be assigned to a project.</p>}
            <div className="projects-people-grid">{portfolio.people.filter(person => `${person.name} ${person.id} ${person.email}`.toLowerCase().includes(query.toLowerCase()) && (peopleFilter === 'all' || peopleFilter === 'backup' && noBackup.some(assignment => assignment.person_id === person.id) || peopleFilter === 'allocation' && allocation(person.id) > 100)).map(person => {const assignments = portfolio.assignments.filter(item => item.person_id === person.id);return <article className="projects-card" key={person.id}><div className="projects-heading"><h3>{person.name}</h3><span className="projects-badge" data-status={person.status}>{person.status}</span></div><p>{person.email || person.id}</p><small>{person.id}</small><p><strong>{allocation(person.id)}%</strong> recorded allocation {allocation(person.id)>100 && <span className="projects-badge" data-level="risk">Review commitments</span>}</p><p>{assignments.length} responsibilities · {workItems.filter(item => item.owner_id === person.id && isOpen(item)).length} open work items</p>{assignments.map(item => <p key={item.id}><button type="button" className="projects-text-button" onClick={() => selectProject(item.project_id,'people')}>{projectName(item.project_id)}</button> — {item.responsibility}{!item.backup_person_id && <span className="projects-badge" data-tag-color="warm-gray">No backup</span>}</p>)}<div className="projects-actions">{bobAction(person.name,{source:'person',personId:person.id},'Review this person’s project involvement, responsibilities, backups and potential handover needs.')}{canManage && <button type="button" onClick={() => {setTab('impact');setChangeKind('person_departure');setChangeTarget(person.id);setChangeStatus('leaving');setChangeDate(person.departure_date || '');invalidatePreview();}}>Preview availability change</button>}{canManage && person.status !== 'active' && <button type="button" disabled={busy} onClick={() => void mutate('/people/'+encodeURIComponent(person.id),'PATCH',{status:'active',departure_date:null})}>Mark active</button>}</div></article>;})}</div>
          </>
        )}
      </>}
      {tab === 'impact' && <><div className="projects-heading"><h3>Change impact</h3>{bobAction('portfolio impact',{source:'impact'},'Explain current confirmed project impacts and potential downstream risks, then suggest follow-ups.')}</div><p className="projects-hint">{canManage ? 'Preview a change before applying it. The what-if analysis does not change saved records.' : 'Current impact for projects you participate in. An administrator can preview and apply changes.'}</p>{canManage && <form className="projects-card projects-form" onSubmit={analyze}><div className="projects-form-grid"><label>Change type<select aria-label="Change type" value={changeKind} onChange={event => {setChangeKind(event.target.value);setChangeTarget('');setChangeStatus(event.target.value === 'person_departure' ? 'leaving' : 'paused');invalidatePreview();}}><option value="person_departure">Person availability</option><option value="project_change">Project status or date</option></select></label><label>{changeKind === 'person_departure' ? 'Person' : 'Project'}<select aria-label={changeKind === 'person_departure' ? 'Person' : 'Project'} required value={changeTarget} onChange={event => {setChangeTarget(event.target.value);invalidatePreview();}}><option value="">Select {changeKind === 'person_departure' ? 'person' : 'project'}</option>{(changeKind === 'person_departure' ? portfolio.people : portfolio.projects).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Proposed status<select aria-label="Proposed status" value={changeStatus} onChange={event => {setChangeStatus(event.target.value);invalidatePreview();}}>{(changeKind === 'person_departure' ? ['leaving','departed'] : ['planned','active','paused','completed']).map(status => <option key={status}>{status}</option>)}</select></label><label>{changeKind === 'person_departure' ? 'Departure date (optional)' : 'New due date (optional)'}<input type="date" value={changeDate} onChange={event => {setChangeDate(event.target.value);invalidatePreview();}} /></label></div><button type="submit" className="feature-primary" disabled={busy || !changeTarget}>Preview impact</button></form>}{preview && <section className="projects-card" aria-label="What-if results"><div className="projects-heading"><h3>What-if preview</h3><span className="projects-badge">Unsaved scenario</span></div>{renderImpact(preview,'scenario')}<div className="projects-actions">{bobAction('this scenario',{source:'scenario',...(changeKind === 'project_change' ? {projectId:changeTarget} : {personId:changeTarget}),scenario:previewPayload || {}},'Review this unsaved scenario, explain its impact and propose a practical mitigation or handover plan.',brandText('Review scenario with Project Buddy'))}<button type="button" className="feature-primary" disabled={busy} onClick={() => void applyPreview()}>Apply this change</button></div></section>}<section className="projects-card"><h3>Current portfolio impact</h3>{renderImpact(portfolio.impact)}</section>{portfolio.recent_change_impacts?.map(change => <section className="projects-card" key={change.event_id}><div className="projects-heading"><h3>Recorded change: {projectName(change.project_id)}</h3>{bobAction(`recorded change to ${projectName(change.project_id)}`,{source:'historical_change',projectId:change.project_id},'Explain the saved change history for this project and what should be followed up today. Separate historical effects from current conditions.')}</div><p className="projects-hint">Saved {new Date(change.created_at).toLocaleString()}. This describes the change when saved; current relationships may differ.</p>{renderImpact(change.impact,'historical_change')}</section>)}</>}

      {tab === 'merged' && (
        <div className="projects-merged-container">
          <nav className="projects-merged-jump-bar" aria-label="Jump to section">
            <span className="projects-merged-jump-label">Quick Jump:</span>
            <button type="button" className="projects-merged-jump-link" onClick={() => scrollToSection('merged-timeline')}>📅 Timeline Planner</button>
            <button type="button" className="projects-merged-jump-link" onClick={() => scrollToSection('merged-portfolio')}>📋 Projects Register</button>
            <button type="button" className="projects-merged-jump-link" onClick={() => scrollToSection('merged-people')}>👥 Team Capacity</button>
            <button type="button" className="projects-merged-jump-link" onClick={() => scrollToSection('merged-overview')}>📊 Executive Briefing</button>
            <button type="button" className="projects-merged-jump-link" onClick={() => scrollToSection('merged-impact')}>⚡ Change Impact</button>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
              <button type="button" className="projects-merged-jump-link" onClick={() => setCollapsedSections({})}>Expand All</button>
              <button type="button" className="projects-merged-jump-link" onClick={() => setCollapsedSections({ overview: true, timeline: true, portfolio: true, people: true, impact: true })}>Collapse All</button>
            </div>
          </nav>

          {/* Section 1: Timeline Planner */}
          <section id="merged-timeline" className="projects-merged-section">
            <div className="projects-merged-section-header" onClick={() => toggleMergedSection('timeline')}>
              <h3><span>📅</span> Timeline Planner &amp; Gantt Schedule</h3>
              <div className="projects-merged-section-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); setTab('timeline'); }}>Focus Tab ↗</button>
                <span>{collapsedSections['timeline'] ? '▼' : '▲'}</span>
              </div>
            </div>
            {!collapsedSections['timeline'] && (
              <div className="projects-merged-section-body">
                <ProjectGantt
                  projects={portfolio.projects}
                  workItems={workItems}
                  dependencies={portfolio.dependencies}
                  assignments={portfolio.assignments}
                  people={portfolio.people}
                  canManage={canManage}
                  onOpenProject={id => selectProject(id)}
                  onEditProject={id => selectProject(id, 'settings')}
                  onAddProject={() => { setSelected(''); setEditing(null); setCreating(true); }}
                  onAddTask={(projectId) => { setSelected(projectId); setWorkCreating('task'); setWorkEditing(null); }}
                  onAskBob={row => contextualAsk(`${row.label} timeline`,{source:'timeline',projectId:row.projectId,...(row.workItemId ? {workItemId:row.workItemId} : {})},`Review the recorded schedule for ${row.label}. Explain its dates, missing schedule information, dependency flow, and connected risks without inventing durations or progress.`)}
                />
              </div>
            )}
          </section>

          {/* Section 2: Projects Register */}
          <section id="merged-portfolio" className="projects-merged-section">
            <div className="projects-merged-section-header" onClick={() => toggleMergedSection('portfolio')}>
              <h3><span>📋</span> Projects Register &amp; Active Work Packages</h3>
              <div className="projects-merged-section-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); setTab('portfolio'); }}>Focus Tab ↗</button>
                <span>{collapsedSections['portfolio'] ? '▼' : '▲'}</span>
              </div>
            </div>
            {!collapsedSections['portfolio'] && (
              <div className="projects-merged-section-body">
                <div className="projects-heading">
                  <div>
                    <h4>Portfolio Projects ({portfolio.projects.length})</h4>
                    <p className="projects-hint">Manage active and planned projects, stage progress, and work breakdown packages.</p>
                  </div>
                  <div className="projects-actions">
                    {canManage && <button type="button" className="feature-primary" onClick={() => { setTab('portfolio'); setEditing(null); setCreating(true); }}>New project</button>}
                    <button type="button" disabled={busy} onClick={() => { setBusy(true); load().catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}>Refresh</button>
                  </div>
                </div>
                <div className="projects-portfolio-filters" style={{ margin: '16px 0' }}>
                  <label>Status
                    <select aria-label="Status filter" value={projectFilter} onChange={e => setProjectFilter(e.target.value)}>
                      <option value="all">All live projects</option>
                      <option value="attention">Needs review</option>
                      <option value="planned">Planned</option>
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="completed">Completed</option>
                    </select>
                  </label>
                  <label>Search
                    <input type="search" placeholder="Filter projects..." value={query} onChange={e => setQuery(e.target.value)} />
                  </label>
                </div>
                <div className="projects-portfolio-grid">
                  {portfolio.projects.filter(p => (projectFilter === 'all' || p.status === projectFilter) && p.name.toLowerCase().includes(query.toLowerCase())).map(p => (
                    <article className="projects-card" key={p.id}>
                      <div className="projects-heading">
                        <h3><button type="button" className="projects-text-button" onClick={() => { selectProject(p.id); setTab('portfolio'); }}>{p.name}</button></h3>
                        <span className="projects-badge" data-status={p.status}>{p.status}</span>
                      </div>
                      <p>{p.description || 'No description provided.'}</p>
                      <p><span className="projects-radar-dot" data-stage={p.stage || 'initiation'} /> Stage: <strong>{p.stage || 'initiation'}</strong> · Milestone: {p.milestone || 'None'}</p>
                      <div className="projects-actions">
                        <button type="button" onClick={() => { selectProject(p.id); setTab('portfolio'); }}>Open Project Details →</button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Section 3: Capacity & Staffing */}
          <section id="merged-people" className="projects-merged-section">
            <div className="projects-merged-section-header" onClick={() => toggleMergedSection('people')}>
              <h3><span>👥</span> Team Capacity &amp; Resource Heatmap</h3>
              <div className="projects-merged-section-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); setTab('people'); }}>Focus Tab ↗</button>
                <span>{collapsedSections['people'] ? '▼' : '▲'}</span>
              </div>
            </div>
            {!collapsedSections['people'] && (
              <div className="projects-merged-section-body">
                <ProjectCapacityHeatmap
                  people={portfolio.people}
                  projects={portfolio.projects}
                  assignments={portfolio.assignments}
                  workItems={workItems}
                  canManage={canManage}
                  onSelectProject={id => selectProject(id)}
                  onPreviewAvailability={personId => {
                    setTab('impact');
                    setChangeKind('person_departure');
                    setChangeTarget(personId);
                    setChangeStatus('leaving');
                    setChangeDate(portfolio.people.find(p => p.id === personId)?.departure_date || '');
                    invalidatePreview();
                  }}
                  onAskBob={(label, prompt) => contextualAsk(label, { source: 'people' }, prompt)}
                />
              </div>
            )}
          </section>

          {/* Section 4: Executive Briefing & Health Radar */}
          <section id="merged-overview" className="projects-merged-section">
            <div className="projects-merged-section-header" onClick={() => toggleMergedSection('overview')}>
              <h3><span>📊</span> Executive Briefing &amp; Governance Radar</h3>
              <div className="projects-merged-section-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); setTab('overview'); }}>Focus Tab ↗</button>
                <span>{collapsedSections['overview'] ? '▼' : '▲'}</span>
              </div>
            </div>
            {!collapsedSections['overview'] && (
              <div className="projects-merged-section-body">
                <div className="projects-governance-radar" role="region" aria-label="Portfolio Governance Summary">
                  <div className="projects-radar-col">
                    <span className="projects-radar-label">Management Stages (PRINCE2 Principle 4)</span>
                    <div className="projects-radar-stages">
                      {STAGES.map(s => {
                        const count = liveProjects.filter(p => (p.stage || 'initiation') === s.id).length;
                        return (
                          <div key={s.id} className="projects-radar-stage-chip">
                            <span className="projects-radar-dot" data-stage={s.id} />
                            <strong>{s.name}</strong> <small>({count})</small>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="projects-radar-col">
                    <span className="projects-radar-label">Tolerance Health (PRINCE2 Principle 5)</span>
                    <div className="projects-radar-tolerance">
                      <span className="projects-tolerance-badge is-ok">✓ Within Tolerance: {liveProjects.filter(p => !p.exception_status || p.exception_status === 'within_tolerance').length}</span>
                      <span className="projects-tolerance-badge is-breached">⚠️ Exception / Threatened: {atRiskCount}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Section 5: Change Impact & Scenarios */}
          <section id="merged-impact" className="projects-merged-section">
            <div className="projects-merged-section-header" onClick={() => toggleMergedSection('impact')}>
              <h3><span>⚡</span> Change Impact &amp; Scenario Forecasting</h3>
              <div className="projects-merged-section-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); setTab('impact'); }}>Focus Tab ↗</button>
                <span>{collapsedSections['impact'] ? '▼' : '▲'}</span>
              </div>
            </div>
            {!collapsedSections['impact'] && (
              <div className="projects-merged-section-body">
                <div className="projects-card">
                  <h4>Current Portfolio Impact Findings</h4>
                  <p className="projects-hint">Automated dependency analysis, timeline clashes, and resource allocation conflicts.</p>
                  {renderImpact(portfolio.impact)}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div></div>}

    {/* Bottom-right Floating Chat Widget Launcher when collapsed */}
    {!assistant && (
      <button
        type="button"
        className="projects-widget-launcher-round"
        onClick={() => setAssistant(true)}
        aria-label={brandText("Open Project Buddy")}
        title={focusLabel && focusLabel !== 'Portfolio overview' ? brandText(`Open Project Buddy (${focusLabel})`) : brandText('Open Project Buddy')}
      >
        <span className="projects-widget-launcher-icon" aria-hidden="true"><TaskTools size={28} /></span>
        {focusLabel && focusLabel !== 'Portfolio overview' && (
          <span className="projects-widget-launcher-indicator" title={focusLabel} aria-hidden="true" />
        )}
      </button>
    )}

    {/* Bottom-right Floating Chat Widget Panel when open */}
    {assistant && (
      <aside
        className={`projects-widget-panel ${widgetExpanded ? 'is-expanded' : ''}`}
        aria-label={brandText("Project Buddy")}
      >
        <header className="projects-widget-header">
          <div className="projects-widget-brand">
            <span className="projects-widget-avatar" aria-hidden="true"><TaskTools size={24} /></span>
            <div className="projects-widget-title-wrap">
              <h4>Project {brandText("Buddy")}</h4>
              <span className="projects-widget-focus-tag" title={focusLabel}>{focusLabel}</span>
            </div>
          </div>
          <div className="projects-widget-controls">
            <button
              type="button"
              className="projects-widget-btn"
              onClick={() => setWidgetExpanded(prev => !prev)}
              title={widgetExpanded ? 'Compact width' : 'Expand width'}
              aria-label={widgetExpanded ? 'Compact width' : 'Expand width'}
            >
              {widgetExpanded ? '⤡' : '⤢'}
            </button>
            <button
              type="button"
              className="projects-widget-btn"
              onClick={() => setAssistant(false)}
              title="Minimize assistant"
              aria-label="Minimize assistant"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="projects-widget-subhead">
          <span>PRINCE2 Governance Assistant</span>
          <small>Authorized portfolio</small>
        </div>

        <div className="projects-widget-prompts" aria-label="Quick PM governance prompts">
          {['Draft Highlight Report', 'Stage Gate check', 'Exception Report', 'Lessons Log & Retrospective', 'What should I follow up today?', 'Backup gaps'].map(prompt => (
            <button
              type="button"
              className="projects-suggestion projects-widget-suggestion"
              disabled={bobBusy || bobRequesting}
              key={prompt}
              onClick={() => contextualAsk(prompt, { source: 'overview' }, prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="projects-bob-messages projects-widget-messages" aria-label="Project conversation" role="log" onScroll={event => {
          const scroller = event.currentTarget;
          followAssistantRef.current = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 48;
        }}>
          {bobMessages.length === 0 && (
            <div className="projects-widget-empty">
              <span className="projects-widget-empty-icon" aria-hidden="true">💡</span>
              <p>Ask Project {brandText("Buddy")} for a project briefing, stage gate check, exception analysis, or dependency follow-ups.</p>
            </div>
          )}
          {bobMessages.map(message => {
            const isUser = message.role === 'user';
            const clarification = !isUser ? parseClarifications(message.content, Boolean(message.isStreaming)) : { text: message.content, questions: [] };
            const nextQuestions = !isUser ? parseNextQuestions(clarification.text, Boolean(message.isStreaming)) : { text: message.content, options: [] };
            const contentToDisplay = isUser ? cleanUserPrompt(message.content, message.displayPrompt) : nextQuestions.text;

            return (
              <article className="projects-bob-message" data-role={message.role} key={message.id}>
                <header className="projects-bob-message-header">
                  <strong>{isUser ? 'You' : brandText('Project Buddy')}</strong>
                  {!isUser && <span className="projects-badge" data-tag-color="purple">PRINCE2 PM</span>}
                </header>
                {!isUser && <AppCollaborationActivity activities={collaborationFromWorkLog(message.workLog)} />}
                <MarkdownView
                  compactDiagrams
                  content={contentToDisplay}
                  isStreaming={message.isStreaming}
                  messageId={message.id}
                  readOnly
                />
                {!isUser && !message.isStreaming && nextQuestions.options.length > 0 && (
                  <div className="projects-followup-container">
                    <span className="projects-followup-title">Suggested next steps:</span>
                    <div className="projects-followup-buttons">
                      {nextQuestions.options.map((opt, optIdx) => (
                        <button
                          key={optIdx}
                          type="button"
                          className="projects-suggestion projects-followup-pill"
                          disabled={bobBusy || bobRequesting}
                          onClick={() => askBob(opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!isUser && !message.isStreaming && clarification.questions.length > 0 && (
                  <div className="projects-clarification-card">
                    {clarification.questions.map((q, qIdx) => (
                      <div key={qIdx} className="projects-clarification-item">
                        <div className="projects-clarification-q"><strong>{q.question}</strong></div>
                        {q.context && <p className="projects-hint">{q.context}</p>}
                        <div className="projects-followup-buttons">
                          {q.options.map((opt, oIdx) => (
                            <button
                              key={oIdx}
                              type="button"
                              className="projects-suggestion projects-followup-pill"
                              disabled={bobBusy || bobRequesting}
                              onClick={() => askBob(opt)}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {(bobError || bobRequestError) && <p className="projects-error projects-widget-error" role="alert">{bobRequestError || bobError}</p>}
        {(bobBusy || bobRequesting) && (
          <div className="projects-widget-status" role="status">
            <span className="projects-widget-spinner" aria-hidden="true" />
            <span>{bobUnavailableReason || brandText('Project Buddy is thinking…')}</span>
            {onStopBob && <button type="button" className="projects-widget-stop-btn" onClick={onStopBob}>Stop</button>}
          </div>
        )}

        <form
          className="projects-form projects-widget-form"
          onSubmit={event => {
            event.preventDefault();
            if (question.trim()) void askBob(question.trim());
          }}
        >
          <div className="projects-widget-input-row">
            <textarea
              aria-label="Your question"
              ref={questionRef}
              required
              maxLength={4000}
              rows={2}
              value={question}
              placeholder={brandText("Ask Project Buddy about projects, stages, or work items…")}
              onChange={event => setQuestion(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (question.trim() && !bobBusy && !bobRequesting) {
                    void askBob(question.trim());
                  }
                }
              }}
            />
            <button
              type="submit"
              className="feature-primary projects-widget-send-btn"
              disabled={bobBusy || bobRequesting || !question.trim()}
              title={brandText("Send to Project Buddy (Enter)")}
              aria-label={brandText("Send to Project Buddy")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            </button>
          </div>
          <div className="projects-widget-form-footer">
            <small>Press Enter to send, Shift+Enter for newline</small>
          </div>
        </form>
      </aside>
    )}
  </section>;
}
