// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));
const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let books: any[];
let quizzes: any[];
let failAssignment: boolean;
let failAccess: boolean;
let certificates: any[];

async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error('Control missing');
  await act(async () => el.click());
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/learning/folders/class1?tab=chapters');
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
  books = [{ id: 'book1', title: 'Reference', extension: 'pdf', lesson_id: null }];
  quizzes = [{ id: 'quiz1', title: 'Assessment', status: 'published', lesson_id: null, is_creator: true }];
  certificates = [{ id: 'cert/1', course_title: 'Course', recipient_name: 'Alex', instructor_name: 'Teacher', issued_at: '2026-01-01T00:00:00Z', email_status: 'queued' }];
  failAssignment = false;
  failAccess = false;
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/me')) return reply({ username: 'teacher', is_admin: true });
    if (url.endsWith('/folders')) return reply({ items: [{ id: 'class1', name: 'Class', is_class: true }] });
    if (url.endsWith('/contents')) return reply({ books, quizzes, notes: [], lessons: [{ id: 'lesson1', title: 'Chapter', status: 'published' }], can_manage_class: true });
    if (url.endsWith('/users')) return reply({ items: [{ username: 'alex', display_name: 'Alex' }, { username: 'sam', display_name: 'Sam' }] });
    if (url.endsWith('/folders/class1/members')) {
      if (options?.method === 'PUT') return failAccess ? reply({ detail: 'Access save failed' }, 503) : reply({});
      return reply({ items: [{ username: 'alex' }], groups: ['/Existing'], app_groups: [], inherited_from: [{ id: 'parent', name: 'Parent' }] });
    }
    if (url.endsWith('/groups')) return reply({ items: [{ path: '/Existing' }] });
    if (url.endsWith('/admin/app-groups')) return reply({ items: [{ id: 'team', name: 'Team', member_count: 2 }] });
    if (url.endsWith('/class-teachers')) return reply({ items: [{ username: 'sam', display_name: 'Sam' }] });
    if (url.endsWith('/books/book1') && options?.method === 'PATCH') {
      if (failAssignment) return reply({ detail: 'Assignment failed' }, 503);
      books = [{ ...books[0], lesson_id: JSON.parse(String(options.body)).lesson_id }]; return reply({});
    }
    if (url.endsWith('/quizzes/quiz1/chapter') && options?.method === 'PATCH') {
      quizzes = [{ ...quizzes[0], lesson_id: JSON.parse(String(options.body)).lesson_id }]; return reply({});
    }
    if (url.endsWith('/certificates')) return reply({ items: certificates });
    if (url.endsWith('/certificates/cert%2F1/send-email')) return reply({ delivery: { status: 'sent', recipient: 'alex@example.com' } });
    return reply({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<LearningWorkspace />));
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('assigns a general document to a chapter and unlinks it back to the library', async () => {
  const card = [...host.querySelectorAll('.learning-general-card')].find(el => el.textContent?.includes('Reference'))!;
  await choose(card.querySelector('select')!, 'lesson1');
  expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url.endsWith('/books/book1'))?.[1]?.body))).toEqual({ lesson_id: 'lesson1' });
  expect(host.textContent).toContain('Document assigned to chapter.');
  await click(host.querySelector('button[title="Move back to general class library"]'));
  expect(host.textContent).toContain('Document moved to general class resources.');
  expect(host.querySelector('.learning-general-resources')?.textContent).toContain('Reference');
});

it('preserves a document in the library after an assignment error and permits retry', async () => {
  failAssignment = true;
  let card = [...host.querySelectorAll('.learning-general-card')].find(el => el.textContent?.includes('Reference'))!;
  await choose(card.querySelector('select')!, 'lesson1');
  expect(host.textContent).toContain('Assignment failed');
  expect(host.querySelector('.learning-general-resources')?.textContent).toContain('Reference');
  failAssignment = false;
  card = [...host.querySelectorAll('.learning-general-card')].find(el => el.textContent?.includes('Reference'))!;
  await choose(card.querySelector('select')!, 'lesson1');
  expect(host.textContent).toContain('Document assigned to chapter.');
});

it('assigns an assessment to a chapter using the quiz-specific endpoint', async () => {
  const card = [...host.querySelectorAll('.learning-general-card')].find(el => el.textContent?.includes('Assessment'))!;
  await choose(card.querySelector('select')!, 'lesson1');
  expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url.endsWith('/quizzes/quiz1/chapter'))?.[1]?.body))).toEqual({ lesson_id: 'lesson1' });
  expect(host.textContent).toContain('Quiz assigned to chapter.');
});

it('previews and emails a certificate with an encoded identifier', async () => {
  await click(host.querySelector('button[title="My certificates"]'));
  const dialog = host.querySelector('dialog')!;
  expect(dialog.textContent).toContain('Course');
  expect(dialog.textContent).toContain('Email delivery queued');
  await click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Preview'));
  expect(dialog.querySelector('iframe')?.getAttribute('src')).toContain('cert%2F1/download?format=html&inline=1');
  await click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Send by email'));
  expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith('/certificates/cert%2F1/send-email') && options?.method === 'POST')).toBe(true);
  expect(host.textContent).toContain('Certificate emailed to alex@example.com.');
});

it('saves direct user, application group, Keycloak group, and teacher grants with retry', async () => {
  await click([...host.querySelectorAll('button')].find(b => b.textContent?.includes('Manage access')));
  const dialog = host.querySelector('dialog')!;
  expect(dialog.textContent).toContain('Inherited access from: Parent');
  const label = (name: string) => [...dialog.querySelectorAll('label')].find(el => el.textContent?.includes(name))!;
  await click(label('Alex').querySelector('input'));
  await click([...dialog.querySelectorAll('label')].find(el => el.textContent?.includes('Sam') && el.querySelector('input[type="checkbox"]'))?.querySelector('input'));
  await click(label('Team').querySelector('input'));
  await choose(label('Lead teacher').querySelector('select')!, 'sam');
  const path = dialog.querySelector<HTMLInputElement>('input[placeholder="/Department/Team"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(path, '/New/Group'); path.dispatchEvent(new Event('input', { bubbles: true })); });
  await click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Add group'));
  failAccess = true;
  await click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save access'));
  expect(dialog.textContent).toContain('Access save failed');
  failAccess = false;
  await click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save access'));
  const requests = fetchMock.mock.calls.filter(([url, options]) => url.endsWith('/folders/class1/members') && options?.method === 'PUT');
  expect(requests).toHaveLength(2);
  expect(JSON.parse(String(requests[1][1]?.body))).toEqual({ usernames: ['sam'], groups: ['/Existing', '/New/Group'], app_groups: ['team'], teacher_username: 'sam' });
  expect(host.querySelector('dialog')).toBeNull();
  expect(host.textContent).toContain('Folder access updated.');
});
