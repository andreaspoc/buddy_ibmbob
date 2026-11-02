// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';

vi.mock('../../src/components/LearningBookPages', () => ({
  LearningBookPages: ({ src }: { src: string }) => <div data-page-src={src} />,
}));
vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/learning/folders/class1/books/book1?chapter=two&page=9');
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/me')) return reply({ username: 'reader', is_admin: false });
    if (url.endsWith('/folders')) return reply({ items: [{ id: 'class1', name: 'Class' }] });
    if (url.includes('/contents')) return reply({ books: [], quizzes: [], lessons: [], notes: [] });
    if (url.includes('/books/book1/search')) return reply({ items: [{ chapter_id: 'one', title: 'First chapter', excerpt: 'found it' }] });
    if (url.endsWith('/books/book1/notes') && options?.method === 'POST') return reply({ id: 'n1', chapter_id: 'two', page: 9, color: 'blue', text: 'Remember this' });
    if (url.includes('/books/book1/notes/') && options?.method === 'DELETE') return reply(undefined, 204);
    if (url.endsWith('/books/book1/notes')) return reply({ items: [] });
    if (url.endsWith('/books/book1/progress')) return reply({});
    if (url.endsWith('/books/book1')) return reply({ id: 'book1', title: 'Test book', author: 'Writer', chapters: [{ id: 'one', title: 'First chapter' }, { id: 'two', title: 'Second chapter' }], progress: { chapter_id: 'one', page: 0, bookmarks: [] } });
    return reply({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<LearningWorkspace />); });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Learning document reader', () => {
  it('opens a linked chapter, searches, navigates, and saves bookmarks', async () => {
    expect(host.querySelector('.learning-reader h2')?.textContent).toBe('Test book');
    expect(host.querySelector('.learning-toc [aria-current="page"]')?.textContent).toContain('Second chapter');
    await click(button('◇ Bookmark chapter'));
    expect(button('◆ Bookmarked').getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith('/progress') && JSON.parse(String(options?.body)).bookmarks[0].chapter_id === 'two')).toBe(true);
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search this document"]')!;
    await act(async () => change(search, 'found'));
    await act(async () => { search.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(host.querySelector('.learning-search-results')?.textContent).toContain('found it');
    await click(button('First chapterfound it'));
    expect(host.querySelector('.learning-toc [aria-current="page"]')?.textContent).toContain('First chapter');
    await click(button('Clear search'));
    expect(host.querySelector('.learning-search-results')).toBeNull();
  });

  it('creates and deletes a private reading note', async () => {
    await click(button('Notes palette'));
    expect(button('Save note').disabled).toBe(true);
    await click(host.querySelector('[aria-label="blue note"]') as HTMLElement);
    await act(async () => change(host.querySelector('.learning-reader-notes textarea')!, 'Remember this'));
    await click(button('Save note'));
    expect(host.querySelector('.learning-note-list')?.textContent).toContain('Remember this');
    const post = fetchMock.mock.calls.find(([url, options]) => url.endsWith('/notes') && options?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ chapter_id: 'two', color: 'blue', text: 'Remember this' });
    await click(button('Delete note'));
    expect(host.querySelector('.learning-note-list')?.textContent).toContain('No notes yet.');
    expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith('/notes/n1') && options?.method === 'DELETE')).toBe(true);
  });

  it('reports failed progress saves and leaves the document available', async () => {
    fetchMock.mockImplementationOnce(async () => reply({ detail: 'Save failed' }, 500));
    await click(button('◇ Bookmark chapter'));
    expect(host.querySelector('.learning-reader [role="alert"]')?.textContent).toBe('Save failed');
    expect(host.querySelector('.learning-reader h2')?.textContent).toBe('Test book');
  });

  it('shows search and note errors while allowing another attempt', async () => {
    fetchMock.mockImplementationOnce(async () => reply({ detail: 'Search unavailable' }, 503));
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search this document"]')!;
    await act(async () => change(search, 'term'));
    await act(async () => { search.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(host.querySelector('.learning-reader [role="alert"]')?.textContent).toBe('Search unavailable');
    await act(async () => { search.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(host.querySelector('.learning-search-results')?.textContent).toContain('found it');
    expect(host.querySelector('.learning-reader [role="alert"]')).toBeNull();
    await click(button('Notes palette'));
    await act(async () => change(host.querySelector('.learning-reader-notes textarea')!, 'Remember this'));
    fetchMock.mockImplementationOnce(async () => reply({ detail: 'Note could not be saved' }, 500));
    await click(button('Save note'));
    expect(host.querySelector('.learning-reader [role="alert"]')?.textContent).toBe('Note could not be saved');
    expect(host.querySelector<HTMLTextAreaElement>('.learning-reader-notes textarea')?.value).toBe('Remember this');
    await click(button('Save note'));
    expect(host.querySelector('.learning-note-list')?.textContent).toContain('Remember this');
  });

  it('navigates chapters with keyboard shortcuts while ignoring typing in search', async () => {
    await click(host.querySelector('.learning-toc [aria-current="page"]') as HTMLElement);
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search this document"]')!;
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(host.querySelector('.learning-toc [aria-current="page"]')?.textContent).toContain('Second chapter');
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(host.querySelector('.learning-toc [aria-current="page"]')?.textContent).toContain('First chapter');
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(host.querySelector('.learning-toc [aria-current="page"]')?.textContent).toContain('Second chapter');
  });

});
