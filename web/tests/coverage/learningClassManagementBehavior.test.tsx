// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let lessons: any[];
let failOrder: boolean;
const click = async (el: HTMLElement | null) => { if (!el) throw new Error('Control missing'); await act(async () => el.click()); };
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
 await act(async () => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
 window.history.replaceState({}, '', '/learning/folders/class1?tab=chapters');
 HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
 lessons = [{ id: 'a', title: 'Alpha', status: 'published' }, { id: 'b', title: 'Beta', status: 'published' }]; failOrder = false;
 fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
  if (url.endsWith('/me')) return reply({ username: 'teacher', is_admin: true });
  if (url.endsWith('/folders') && options?.method === 'POST') return reply({ id: 'new', name: 'New class', is_class: true });
  if (url.endsWith('/folders')) return reply({ items: [{ id: 'class1', name: 'Class', is_class: true }] });
  if (url.endsWith('/contents')) return reply({ books: [], quizzes: [], notes: [], lessons, can_manage_class: true });
  if (url.endsWith('/lessons/order')) {
   if (failOrder) return reply({ detail: 'Order failed' }, 503);
   const ids = JSON.parse(String(options?.body)).lesson_ids; lessons = ids.map((id: string) => lessons.find(l => l.id === id)); return reply({});
  }
  if (url.endsWith('/translate-content')) return reply({ detail: 'Unavailable' }, 503);
  return reply({ items: [] });
 });
 vi.stubGlobal('fetch', fetchMock); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
 await act(async () => root.render(<LearningWorkspace />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('reorders chapters with a persisted ordered list and disables boundary moves', async () => {
 const firstUp = host.querySelector<HTMLButtonElement>('button[aria-label="Move Alpha earlier"]')!;
 expect(firstUp.disabled).toBe(true);
 await click(host.querySelector('button[aria-label="Move Alpha later"]'));
 const request = fetchMock.mock.calls.find(([url]) => url.endsWith('/lessons/order'));
 expect(JSON.parse(String(request?.[1]?.body))).toEqual({ lesson_ids: ['b', 'a'] });
 expect(host.textContent).toContain('Chapter order updated.');
 const cards = [...host.querySelectorAll('.learning-chapter-card')];
 expect(cards[0].textContent).toContain('Beta'); expect(cards[1].textContent).toContain('Alpha');
});

it('reports a failed chapter reorder and permits retry', async () => {
 failOrder = true; await click(host.querySelector('button[aria-label="Move Alpha later"]'));
 expect(host.textContent).toContain('Order failed');
 failOrder = false; await click(host.querySelector('button[aria-label="Move Alpha earlier"]'));
 expect(host.textContent).toContain('Chapter order updated.');
});

it('creates a class with fallback translations when translation is unavailable', async () => {
 await click(host.querySelector('button[aria-label="Create learning folder"]'));
 const dialog = host.querySelector('dialog')!;
 await setValue(dialog.querySelector('input')!, '  New class  ');
 await setValue(dialog.querySelector('textarea')!, '  A description  ');
 await click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Create folder')!);
 const request = fetchMock.mock.calls.find(([url, options]) => url.endsWith('/folders') && options?.method === 'POST');
 const body = JSON.parse(String(request?.[1]?.body));
 expect(body.name).toBe('New class'); expect(body.description).toBe('A description'); expect(body.parent_id).toBe('class1');
 expect(body.approved_languages).toHaveLength(3);
 for (const value of Object.values(body.translations) as any[]) expect(value).toEqual({ name: 'New class', description: 'A description' });
 expect(host.querySelector('dialog')).toBeNull();
});

it('uploads a document to the chosen chapter with its original file metadata', async () => {
 const upload = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Upload Document'))!;
 await click(upload);
 const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
 const file = new File(['learning'], 'lesson.txt', { type: 'text/plain' });
 Object.defineProperty(input, 'files', { configurable: true, value: [file] });
 await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
 const request = fetchMock.mock.calls.find(([url, options]) => url.includes('/books?lesson_id=a') && options?.method === 'POST');
 expect(request).toBeDefined();
 expect((request![1]!.body as FormData).get('file')).toBe(file);
 expect(host.textContent).toContain('Document uploaded and attached to chapter.');
});
