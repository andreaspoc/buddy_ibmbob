// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  enrich: vi.fn(),
  fly: vi.fn(async () => undefined),
}));
vi.mock('../../src/components/AppDialog', () => ({ appConfirm: mocks.confirm }));
vi.mock('../../src/lib/noteEnrichment', () => ({ enrichNote: mocks.enrich }));
vi.mock('../../src/lib/noteFlight', () => ({ flyNoteToNotes: mocks.fly }));
vi.mock('../../src/components/NotesOfficeTransfer', () => ({ NotesToOfficeButton: ({ ids }: { ids: number[] }) => <span data-office-ids>{ids.join(',')}</span> }));
vi.mock('../../src/components/EmailNote', () => ({ EmailNote: ({ note, onClose }: any) => <button type="button" data-email-note onClick={onClose}>email {note.title}</button> }));
vi.mock('../../src/components/ShareToPeople', () => ({ ShareToPeople: ({ item, onClose }: any) => <button type="button" data-share-note onClick={onClose}>share {item.title}</button> }));
vi.mock('../../src/components/NoteDetails', () => ({ NoteDetails: ({ noteId, onRestored }: any) => <button type="button" data-restore onClick={() => onRestored({ id: noteId, title: 'Restored title', body: 'Restored body', color: 'rose' })}>restore</button> }));

import { NotesWorkspace, StickyNotes } from '../../src/components/StickyNotes';

type Reply = { status?: number; body?: unknown; blob?: Blob };
type Route = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

const reply = ({ status = 200, body = {}, blob }: Reply) => ({
  ok: status < 400, status,
  json: async () => { if (body === 'BAD') throw new Error('bad json'); return body; },
  blob: async () => blob ?? new Blob(['x']),
});

let host: HTMLDivElement;
let root: Root;
let calls: { url: string; method: string; body?: any }[];
let route: Route;
const onBack = vi.fn();

const baseNotes = () => [
  { id: 1, title: 'Alpha', body: 'alpha body [[Beta]]', color: 'butter', collection: 'Work', tags: ['red', 'blue'], favorite: true, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-03-01T00:00:00Z', sources: [{ title: 'Doc', url: 'https://example.test/doc' }] },
  { id: 2, title: 'Beta', body: 'beta body', color: 'sky', collection: '', tags: [], favorite: false, created_at: 'not-a-date' },
  { id: 3, title: 'Gamma', body: 'gamma body', color: 'mint', collection: '2026-01-01', tags: ['red'], favorite: false, created_at: '2026-01-03T00:00:00Z' },
  { id: 4, title: 'Delta', body: 'delta body', color: 'rose', collection: '2026-02-01', favorite: false },
];

/** A small stateful notes API: the workspace reloads after every change it announces. */
function notesRoute(initial: any[], overrides: Record<string, Reply | (() => Reply)> = {}): Route {
  let items = [...initial];
  return (url, init) => {
    const path = url.split('?')[0];
    const key = `${init?.method || 'GET'} ${path}`;
    const hit = overrides[key];
    const response = hit ? (typeof hit === 'function' ? hit() : hit) : undefined;
    if (response && (response.status ?? 200) >= 400 && response.status !== 404) return response;
    if (key === 'GET /api/notes') return { body: { items, default_collection: 'Today' } };
    if (init?.method === 'DELETE') items = items.filter(note => `/api/notes/${note.id}` !== path);
    const saved = response?.body as { id?: number } | undefined;
    if (saved?.id) items = items.some(note => note.id === saved.id) ? items.map(note => (note.id === saved.id ? saved : note)) : [saved, ...items];
    return response ?? { body: {} };
  };
}

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const buttons = (scope: ParentNode = host) => [...scope.querySelectorAll('button')];
const button = (label: string | RegExp, scope: ParentNode = host) => {
  const found = buttons(scope).find(item => (typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent || '')));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
};
const click = async (element: Element | null) => { await act(async () => { element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await flush(); };
const press = (label: string | RegExp, scope?: ParentNode) => click(button(label, scope));
function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, caret?: number) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  if (caret !== undefined && 'setSelectionRange' in element) element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const type = async (element: Element | null, value: string, caret?: number) => { await act(async () => setValue(element as HTMLInputElement, value, caret)); await flush(); };
const key = async (element: Element | null, name: string, init: KeyboardEventInit = {}) => { await act(async () => { element?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })); }); await flush(); };
const notice = () => q('[role="alert"]')?.textContent || '';
const noteTitles = () => [...host.querySelectorAll('.notes-saved-card h2')].map(item => item.textContent);

async function mount(items: any[] = baseNotes(), overrides: Record<string, Reply | (() => Reply)> = {}, path = '/notes') {
  window.history.replaceState({}, '', path);
  route = notesRoute(items, overrides);
  await act(async () => root.render(<NotesWorkspace onBack={onBack} />));
  await flush();
}
const openNew = () => press('＋ New note');
const titleInput = () => q<HTMLInputElement>('dialog form input[maxlength="160"]');
const bodyInput = () => q<HTMLTextAreaElement>('dialog textarea[aria-label="Note content"]');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls = [];
  route = () => ({ body: { items: [] } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return reply(await route(String(url), init));
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  (HTMLElement.prototype as any).hidePopover = vi.fn();
  mocks.confirm.mockReset(); mocks.confirm.mockResolvedValue(true);
  mocks.enrich.mockReset(); mocks.fly.mockReset(); mocks.fly.mockResolvedValue(undefined); onBack.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('StickyNotes drafts in chat', () => {
  const drafts = [{ title: 'One', body: 'first', color: 'butter' }, { title: 'Two', body: 'second', color: 'sky' }] as any[];
  const renderDrafts = async (notes = drafts, props: Record<string, unknown> = {}) => {
    await act(async () => root.render(<StickyNotes notes={notes} sessionId="s1" messageId="m1" {...props} />));
    await flush();
  };
  const cards = () => [...host.querySelectorAll('.sticky-note h3')].map(item => item.textContent);

  it('hides drafts already saved from the same message, including by source index', async () => {
    route = () => ({ body: { items: [{ id: 9, title: 'renamed', body: 'x', color: 'mint', source_session_id: 's1', source_message_id: 'm1', source_note_index: 0 }] } });
    await renderDrafts();
    expect(cards()).toEqual(['Two']);
  });

  it('hides drafts matched by saved content from a later turn and pages through results', async () => {
    let page = 0;
    route = () => (page++ === 0
      ? { body: { items: [{ id: 5, title: 'other', body: 'o', color: 'mint', source_session_id: 'elsewhere' }], next_before_id: 5 } }
      : { body: { items: [{ id: 3, title: ' Two ', body: 'second ', color: 'sky', source_session_id: 's1', source_message_id: 'm-later' }] } });
    await renderDrafts();
    expect(calls.map(call => call.url)).toEqual(['/api/notes', '/api/notes?before_id=5']);
    expect(cards()).toEqual(['One']);
  });

  it('shows the moved confirmation when every draft is saved', async () => {
    route = () => ({ body: { items: drafts.map((note, index) => ({ ...note, id: index + 1, source_session_id: 's1', source_message_id: 'm1' })) } });
    await renderDrafts();
    expect(q('[data-notes-moved]')?.textContent).toContain('All notes moved to My Notes.');
  });

  it('read-only mode never queries saved notes or offers saving', async () => {
    await renderDrafts(drafts, { readOnly: true });
    expect(calls).toHaveLength(0);
    expect(q('[data-note-save]')).toBeNull();
    expect(host.textContent).toContain('From this conversation');
  });

  it('saves a draft with provenance then removes the card and announces the change', async () => {
    const changed = vi.fn();
    window.addEventListener('buddy-notes-changed', changed);
    route = (_url, init) => (init?.method === 'POST' ? { body: { id: 1 } } : { body: { items: [] } });
    await renderDrafts();
    await click(q('[data-note-save]'));
    const post = calls.find(call => call.method === 'POST');
    window.removeEventListener('buddy-notes-changed', changed);
    expect(post?.body).toMatchObject({ title: 'One', source_session_id: 's1', source_message_id: 'm1', source_note_index: 0 });
    expect(mocks.fly).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalled();
    expect(cards()).toEqual(['Two']);
  });

  it('skips the POST when a copy appears after the first render', async () => {
    let lookups = 0;
    route = () => (lookups++ === 0 ? { body: { items: [] } } : { body: { items: [{ id: 1, title: 'One', body: 'first', color: 'butter', source_session_id: 's1' }] } });
    await renderDrafts();
    await click(q('[data-note-save]'));
    expect(calls.some(call => call.method === 'POST')).toBe(false);
    expect(cards()).toEqual(['Two']);
  });

  it('keeps a saved note saved when the decorative flight fails', async () => {
    mocks.fly.mockRejectedValue(new Error('no animation'));
    route = () => ({ body: { items: [] } });
    await renderDrafts();
    await click(q('[data-note-save]'));
    expect(cards()).toEqual(['Two']);
    expect(notice()).toBe('');
  });

  it('reports an error on the card when the save is rejected', async () => {
    route = (_url, init) => (init?.method === 'POST' ? { status: 500 } : { body: { items: [] } });
    await renderDrafts();
    await click(q('[data-note-save]'));
    expect(q('.sticky-note-error')?.textContent).toBe('This note could not be saved. Please try again.');
    expect(cards()).toEqual(['One', 'Two']);
  });

  it('reports a lookup failure on the card and leaves it available', async () => {
    let lookups = 0;
    route = () => (lookups++ === 0 ? { body: { items: [] } } : { status: 503 });
    await renderDrafts();
    await click(q('[data-note-save]'));
    expect(q('.sticky-note-error')?.textContent).toBe('Your notes could not be loaded. Please try again.');
  });

  it('marks a draft moved only when the moved event matches this message', async () => {
    route = () => ({ body: { items: [] } });
    await renderDrafts();
    const key = JSON.stringify(['One', 'first', 'butter']);
    const fire = (detail: unknown) => act(async () => { window.dispatchEvent(new CustomEvent('buddy-note-moved', { detail })); });
    await fire({ sessionId: 'other', messageId: 'm1', key });
    await fire({ sessionId: 's1', messageId: 'm1', key: 5 });
    expect(cards()).toEqual(['One', 'Two']);
    await fire({ sessionId: 's1', messageId: 'm1', key });
    expect(cards()).toEqual(['Two']);
  });

  it('re-checks saved notes when the notes-changed event fires', async () => {
    let saved = false;
    route = () => ({ body: { items: saved ? [{ id: 1, title: 'One', body: 'first', color: 'butter', source_session_id: 's1', source_message_id: 'm1' }] : [] } });
    await renderDrafts();
    expect(cards()).toEqual(['One', 'Two']);
    saved = true;
    await act(async () => { window.dispatchEvent(new Event('buddy-notes-changed')); });
    await flush();
    expect(cards()).toEqual(['Two']);
  });
});

describe('NotesWorkspace library', () => {
  it('shows a load error with retry that recovers', async () => {
    let attempts = 0;
    route = () => (attempts++ === 0 ? { status: 500 } : { body: { items: baseNotes() } });
    window.history.replaceState({}, '', '/notes');
    await act(async () => root.render(<NotesWorkspace onBack={onBack} />));
    await flush();
    expect(notice()).toContain('Your notes could not be loaded');
    await press('Retry loading');
    expect(notice()).toBe('');
    expect(noteTitles()).toHaveLength(4);
  });

  it('shows the empty state and goes back to chat', async () => {
    await mount([]);
    expect(host.textContent).toContain('Your next good idea belongs here');
    await press('Make your first notes →');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('follows paged results and uses the singular count', async () => {
    let page = 0;
    route = () => (page++ === 0 ? { body: { items: [baseNotes()[0]], next_before_id: 1 } } : { body: { items: [] } });
    window.history.replaceState({}, '', '/notes');
    await act(async () => root.render(<NotesWorkspace onBack={onBack} />));
    await flush();
    expect(calls.map(call => call.url)).toContain('/api/notes?before_id=1');
    expect(q('.notes-count')?.textContent).toMatch(/1 saved note$/);
  });

  it('sorts dated collections after named ones, newest date first', async () => {
    await mount();
    const names = [...host.querySelectorAll('.notes-library-filters [title]')].map(item => item.getAttribute('title'));
    expect(names).toEqual(['Work', '2026-02-01', '2026-01-01']);
  });

  it.each([
    ['title', ['Alpha', 'Beta', 'Delta', 'Gamma']],
    ['oldest', ['Alpha', 'Beta', 'Gamma', 'Delta']],
    ['newest', ['Delta', 'Gamma', 'Beta', 'Alpha']],
    ['updated', ['Alpha', 'Gamma', 'Beta', 'Delta']],
    ['favorites', ['Alpha', 'Delta', 'Gamma', 'Beta']],
  ])('sorts by %s', async (sort, expected) => {
    await mount();
    await type(q('.notes-view-tools select'), sort);
    expect(noteTitles()).toEqual(expected);
  });

  it('filters by library, favorites, tags, collections and colours', async () => {
    await mount();
    const filters = () => q('.notes-library-filters')!;
    await press(/^Inbox/, filters());
    expect(noteTitles()).toEqual(['Beta']);
    expect(q('.notes-library-title h2')?.textContent).toBe('Inbox');
    await press(/Favorites/, filters());
    expect(noteTitles()).toEqual(['Alpha']);
    expect(q('.notes-library-title h2')?.textContent).toBe('Favorites');
    await press('#red', filters());
    expect(q('.notes-library-title h2')?.textContent).toBe('#red');
    expect(noteTitles()).toEqual(['Alpha', 'Gamma']);
    await press('#red', filters());
    expect(noteTitles()).toHaveLength(4);
    await press(/Work/, filters());
    expect(q('.notes-library-title h2')?.textContent).toBe('Work');
    await press(/^All notes/, filters());
    await click(q('.notes-toolbar [data-note-color="sky"]'));
    expect(noteTitles()).toEqual(['Beta']);
    await click(buttons(q('.notes-toolbar')!).find(item => item.textContent === 'All notes')!);
    expect(noteTitles()).toHaveLength(4);
  });

  it('clicking a tag on a card filters by it', async () => {
    await mount();
    await press('#blue', q('.notes-card-tags')!);
    expect(noteTitles()).toEqual(['Alpha']);
  });

  it('clears filters from the no-match state', async () => {
    await mount();
    await click(q('.notes-toolbar [data-note-color="lavender"]'));
    expect(host.textContent).toContain('No matching notes');
    await press('Clear filters');
    expect(noteTitles()).toHaveLength(4);
  });

  it('searches across all fields and reports the count', async () => {
    await mount();
    const search = q('input[type="search"]');
    await type(search, 'example.test');
    expect(noteTitles()).toEqual(['Alpha']);
    expect(q('.notes-search-summary')?.textContent).toContain('1 note');
    await type(search, 'body');
    expect(q('.notes-search-summary')?.textContent).toContain('4 notes');
    await type(search, 'inbox');
    expect(noteTitles()).toEqual(['Beta']);
    expect(q('.notes-library-title h2')?.textContent).toBe('Search all notes');
    await press('Clear search');
    expect(q('.notes-search-summary')).toBeNull();
  });

  it('switches between cards and list view', async () => {
    await mount();
    await press('List');
    expect(q('.notes-list-view')).not.toBeNull();
    await press('Cards');
    expect(q('.notes-list-view')).toBeNull();
  });

  it('renders the fallback date label and collection names on cards', async () => {
    await mount();
    const beta = q('[data-note-id="2"]')!;
    expect(beta.querySelector('.sticky-note-number')?.textContent).toBe('SAVED NOTE');
    expect(beta.querySelector('.notes-card-collection')?.textContent).toContain('Inbox');
    expect(q('[data-note-id="1"] .notes-card-sources a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('toggles favourites through the API and updates the star', async () => {
    await mount(baseNotes(), { 'PATCH /api/notes/2': { body: { ...baseNotes()[1], favorite: true } } });
    await click(q('[data-note-id="2"] .notes-favorite'));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ favorite: true });
    expect(q('[data-note-id="2"] .notes-favorite')?.textContent).toBe('★');
  });

  it('reports a favourite failure', async () => {
    await mount(baseNotes(), { 'PATCH /api/notes/2': { status: 500 } });
    await click(q('[data-note-id="2"] .notes-favorite'));
    expect(notice()).toContain('Could not update favorite');
    expect(q<HTMLButtonElement>('[data-note-id="2"] .notes-favorite')?.disabled).toBe(false);
  });

  it('runs the card option menu actions', async () => {
    await mount(baseNotes(), { 'PATCH /api/notes/1': { body: { ...baseNotes()[0], favorite: false } } });
    const card = () => q('[data-note-id="1"]')!;
    await press('View full note ↗', card());
    expect(card().classList.contains('is-expanded')).toBe(true);
    await press('Show less ↑', card());
    expect(card().classList.contains('is-expanded')).toBe(false);
    await press('Send note as email', card());
    expect(q('[data-email-note]')?.textContent).toBe('email Alpha');
    await click(q('[data-email-note]'));
    expect(q('[data-email-note]')).toBeNull();
    await press('Share to people', card());
    expect(q('[data-share-note]')?.textContent).toBe('share Alpha');
    await click(q('[data-share-note]'));
    expect(q('[data-share-note]')).toBeNull();
    await press('Unfavorite note', card());
    expect(q('[data-note-id="1"] .notes-favorite')?.textContent).toBe('☆');
  });

  it('asks before deleting, can keep the note, then deletes after the animation', async () => {
    await mount();
    const card = () => q('[data-note-id="2"]')!;
    await press('Delete note', card());
    expect(card().textContent).toContain('Delete this note?');
    await press('Keep note', card());
    expect(card().textContent).not.toContain('Delete this note?');
    await press('Delete note', card());
    await act(async () => { button('Delete', card()).click(); await new Promise(resolve => setTimeout(resolve, 260)); });
    await flush();
    expect(calls.find(call => call.method === 'DELETE')?.url).toBe('/api/notes/2');
    expect(q('[data-note-id="2"]')).toBeNull();
  });

  it('treats a 404 delete as success and surfaces other failures', async () => {
    await mount(baseNotes(), { 'DELETE /api/notes/2': { status: 404 }, 'DELETE /api/notes/3': { status: 500 } });
    await press('Delete note', q('[data-note-id="3"]')!);
    await press('Delete', q('[data-note-id="3"]')!);
    expect(notice()).toContain('This note could not be deleted');
    await press('Keep note', q('[data-note-id="3"]')!);
    await press('Delete note', q('[data-note-id="2"]')!);
    await press('Delete', q('[data-note-id="2"]')!);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
    expect(q('[data-note-id="2"]')).toBeNull();
    expect(notice()).toBe('');
  });

  describe('selection, export and Bob', () => {
    const select = (id: number) => click(q(`[data-note-id="${id}"] input[type="checkbox"]`));

    it('exports selected notes and names the download', async () => {
      const created = vi.fn(() => 'blob:x');
      vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
      const clicks: string[] = [];
      const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
      await mount();
      await select(1); await select(2);
      expect(q('[data-office-ids]')?.textContent).toBe('1,2');
      await press('Export PDF');
      await press('Export Markdown');
      anchorClick.mockRestore();
      expect(clicks).toEqual(['notes.pdf', 'notes.md']);
      expect(calls.filter(call => call.url.startsWith('/api/notes/export')).map(call => call.url.split('&ids=')[1])).toEqual(['1,2', '1,2']);
    });

    it.each([
      ['detail message', { status: 400, body: { detail: 'Too large' } }, 'Too large'],
      ['non-JSON failure', { status: 500, body: 'BAD' }, 'Could not export notes. Please try again.'],
    ])('reports export failure with %s', async (_name, failure, text) => {
      await mount(baseNotes(), { 'GET /api/notes/export': failure as Reply });
      await press('Export PDF');
      expect(notice()).toContain(text);
    });

    it('refuses exports above 100 notes', async () => {
      const many = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, title: `N${index}`, body: 'b', color: 'butter' }));
      await mount(many);
      await press('Export Markdown');
      expect(notice()).toContain('Export up to 100 notes at a time');
      expect(calls.some(call => call.url.includes('export'))).toBe(false);
    });

    it('selects all visible notes, unselects them and clears selection', async () => {
      await mount();
      const all = () => q<HTMLInputElement>('input[aria-label="Select all visible notes"]');
      await click(all());
      expect(q('[data-notes-selection]')?.textContent).toContain('4 notes selected');
      await click(all());
      expect(q('[data-notes-selection]')).toBeNull();
      await select(1);
      await select(1);
      expect(q('[data-notes-selection]')).toBeNull();
      await select(2);
      await press('Clear selection');
      expect(q('[data-notes-selection]')).toBeNull();
    });

    it.each([
      ['✦ Summarize', 'Synthesize these selected notes'],
      ['Compare', 'Compare the selected notes'],
      ['Make action plan', 'Build an actionable plan'],
    ])('%s opens a Bob-written draft in preview', async (label, instruction) => {
      mocks.enrich.mockImplementation(async (_note: unknown, _instruction: string, options: any) => { options.onStatus('working'); return { title: 'Synthesis', body: 'Merged text' }; });
      await mount();
      await select(1);
      await press(label);
      expect(mocks.enrich.mock.calls[0][1]).toContain(instruction);
      expect(mocks.enrich.mock.calls[0][0].body).toContain('[Doc](https://example.test/doc)');
      expect(titleInput()?.value).toBe('Synthesis');
      expect(q('[role="tab"][aria-selected="true"]')?.textContent).toBe('Preview');
    });

    it('reports bulk Bob failures and oversized selections', async () => {
      mocks.enrich.mockRejectedValue(new Error('Bob offline'));
      await mount([{ id: 1, title: 'Long', body: 'x'.repeat(15000), color: 'butter' }, { id: 2, title: 'Short', body: 'y', color: 'sky' }]);
      await select(1);
      await press('Compare');
      expect(notice()).toContain('Select fewer or shorter notes');
      await select(1); await select(2);
      await press('Compare');
      expect(notice()).toContain('Bob offline');
    });

    it('can stop a running bulk request and ignores its late result', async () => {
      let resolve: (value: unknown) => void = () => {};
      mocks.enrich.mockImplementation(() => new Promise(done => { resolve = done; }));
      await mount();
      await select(1);
      await press('✦ Summarize');
      expect(q('[data-notes-selection] [role="status"]')?.textContent).toBe('Asking Bob…');
      await press('Stop');
      expect(q('[data-notes-selection] [role="status"]')).toBeNull();
      await act(async () => resolve({ title: 'Late', body: 'late' }));
      await flush();
      expect(titleInput()).toBeNull();
    });
  });
});

describe('NotesWorkspace editor', () => {
  it('validates, creates a note with cleaned tags and sources, and files it in its collection', async () => {
    const created = { id: 10, title: 'New', body: 'Text', color: 'lavender', collection: 'Ideas', tags: ['a', 'b'], favorite: true };
    await mount(baseNotes(), { 'POST /api/notes': { body: created } });
    await openNew();
    expect(window.location.pathname).toBe('/notes/new');
    expect(q('#notes-editor-title')?.textContent).toBe('A new thought');
    expect(q<HTMLInputElement>('input[aria-label="Collection"]')?.value).toBe('Today');
    await act(async () => { q('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(notice()).toContain('Add a title and some note content');
    await type(titleInput(), ' New ');
    await type(bodyInput(), ' Text ');
    await type(q('input[aria-label="Collection"]'), 'Ideas');
    await type(q('input[aria-label="Note tags"]'), 'a, b, a, ');
    await click(q('dialog [data-note-color="lavender"]'));
    await click(q('.notes-editor-favorite input'));
    await press('＋ Add source');
    await press('＋ Add source');
    await type(q('input[aria-label="Source URL 1"]'), ' https://example.test/a ');
    await type(q('input[aria-label="Source title 2"]'), 'dropped');
    await key(q('form'), 's', { ctrlKey: true });
    const post = calls.find(call => call.method === 'POST');
    expect(post?.body).toEqual({ title: 'New', body: 'Text', color: 'lavender', collection: 'Ideas', tags: ['a', 'b'], favorite: true, sources: [{ title: 'https://example.test/a', url: 'https://example.test/a' }] });
    expect(window.location.pathname).toBe('/notes');
    expect(q('.notes-library-title h2')?.textContent).toBe('Ideas');
    expect(noteTitles()).toEqual(['New']);
  });

  it('edits and PATCHes an existing note, removing a source', async () => {
    await mount(baseNotes(), { 'PATCH /api/notes/1': { body: { ...baseNotes()[0], title: 'Alpha 2' } } });
    await click(q('[data-note-id="1"] [data-note-edit]'));
    expect(window.location.pathname).toBe('/notes/1');
    expect(q('#notes-editor-title')?.textContent).toBe('Edit your note');
    await type(titleInput(), 'Alpha 2');
    await press('Remove source');
    await press('Save note');
    const patch = calls.find(call => call.method === 'PATCH');
    expect(patch?.url).toBe('/api/notes/1');
    expect(patch?.body.sources).toEqual([]);
    expect(q('[data-note-id="1"] h2')?.textContent).toBe('Alpha 2');
  });

  it.each([
    ['too many tags', Array.from({ length: 21 }, (_, index) => `t${index}`).join(',')],
    ['an overlong tag', 'x'.repeat(41)],
  ])('rejects %s', async (_name, tags) => {
    await mount();
    await click(q('[data-note-id="2"] [data-note-edit]'));
    await type(q('input[aria-label="Note tags"]'), tags);
    await press('Save note');
    expect(notice()).toContain('Use up to 20 tags');
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('surfaces save failures and stays open', async () => {
    await mount(baseNotes(), { 'PATCH /api/notes/2': { status: 500 } });
    await click(q('[data-note-id="2"] [data-note-edit]'));
    await press('Save note');
    expect(notice()).toContain('Your changes could not be saved');
    expect(titleInput()).not.toBeNull();
  });

  it('confirms before discarding changes and keeps the draft when declined', async () => {
    await mount();
    await openNew();
    await type(titleInput(), 'Draft');
    mocks.confirm.mockResolvedValue(false);
    await press('Cancel');
    expect(titleInput()?.value).toBe('Draft');
    mocks.confirm.mockResolvedValue(true);
    await act(async () => { q('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    await flush();
    expect(titleInput()).toBeNull();
    expect(window.location.pathname).toBe('/notes');
  });

  it('warns on unload only with unsaved changes', async () => {
    await mount();
    const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    expect(unload()).toBe(false);
    await openNew();
    await type(titleInput(), 'Draft');
    expect(unload()).toBe(true);
  });

  it('applies templates, confirming before replacing a non-empty draft', async () => {
    await mount();
    await openNew();
    const template = () => q('.notes-template-tools select');
    await type(template(), 'meeting');
    expect(titleInput()?.value).toBe('Meeting notes');
    expect(bodyInput()?.value).toContain('## Agenda');
    mocks.confirm.mockResolvedValue(false);
    await type(template(), 'project');
    expect(titleInput()?.value).toBe('Meeting notes');
    mocks.confirm.mockResolvedValue(true);
    await type(template(), 'project');
    expect(titleInput()?.value).toBe('Project notes');
    expect(bodyInput()?.value).toContain('## Open questions');
  });

  it('opens a new daily note or reuses the existing one', async () => {
    await mount();
    await press('Daily note');
    expect(titleInput()?.value).toMatch(/^Daily note · \d{4}-\d{2}-\d{2}$/);
    expect(q<HTMLInputElement>('input[aria-label="Note tags"]')?.value).toMatch(/^daily, daily:/);
    const date = titleInput()!.value.split(' · ')[1];
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount([{ id: 7, title: `Log ${date}`, body: 'b', color: 'butter', tags: ['daily'] }]);
    await press('Daily note');
    expect(q('#notes-editor-title')?.textContent).toBe('Edit your note');
    expect(titleInput()?.value).toBe(`Log ${date}`);
  });

  it.each([
    ['Heading', '## '], ['Bold', '**'], ['Italic', '*'], ['Bullet list', '- '], ['Checklist', '- [ ]'], ['Quote', '> '], ['Code block', '```'], ['Divider', '---'],
  ])('formats with %s', async (label, marker) => {
    await mount();
    await openNew();
    await press(label, q('.notes-format-toolbar')!);
    expect(bodyInput()?.value).toContain(marker);
  });

  it('applies keyboard bold/italic and refuses formatting over the limit', async () => {
    await mount();
    await openNew();
    await key(bodyInput(), 'b', { ctrlKey: true });
    expect(bodyInput()?.value).toContain('**');
    await type(bodyInput(), 'plain');
    await key(bodyInput(), 'i', { metaKey: true });
    expect(bodyInput()?.value).toContain('*');
    await type(bodyInput(), 'x'.repeat(6000));
    await press('Divider', q('.notes-format-toolbar')!);
    expect(notice()).toContain('Formatting would exceed the 6,000 character limit');
  });

  it('opens the slash menu on a new line, navigates it and inserts a block', async () => {
    await mount();
    await openNew();
    await type(bodyInput(), '/', 1);
    const menu = () => q('.notes-slash-menu');
    expect(menu()).not.toBeNull();
    await key(bodyInput(), 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Heading');
    await key(menu(), 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Bullet list');
    await key(menu(), 'ArrowUp');
    expect(document.activeElement?.textContent).toBe('Heading');
    await press('Quote', menu()!);
    expect(bodyInput()?.value.startsWith('/')).toBe(false);
    expect(bodyInput()?.value).toContain('> ');
    expect(menu()).toBeNull();
  });

  it('closes the slash menu with Escape from either the field or the menu', async () => {
    await mount();
    await openNew();
    await type(bodyInput(), '/', 1);
    await key(bodyInput(), 'Escape');
    expect(q('.notes-slash-menu')).toBeNull();
    await type(bodyInput(), '', 0);
    await type(bodyInput(), '/', 1);
    await key(q('.notes-slash-menu'), 'Escape');
    expect(q('.notes-slash-menu')).toBeNull();
  });

  it('closes the slash menu when the caret moves or the slash is removed', async () => {
    await mount();
    await openNew();
    await type(bodyInput(), '/', 1);
    await act(async () => { bodyInput()!.focus(); bodyInput()!.setSelectionRange(0, 0); bodyInput()!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); });
    expect(q('.notes-slash-menu')).toBeNull();
    await type(bodyInput(), 'x/', 2);
    expect(q('.notes-slash-menu')).toBeNull();
  });

  it('navigates tabs with the keyboard and previews markdown', async () => {
    await mount();
    await openNew();
    const tabs = () => q('.notes-editor-tabs');
    await key(tabs(), 'x');
    expect(bodyInput()).not.toBeNull();
    await key(tabs(), 'End');
    expect(q('#note-preview-panel')?.textContent).toContain('Your note preview will appear here.');
    await key(tabs(), 'ArrowLeft');
    expect(bodyInput()).not.toBeNull();
    await type(bodyInput(), '# Title text');
    await key(tabs(), 'ArrowRight');
    expect(q('#note-preview-panel h1')?.textContent).toBe('Title text');
    await key(tabs(), 'Home');
    expect(bodyInput()).not.toBeNull();
  });

  it('lists headings in an outline that returns to writing', async () => {
    await mount();
    await openNew();
    await type(bodyInput(), '## First\n\ntext');
    await press('Preview');
    await press('First', q('.notes-outline')!);
    expect(bodyInput()).not.toBeNull();
    expect(bodyInput()?.selectionStart).toBe(0);
  });

  it('inserts, resolves and navigates note links and backlinks', async () => {
    await mount();
    await click(q('[data-note-id="2"] [data-note-edit]'));
    const backlinks = q('.notes-links-panel')!;
    expect(backlinks.textContent).toContain('No linked notes yet.');
    expect(button(/Alpha ↗/, backlinks)).toBeTruthy();
    await type(q('select[aria-label="Link a note"]'), '3');
    expect(bodyInput()?.value).toContain('Gamma');
    mocks.confirm.mockResolvedValue(false);
    await press(/Gamma ↗/, q('.notes-links-panel')!);
    expect(titleInput()?.value).toBe('Beta');
    mocks.confirm.mockResolvedValue(true);
    await press(/Gamma ↗/, q('.notes-links-panel')!);
    expect(titleInput()?.value).toBe('Gamma');
  });

  it('labels unresolved and ambiguous note links', async () => {
    const twins = [{ id: 1, title: 'Twin', body: 'a', color: 'butter' }, { id: 2, title: 'Twin', body: 'b', color: 'sky' }, { id: 3, title: 'Host', body: '[[Twin]] [[Missing]]', color: 'mint' }];
    await mount(twins);
    await click(q('[data-note-id="3"] [data-note-edit]'));
    const panel = q('.notes-links-panel')!.textContent;
    expect(panel).toContain('Twin · Choose a unique note link');
    expect(panel).toContain('Missing · Note not found');
  });

  it('navigates from a rendered note link inside a card', async () => {
    await mount();
    const link = q('[data-note-id="1"] .sticky-note-copy a[href="#note-2"]');
    expect(link?.textContent).toBe('Beta');
    await click(link);
    expect(titleInput()?.value).toBe('Beta');
    expect(window.location.pathname).toBe('/notes/2');
  });

  it('restores a version through NoteDetails and announces it', async () => {
    const restored = { id: 2, title: 'Restored title', body: 'Restored body', color: 'rose' };
    await mount(baseNotes(), { 'PATCH /api/notes/2': { body: restored } });
    await click(q('[data-note-id="2"] [data-note-edit]'));
    await fetch('/api/notes/2', { method: 'PATCH' }); // the version restore endpoint already persisted it
    await click(q('[data-restore]'));
    expect(titleInput()?.value).toBe('Restored title');
    expect(q('[data-note-id="2"] h2')?.textContent).toBe('Restored title');
    expect(q('[data-note-color="rose"][data-note-id="2"]')).not.toBeNull();
  });

  describe('Enrich with Bob', () => {
    const openBob = async (id = 2) => { await click(q(`[data-note-id="${id}"] [data-note-enrich]`)); };

    it('is opened from the card, offers presets and toggles closed', async () => {
      await mount();
      await openBob();
      const content = () => q('.notes-enrichment-content');
      expect(content()).not.toBeNull();
      await press('Add examples', content()!);
      expect(button('Add examples', content()!).getAttribute('aria-pressed')).toBe('true');
      await click(q('.notes-enrichment-toggle'));
      expect(content()).toBeNull();
    });

    it('requires instructions before asking', async () => {
      await mount();
      await openBob();
      await type(q('textarea[aria-label="Instructions for Bob"]'), '  ');
      await press('✦ Ask Bob for a revision');
      expect(notice()).toContain('Add note content and tell Bob how to improve it');
      expect(mocks.enrich).not.toHaveBeenCalled();
    });

    it('shows a proposal that can be applied, blocking save until decided', async () => {
      mocks.enrich.mockImplementation(async (_note: unknown, _text: string, options: any) => { options.onStatus('Thinking'); return { title: 'Better', body: 'Better body' }; });
      await mount();
      await openBob();
      await press('✦ Ask Bob for a revision');
      const revision = () => q('[data-note-revision]');
      expect(revision()?.textContent).toContain('Better body');
      expect(button('Save note').disabled).toBe(true);
      await press('Use this revision');
      expect(q('.notes-revision-applied')?.textContent).toContain('Revision added to your draft');
      expect(titleInput()?.value).toBe('Better');
      expect(q('[role="tab"][aria-selected="true"]')?.textContent).toBe('Preview');
    });

    it('can discard a proposal, and a pending proposal needs confirmation to close', async () => {
      mocks.enrich.mockResolvedValue({ title: 'Better', body: 'Better body' });
      await mount();
      await openBob();
      await press('✦ Ask Bob for a revision');
      mocks.confirm.mockResolvedValue(false);
      await press('Cancel');
      expect(mocks.confirm).toHaveBeenCalledTimes(1);
      expect(q('[data-note-revision]')).not.toBeNull();
      await press('Discard suggestion');
      expect(q('[data-note-revision]')).toBeNull();
      await press('Cancel');
      expect(titleInput()).toBeNull();
    });

    it('reports errors and can be stopped mid-flight', async () => {
      mocks.enrich.mockRejectedValueOnce(new Error('Too busy'));
      await mount();
      await openBob();
      await press('✦ Ask Bob for a revision');
      expect(notice()).toContain('Too busy');
      let resolve: (value: unknown) => void = () => {};
      mocks.enrich.mockImplementation(() => new Promise(done => { resolve = done; }));
      await press('✦ Ask Bob for a revision');
      expect(q('.notes-enrichment-progress [role="status"]')?.textContent).toContain('Asking Bob…');
      expect(bodyInput()?.disabled).toBe(true);
      await press('Stop', q('.notes-enrichment-progress')!);
      expect(q('.notes-enrichment-progress')).toBeNull();
      await act(async () => resolve({ title: 'Late', body: 'late' }));
      await flush();
      expect(q('[data-note-revision]')).toBeNull();
    });
  });

  describe('deep links and history', () => {
    it.each([
      ['/notes/3', 'Gamma'],
      ['/notes?note=2', 'Beta'],
    ])('opens %s directly', async (path, title) => {
      await mount(baseNotes(), {}, path);
      expect(titleInput()?.value).toBe(title);
    });

    it('opens the new editor at /notes/new', async () => {
      await mount(baseNotes(), {}, '/notes/new');
      expect(q('#notes-editor-title')?.textContent).toBe('A new thought');
    });

    it('reports a missing linked note', async () => {
      await mount(baseNotes(), {}, '/notes/999');
      expect(notice()).toContain('Note not found');
      expect(titleInput()).toBeNull();
    });

    it('ignores a malformed note query', async () => {
      await mount(baseNotes(), {}, '/notes?note=abc');
      expect(notice()).toBe('');
      expect(titleInput()).toBeNull();
    });

    it('follows browser history unless the draft has unsaved changes', async () => {
      await mount();
      const pop = async (path: string) => { window.history.replaceState({}, '', path); await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); }); await flush(); };
      await pop('/notes/3');
      expect(titleInput()?.value).toBe('Gamma');
      await pop('/notes');
      expect(titleInput()).toBeNull();
      await pop('/notes/new');
      expect(q('#notes-editor-title')?.textContent).toBe('A new thought');
      await type(titleInput(), 'Unsaved');
      await pop('/notes');
      expect(titleInput()?.value).toBe('Unsaved');
    });
  });
});
