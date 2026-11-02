import { brandText } from '../lib/brand';
import { navigateOffice } from '../lib/officeUrl';
import { words } from './ProjectPlanningModel';
import { csvCell } from '../lib/spreadsheetExport';
import DOMPurify from 'dompurify';
import type { Project, WorkItem, Person, StageApproval } from './ProjectsWorkspace';

type Assignment = { id: string; project_id: string; person_id: string; responsibility: string; role: string; backup_person_id: string | null; allocation: number };
type Dependency = { id: string; source_project_id: string; target_project_id: string; description: string };

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function escapeCsvCell(value: unknown): string {
  return csvCell(value);
}

export function generateProjectCsv(
  project: Project,
  workItems: WorkItem[],
  assignments: Assignment[],
  dependencies: Dependency[],
  people: Person[]
): string {
  const personName = (id: string | null) => people.find(p => p.id === id)?.name || id || 'Unassigned';
  const lines: string[] = [];

  // 1. Metadata
  lines.push('--- PROJECT METADATA & TOLERANCE HEALTH ---');
  lines.push(['Project Name', 'Stage', 'Status', 'Priority', 'Due Date', 'Tolerance (Days)', 'Exception Status', 'Milestone', 'Tailoring'].map(escapeCsvCell).join(','));
  lines.push([
    project.name,
    project.stage || 'initiation',
    project.status,
    project.priority,
    project.due_date || 'None',
    `±${project.tolerance_days ?? 0}`,
    project.exception_status || 'within_tolerance',
    project.milestone || 'None',
    project.tailoring_level || 'standard'
  ].map(escapeCsvCell).join(','));
  lines.push('');

  // 2. Deliverables / Products
  const deliverables = workItems.filter(w => w.project_id === project.id && w.kind === 'deliverable');
  lines.push('--- PRODUCTS & DELIVERABLES (PRINCE2 PRODUCT FOCUS) ---');
  lines.push(['ID', 'Title', 'Status', 'Priority', 'Reviewer', 'Due Date', 'Acceptance Criteria', 'Acceptance Evidence'].map(escapeCsvCell).join(','));
  if (deliverables.length) {
    deliverables.forEach(item => {
      lines.push([
        item.id,
        item.title,
        item.status,
        item.priority,
        personName(item.reviewer_id || null),
        item.due_date || 'None',
        item.acceptance_criteria || '',
        item.acceptance_evidence || ''
      ].map(escapeCsvCell).join(','));
    });
  } else {
    lines.push(['No product deliverables recorded', '', '', '', '', '', '', ''].map(escapeCsvCell).join(','));
  }
  lines.push('');

  // 3. Operational Tasks
  const tasks = workItems.filter(w => w.project_id === project.id && ['task', 'milestone'].includes(w.kind));
  lines.push('--- WORK BREAKDOWN & OPERATIONAL TASKS ---');
  lines.push(['ID', 'Kind', 'Title', 'Owner', 'Due Date', 'Status', 'Priority', 'Description'].map(escapeCsvCell).join(','));
  if (tasks.length) {
    tasks.forEach(item => {
      lines.push([
        item.id,
        item.kind,
        item.title,
        personName(item.owner_id),
        item.due_date || 'None',
        item.status,
        item.priority,
        item.description || ''
      ].map(escapeCsvCell).join(','));
    });
  } else {
    lines.push(['No tasks recorded', '', '', '', '', '', '', ''].map(escapeCsvCell).join(','));
  }
  lines.push('');

  // 4. RAID Register
  const raid = workItems.filter(w => w.project_id === project.id && ['risk', 'issue', 'decision'].includes(w.kind));
  lines.push('--- RAID REGISTER (RISKS, ISSUES & DECISIONS) ---');
  lines.push(['ID', 'Category', 'Title', 'Owner', 'Status', 'Priority', 'Mitigation / Resolution / Rationale'].map(escapeCsvCell).join(','));
  if (raid.length) {
    raid.forEach(item => {
      lines.push([
        item.id,
        item.kind.toUpperCase(),
        item.title,
        personName(item.owner_id),
        item.status,
        item.priority,
        item.resolution || item.description || ''
      ].map(escapeCsvCell).join(','));
    });
  } else {
    lines.push(['No RAID items recorded', '', '', '', '', '', ''].map(escapeCsvCell).join(','));
  }
  lines.push('');

  // 5. Board & Responsibilities
  const projectAssignments = assignments.filter(a => a.project_id === project.id);
  lines.push('--- PROJECT BOARD & RESPONSIBILITIES ---');
  lines.push(['Person', 'Role', 'Allocation (%)', 'Responsibility', 'Backup'].map(escapeCsvCell).join(','));
  if (projectAssignments.length) {
    projectAssignments.forEach(item => {
      lines.push([
        personName(item.person_id),
        words(item.role),
        `${item.allocation}%`,
        item.responsibility,
        item.backup_person_id ? personName(item.backup_person_id) : 'None'
      ].map(escapeCsvCell).join(','));
    });
  } else {
    lines.push(['No responsibilities recorded', '', '', '', ''].map(escapeCsvCell).join(','));
  }

  // 6. Dependencies
  const projectDeps = dependencies.filter(d => d.source_project_id === project.id || d.target_project_id === project.id);
  lines.push('');
  lines.push('--- CONNECTED DEPENDENCIES ---');
  lines.push(['Type', 'Source Project ID', 'Target Project ID', 'Description'].map(escapeCsvCell).join(','));
  if (projectDeps.length) {
    projectDeps.forEach(d => {
      lines.push([
        d.source_project_id === project.id ? 'Downstream Impact' : 'Upstream Requirement',
        d.source_project_id,
        d.target_project_id,
        d.description
      ].map(escapeCsvCell).join(','));
    });
  } else {
    lines.push(['No dependencies recorded', '', '', ''].map(escapeCsvCell).join(','));
  }

  return lines.join('\r\n');
}

const REPORT_STYLES = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #161616; line-height: 1.6; max-width: 900px; margin: 40px auto; padding: 0 20px; }
    header { border-bottom: 3px solid #0f62fe; padding-bottom: 16px; margin-bottom: 24px; }
    h1 { color: #0f62fe; margin: 0 0 8px 0; font-size: 26px; }
    h2 { color: #161616; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-top: 32px; font-size: 18px; }
    .kpi-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .kpi-box { background: #f4f4f4; border: 1px solid #e0e0e0; border-radius: 4px; padding: 12px 16px; flex: 1; min-width: 140px; }
    .kpi-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #525252; margin-bottom: 4px; }
    .kpi-value { font-size: 18px; font-weight: bold; color: #161616; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border: 1px solid #e0e0e0; padding: 8px 12px; text-align: left; }
    th { background: #f4f4f4; font-weight: 600; color: #161616; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge-ok { background: #defbe6; color: #0e6027; }
    .badge-warn { background: #fdf5d7; color: #684e00; }
    .badge-alert { background: #ffd7d9; color: #750e13; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #6f6f6f; text-align: center; }
`;
const PRINT_STYLES = `
    @media print {
      .no-print { display: none !important; }
      body { margin: 0; max-width: 100%; padding: 0; }
      @page { size: A4; margin: 15mm; }
      h2 { page-break-after: avoid; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
    }
    .print-bar {
      position: sticky; top: 0; background: #ffffff; border-bottom: 2px solid #0f62fe;
      padding: 12px 20px; margin: -40px -20px 24px -20px; display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 2px 6px rgba(0,0,0,0.08); z-index: 100;
    }
    .print-btn {
      background: #0f62fe; color: #ffffff; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 600; cursor: pointer;
    }
    .print-btn:hover { background: #0353e9; }
`;

export function generateProjectDocHtml(
  project: Project,
  workItems: WorkItem[],
  assignments: Assignment[],
  approvals: StageApproval[],
  people: Person[]
): string {
  const personName = (id: string | null) => people.find(p => p.id === id)?.name || id || 'Unassigned';
  const deliverables = workItems.filter(w => w.project_id === project.id && w.kind === 'deliverable');
  const tasks = workItems.filter(w => w.project_id === project.id && ['task', 'milestone'].includes(w.kind));
  const raid = workItems.filter(w => w.project_id === project.id && ['risk', 'issue', 'decision'].includes(w.kind));
  const projectAssignments = assignments.filter(a => a.project_id === project.id);
  const projectApprovals = approvals.filter(a => a.project_id === project.id);

  return brandText(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(project.name)} - PRINCE2 Highlight Report</title>
  <style>${REPORT_STYLES}</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(project.name)}</h1>
    <p><strong>PRINCE2 Highlight Report</strong> · Stage: ${escapeHtml(words(project.stage || 'initiation'))} · Generated: ${new Date().toLocaleDateString()}</p>
  </header>

  <div class="kpi-row">
    <div class="kpi-box">
      <div class="kpi-label">Management Stage</div>
      <div class="kpi-value">${escapeHtml(words(project.stage || 'initiation'))}</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Tolerance Status</div>
      <div class="kpi-value">${project.exception_status === 'breached' ? '⚠ Breached' : project.exception_status === 'threatened' ? '⚠ Threatened' : '✓ Within Tolerance'}</div>
      <small>±${escapeHtml(project.tolerance_days ?? 0)} days threshold</small>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Deliverables Accepted</div>
      <div class="kpi-value">${deliverables.filter(d => d.status === 'accepted').length} / ${deliverables.length}</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Tasks Done</div>
      <div class="kpi-value">${tasks.filter(t => t.status === 'done').length} / ${tasks.length}</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Active RAID Items</div>
      <div class="kpi-value">${raid.filter(r => r.status !== 'resolved').length}</div>
    </div>
  </div>

  <h2>1. Business Justification & Executive Summary (Principle 1)</h2>
  <p>${escapeHtml(project.business_case || project.description || 'No business case recorded. Maintain continued business justification according to PRINCE2 standards.')}</p>

  <h2>2. Project Product Description & Acceptance Methods (Principle 6)</h2>
  <p>${escapeHtml(project.product_description || 'No project product description recorded. Define quality criteria and acceptance methods.')}</p>

  <h2>3. Work Package & Product Deliverables Status</h2>
  ${deliverables.length ? `
  <table>
    <thead><tr><th>Product Deliverable</th><th>Status</th><th>Reviewer</th><th>Due Date</th><th>Acceptance Criteria</th></tr></thead>
    <tbody>
      ${deliverables.map(d => `<tr>
        <td><strong>${escapeHtml(d.title)}</strong></td>
        <td><span class="badge ${d.status === 'accepted' ? 'badge-ok' : d.status === 'quality_review' ? 'badge-warn' : ''}">${escapeHtml(words(d.status))}</span></td>
        <td>${escapeHtml(personName(d.reviewer_id || null))}</td>
        <td>${escapeHtml(d.due_date || 'Unscheduled')}</td>
        <td>${escapeHtml(d.acceptance_criteria || 'Not specified')}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<p>No product deliverables recorded for this period.</p>'}

  <h2>4. Operational Tasks & Milestones</h2>
  ${tasks.length ? `
  <table>
    <thead><tr><th>Task</th><th>Owner</th><th>Due Date</th><th>Status</th><th>Priority</th></tr></thead>
    <tbody>
      ${tasks.map(t => `<tr>
        <td>${escapeHtml(t.title)}</td>
        <td>${escapeHtml(personName(t.owner_id))}</td>
        <td>${escapeHtml(t.due_date || 'None')}</td>
        <td><span class="badge ${t.status === 'done' ? 'badge-ok' : t.status === 'blocked' ? 'badge-alert' : ''}">${escapeHtml(words(t.status))}</span></td>
        <td>${escapeHtml(words(t.priority))}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<p>No operational tasks recorded.</p>'}

  <h2>5. Risks, Issues & Decisions Log (RAID Register)</h2>
  ${raid.length ? `
  <table>
    <thead><tr><th>Category</th><th>Item Title</th><th>Owner</th><th>Status</th><th>Resolution / Mitigation Plan</th></tr></thead>
    <tbody>
      ${raid.map(r => `<tr>
        <td><strong>${escapeHtml(r.kind.toUpperCase())}</strong></td>
        <td>${escapeHtml(r.title)}</td>
        <td>${escapeHtml(personName(r.owner_id))}</td>
        <td><span class="badge ${r.status === 'resolved' ? 'badge-ok' : r.kind === 'issue' ? 'badge-alert' : 'badge-warn'}">${escapeHtml(words(r.status))}</span></td>
        <td>${escapeHtml(r.resolution || r.description || 'Pending mitigation plan')}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<p>No risks, issues or decisions recorded.</p>'}

  <h2>6. Project Board & Governance (Principle 3)</h2>
  ${projectAssignments.length ? `
  <table>
    <thead><tr><th>Role</th><th>Board Member</th><th>Allocation</th><th>Responsibility</th><th>Active Backup</th></tr></thead>
    <tbody>
      ${projectAssignments.map(a => `<tr>
        <td><strong>${escapeHtml(words(a.role))}</strong></td>
        <td>${escapeHtml(personName(a.person_id))}</td>
        <td>${escapeHtml(a.allocation)}%</td>
        <td>${escapeHtml(a.responsibility)}</td>
        <td>${escapeHtml(a.backup_person_id ? personName(a.backup_person_id) : 'No backup')}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<p>No board members assigned.</p>'}

  <h2>7. Stage Approvals & Gate Decisions (Principle 4: Manage by Stages)</h2>
  ${projectApprovals.length ? `
  <table>
    <thead><tr><th>Stage</th><th>Decision</th><th>Approver</th><th>Recorded Date</th><th>Evidence</th></tr></thead>
    <tbody>
      ${projectApprovals.map(app => `<tr>
        <td><strong>${escapeHtml(words(app.stage))}</strong></td>
        <td><span class="badge ${app.decision === 'approved' ? 'badge-ok' : 'badge-alert'}">${escapeHtml(words(app.decision))}</span></td>
        <td>${escapeHtml(personName(app.approver_id))}</td>
        <td>${escapeHtml(app.created_at)}</td>
        <td>${escapeHtml(app.evidence)}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<p>No stage boundary decisions recorded.</p>'}

  <footer>
    <p>Report generated from verified ${brandText('Buddy')} project records · PRINCE2 Controlled Environment</p>
  </footer>
</body>
</html>`);
}

export function generateProjectPdfHtml(
  project: Project,
  workItems: WorkItem[],
  assignments: Assignment[],
  approvals: StageApproval[],
  people: Person[]
): string {
  const baseDoc = generateProjectDocHtml(project, workItems, assignments, approvals, people);
  // Inject print styles and action toolbar
  return baseDoc.replace('</head>', `
  <style>${PRINT_STYLES}</style>
</head>`).replace('<body>', `<body>
  <div class="print-bar no-print">
    <span><strong>${escapeHtml(project.name)}</strong> · Executive Report Ready to Print / Save as PDF</span>
    <button class="print-btn" id="print-report" type="button">🖨 Print / Save as PDF</button>
  </div>`);
}

export async function exportProjectToOffice(
  kind: 'word' | 'excel' | 'pdf',
  project: Project,
  workItems: WorkItem[],
  assignments: Assignment[],
  approvals: StageApproval[],
  dependencies: Dependency[],
  people: Person[],
  onSuccess: (msg: string) => void,
  onError: (msg: string) => void
) {
  try {
    const safeName = project.name.replace(/[/\\?%*:|"<>]/g, '_');

    if (kind === 'pdf') {
      const body = DOMPurify.sanitize(generateProjectPdfHtml(project, workItems, assignments, approvals, people));
      const htmlContent = `<!doctype html><html><head><meta charset="utf-8"><style>${REPORT_STYLES}${PRINT_STYLES}</style></head><body>${body}</body></html>`;
      // Open print-ready window directly
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(htmlContent);
        printWindow.document.close();
        printWindow.document.getElementById('print-report')?.addEventListener('click', () => printWindow.print());
        printWindow.focus();
        onSuccess(`Executive PDF Report generated for "${project.name}". Use the Print/Save PDF button to save as PDF.`);
        return;
      }
      // If popup was blocked, fallback to saving in Office
      const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8;' });
      const formData = new FormData();
      formData.append('file', blob, `${safeName} - Executive Report.html`);
      const response = await fetch('/api/office/files', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Could not upload to Office Suite');
      const saved = await response.json();
      onSuccess(`Saved "${safeName} - Executive Report" to Office Suite.`);
      navigateOffice(`/office/files/${saved.id}`);
      return;
    }

    let blob: Blob;
    let filename: string;

    if (kind === 'excel') {
      filename = `${safeName} - Project Tracker.csv`;
      const csv = generateProjectCsv(project, workItems, assignments, dependencies, people);
      blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    } else {
      filename = `${safeName} - Highlight Report.html`;
      const docHtml = generateProjectDocHtml(project, workItems, assignments, approvals, people);
      blob = new Blob([docHtml], { type: 'text/html;charset=utf-8;' });
    }

    const formData = new FormData();
    formData.append('file', blob, filename);
    const response = await fetch('/api/office/files', { method: 'POST', body: formData });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Could not save file to Office Suite');
    }
    const saved = await response.json();
    onSuccess(`Saved "${filename}" to Office Suite. Opening editor…`);
    navigateOffice(`/office/files/${saved.id}`);
  } catch (err) {
    onError((err as Error).message);
  }
}
