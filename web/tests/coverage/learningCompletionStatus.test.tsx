// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LearningCourseCompletion from '../../src/components/LearningCourseCompletion';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const certificate = { id: 'cert', recipient_name: 'Learner', course_title: 'Course', instructor_name: 'Teacher', version: 1, class_revision: 1, issued_at: '2026-10-31T00:00:00Z', revoked_at: null as string | null, revocation_reason: null };

async function statusFor(item: { eligible: boolean; certificate: typeof certificate | null }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    course: { id: 'class', title: 'Course', revision: 2 }, can_manage: false, smtp_enabled: false,
    items: [{ username: 'learner', display_name: 'Learner', requirements: [], evidence_digest: 'a', ...item }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<LearningCourseCompletion classId="class" canManage={false} />); });
  const text = host.querySelector('.learning-completion-person')?.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('course completion status', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a certificate valid while a new required module is unfinished', async () => {
    expect(await statusFor({ eligible: false, certificate })).toContain('New required activities added — existing certificate remains valid');
  });

  it('shows an issued certificate when all requirements are complete, even on an older revision', async () => {
    expect(await statusFor({ eligible: true, certificate })).toContain('Completion approved — certificate issued');
  });

  it('does not treat a revoked certificate as valid', async () => {
    const revoked = { ...certificate, revoked_at: '2026-10-31T00:00:00Z' };
    expect(await statusFor({ eligible: false, certificate: revoked })).toContain('Course requirements are not complete');
    expect(await statusFor({ eligible: true, certificate: revoked })).toContain('Requirements complete — teacher approval required');
  });

  it('reports incomplete requirements without a certificate', async () => {
    expect(await statusFor({ eligible: false, certificate: null })).toContain('Course requirements are not complete');
  });
});
