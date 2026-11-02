// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function findButton(label: string) {
  const element = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const change = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};
function labeled<T extends HTMLElement>(label: string): T {
  const node = [...host.querySelectorAll('dialog label')].find(x => x.firstChild?.textContent?.trim() === label)?.querySelector('input,textarea,select');
  if (!node) throw new Error(`Missing field ${label}`);
  return node as T;
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/learning/folders/class1?tab=quizzes');
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/me')) return response({ username: 'author', is_admin: true, can_create_quizzes: true });
    if (url.endsWith('/folders')) return response({ items: [{ id: 'class1', name: 'Class' }] });
    if (url.endsWith('/contents')) return response({ books: [], quizzes: [], lessons: [], notes: [] });
    if (url.endsWith('/translate-content')) {
      const body = JSON.parse(String(options?.body));
      return response({ translated: { title: `${body.payload.title} ${body.target_language}`, questions: body.payload.questions } });
    }
    if (url.endsWith('/folders/class1/quizzes') && options?.method === 'POST') return response({ id: 'draft1' });
    if (url.endsWith('/quizzes/draft1/publish')) return response({});
    return response({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<LearningWorkspace />));
  await click(host.querySelector('button[title="New quiz"]')!);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Learning quiz authoring', () => {
  it('validates a written question and saves a private draft', async () => {
    await click(findButton('✓ Approve All 3 Languages & Finish Draft'));
    expect(host.querySelector('dialog [role="alert"]')?.textContent).toContain('complete every question');
    await change(labeled('Quiz title'), 'Practice');
    await change(labeled('Question type'), 'text');
    await change(labeled('Question'), 'Explain the process');
    await change(labeled('Reference answer'), 'The reference answer');
    await click(findButton('✓ Approve All 3 Languages & Finish Draft'));
    expect(host.querySelector('dialog [role="alert"]')?.textContent).toContain('marking guidance');
    await change(labeled('Marking guidance'), 'Credit a clear explanation');
    await act(async () => host.querySelector('form.learning-editor')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const post = fetchMock.mock.calls.find(([url, options]) => url.endsWith('/folders/class1/quizzes') && options?.method === 'POST');
    const payload = JSON.parse(String(post?.[1]?.body));
    expect(payload.title).toBe('Practice');
    expect(payload.questions[0]).toMatchObject({ type: 'text', question: 'Explain the process', answer: 'The reference answer', rubric: 'Credit a clear explanation' });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/publish'))).toBe(false);
    expect(host.querySelector('form.learning-editor')).toBeNull();
  });

  it('preserves correct answers when removing options, generates translations and publishes', async () => {
    await change(labeled('Quiz title'), 'Knowledge check');
    await change(labeled('Question'), 'Select the right answers');
    await change(labeled('Question type'), 'multiple');
    await change(host.querySelector('[aria-label="Question 1, option 1"]')!, 'One');
    await change(host.querySelector('[aria-label="Question 1, option 2"]')!, 'Two');
    await click(findButton('+ Add option'));
    await change(host.querySelector('[aria-label="Question 1, option 3"]')!, 'Three');
    await click(host.querySelector('[aria-label="Question 1, option 3 is correct"]')!);
    await click(host.querySelector('[aria-label="Remove option 2"]')!);
    expect((host.querySelector('[aria-label="Question 1, option 2 is correct"]') as HTMLInputElement).checked).toBe(true);
    const generate = [...host.querySelectorAll('dialog button')].find(x => x.textContent?.includes('Generate 3 Languages'))!;
    await click(generate);
    expect(host.querySelector('.learning-i18n-approval-bar')?.parentElement?.textContent).toContain('Review and approve all 3 languages');
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/translate-content'))).toHaveLength(2);
    await click(findButton('✓ Approve All 3 Languages & Finish Draft'));
    const post = fetchMock.mock.calls.find(([url, options]) => url.endsWith('/folders/class1/quizzes') && options?.method === 'POST');
    const payload = JSON.parse(String(post?.[1]?.body));
    expect(payload.questions[0]).toMatchObject({ options: ['One', 'Three'], answer: [1] });
    expect(payload.approved_languages).toEqual(['en', 'el', 'hi']);
    expect(Object.keys(payload.translations)).toEqual(expect.arrayContaining(['en', 'el', 'hi']));
    expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith('/quizzes/draft1/publish') && options?.method === 'POST')).toBe(true);
  });
});
