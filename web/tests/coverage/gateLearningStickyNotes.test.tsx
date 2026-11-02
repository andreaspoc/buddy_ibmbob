// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/components/LessonContent', () => ({ LessonContent: ({ text }: { text: string }) => <div data-lesson-content>{text}</div> }));

import { ChapterStickyNotesStrip, LearningNoteEditorModal, LearningStickyNotesBoard, type ClassNote } from '../../src/components/LearningStickyNotes';

const chapters = [{ id: 'l1', title: 'Forces' }, { id: 'l2', title: 'Energy' }];
const note = (over: Partial<ClassNote> = {}): ClassNote => ({ id: 'n1', folder_id: 'f', lesson_id: 'l1', title: 'Newton', body: 'F = ma', color: 'butter', tags: ['exam'], favorite: false, created_at: '', updated_at: '', ...over });

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const button = (label: string | RegExp, scope: ParentNode = host) => {
  const found = [...scope.querySelectorAll('button')].find(item => (typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent || '')));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
};
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
const render = async (ui: React.ReactElement) => { await act(async () => root.render(ui)); await flush(); };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('LearningNoteEditorModal', () => {
  const onClose = vi.fn();
  const onSave = vi.fn(async () => undefined);
  const modal = (props: Partial<React.ComponentProps<typeof LearningNoteEditorModal>> = {}) => <LearningNoteEditorModal open classTitle="Physics" chapters={chapters} onClose={onClose} onSave={onSave} {...props} />;
  const bodyField = () => q<HTMLTextAreaElement>('.learning-note-textarea');
  const submit = async () => { await act(async () => { q('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush(); };

  beforeEach(() => { onClose.mockReset(); onSave.mockReset(); onSave.mockResolvedValue(undefined); });

  it('renders nothing while closed', async () => {
    await render(modal({ open: false }));
    expect(host.innerHTML).toBe('');
  });

  it('starts empty for a new note in the default chapter', async () => {
    await render(modal({ defaultLessonId: 'l2' }));
    expect(q('[role="dialog"]')?.getAttribute('aria-label')).toBe('New sticky note');
    expect(q('.learning-catalog-eyebrow')?.textContent).toContain('PHYSICS');
    expect(q<HTMLSelectElement>('select')?.value).toBe('l2');
    expect(button('Save sticky note').disabled).toBe(true);
  });

  it('refuses to save whitespace', async () => {
    await render(modal());
    await type(bodyField(), '   ');
    await submit();
    expect(q('.learning-alert')?.textContent).toBe('Write a note before saving.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves trimmed values, normalising tags and clearing the chapter', async () => {
    await render(modal());
    await type(q('input[maxlength="240"]'), ' Title ');
    await type(bodyField(), ' Body ');
    await type(q('input[placeholder^="exam"]'), '#Exam, ##Two,  , three');
    await click(q('button[title="Lavender"]'));
    await click(q('.learning-note-favorite-check input'));
    await submit();
    expect(onSave).toHaveBeenCalledWith({ id: undefined, title: 'Title', body: 'Body', color: 'lavender', tags: ['exam', 'two', 'three'], favorite: true, lesson_id: null });
  });

  it('keeps an existing note and its chapter when editing', async () => {
    await render(modal({ initialNote: note({ id: 'n9', color: 'mint', favorite: true, tags: ['a', 'b'] }) }));
    expect(q('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit sticky note');
    expect(q('h2')?.textContent).toBe('Edit sticky note');
    expect(q<HTMLInputElement>('input[placeholder^="exam"]')?.value).toBe('a, b');
    expect(q('button[title="Fresh mint"]')?.textContent).toBe('✓');
    await type(q('select'), 'l2');
    await press('Save changes');
    await submit();
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n9', lesson_id: 'l2', color: 'mint', favorite: true, tags: ['a', 'b'] }));
  });

  it.each([
    ['message', new Error('Server said no'), 'Server said no'],
    ['no message', {}, 'Could not save sticky note'],
  ])('shows a save failure with %s', async (_name, failure, text) => {
    onSave.mockRejectedValue(failure);
    await render(modal());
    await type(bodyField(), 'Body');
    await submit();
    expect(q('.learning-alert')?.textContent).toBe(text);
  });

  it('switches to a preview and back', async () => {
    await render(modal());
    await press('Preview');
    expect(q('.learning-note-preview')?.textContent).toBe('Nothing to preview yet.');
    await press('Write');
    await type(bodyField(), '# Heading');
    await press('Preview');
    expect(q('[data-lesson-content]')?.textContent).toBe('# Heading');
    expect(q('.learning-note-preview')?.getAttribute('data-note-color')).toBe('butter');
  });

  it('closes from the backdrop, the header and cancel', async () => {
    await render(modal());
    await click(q('.learning-note-backdrop-close'));
    await click(q('button[aria-label="Close note editor"]'));
    await press('Cancel');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows the saving state while busy', async () => {
    await render(modal({ busy: true }));
    expect(button('Saving...').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
  });

  it('reloads fields when reopened for another note', async () => {
    await render(modal({ initialNote: note({ title: 'First' }) }));
    await type(q('input[maxlength="240"]'), 'Changed');
    await render(modal({ initialNote: note({ id: 'n2', title: 'Second', lesson_id: null }), defaultLessonId: 'l2' }));
    expect(q<HTMLInputElement>('input[maxlength="240"]')?.value).toBe('Second');
    expect(q<HTMLSelectElement>('select')?.value).toBe('l2');
  });
});

describe('LearningStickyNotesBoard', () => {
  const onCreateNote = vi.fn();
  const onEditNote = vi.fn();
  const onToggleFavorite = vi.fn(async () => undefined);
  const onDeleteNote = vi.fn(async () => undefined);
  const defaults = () => [
    note({ id: 'a', title: 'Alpha', tags: ['exam', 'core'], favorite: true, color: 'rose' }),
    note({ id: 'b', title: 'Bravo', lesson_id: 'l2', body: 'kinetic energy', tags: ['exam'] }),
    note({ id: 'c', title: 'Charlie', lesson_id: null, tags: [], color: 'sky', body: 'general text' }),
  ];
  const board = (notes: ClassNote[] = defaults(), classTitle = 'Physics') => <LearningStickyNotesBoard classTitle={classTitle} notes={notes} chapters={chapters} onCreateNote={onCreateNote} onEditNote={onEditNote} onToggleFavorite={onToggleFavorite} onDeleteNote={onDeleteNote} />;
  const shown = () => [...host.querySelectorAll('.learning-sticky-note-card h3')].map(item => item.textContent);
  const sidebar = () => q('.learning-notes-sidebar')!;
  const card = (index = 0) => host.querySelectorAll('.learning-sticky-note-card')[index];

  beforeEach(() => { for (const fn of [onCreateNote, onEditNote, onToggleFavorite, onDeleteNote]) fn.mockClear(); });

  it('summarises notes with correct plurals', async () => {
    await render(board());
    expect(q('.learning-instructor-pill')?.textContent).toContain('3 sticky notes');
    await render(board([note()]));
    expect(q('.learning-instructor-pill')?.textContent).toContain('1 sticky note ');
  });

  it('filters by chapter, general and favourites, with counts', async () => {
    await render(board());
    expect(button(/Ch\. 1/, sidebar()).querySelector('small')?.textContent).toBe('1');
    await press(/Ch\. 2/, sidebar());
    expect(shown()).toEqual(['Bravo']);
    await press(/General notes/, sidebar());
    expect(shown()).toEqual(['Charlie']);
    await press(/All class notes/, sidebar());
    expect(shown()).toHaveLength(3);
    await press(/Favorites/, sidebar());
    expect(shown()).toEqual(['Alpha']);
    expect(button(/All class notes/, sidebar()).getAttribute('aria-pressed')).toBe('false');
    await press(/All class notes/, sidebar());
    expect(shown()).toHaveLength(3);
  });

  it('hides the general filter when every note has a chapter', async () => {
    await render(board([note()]));
    expect(() => button(/General notes/, sidebar())).toThrow();
  });

  it('orders tags by count and toggles a tag filter from sidebar and card', async () => {
    await render(board());
    const tagButtons = [...sidebar().querySelectorAll('button')].filter(item => item.textContent?.startsWith('#')).map(item => item.textContent);
    expect(tagButtons).toEqual(['#exam2', '#core1']);
    await press(/#core/, sidebar());
    expect(shown()).toEqual(['Alpha']);
    await press(/#core/, sidebar());
    expect(shown()).toHaveLength(3);
    await press('#core', card(0));
    expect(shown()).toEqual(['Alpha']);
    await press('#core', card(0));
    expect(shown()).toHaveLength(3);
  });

  it('filters by colour and toggles the colour off', async () => {
    await render(board());
    const bar = () => q('.learning-notes-color-bar')!;
    await click(bar().querySelector('button[title="Sky blue"]'));
    expect(shown()).toEqual(['Charlie']);
    expect(bar().querySelector('button[title="Sky blue"]')?.textContent).toBe('✓');
    await click(bar().querySelector('button[title="Sky blue"]'));
    expect(shown()).toHaveLength(3);
    await click(bar().querySelector('button[title="Soft rose"]'));
    await press('All colors', bar());
    expect(shown()).toHaveLength(3);
  });

  it.each([
    ['title', 'ALPHA', ['Alpha']],
    ['body', 'kinetic', ['Bravo']],
    ['tag', 'cor', ['Alpha']],
    ['blank query', '   ', ['Alpha', 'Bravo', 'Charlie']],
  ])('searches by %s', async (_name, text, expected) => {
    await render(board());
    await type(q('input[type="search"]'), text);
    expect(shown()).toEqual(expected);
  });

  it('tolerates notes with missing text and tags while searching', async () => {
    await render(board([note({ title: undefined as never, body: undefined as never, tags: undefined as never })]));
    await type(q('input[type="search"]'), 'nope');
    expect(host.textContent).toContain('No sticky notes here yet');
  });

  it('creates notes in the selected chapter from hero and empty state', async () => {
    await render(board());
    await press('+ New Sticky Note');
    expect(onCreateNote).toHaveBeenLastCalledWith(null);
    await press(/Ch\. 1/, sidebar());
    await press('+ New Sticky Note');
    expect(onCreateNote).toHaveBeenLastCalledWith('l1');
    await render(board([]));
    await press('+ Create your first sticky note');
    expect(onCreateNote).toHaveBeenLastCalledWith('l1');
  });

  it('asks for a null chapter from the empty state on general views', async () => {
    await render(board([]));
    await press('+ Create your first sticky note');
    expect(onCreateNote).toHaveBeenLastCalledWith(null);
  });

  it('labels the chapter, stored lesson title or class on a card', async () => {
    await render(board([note({ id: 'a' }), note({ id: 'b', lesson_id: 'gone', lesson_title: 'Archived lesson' }), note({ id: 'c', lesson_id: 'gone2', lesson_title: null }), note({ id: 'd', lesson_id: null })]));
    const labels = [...host.querySelectorAll('.notes-card-collection')].map(item => item.textContent);
    expect(labels).toEqual(['▱ Chapter 1 · Forces', '▱ Archived lesson', '▱ Physics · General', '▱ Physics · General']);
    await click(host.querySelectorAll('.notes-card-collection')[0]);
    expect(button(/Ch\. 1/, sidebar()).getAttribute('aria-pressed')).toBe('true');
  });

  it('disables the chapter link on general notes and defaults the paper colour', async () => {
    await render(board([note({ lesson_id: null, color: undefined as never })]));
    expect(q<HTMLButtonElement>('.notes-card-collection')?.disabled).toBe(true);
    expect(card().getAttribute('data-note-color')).toBe('butter');
  });

  it('toggles favourites through the callback', async () => {
    const notes = defaults();
    await render(board(notes));
    const star = card(0).querySelector('.learning-note-fav-btn')!;
    expect(star.getAttribute('title')).toBe('Remove from favorites');
    expect(card(1).querySelector('.learning-note-fav-btn')?.getAttribute('title')).toBe('Pin to favorites');
    await click(star);
    expect(onToggleFavorite).toHaveBeenCalledWith(notes[0]);
  });

  it('offers expand only for long notes', async () => {
    await render(board([note({ body: 'x'.repeat(281) }), note({ id: 'short', body: 'x'.repeat(280) })]));
    expect(() => button('Full note', card(1))).toThrow();
    await press('Full note', card(0));
    expect(card(0).classList.contains('is-expanded')).toBe(true);
    await press('Collapse', card(0));
    expect(card(0).classList.contains('is-expanded')).toBe(false);
  });

  it('edits a note', async () => {
    const notes = defaults();
    await render(board(notes));
    await press('Edit note', card(1));
    expect(onEditNote).toHaveBeenCalledWith(notes[1]);
  });

  it('confirms deletion, supports cancel, and clears the prompt afterwards', async () => {
    await render(board());
    await press('Delete', card(0));
    expect(card(0).textContent).toContain('Remove this sticky note?');
    await press('Cancel', card(0));
    expect(card(0).textContent).not.toContain('Remove this sticky note?');
    await press('Delete', card(0));
    await press('Delete', card(0).querySelector('.notes-delete-confirm')!);
    expect(onDeleteNote).toHaveBeenCalledWith('a');
    expect(card(0).textContent).not.toContain('Remove this sticky note?');
  });
});

describe('ChapterStickyNotesStrip', () => {
  const onAddNote = vi.fn();
  const onEditNote = vi.fn();
  const onOpenAllNotes = vi.fn();
  const strip = (notes: ClassNote[]) => <ChapterStickyNotesStrip chapterId="l1" chapterNumber={2} chapterTitle="Forces" notes={notes} onAddNote={onAddNote} onEditNote={onEditNote} onOpenAllNotes={onOpenAllNotes} />;
  const mini = () => q('.learning-mini-sticky-note');

  beforeEach(() => { for (const fn of [onAddNote, onEditNote, onOpenAllNotes]) fn.mockClear(); });

  it('invites a first note when empty', async () => {
    await render(strip([]));
    expect(q('.learning-chapter-notes-empty')?.textContent).toContain('No sticky notes for Chapter 2 yet.');
    expect(() => button('Open Notes Board →')).toThrow();
    await press('+ Pin a sticky note for this chapter');
    await press('+ Add Sticky Note');
    expect(onAddNote.mock.calls).toEqual([['l1'], ['l1']]);
  });

  it('lists notes, limiting tags to three, and opens the board', async () => {
    await render(strip([note({ favorite: true, tags: ['a', 'b', 'c', 'd'], color: 'rose' }), note({ id: 'n2', tags: undefined as never, color: undefined as never })]));
    expect(q('.learning-chapter-subcount')?.textContent).toBe('2');
    expect(host.querySelectorAll('.learning-note-tag-pill')).toHaveLength(3);
    const labels = [...host.querySelectorAll('.sticky-note-number')].map(item => item.textContent);
    expect(labels).toEqual(['★ FAVORITE', 'STICKY NOTE']);
    expect(host.querySelectorAll('.learning-mini-sticky-note')[1].getAttribute('data-note-color')).toBe('butter');
    await press('Open Notes Board →');
    expect(onOpenAllNotes).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter', 1], [' ', 1], ['x', 0],
  ])('opens a note from the keyboard with "%s"', async (name, count) => {
    await render(strip([note()]));
    await act(async () => { mini()!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
    expect(onEditNote).toHaveBeenCalledTimes(count);
  });

  it('opens a note on click', async () => {
    const item = note();
    await render(strip([item]));
    await click(mini());
    expect(onEditNote).toHaveBeenCalledWith(item);
  });
});
