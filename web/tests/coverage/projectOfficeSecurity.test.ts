// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { exportProjectToOffice, generateProjectDocHtml, generateProjectPdfHtml } from '../../src/components/ProjectOfficeExport';

describe('project report HTML', () => {
  test('renders project data as text in Word and print reports', () => {
    const payload = '</title><img src=x onerror="alert(1)"><script>alert(2)</script>';
    const project = { id: 'p', name: payload, stage: 'initiation', status: 'active', priority: 'high',
      business_case: payload, product_description: payload };
    const items = [{ project_id: 'p', kind: 'deliverable', title: payload, status: 'accepted', acceptance_criteria: payload },
      { project_id: 'p', kind: 'task', title: payload, status: 'done', priority: 'high' },
      { project_id: 'p', kind: 'risk', title: payload, status: 'open', resolution: payload }];
    const assignments = [{ project_id: 'p', person_id: 'u', role: 'owner', allocation: 10, responsibility: payload }];
    const approvals = [{ project_id: 'p', stage: 'initiation', decision: 'approved', approver_id: 'u', created_at: payload, evidence: payload }];
    const people = [{ id: 'u', name: payload }];
    for (const html of [generateProjectDocHtml, generateProjectPdfHtml].map(fn =>
      fn(project as never, items as never, assignments as never, approvals as never, people as never))) {
      const document = new DOMParser().parseFromString(html, 'text/html');
      expect(document.querySelectorAll('img, [onerror]')).toHaveLength(0);
      expect(document.querySelectorAll('script, [onclick]')).toHaveLength(0);
      expect(document.body.textContent).toContain(payload);
    }
  });
  test('print window uses inert HTML and a separately registered print handler', async () => {
    const doc = document.implementation.createHTMLDocument('');
    const print = vi.fn();
    const popup = { document: doc, print, focus: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    try {
      await exportProjectToOffice('pdf', {id:'p', name:'<img src=x onerror=alert(1)>'} as never,
        [], [], [], [], [], vi.fn(), vi.fn());
      expect(doc.querySelector('img, script, [onerror], [onclick]')).toBeNull();
      doc.getElementById('print-report')?.click();
      expect(print).toHaveBeenCalledOnce();
    } finally { open.mockRestore(); }
  });
});
