// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { prepareReactPreview } from '../../src/lib/reactPreview';
import { ArtifactChangeRequest } from '../../src/components/ArtifactChangeRequest';
import LearningCourseCompletion from '../../src/components/LearningCourseCompletion';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

test('React preview removes multiline React imports but preserves other imports and escapes script endings', () => {
  const result = prepareReactPreview(`import React, {\n  useState,\n  useEffect\n} from 'react';\nimport x from 'other';\nexport default function App() { return '</script>'; }`);
  expect(result).not.toContain("from 'react'");
  expect(result).not.toContain('useState,');
  expect(result).toContain("import x from 'other';");
  expect(result).toContain('const ArtifactComponent = function App');
  expect(result).toContain('<\\/script>');
});

test('artifact change request closes on Escape without submitting an edit', async () => {
  const listener = vi.fn(); window.addEventListener('buddy-request-artifact-edit', listener);
  try {
    await act(async () => root.render(<ArtifactChangeRequest sessionId="fixture" path="report.html" />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('textarea')).not.toBeNull();
    await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('textarea')).toBeNull(); expect(listener).not.toHaveBeenCalled();
  } finally { window.removeEventListener('buddy-request-artifact-edit', listener); }
});

test('teacher sees each learner’s progress and failed requirements', async () => {
  const response = { course: { id: 'class', title: 'Course', revision: 1 }, can_manage: true, items: [
    { username: 'learner', display_name: 'Example Learner', eligible: false, evidence_digest: 'a', certificate: null,
      requirements: [{ assignment_id: 'lesson', title: 'Lesson', resource_type: 'lesson', resource_version: 1, completed: true, status: 'completed' },
        { assignment_id: 'quiz', title: 'Quiz', resource_type: 'quiz', resource_version: 1, completed: false, status: 'Required quiz score not reached', score: 4, max_score: 10, minimum_score_percent: 70 }] }
  ] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
  await act(async () => { root.render(<LearningCourseCompletion classId="class" canManage />); });
  expect(host.textContent).toContain('Example Learner');
  expect(host.textContent).toContain('Required activities completed: 1 / 2');
  expect(host.textContent).toContain('Required quiz score not reached');
  expect(host.textContent).toContain('4 / 10 points');
});

test('artifact panel can be resized with arrow keys', async () => {
  const { ArtifactWorkspacePanel } = await import('../../src/components/ArtifactWorkspacePanel');
  localStorage.removeItem('buddy-artifact-size');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 1200 });
  await act(async () => root.render(<ArtifactWorkspacePanel><p>Content</p></ArtifactWorkspacePanel>));
  const separator = host.querySelector('[role="separator"]')!;
  expect(separator.getAttribute('aria-valuenow')).toBe('48');
  await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(separator.getAttribute('aria-valuenow')).toBe('53');
  expect(host.style.getPropertyValue('--artifact-width')).toBe('53%');
  localStorage.removeItem('buddy-artifact-size');
});
