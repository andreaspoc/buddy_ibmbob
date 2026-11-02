// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/components/LessonContent', () => ({ LessonContent: ({ text }: { text: string }) => <div data-lesson-content>{text}</div> }));
vi.mock('../../src/components/LessonBoard', () => ({
  LessonBoard: ({ board }: { board: { layout: string; cards: unknown[] } }) => <div data-board>{`${board.layout}:${board.cards.length}`}</div>,
  newBoardCard: () => ({ id: crypto.randomUUID(), title: 'New learning card', body: '', color: 'violet', next_ids: [] }),
}));

import { LearningLessons } from '../../src/components/LearningLessons';
import { LearningLanguageProvider } from '../../src/learningLanguage';

type Reply = { status?: number; body?: unknown };
type Props = Partial<React.ComponentProps<typeof LearningLessons>>;
const FOLDER = 'f1';
const step = (over: Record<string, unknown> = {}) => ({ id: 's1', kind: 'text', title: 'Intro', text: 'Read this', url: '', asset_id: null, options: [], answer: null, feedback: '', board: null, ...over });
const summary = (over: Record<string, unknown> = {}) => ({ id: 'l1', title: 'First lesson', status: 'draft', version: 1, is_creator: true, ...over });
const lessonRow = (over: Record<string, unknown> = {}) => ({ ...summary({ status: 'published', is_creator: false }), description: 'About it', steps: [step(), step({ id: 's2', title: 'Second', text: 'More' })], draft_digest: 'dg1', ...over });
const question = (over: Record<string, unknown> = {}) => step({ id: 'q', kind: 'question', title: 'Quiz me', options: ['Yes', 'No'], answer: 0, feedback: 'Because', ...over });

let host: HTMLDivElement;
let root: Root;
let items: unknown[];
let lessons: Record<string, unknown>;
let overrides: Record<string, Reply>;
let calls: { url: string; method: string; body: any }[];

function respond(path: string, method: string): Reply {
  const hit = overrides[`${method} ${path}`];
  if (hit) return hit;
  if (method === 'GET' && path === `/folders/${FOLDER}/lessons`) return { body: { items } };
  if (method === 'GET' && lessons[path]) return { body: lessons[path] };
  if (method === 'POST' && path === `/folders/${FOLDER}/lessons`) return { body: { id: 'new', draft_digest: 'dg-new' } };
  if (method === 'PUT' && path.startsWith('/lessons/') && !path.endsWith('/progress')) return { body: { draft_digest: 'dg2' } };
  return { body: {} };
}

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const button = (label: string | RegExp, scope: ParentNode = host) => {
  const found = [...scope.querySelectorAll('button')].find(item => (typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent || '')));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
};
const hasButton = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll('button')].some(item => item.textContent?.trim() === label);
const click = async (element: Element | null) => { await act(async () => { element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await flush(); };
const press = (label: string | RegExp, scope?: ParentNode) => click(button(label, scope));
const type = async (element: Element | null, value: string) => {
  await act(async () => {
    const field = element as HTMLInputElement;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};
const field = (text: string, scope: ParentNode = host, tag = 'input,textarea,select') => [...scope.querySelectorAll('label')].find(label => label.textContent?.trim().startsWith(text))?.querySelector(tag) ?? null;
const pick = async (input: Element | null, file: File, size?: number) => {
  if (size) Object.defineProperty(file, 'size', { value: size });
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};
const alertText = () => q('[role="alert"]')?.textContent || '';
const noticeText = () => q('.learning-notice[role="status"]')?.textContent || '';
const sent = (method: string, part = '') => calls.filter(call => call.method === method && call.url.includes(part));
const sections = () => [...host.querySelectorAll('form > fieldset > article.lesson-section')];
const titles = () => [...host.querySelectorAll('.lesson-grid h3')].map(item => item.textContent);

async function mount(props: Props = {}) {
  await act(async () => root.render(<LearningLessons folderId={FOLDER} canCreate search="" {...props} />));
  await flush();
}
async function newDraft(props: Props = {}) {
  await mount(props);
  await press('+ Create lesson');
  await type(field('Lesson title'), 'My lesson');
}
async function openPlayer(row: Record<string, unknown>, props: Props = {}) {
  lessons['/lessons/l1'] = lessonRow(row);
  items = [summary({ status: 'published', is_creator: Boolean(row.is_creator) })];
  await mount(props);
  await press(row.is_creator ? 'Preview' : 'Open lesson');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  items = [summary()];
  lessons = {};
  overrides = {};
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const path = url.replace('/api/learning', '');
    calls.push({ url: path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const { status = 200, body = {} } = respond(path, method);
    return { ok: status < 400, status, json: async () => { if (body === 'BAD') throw new Error('bad'); return body; } };
  }));
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  (Element.prototype as any).animate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('lesson list', () => {
  it.each([
    [{ detail: 'No folder' }, 'No folder'],
    ['BAD', 'Unable to complete this request (500). Check the lesson fields.'],
  ])('shows a load failure (%#)', async (body, text) => {
    overrides[`GET /folders/${FOLDER}/lessons`] = { status: 500, body };
    await mount();
    expect(alertText()).toBe(text);
  });

  it.each([
    [true, 'Create a lesson, write your content'],
    [false, 'Your assigned lessons will appear here'],
  ])('explains an empty list (canCreate=%s)', async (canCreate, text) => {
    items = [];
    await mount({ canCreate });
    expect(host.textContent).toContain(text);
    expect(hasButton('+ Create lesson')).toBe(canCreate);
  });

  it('reports the loaded lessons to the host', async () => {
    const onLessonsChange = vi.fn();
    await mount({ onLessonsChange });
    expect(onLessonsChange).toHaveBeenCalledWith(items);
  });

  it('offers creators every action and learners only published lessons', async () => {
    items = [summary(), summary({ id: 'l2', title: 'Published', status: 'published' }), summary({ id: 'l3', title: 'Hidden draft', is_creator: false }), summary({ id: 'l4', title: 'Assigned', status: 'published', is_creator: false })];
    await mount({ onDraftQuiz: vi.fn(async () => undefined) });
    const cards = [...host.querySelectorAll('.lesson-grid > article')];
    expect(hasButton('Approve & publish', cards[0])).toBe(true);
    expect(hasButton('Approve & publish', cards[1])).toBe(false);
    expect(hasButton('Preview', cards[2])).toBe(false);
    expect(hasButton('Open lesson', cards[2])).toBe(false);
    expect(hasButton('Open lesson', cards[3])).toBe(true);
    expect(hasButton('Delete', cards[3])).toBe(false);
    expect(hasButton('Draft Quiz', cards[3])).toBe(true);
  });

  it('drafts a quiz through the host and shows its failure', async () => {
    const onDraftQuiz = vi.fn(async () => { throw new Error('No quiz'); });
    await mount({ onDraftQuiz });
    await press('Draft Quiz');
    expect(onDraftQuiz).toHaveBeenCalledWith(items[0]);
    expect(alertText()).toBe('No quiz');
  });

  it('searches titles, including translated ones, and hides reorder controls during a search', async () => {
    localStorage.setItem('buddy-learning-language', 'el');
    items = [summary({ translations: { el: { title: 'Ελληνικό μάθημα' } } }), summary({ id: 'l2', title: 'Other' })];
    await act(async () => root.render(<LearningLanguageProvider><LearningLessons folderId={FOLDER} canCreate search="ελληνικό" /></LearningLanguageProvider>));
    await flush();
    expect(titles()).toEqual(['Ελληνικό μάθημα']);
    expect(q('.lesson-reorder-controls')).toBeNull();
  });

  describe('reordering', () => {
    beforeEach(() => { items = [summary(), summary({ id: 'l2', title: 'Second lesson' })]; });

    it('moves lessons, disabling impossible moves', async () => {
      const onLessonsChange = vi.fn();
      await mount({ onLessonsChange });
      expect(q<HTMLButtonElement>('button[aria-label="Move First lesson earlier"]')?.disabled).toBe(true);
      expect(q<HTMLButtonElement>('button[aria-label="Move Second lesson later"]')?.disabled).toBe(true);
      await click(q('button[aria-label="Move First lesson later"]'));
      expect(titles()).toEqual(['Second lesson', 'First lesson']);
      expect(sent('PUT', '/lessons/order')[0].body).toEqual({ lesson_ids: ['l2', 'l1'] });
      expect(noticeText()).toBe('Lesson order updated.');
      expect(onLessonsChange).toHaveBeenLastCalledWith([items[1], items[0]]);
      await click(q('button[aria-label="Move First lesson earlier"]'));
      expect(titles()).toEqual(['First lesson', 'Second lesson']);
    });

    it('restores the server order when saving fails', async () => {
      overrides[`PUT /folders/${FOLDER}/lessons/order`] = { status: 500, body: { detail: 'Order refused' } };
      await mount();
      await click(q('button[aria-label="Move First lesson later"]'));
      expect(alertText()).toBe('Order refused');
      expect(titles()).toEqual(['First lesson', 'Second lesson']);
    });
  });

  it('publishes after approval and can cancel', async () => {
    await mount();
    await press('Approve & publish');
    expect(q('dialog')?.textContent).toContain('Publish “First lesson” to everyone');
    await press('Cancel', q('dialog')!);
    expect(q('dialog')).toBeNull();
    expect(sent('POST', '/publish')).toHaveLength(0);
    await press('Approve & publish');
    await press('Approve & publish', q('dialog')!);
    expect(sent('POST', '/publish')[0].url).toBe('/lessons/l1/publish');
    expect(noticeText()).toBe('Lesson published successfully.');
  });

  it('deletes after confirmation and reports failures', async () => {
    await mount();
    await press('Delete');
    expect(q('dialog')?.textContent).toContain('Are you sure you want to delete “First lesson”?');
    await press('Delete lesson', q('dialog')!);
    expect(noticeText()).toBe('Lesson deleted.');
    overrides['DELETE /lessons/l1'] = { status: 403, body: { detail: 'Not yours' } };
    await press('Delete');
    await press('Delete lesson', q('dialog')!);
    expect(alertText()).toBe('Not yours');
  });

  it('copies a lesson as an independent new draft with fresh ids', async () => {
    lessons['/lessons/l1'] = lessonRow({ title: 'T'.repeat(250) });
    await mount();
    await press('Copy as new lesson');
    expect((field('Lesson title') as HTMLInputElement).value).toBe(`${'T'.repeat(193)} (copy)`);
    expect(q('form h2')?.textContent).toBe('Create lesson');
    expect(noticeText()).toContain('Independent lesson copy created');
    await press('Save draft');
    const body = sent('POST', '/lessons')[0].body;
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].id).not.toBe('s1');
  });

  it('warns on unload once the draft has changed', async () => {
    await newDraft();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('opening via props', () => {
  it('starts a new lesson when asked', async () => {
    const onLessonOpened = vi.fn();
    await mount({ createNewLesson: true, onLessonOpened });
    expect(q('form h2')?.textContent).toBe('Create lesson');
    expect(onLessonOpened).toHaveBeenCalled();
  });

  it('opens a lesson in the editor, using the matching translation', async () => {
    localStorage.setItem('buddy-learning-language', 'el');
    lessons['/lessons/l1'] = lessonRow({ language: 'en', approved_languages: ['en'], translations: { el: { title: 'Τίτλος', description: 'Περιγραφή', steps: [step({ title: 'Α' }), step({ id: 's2', title: 'Β' })] } } });
    const onLessonOpened = vi.fn();
    await mount({ openLessonId: 'l1', openLessonEditor: true, onLessonOpened });
    expect(q('form h2')?.textContent).toBe('Edit lesson');
    expect((field('Lesson title') as HTMLInputElement).value).toBe('Τίτλος');
    expect((field('Section title') as HTMLInputElement).value).toBe('Α');
    expect(onLessonOpened).toHaveBeenCalled();
  });

  it('falls back to the base lesson when a translation is partial', async () => {
    localStorage.setItem('buddy-learning-language', 'el');
    lessons['/lessons/l1'] = lessonRow({ translations: { el: { steps: [step({ title: 'Only one' })] } } });
    await mount({ openLessonId: 'l1', openLessonEditor: true });
    expect((field('Lesson title') as HTMLInputElement).value).toBe('First lesson');
    expect((field('Section title') as HTMLInputElement).value).toBe('Intro');
  });

  it('opens in the player and reports failure', async () => {
    lessons['/lessons/l1'] = lessonRow();
    await mount({ openLessonId: 'l1' });
    expect(q('.lesson-player')).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    overrides['GET /lessons/l2'] = { status: 404, body: { detail: 'Lesson missing' } };
    await mount({ openLessonId: 'l2' });
    expect(alertText()).toBe('Lesson missing');
  });
});

describe('saving a lesson', () => {
  it('creates a draft, then updates it with the returned digest', async () => {
    await newDraft();
    await type(field('Introduction'), 'Overview');
    await act(async () => { q('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(sent('POST', '/lessons')[0].body).toMatchObject({ title: 'My lesson', description: 'Overview' });
    expect(noticeText()).toBe('Draft saved.');
    expect(q('form h2')?.textContent).toBe('Edit lesson');
    await press('Save draft');
    expect(sent('PUT', '/lessons/new')[0].body.expected_digest).toBe('dg-new');
  });

  it('saves and publishes in one step', async () => {
    await newDraft();
    await press('Save & Publish');
    expect(sent('POST', '/publish')[0]).toMatchObject({ url: '/lessons/new/publish', body: { expected_digest: 'dg-new' } });
    expect(noticeText()).toBe('Lesson saved and published.');
  });

  it('shows a conflict while saving', async () => {
    lessons['/lessons/l1'] = lessonRow({ is_creator: true });
    await mount({ openLessonId: 'l1', openLessonEditor: true });
    overrides['PUT /lessons/l1'] = { status: 409, body: { detail: 'Someone else edited this' } };
    await press('Save draft');
    expect(alertText()).toBe('Someone else edited this');
    expect(sent('PUT', '/lessons/l1')[0].body.expected_digest).toBe('dg1');
  });

  it('approves all three languages, filling missing translations', async () => {
    await newDraft();
    await press(/Approve All 3 Languages/);
    const body = sent('POST', '/lessons')[0].body;
    expect(body.approved_languages).toEqual(['en', 'el', 'hi']);
    expect(Object.keys(body.translations).sort()).toEqual(['el', 'en', 'hi']);
    expect(body.translations.hi).toMatchObject({ title: 'My lesson', approved: true });
    expect(noticeText()).toContain('All 3 languages');
  });

  it('keeps the English entry as the canonical title when saving another language', async () => {
    await newDraft();
    await press(/Ελληνικά/, q('.learning-i18n-lang-tabs')!);
    await type(field('Lesson title'), 'Ελληνικός τίτλος');
    await press('Save draft');
    const body = sent('POST', '/lessons')[0].body;
    expect(body.title).toBe('My lesson');
    expect(body.translations.el.title).toBe('Ελληνικός τίτλος');
    expect(body.approved_languages).toEqual([]);
  });

  it('exports the draft as a JSON download', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const downloads: string[] = [];
    const clicker = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    await newDraft();
    await press('Export editable lesson');
    clicker.mockRestore();
    expect(downloads).toEqual(['lesson-draft.json']);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });
});

describe('leaving the editor', () => {
  it('asks before discarding unsaved changes', async () => {
    const onBackToChapters = vi.fn();
    await newDraft({ onBackToChapters });
    await press('Back to lessons');
    expect(q('dialog')?.textContent).toContain('Discard unsaved changes?');
    await press('Cancel', q('dialog')!);
    expect(q('form')).not.toBeNull();
    await press('Back to lessons');
    await press('Discard', q('dialog')!);
    expect(q('form')).toBeNull();
    expect(onBackToChapters).toHaveBeenCalledOnce();
  });

  it('leaves immediately when nothing changed', async () => {
    await mount();
    await press('+ Create lesson');
    await press('Back to lessons');
    expect(q('dialog')).toBeNull();
    expect(q('form')).toBeNull();
  });
});

describe('language approval', () => {
  const tab = (name: RegExp) => [...host.querySelectorAll('.learning-i18n-lang-pill')].find(item => name.test(item.textContent || ''))!;

  it('labels language state and toggles approval', async () => {
    await newDraft();
    expect(tab(/English/).querySelector('small')?.textContent).toBe('Ready');
    expect(tab(/हिन्दी/).querySelector('small')?.textContent).toBe('Draft');
    await click(tab(/English/).querySelector('.learning-i18n-approve-toggle'));
    expect(tab(/English/).querySelector('small')?.textContent).toBe('✓ Approved');
    expect(tab(/English/).classList.contains('is-approved')).toBe(true);
    await click(tab(/Ελληνικά/).querySelector('.learning-i18n-approve-toggle'));
    await click(tab(/English/).querySelector('.learning-i18n-approve-toggle'));
    expect(tab(/English/).querySelector('small')?.textContent).toBe('Ready');
    await press('Save draft');
    expect(sent('POST', '/lessons')[0].body.approved_languages).toEqual(['el']);
  });

  it('switching languages keeps each language draft', async () => {
    await newDraft();
    await press(/Ελληνικά/, q('.learning-i18n-lang-tabs')!);
    expect((field('Lesson title') as HTMLInputElement).value).toBe('My lesson');
    await type(field('Lesson title'), 'Νέος');
    await press(/English/, q('.learning-i18n-lang-tabs')!);
    expect((field('Lesson title') as HTMLInputElement).value).toBe('My lesson');
    await press(/Ελληνικά/, q('.learning-i18n-lang-tabs')!);
    expect((field('Lesson title') as HTMLInputElement).value).toBe('Νέος');
  });

  describe('generating three languages', () => {
    const generate = () => press(/Generate 3 Languages/);

    it('requires a title or a Buddy brief', async () => {
      await mount();
      await press('+ Create lesson');
      await generate();
      expect(alertText()).toContain('Add a lesson title or generate a Buddy draft first');
    });

    it('translates the current content into the other languages, keeping step counts safe', async () => {
      const replies: Reply[] = [
        { body: { translated: { title: 'Ελληνικά', description: 'Δ', steps: [step({ title: 'Μ' })] } } },
        { body: { translated: { steps: [] } } },
      ];
      await newDraft();
      overrides = new Proxy({} as Record<string, Reply>, { get: (_t, key) => (key === 'POST /translate-content' ? replies.shift() : undefined) });
      await generate();
      const posts = sent('POST', '/translate-content');
      expect(posts.map(call => call.body.target_language)).toEqual(['el', 'hi']);
      expect(posts[0].body.source_language).toBe('en');
      expect(noticeText()).toContain('Generated in English first, then Ελληνικά and हिन्दी');
      await press(/हिन्दी/, q('.learning-i18n-lang-tabs')!);
      expect((field('Lesson title') as HTMLInputElement).value).toBe('My lesson');
      await press(/Ελληνικά/, q('.learning-i18n-lang-tabs')!);
      expect((field('Lesson title') as HTMLInputElement).value).toBe('Ελληνικά');
      expect((field('Section title') as HTMLInputElement).value).toBe('Μ');
    });

    it('uses a complete Buddy draft directly', async () => {
      const entry = (title: string) => ({ title, description: 'd', steps: [step({ title })] });
      overrides[`POST /folders/${FOLDER}/lesson-draft`] = { body: { draft: { title: 'Base', description: 'b', steps: [step()], approved_languages: ['en'], translations: { en: entry('Eng'), el: entry('Ell'), hi: entry('Hin') } } } };
      await mount();
      await press('+ Create lesson');
      await type(field('Instructions for Buddy'), 'Teach gravity');
      await generate();
      expect(sent('POST', '/translate-content')).toHaveLength(0);
      expect((field('Lesson title') as HTMLInputElement).value).toBe('Eng');
      expect(noticeText()).toContain('Generated English first, followed by Ελληνικά and हिन्दी');
    });

    it('explains a translation reply with no translation instead of showing a raw error', async () => {
      overrides[`POST /folders/${FOLDER}/lesson-draft`] = { body: { draft: { title: 'Base', description: 'b', steps: [step()] } } };
      overrides['POST /translate-content'] = { body: {} };
      await mount();
      await press('+ Create lesson');
      await type(field('Instructions for Buddy'), 'Teach gravity');
      await generate();
      const text = document.body.textContent ?? '';
      expect(text).toContain('The translation service did not return a translation');
      expect(text).not.toMatch(/Cannot read|TypeError|undefined/);
    });

    it('translates a Buddy draft that came back in one language', async () => {
      overrides[`POST /folders/${FOLDER}/lesson-draft`] = { body: { draft: { title: 'Base', description: 'b', steps: [step()] } } };
      overrides['POST /translate-content'] = { body: { translated: {} } };
      await mount();
      await press('+ Create lesson');
      await type(field('Instructions for Buddy'), 'Teach gravity');
      await generate();
      expect(sent('POST', '/translate-content').map(call => call.body.payload.title)).toEqual(['Base', 'Base']);
      expect((field('Lesson title') as HTMLInputElement).value).toBe('Base');
    });
  });
});

describe('importing material', () => {
  const importInput = () => field('Import document');
  const asJson = (value: unknown, name = 'lesson.json') => new File([typeof value === 'string' ? value : JSON.stringify(value)], name);
  const startEmpty = async () => { await mount(); await press('+ Create lesson'); };

  it('imports a JSON lesson, replacing the blank section and using its title', async () => {
    await startEmpty();
    await pick(importInput(), asJson({ title: 'Imported', steps: [{ title: 'From file', kind: 'reveal', text: 'Hidden' }] }));
    expect((field('Lesson title') as HTMLInputElement).value).toBe('Imported');
    expect(sections()).toHaveLength(1);
    expect((field('Section title') as HTMLInputElement).value).toBe('From file');
    expect(field('Hidden explanation')).not.toBeNull();
    expect(noticeText()).toContain('Material imported into editable sections');
  });

  it('adds to existing sections and keeps the current title', async () => {
    await newDraft();
    await type(field('Section title'), 'Kept');
    await pick(importInput(), asJson({ title: 'Other', description: 'x', steps: [{ title: 'Added', kind: 'text' }] }));
    expect((field('Lesson title') as HTMLInputElement).value).toBe('My lesson');
    expect(sections()).toHaveLength(2);
  });

  it.each([
    ['no steps', { title: 'X', steps: [] }],
    ['missing title', { steps: [{ title: 'A', kind: 'text' }] }],
    ['null body', null],
    ['invalid section', { title: 'X', steps: [{ kind: 'text' }] }],
    ['too many sections', { title: 'X', steps: Array.from({ length: 101 }, () => ({ title: 'A', kind: 'text' })) }],
  ])('rejects a JSON lesson with %s', async (_name, value) => {
    await startEmpty();
    await pick(importInput(), asJson(value));
    expect(alertText()).toBe('Import a lesson draft with a title and 1–100 activity sections.');
  });

  it('reports malformed JSON', async () => {
    await startEmpty();
    await pick(importInput(), asJson('{nope'));
    expect(alertText()).not.toBe('');
    expect(sections()).toHaveLength(1);
  });

  it.each([
    ['a document over 50 MB', 'big.pdf', 51 * 1024 * 1024, 'Upload a document no larger than 50 MB.'],
    ['JSON over 1 MB', 'big.json', 2 * 1024 * 1024, 'Lesson JSON must be no larger than 1 MB.'],
  ])('refuses %s', async (_name, name, size, text) => {
    await startEmpty();
    await pick(importInput(), new File(['x'], name), size);
    expect(alertText()).toBe(text);
  });

  it('uploads documents to the import endpoint', async () => {
    overrides[`POST /folders/${FOLDER}/lesson-import`] = { body: { title: 'From PDF', description: '', steps: [step({ id: 'p', title: 'Page 1' })] } };
    await startEmpty();
    await pick(importInput(), new File(['x'], 'notes.pdf'));
    expect(sent('POST', '/lesson-import')[0].body).toBeInstanceOf(FormData);
    expect((field('Section title') as HTMLInputElement).value).toBe('Page 1');
  });

  it('refuses to grow past 100 sections', async () => {
    await newDraft();
    await type(field('Section title'), 'Kept');
    await pick(importInput(), asJson({ title: 'X', steps: Array.from({ length: 100 }, () => ({ title: 'A', kind: 'text' })) }));
    expect(alertText()).toContain('A lesson supports up to 100 sections');
    expect(sections()).toHaveLength(1);
  });
});

describe('editing sections', () => {
  const kindSelect = (scope: ParentNode = host) => field('Activity type', scope);

  it('moves, duplicates and removes sections', async () => {
    await newDraft();
    await type(field('Section title'), 'A');
    await press('+ Add section');
    const names = () => sections().map(item => (field('Section title', item) as HTMLInputElement).value);
    await type(field('Section title', sections()[1]), 'B');
    expect(q<HTMLButtonElement>('button[aria-label="Move section 1 up"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('button[aria-label="Move section 2 down"]')?.disabled).toBe(true);
    await click(q('button[aria-label="Move section 1 down"]'));
    expect(names()).toEqual(['B', 'A']);
    await click(q('button[aria-label="Move section 2 up"]'));
    expect(names()).toEqual(['A', 'B']);
    await click(q('button[aria-label="Duplicate section 1"]'));
    expect(names()).toEqual(['A', 'A (copy)', 'B']);
    await press('Remove', sections()[1]);
    expect(names()).toEqual(['A', 'B']);
    await press('Remove', sections()[1]);
    expect(button('Remove', sections()[0]).disabled).toBe(true);
  });

  it.each([
    ['Learn', 'text', 'Content / instructions'],
    ['Discover', 'reveal', 'Hidden explanation'],
    ['Visual', 'image', 'Image description (alternative text)'],
  ])('adds a %s activity with fitting labels', async (label, kind, textLabel) => {
    await newDraft();
    await press(new RegExp(`${label}$`), q('.lesson-activity-toolbox')!);
    const added = sections()[1];
    expect((kindSelect(added) as HTMLSelectElement).value).toBe(kind);
    expect(field(textLabel, added)).not.toBeNull();
  });

  it('counts activities in the author summary', async () => {
    await newDraft();
    await press(/Practice$/, q('.lesson-activity-toolbox')!);
    await press(/Explore$/, q('.lesson-activity-toolbox')!);
    const summaryText = q('.lesson-author-summary')?.textContent;
    expect(summaryText).toContain('3 sections');
    expect(summaryText).toContain('1 practice activities');
    expect(summaryText).toContain('1 interactive boards');
  });

  it('edits question choices, the answer and feedback', async () => {
    await newDraft();
    await type(kindSelect(), 'question');
    await flush();
    expect((field('Choice 1') as HTMLInputElement).value).toBe('Choice 1');
    expect(button('Remove last choice').disabled).toBe(true);
    await press('Add choice');
    await type(field('Choice 3'), 'Third');
    await type(field('Correct choice'), '2');
    await type(field('Feedback after checking'), 'Well done');
    await type(field('Choice 1'), 'First');
    await press('Save draft');
    expect(sent('POST', '/lessons')[0].body.steps[0]).toMatchObject({ options: ['First', 'Choice 2', 'Third'], answer: 2, feedback: 'Well done' });
    await press('Remove last choice');
    expect(field('Choice 3')).toBeNull();
    expect((field('Correct choice') as HTMLSelectElement).value).toBe('0');
  });

  it('limits choices to eight', async () => {
    await newDraft();
    await type(kindSelect(), 'question');
    await flush();
    for (let index = 0; index < 6; index += 1) await press('Add choice');
    expect(button('Add choice').disabled).toBe(true);
  });

  it('stores private teacher notes on the section', async () => {
    await newDraft();
    await type(field('Teaching guidance'), 'Take five minutes');
    await type(field('Content / instructions'), 'Body text');
    await press('Save draft');
    expect(sent('POST', '/lessons')[0].body.steps[0]).toMatchObject({ teacher_notes: 'Take five minutes', text: 'Body text' });
  });

  describe('boards', () => {
    const startBoard = async () => { await newDraft(); await type(kindSelect(), 'board'); await flush(); };
    const cards = () => [...host.querySelectorAll('.lesson-board-editor > article')];

    it('edits cards and updates the learner preview', async () => {
      await startBoard();
      expect(q('[data-board]')?.textContent).toBe('cards:2');
      expect(host.textContent).toContain('Learners reveal each card');
      expect(button('Remove card', cards()[0]).disabled).toBe(true);
      await press('+ Add learning card');
      expect(q('[data-board]')?.textContent).toBe('cards:3');
      await type(field('Card title', cards()[0]), 'Gravity');
      await type(field('Card content', cards()[0]), 'Pulls down');
      await type(field('Card color', cards()[0]), 'green');
      await press('Remove card', cards()[2]);
      await press('Save draft');
      const board = sent('POST', '/lessons')[0].body.steps[0].board;
      expect(board.cards).toHaveLength(2);
      expect(board.cards[0]).toMatchObject({ title: 'Gravity', body: 'Pulls down', color: 'green' });
    });

    it('caps a board at twelve cards', async () => {
      await startBoard();
      for (let index = 0; index < 10; index += 1) await press('+ Add learning card');
      expect(button('+ Add learning card').disabled).toBe(true);
    });

    it('connects branching paths, resets links on layout change and limits choices', async () => {
      await startBoard();
      await press('+ Add learning card');
      await press('+ Add learning card');
      await press('+ Add learning card');
      await press('+ Add learning card');
      await type(field('Board style'), 'path');
      await flush();
      expect(host.textContent).toContain('The first card starts the scenario.');
      const links = () => [...cards()[0].querySelectorAll<HTMLInputElement>('.lesson-choice input')];
      expect(links()).toHaveLength(5);
      for (let index = 0; index < 4; index += 1) await click(links()[index]);
      expect(links()[4].disabled).toBe(true);
      await click(links()[0]);
      expect(links()[4].disabled).toBe(false);
      await press('Remove card', cards()[2]); // also drops the link pointing at it
      await press('Save draft');
      const board = sent('POST', '/lessons')[0].body.steps[0].board;
      expect(board.layout).toBe('path');
      expect(board.cards[0].next_ids).toHaveLength(2);
      await type(field('Board style'), 'cards');
      await flush();
      await type(field('Board style'), 'path');
      await flush();
      expect(links().filter(item => item.checked)).toHaveLength(0);
    });
  });

  describe('media', () => {
    const upload = (kind: string) => field(kind);
    const asset = (mime: string) => { overrides[`POST /folders/${FOLDER}/lesson-assets`] = { body: { id: 'asset1', mime } }; };

    it('attaches an uploaded image', async () => {
      asset('image/png');
      await newDraft();
      await type(field('Activity type'), 'image');
      await flush();
      await pick(upload('Upload image'), new File(['x'], 'pic.png'));
      expect(host.textContent).toContain('Media attached');
      expect(noticeText()).toBe('Uploaded pic.png. Save the draft to preview it.');
    });

    it('rejects a file not matching the section', async () => {
      asset('image/png');
      await newDraft();
      await type(field('Activity type'), 'video');
      await flush();
      await pick(upload('Or upload MP4'), new File(['x'], 'pic.png'));
      expect(alertText()).toBe('Choose a file matching this section type.');
    });

    it('refuses oversized media before uploading', async () => {
      await newDraft();
      await type(field('Activity type'), 'video');
      await flush();
      await pick(upload('Or upload MP4'), new File(['x'], 'big.mp4'), 51 * 1024 * 1024);
      expect(alertText()).toBe('Upload media no larger than 50 MB.');
      expect(sent('POST', '/lesson-assets')).toHaveLength(0);
    });

    it('clears an attachment when a video URL is typed', async () => {
      asset('video/mp4');
      await newDraft();
      await type(field('Activity type'), 'video');
      await flush();
      await pick(upload('Or upload MP4'), new File(['x'], 'clip.mp4'));
      expect(host.textContent).toContain('Media attached');
      await type(field('YouTube or Vimeo URL'), 'https://example.test/v');
      expect(host.textContent).not.toContain('Media attached');
    });
  });

  describe('Buddy proposals', () => {
    const proposal = (over: Record<string, unknown> = {}) => ({ title: 'Proposed', description: 'Why', steps: [step({ id: 'p1', title: 'Prop text' }), question({ id: 'p2' }), step({ id: 'p3', kind: 'board', title: 'Prop board', board: { layout: 'cards', cards: [{}, {}] } })], ...over });
    const ask = async (truncated = false, draft = proposal()) => {
      overrides[`POST /folders/${FOLDER}/lesson-draft`] = { body: { draft, source_truncated: truncated } };
      await type(field('Instructions for Buddy'), 'Improve it');
      await press('Draft with Buddy');
    };

    it('stays disabled without instructions', async () => {
      await newDraft();
      expect(button('Draft with Buddy').disabled).toBe(true);
    });

    it('shows a proposal for review, marking the right answer', async () => {
      await newDraft();
      await ask();
      const shown = q('.lesson-proposal')!;
      expect(sent('POST', '/lesson-draft')[0].body).toMatchObject({ message: 'Improve it', language: 'en' });
      expect(sent('POST', '/lesson-draft')[0].body.current.title).toBe('My lesson');
      expect(shown.textContent).toContain('Yes (correct)');
      expect(shown.textContent).not.toContain('No (correct)');
      expect(shown.querySelector('[data-board]')?.textContent).toBe('cards:2');
      expect(noticeText()).toBe('Buddy’s proposal is ready for your review.');
    });

    it('warns about a truncated source and sends no current draft when empty', async () => {
      await mount();
      await press('+ Create lesson');
      await ask(true);
      expect(sent('POST', '/lesson-draft')[0].body.current).toBeNull();
      expect(noticeText()).toContain('Buddy used part of your source material.');
    });

    it('applies a proposal, retaining uploaded media', async () => {
      await newDraft();
      await type(field('Activity type'), 'image');
      await flush();
      await ask();
      await press('Apply Buddy proposal');
      expect((field('Lesson title') as HTMLInputElement).value).toBe('Proposed');
      expect(sections()).toHaveLength(4);
      expect((field('Activity type', sections()[3]) as HTMLSelectElement).value).toBe('image');
      expect(q('.lesson-proposal')).toBeNull();
    });

    it('can discard a proposal and refuses one that would overflow', async () => {
      await newDraft();
      await type(field('Activity type'), 'image');
      await flush();
      await ask();
      await press('Discard proposal');
      expect(q('.lesson-proposal')).toBeNull();
      await ask(false, proposal({ steps: Array.from({ length: 100 }, (_, index) => step({ id: `p${index}`, title: `P${index}` })) }));
      await press('Apply Buddy proposal');
      expect(alertText()).toBe('Split this lesson into smaller lessons before applying.');
    });
  });
});

describe('author preview', () => {
  const previewWith = async (setup?: () => Promise<void>) => {
    await newDraft();
    await setup?.();
    await press('Preview lesson');
  };

  it('previews a draft and returns to the editor', async () => {
    await previewWith();
    expect(q('.lesson-eyebrow')?.textContent).toBe('AUTHOR PREVIEW');
    expect(q('.lesson-player h2')?.textContent).toBe('My lesson');
    expect(button('Finish preview').disabled).toBe(false);
    await press('Finish preview');
    expect(noticeText()).toBe('End of author preview.');
    await press('Back to editor');
    expect(q('form')).not.toBeNull();
    expect((field('Lesson title') as HTMLInputElement).value).toBe('My lesson');
  });

  it('checks answers locally without calling the server', async () => {
    await previewWith(async () => {
      await type(field('Activity type'), 'question');
      await flush();
      await type(field('Feedback after checking'), 'Local feedback');
    });
    await click(host.querySelectorAll('.lesson-choice input')[1]);
    await press('Check answer');
    expect(sent('POST', '/check')).toHaveLength(0);
    expect(q('.lesson-practice-feedback')?.textContent).toContain('Not quite');
    await click(host.querySelectorAll('.lesson-choice input')[0]);
    await press('Check answer');
    expect(q('.lesson-practice-feedback')?.textContent).toContain('✓ Correct. Well done!');
    expect(q('.lesson-practice-feedback')?.textContent).toContain('Local feedback');
  });

  it('asks to save before previewing unsaved uploaded media', async () => {
    overrides[`POST /folders/${FOLDER}/lesson-assets`] = { body: { id: 'a1', mime: 'video/mp4' } };
    await previewWith(async () => {
      await type(field('Activity type'), 'video');
      await flush();
      await pick(field('Or upload MP4'), new File(['x'], 'clip.mp4'));
    });
    expect(q('.lesson-activity-card .learning-notice')?.textContent).toBe('Save your draft to preview uploaded media.');
    expect(q('video')).toBeNull();
  });

  it('keeps answers when moving between preview sections', async () => {
    await previewWith(async () => {
      await type(field('Activity type'), 'question');
      await flush();
      await press('+ Add section');
    });
    await click(host.querySelectorAll('.lesson-choice input')[0]);
    await press('Check answer');
    await press('Save & continue');
    expect(q('.lesson-choice')).toBeNull();
    await press('Previous');
    expect(q('.lesson-practice-feedback')?.textContent).toContain('✓ Correct');
    expect(host.querySelector('.lesson-outline')?.textContent).toContain('✓ Answered');
  });
});

describe('lesson player', () => {
  it('resumes from saved progress and shows the path', async () => {
    await openPlayer({ progress: { step: 1, completed: false } });
    expect(q('.lesson-progress-bar')?.textContent).toContain('Section 2 of 2');
    expect(q('.lesson-eyebrow')?.textContent).toBe('YOUR LEARNING JOURNEY');
    const outline = [...host.querySelectorAll('.lesson-outline button')];
    expect(outline[0].className).toBe('is-step-done');
    expect(outline[1].getAttribute('aria-current')).toBe('step');
  });

  it('saves progress when continuing and completes the lesson', async () => {
    const onProgressChange = vi.fn();
    await openPlayer({}, { onProgressChange });
    expect(q('.lesson-player-controls small')?.textContent).toBe('Up next: Second');
    await press('Save & continue');
    expect(sent('PUT', '/progress')[0].body).toEqual({ version: 1, step: 1, completed: false });
    expect(noticeText()).toBe('Progress saved.');
    await press('Complete lesson');
    expect(sent('PUT', '/progress')[1].body).toEqual({ version: 1, step: 1, completed: true });
    expect(q('.lesson-completion')?.textContent).toContain('You finished First lesson');
    expect(noticeText()).toBe('Lesson completed. Your progress is saved.');
    expect(onProgressChange).toHaveBeenLastCalledWith('l1', { step: 1, completed: true, started: true });
  });

  it('reviews a completed lesson from the start', async () => {
    await openPlayer({ progress: { step: 1, completed: false } });
    await press('Complete lesson');
    await press('Review lesson');
    expect(q('.lesson-completion')).toBeNull();
    expect(q('.lesson-progress-bar')?.textContent).toContain('Section 1 of 2');
    expect(q('.lesson-progress-bar')?.textContent).toContain('Completed');
    expect(q('.lesson-eyebrow')?.textContent).toBe('COMPLETED LESSON');
  });

  it('moves on from the completion screen and saves progress', async () => {
    const onBackToChapters = vi.fn();
    await openPlayer({ progress: { step: 1, completed: true } }, { onBackToChapters });
    await press('Complete lesson');
    await press('Explore more lessons');
    expect(q('.lesson-player')).toBeNull();
    expect(onBackToChapters).toHaveBeenCalled();
    expect(sent('PUT', '/progress').at(-1)?.body.completed).toBe(true);
  });

  it('limits learners to reached sections and lets authors jump anywhere', async () => {
    await openPlayer({});
    const outline = () => [...host.querySelectorAll<HTMLButtonElement>('.lesson-outline button')];
    expect(outline()[1].disabled).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(host);
    await openPlayer({ is_creator: true });
    expect(outline()[1].disabled).toBe(false);
    await click(outline()[1]);
    expect(q('.lesson-activity-card h3')?.textContent).toBe('Second');
    expect(button('Edit lesson')).toBeTruthy();
  });

  it('opens the editor from the player', async () => {
    await openPlayer({ is_creator: true });
    await press('Edit lesson', q('.lesson-player-header-actions')!);
    expect(q('form h2')?.textContent).toBe('Edit lesson');
    expect(q('.lesson-player')).toBeNull();
  });

  it('saves progress on leave and on unmount, ignoring save failures', async () => {
    overrides['PUT /lessons/l1/progress'] = { status: 500, body: {} };
    const onProgressChange = vi.fn();
    await openPlayer({}, { onProgressChange });
    await press('Back to lessons');
    expect(sent('PUT', '/progress')).toHaveLength(1);
    expect(onProgressChange).toHaveBeenCalledWith('l1', { step: 0, completed: false, started: true });
    expect(alertText()).toBe('');
    await press('Open lesson');
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(sent('PUT', '/progress')).toHaveLength(2);
  });

  it('does not save progress for a draft opened in preview', async () => {
    lessons['/lessons/l1'] = lessonRow({ status: 'draft', is_creator: true });
    await mount();
    await press('Preview');
    expect(q('.lesson-eyebrow')?.textContent).toBe('AUTHOR PREVIEW');
    await press('Save & continue');
    expect(q('.lesson-progress-bar')?.textContent).toContain('Section 2 of 2');
    await press('Back to lessons');
    expect(sent('PUT', '/progress')).toHaveLength(0);
  });

  it('shows an error when saving progress fails', async () => {
    overrides['PUT /lessons/l1/progress'] = { status: 500, body: { detail: 'Offline' } };
    await openPlayer({});
    await press('Save & continue');
    expect(alertText()).toBe('Offline');
    expect(q('.lesson-progress-bar')?.textContent).toContain('Section 1 of 2');
  });

  it('labels untitled lessons and sections', async () => {
    await openPlayer({ title: '', steps: [step({ title: '' }), step({ id: 's2', title: '' })] });
    expect(q('.lesson-player h2')?.textContent).toBe('Untitled lesson');
    expect(q('.lesson-activity-card h3')?.textContent).toBe('Untitled section');
    expect(q('.lesson-outline')?.textContent).toContain('Untitled section');
  });

  it('shows a translated lesson with the matching step count', async () => {
    localStorage.setItem('buddy-learning-language', 'el');
    lessons['/lessons/l1'] = lessonRow({ translations: { el: { title: 'Μάθημα', description: 'Περιγραφή', steps: [step({ title: 'Ενότητα 1' }), step({ id: 's2', title: 'Ενότητα 2' })] } } });
    await act(async () => root.render(<LearningLanguageProvider><LearningLessons folderId={FOLDER} canCreate={false} search="" openLessonId="l1" /></LearningLanguageProvider>));
    await flush();
    expect(q('.lesson-player h2')?.textContent).toBe('Μάθημα');
    expect(q('.lesson-activity-card h3')?.textContent).toBe('Ενότητα 1');
  });

  describe('activities', () => {
    it.each([
      ['reveal', step({ kind: 'reveal', title: 'Secret' }), '.lesson-reveal summary', 'Reveal explanation'],
      ['board', step({ kind: 'board', board: { layout: 'path', cards: [{}, {}, {}] } }), '[data-board]', 'path:3'],
    ])('renders a %s section', async (_kind, content, selector, text) => {
      await openPlayer({ steps: [content] });
      expect(q(selector)?.textContent).toContain(text);
    });

    it('shows uploaded images with alternative text', async () => {
      await openPlayer({ steps: [step({ kind: 'image', asset_id: 'pic', text: 'A diagram' })] });
      expect(q('img')?.getAttribute('src')).toBe('/api/learning/lessons/l1/assets/pic');
      expect(q('img')?.getAttribute('alt')).toBe('A diagram');
    });

    it('falls back to the title for image alternative text', async () => {
      await openPlayer({ steps: [step({ kind: 'image', asset_id: 'pic', text: '' })] });
      expect(q('img')?.getAttribute('alt')).toBe('Intro');
    });

    it('plays uploaded video and sandboxes embedded video', async () => {
      await openPlayer({ steps: [step({ kind: 'video', asset_id: 'clip' }), step({ id: 's2', kind: 'video', url: 'https://example.test/embed', title: 'Clip' })], is_creator: true });
      expect(q('video')?.getAttribute('src')).toBe('/api/learning/lessons/l1/assets/clip');
      await press('Save & continue');
      const frame = q('iframe');
      expect(frame?.getAttribute('src')).toBe('https://example.test/embed');
      expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    });

    describe('practice questions', () => {
      const openQuestion = async () => {
        await openPlayer({ steps: [question(), step({ id: 's2', title: 'After' })] });
      };
      const choose = (index: number) => click(host.querySelectorAll('.lesson-choice input')[index]);

      it('requires an answer and a check before continuing', async () => {
        await openQuestion();
        expect(button('Check answer').disabled).toBe(true);
        expect(button('Save & continue').disabled).toBe(true);
        expect(q('.lesson-practice-hint')).not.toBeNull();
        await choose(1);
        expect(q('.lesson-choice-status')?.textContent).toBe('Selected');
        expect(q('.lesson-choice.is-selected .lesson-choice-letter')?.textContent).toBe('B');
      });

      it('coaches a wrong answer, and clears it when the choice changes', async () => {
        overrides['POST /lessons/l1/check'] = { body: { correct: false, feedback: 'Think again' } };
        await openQuestion();
        await choose(1);
        await press('Check answer');
        expect(sent('POST', '/check')[0].body).toEqual({ version: 1, step_id: 'q', answer: 1 });
        expect(q('.lesson-practice-feedback')?.textContent).toContain('Your answer: Option B (No)');
        expect(q('.lesson-practice-coach')).not.toBeNull();
        expect(q('.lesson-choice.is-wrong-choice .lesson-choice-status')?.textContent).toBe('✕ Try again');
        expect(q('.lesson-outline')?.textContent).toContain('Needs review');
        await choose(0);
        expect(q('.lesson-practice-feedback')).toBeNull();
      });

      it('restores a checked answer when returning to the question', async () => {
        overrides['POST /lessons/l1/check'] = { body: { correct: true, feedback: 'Right' } };
        await openQuestion();
        await choose(0);
        await press('Check answer');
        expect(q('.lesson-choice.is-correct-choice')).not.toBeNull();
        expect(q('.lesson-outline')?.textContent).toContain('✓ Answered');
        await press('Save & continue');
        expect(q('.lesson-choice')).toBeNull();
        await press('Previous');
        expect(q('.lesson-practice-feedback')?.textContent).toContain('Right');
        expect(q('.lesson-practice-coach')).toBeNull();
      });

      it('shows a checking failure', async () => {
        overrides['POST /lessons/l1/check'] = { status: 500, body: { detail: 'Check failed' } };
        await openQuestion();
        await choose(0);
        await press('Check answer');
        expect(alertText()).toBe('Check failed');
        expect(q('.lesson-practice-feedback')).toBeNull();
      });
    });
  });
});
