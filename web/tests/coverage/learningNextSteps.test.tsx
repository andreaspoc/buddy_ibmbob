// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LearningNextSteps } from '../../src/components/LearningNextSteps';

describe('learner next steps', () => {
  it('shows only actionable current items and opens the selected item', async () => {
    const host = document.createElement('div'); const root = createRoot(host);
    const onLesson = vi.fn(), onQuiz = vi.fn();
    await act(async () => { root.render(<LearningNextSteps
      lessons={[{ id: 'l1', title: 'Resume', status: 'published', started: true }, { id: 'l2', title: 'Done', status: 'published', started: true, completed: true }, { id: 'l3', title: 'Draft', status: 'draft', started: true }]}
      quizzes={[{ id: 'q1', title: 'Available', status: 'published' }, { id: 'q2', title: 'Pending', status: 'published', submitted: true, pending_manual: true }, { id: 'q3', title: 'Completed', status: 'published', submitted: true }]}
      onLesson={onLesson} onQuiz={onQuiz} />); });
    expect(host.textContent).toContain('Continue learning');
    expect(host.textContent).toContain('Awaiting grading');
    expect(host.textContent).not.toContain('Done'); expect(host.textContent).not.toContain('Draft'); expect(host.textContent).not.toContain('Completed');
    const buttons = host.querySelectorAll('button');
    await act(async () => { buttons[0].click(); buttons[1].click(); buttons[2].click(); });
    expect(onLesson).toHaveBeenCalledWith('l1'); expect(onQuiz).toHaveBeenCalledWith('q1'); expect(onQuiz).toHaveBeenCalledWith('q2');
    await act(async () => { root.unmount(); });
  });
  it('renders nothing when there is no current work', async () => {
    const host = document.createElement('div'); const root = createRoot(host);
    await act(async () => { root.render(<LearningNextSteps lessons={[]} quizzes={[]} onLesson={() => {}} onQuiz={() => {}} />); });
    expect(host.innerHTML).toBe(''); await act(async () => { root.unmount(); });
  });
});
