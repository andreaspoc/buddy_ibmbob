// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));
vi.mock('../../src/components/LearningQuizResults', () => ({ QuizGradingState: () => null, QuizReport: () => <p>Report</p>, QuizStatistics: () => <p>Statistics</p> }));
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let failSuggestion: boolean;
let failSave: boolean;
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const question = { id: 'q1', type: 'text', question: 'Explain routing', answer: 'Reference', rubric: 'Mention paths', points: 5 };
const result = { id: 's1', username: 'student', quiz_version: 2, submitted_at: '2026-01-01T00:00:00Z', score: 2, max_score: 5, pending_manual: true, answers: { q1: 'My answer' }, grades: { q1: { score: 2, feedback: 'Initial' } } };
const button = (name: string) => {
 const b = [...host.querySelectorAll('button')].find(x => x.textContent?.trim() === name);
 if (!b) throw new Error(`Missing button ${name}; ${host.textContent?.slice(-1500)}`);
 return b;
};
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const setValue = async (el: HTMLInputElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); };
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
 window.history.replaceState({}, '', '/learning/folders/class1?tab=quizzes');
 HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
 failSuggestion = false; failSave = false;
 fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
  if (url.endsWith('/me')) return reply({ username: 'author', is_admin: true });
  if (url.endsWith('/folders')) return reply({ items: [{ id: 'class1', name: 'Class' }] });
  if (url.endsWith('/contents')) return reply({ books: [], quizzes: [{ id: 'quiz1', title: 'Assessment', status: 'published', is_creator: true }], lessons: [], notes: [] });
  if (url.endsWith('/quizzes/quiz1/results')) return reply({ items: [result], questions: [question] });
  if (url.endsWith('/submissions/s1/suggest-grades')) return failSuggestion ? reply({ detail: 'Suggestion unavailable' }, 503) : reply({ grades: { q1: { score: 4, feedback: 'Good detail' } }, review_required: true });
  if (url.endsWith('/submissions/s1/grade')) return failSave ? reply({ detail: 'Save failed' }, 503) : reply({});
  return reply({ items: [] });
 });
 vi.stubGlobal('fetch', fetchMock);
 host = document.createElement('div'); document.body.append(host); root = createRoot(host);
 await act(async () => root.render(<LearningWorkspace />));
 await click(button('Results'));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('reviews suggested written marks, validates and saves edited feedback', async () => {
 expect(host.textContent).toContain('Statistics');
 expect(host.textContent).toContain('Marking pending');
 await click(button('View answers'));
 expect(host.textContent).toContain('My answer');
 expect(host.textContent).toContain('Mention paths');
 await click(button('Ask Buddy to grade written answers'));
 expect(host.textContent).toContain('suggested marks are not saved');
 const score = host.querySelector<HTMLInputElement>('input[type="number"]')!;
 const feedback = [...host.querySelectorAll<HTMLInputElement>('.learning-result-answer input')].find(el => el.type === 'text')!;
 expect(score.value).toBe('4'); expect(feedback.value).toBe('Good detail');
 await setValue(score, '6'); expect(button('Save marking').disabled).toBe(true);
 await setValue(score, '5'); await setValue(feedback, 'Reviewed');
 await click(button('Save marking'));
 const request = fetchMock.mock.calls.find(([url]) => url.endsWith('/submissions/s1/grade'));
 expect(JSON.parse(String(request?.[1]?.body))).toEqual({ grades: { q1: { score: 5, feedback: 'Reviewed' } } });
 expect(host.querySelector('.learning-submission')).toBeNull();
 expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/results'))).toHaveLength(2);
});

it('surfaces suggestion and save errors, then allows retry', async () => {
 await click(button('View answers'));
 failSuggestion = true; await click(button('Ask Buddy to grade written answers'));
 expect(host.querySelector('[role="alert"]')?.textContent).toBe('Suggestion unavailable');
 failSuggestion = false; await click(button('Ask Buddy to grade written answers'));
 expect(host.querySelector('[role="alert"]')).toBeNull();
 failSave = true; await click(button('Save marking'));
 expect(host.querySelector('[role="alert"]')?.textContent).toBe('Save failed');
 expect(host.querySelector('.learning-submission')).not.toBeNull();
 failSave = false; await click(button('Save marking'));
 expect(host.querySelector('.learning-submission')).toBeNull();
});
