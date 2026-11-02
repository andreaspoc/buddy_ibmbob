// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LearningWorkspace from '../../src/components/LearningWorkspace';
vi.mock('../../src/components/FloatingLearningAssistant', () => ({ FloatingLearningAssistant: () => null }));
vi.mock('../../src/components/LearningAssistant', () => ({ LearningAssistant: () => null }));
let host: HTMLDivElement; let root: Root; let fetchMock: ReturnType<typeof vi.fn>; let failImport: boolean;
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const button = (name: string) => { const b = [...host.querySelectorAll('button')].find(x => x.textContent?.trim() === name); if (!b) throw new Error(`Missing ${name}`); return b; };
const click = async (el: HTMLElement) => { await act(async () => el.click()); };
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.history.replaceState({}, '', '/learning/folders/class1?tab=library');
 HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn(); failImport = false;
 fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
  if (url.endsWith('/me')) return reply({ username: 'admin', is_admin: true });
  if (url.endsWith('/folders')) return reply({ items: [{ id: 'class1', name: 'Class' }] });
  if (url.endsWith('/contents')) return reply({ books: [], quizzes: [], lessons: [], notes: [] });
  if (url.includes('/office-files?')) {
   const query = new URL(url, 'https://example.test').searchParams;
   if (query.get('query') === 'missing') return reply({ items: [] });
   if (query.get('query') === 'error') return reply({ detail: 'Search unavailable' }, 503);
   if (query.get('offset') === '25') return reply({ items: [{ id: 'f2', name: 'Second.docx', extension: 'docx' }], next_offset: null });
   return reply({ items: [{ id: 'f1', name: 'First.pdf', extension: 'pdf' }], next_offset: 25 });
  }
  if (url.endsWith('/import-office') && options?.method === 'POST') return failImport ? reply({ detail: 'Import failed' }, 503) : reply({});
  return reply({ items: [] });
 });
 vi.stubGlobal('fetch', fetchMock); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
 await act(async () => root.render(<LearningWorkspace />)); await click(button('Import from Office Suite'));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
const search = async (value: string) => { const input = host.querySelector<HTMLInputElement>('input[aria-label="Search Office files…"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };
it('paginates accessible files and imports the selected document', async () => {
 expect(button('Import document').disabled).toBe(true);
 expect(host.textContent).toContain('First.pdf');
 await click(button('Load more')); expect(host.textContent).toContain('Second.docx');
 await click(host.querySelector<HTMLInputElement>('input[value="f2"]')!);
 await click(button('Import document'));
 const request = fetchMock.mock.calls.find(([url]) => url.endsWith('/import-office'));
 expect(JSON.parse(String(request?.[1]?.body))).toEqual({ file_id: 'f2' });
 expect(host.querySelector('dialog')).toBeNull();
 expect(host.textContent).toContain('Document imported from Office Suite.');
});
it('clears selection on search and recovers from search and import failures', async () => {
 await click(host.querySelector<HTMLInputElement>('input[value="f1"]')!);
 await search('missing'); expect(button('Import document').disabled).toBe(true);
 expect(host.textContent).toContain('No accessible Office files found.');
 await search('error'); expect(host.querySelector('dialog [role="alert"]')?.textContent).toBe('Search unavailable');
 await search('all'); expect(host.querySelector('dialog [role="alert"]')).toBeNull();
 await click(host.querySelector<HTMLInputElement>('input[value="f1"]')!);
 failImport = true; await click(button('Import document'));
 expect(host.querySelector('dialog [role="alert"]')?.textContent).toBe('Import failed');
 failImport = false; await click(button('Import document'));
 expect(host.querySelector('dialog')).toBeNull();
});
