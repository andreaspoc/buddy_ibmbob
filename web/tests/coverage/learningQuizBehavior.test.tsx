// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('../../src/components/LearningQuizResults', () => ({
  QuizGradingState: () => <p>Loading results</p>,
  QuizReport: ({ submission }: { submission: { score: number } }) => <p>Score: {submission.score}</p>,
  QuizStatistics: () => null,
}));
vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let failSubmit: boolean;
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const button = (label: string) => {
  const b = [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(x => x.textContent?.trim() === label);
  if (!b) throw new Error(`Missing button ${label}`);
  return b;
};
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const setValue = async (el: HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};
const result = { id: 'attempt', score: 3, max_score: 4, pending_manual: true, answers: {}, grades: {} };
const questions = [
  { id: 'q1', type: 'single', question: 'Choose one', options: ['A', 'B'], points: 1 },
  { id: 'q2', type: 'multiple', question: 'Choose several', options: ['C', 'D'], points: 1 },
  { id: 'q3', type: 'dropdown', question: 'Choose from list', options: ['E', 'F'], points: 1 },
  { id: 'q4', type: 'text', question: 'Explain', points: 1 },
];

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/learning/folders/class1/quizzes/quiz1');
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
  failSubmit = false;
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/me')) return response({ username: 'learner', is_admin: false });
    if (url.endsWith('/folders')) return response({ items: [{ id: 'class1', name: 'Class' }] });
    if (url.endsWith('/contents')) return response({ books: [], quizzes: [], lessons: [], notes: [] });
    if (url.endsWith('/quizzes/quiz1')) return response({ id: 'quiz1', title: 'Assessment', status: 'published', version: 2, questions });
    if (url.endsWith('/start')) return response({});
    if (url.endsWith('/submit')) return failSubmit ? response({ detail: 'Please retry submission' }, 503) : response({ submitted: true, result });
    if (url.includes('/my-result/grade')) return response({ ...result, pending_manual: false, score: 4 });
    if (url.includes('/my-result')) return response(result);
    return response({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<LearningWorkspace />); });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Learning quiz attempt', () => {
  it('requires answers, supports all question types, review edits and grading retry', async () => {
    expect(host.querySelector('dialog h2')?.textContent).toBe('Assessment');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(true);
    expect(button('Next →').disabled).toBe(true);
    await click(host.querySelector('input[name="answer-q1"]')!);
    await click(button('Next →'));
    const checks = host.querySelectorAll<HTMLInputElement>('input[name="answer-q2"]');
    await click(checks[0]); await click(checks[1]); await click(checks[0]);
    await click(button('Next →'));
    await setValue(host.querySelector('select[aria-label="Answer question 3"]')!, '1');
    await click(button('Next →'));
    await setValue(host.querySelector('textarea[aria-label="Answer question 4"]')!, 'A detailed answer');
    await click(button('Review answers'));
    expect(host.querySelector('.learning-quiz-review')?.textContent).toContain('A detailed answer');
    expect(host.querySelector('.learning-quiz-review')?.textContent).toContain('D');
    await click(host.querySelector('[aria-label="Review question 1, answered"]')!);
    const radios = host.querySelectorAll<HTMLInputElement>('input[name="answer-q1"]');
    await click(radios[1]); await click(button('Next →')); await click(button('Next →')); await click(button('Next →')); await click(button('Review answers'));
    failSubmit = true;
    await click(button('Submit answers'));
    expect(host.querySelector('dialog [role="alert"]')?.textContent).toBe('Please retry submission');
    failSubmit = false;
    await click(button('Submit answers'));
    const submissions = fetchMock.mock.calls.filter(([url]) => url.endsWith('/submit'));
    const payload = JSON.parse(String(submissions[1][1]?.body));
    expect(payload).toMatchObject({ version: 2, answers: { q1: [1], q2: [1], q3: [1], q4: 'A detailed answer' } });
    expect(payload.request_id).toBe(JSON.parse(String(submissions[0][1]?.body)).request_id);
    expect(host.textContent).toContain('Score: 3');
    await click(button('Retry automatic grading'));
    expect(host.textContent).toContain('Score: 4');
    expect(host.textContent).not.toContain('Retry automatic grading');
  });
});
