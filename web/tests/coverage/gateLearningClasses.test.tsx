// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/components/LessonContent', () => ({ LessonContent: ({ text }: { text: string }) => <div data-lesson-content>{text}</div> }));
vi.mock('../../src/components/LearningCourseCompletion', () => ({ default: ({ classId, canManage }: { classId: string; canManage: boolean }) => <div data-completion>{`${classId}:${canManage}`}</div> }));

import { LearningClasses } from '../../src/components/LearningClasses';

type Reply = { status?: number; body?: unknown };
const FOLDER = 'folder-1';
const klass = (over: Record<string, unknown> = {}) => ({ id: 'c1', title: 'Physics', description: 'Motion and force', revision: 3, can_manage: true, folder_id: FOLDER, ...over });
const assignment = (over: Record<string, unknown> = {}) => ({ id: 'a1', title: 'Essay', instructions: 'Write it', section: '', due_at: null, resource_type: 'none', resource_id: null, allow_late: false, required: true, minimum_score_percent: 0, revision: 2, ...over });
const submission = (over: Record<string, unknown> = {}) => ({ id: 's1', username: 'lea', display_name: 'Lea', text: 'My work', revision: 4, submitted_at: '2026-02-01T10:00:00Z', assignment_revision: 2, ...over });

let host: HTMLDivElement;
let root: Root;
let state: Record<string, unknown>;
let overrides: Record<string, Reply>;
let calls: { url: string; method: string; body: any }[];

const resetState = () => {
  state = {
    list: [klass()], detail: klass(), announcements: [], sessions: [], assignments: [], members: [], candidates: [],
    contents: { books: [{ id: 'b1', title: 'Book One' }], lessons: [{ id: 'l1', title: 'Live lesson', status: 'published' }, { id: 'l2', title: 'Draft lesson', status: 'draft' }], quizzes: [{ id: 'q1', title: 'Quiz One', status: 'published' }] },
    submissions: [], teachers: [{ username: 'tess', display_name: 'Tess' }],
  };
};
function respond(url: string, method: string): Reply {
  const path = url.replace('/api/learning', '');
  const hit = overrides[`${method} ${path}`];
  if (hit) return hit;
  if (method !== 'GET') return { body: { id: 'c1', folder_deleted: false } };
  if (path.endsWith('/class-teachers')) return { body: { items: state.teachers } };
  if (path.endsWith(`/folders/${FOLDER}/classes`)) return { body: { items: state.list } };
  if (path.endsWith('/contents')) return { body: state.contents };
  if (path.endsWith('/submissions')) return { body: { items: state.submissions } };
  for (const name of ['announcements', 'sessions', 'assignments', 'members', 'candidates']) if (path.endsWith(`/${name}`)) return { body: { items: state[name] } };
  return { body: state.detail };
}

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const button = (label: string | RegExp, scope: ParentNode = host) => {
  const found = [...scope.querySelectorAll('button')].find(item => (typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent || '')));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
};
const hasButton = (label: string) => [...host.querySelectorAll('button')].some(item => item.textContent?.trim() === label);
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
const labelled = (text: string, tag = 'input') => [...host.querySelectorAll('label')].find(label => label.textContent?.startsWith(text))?.querySelector(tag) ?? null;
const submit = async (form: Element | null = q('form')) => { await act(async () => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush(); };
const alertText = () => q('[role="alert"]')?.textContent || '';
const noticeText = () => q('.learning-notice')?.textContent || '';
const sent = (method: string) => calls.filter(call => call.method === method);

async function mount(props: Partial<React.ComponentProps<typeof LearningClasses>> = {}) {
  await act(async () => root.render(<LearningClasses folderId={FOLDER} canCreate {...props} />));
  await flush();
}
async function openClass(detail: Record<string, unknown> = {}, props: Partial<React.ComponentProps<typeof LearningClasses>> = {}) {
  state.detail = klass(detail);
  state.list = [klass(detail)];
  await mount(props);
  await press('Open class');
}
const goTab = (label: string) => press(label, q('.learning-class-tabs')!);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetState();
  overrides = {};
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({ url: url.replace('/api/learning', ''), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status = 200, body = {} } = respond(url, method);
    return { ok: status < 400, status, json: async () => { if (body === 'BAD') throw new Error('bad'); return body; } };
  }));
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('class list', () => {
  it.each([
    [{ detail: 'Folder closed' }, 'Folder closed'],
    [{ detail: { nested: true } }, 'Unable to complete this request (500). Check the fields and your current class access.'],
    ['BAD', 'Unable to complete this request (500). Check the fields and your current class access.'],
  ])('shows load failures clearly (%#)', async (body, text) => {
    overrides[`GET /folders/${FOLDER}/classes`] = { status: 500, body };
    await mount();
    expect(alertText()).toBe(text);
    expect(q('p[role="status"]')).toBeNull();
  });

  it('reports a teacher list failure for class leads', async () => {
    overrides[`GET /folders/${FOLDER}/class-teachers`] = { status: 403, body: { detail: 'No teacher access' } };
    await mount({ canAssignTeacher: true });
    expect(alertText()).toBe('No teacher access');
  });

  it.each([
    [true, 'Create your first class', true],
    [false, 'No classes assigned yet', false],
  ])('explains an empty list (canCreate=%s)', async (canCreate, heading, hasCreate) => {
    state.list = [];
    await mount({ canCreate });
    expect(q('.learning-class-empty h3')?.textContent).toBe(heading);
    expect(hasButton('Create class')).toBe(hasCreate);
  });

  it('labels and searches classes', async () => {
    state.list = [klass({ title: 'Mine' }), klass({ id: 'c2', title: 'Enrolled', can_manage: false, teacher_display_name: 'Tess' }), klass({ id: 'c3', title: 'Old', archived: true, description: 'Past term' })];
    await mount();
    const labels = () => [...host.querySelectorAll('.learning-class-grid .learning-class-eyebrow')].map(item => item.textContent);
    expect(labels()).toEqual(['YOUR CLASS', 'ENROLLED', 'ARCHIVED']);
    expect(host.textContent).toContain('Lead teacher: Tess');
    expect(host.textContent).toContain('Lead teacher: Assigned teacher');
    await mount({ search: 'PAST' });
    expect(labels()).toEqual(['ARCHIVED']);
  });

  it.each([
    ['the class matching the folder', [klass({ id: 'other', title: 'Other' }), klass({ id: FOLDER, title: 'Primary' })], `/classes/${FOLDER}`],
    ['the first class otherwise', [klass({ id: 'first', title: 'First' }), klass({ id: 'second' })], '/classes/first'],
  ])('auto-opens %s', async (_name, list, expected) => {
    state.list = list;
    await mount({ autoOpenFolderClass: true });
    expect(calls.some(call => call.url === expected)).toBe(true);
    expect(q('.learning-class-header')).not.toBeNull();
  });

  it('does not auto-open when there are no classes', async () => {
    state.list = [];
    await mount({ autoOpenFolderClass: true });
    expect(q('.learning-class-header')).toBeNull();
  });

  it('reports an error when opening a class fails', async () => {
    overrides['GET /classes/c1'] = { status: 404, body: { detail: 'Gone' } };
    await mount();
    await press('Open class');
    expect(alertText()).toBe('Gone');
    expect(q('.learning-class-header')).toBeNull();
  });

  it('warns before leaving with an open editor', async () => {
    await mount();
    const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    expect(unload()).toBe(false);
    await press('Create class');
    expect(unload()).toBe(true);
    await press('Discard changes');
    expect(q('form')).toBeNull();
  });
});

describe('deleting a class', () => {
  const startDelete = async () => {
    state.list = [klass({ can_delete: true })];
    const onDeleted = vi.fn();
    await mount({ onDeleted });
    await press('Delete class');
    return onDeleted;
  };
  const dialog = () => q('dialog')!;

  it('asks first and can be cancelled', async () => {
    await startDelete();
    expect(dialog().textContent).toContain('Delete “Physics”?');
    await press('Cancel', dialog());
    expect(q('dialog')).toBeNull();
    expect(sent('DELETE')).toHaveLength(0);
  });

  it('reloads the list when the folder remains', async () => {
    const onDeleted = await startDelete();
    state.list = [];
    await press('Delete', dialog());
    expect(sent('DELETE')[0].url).toBe('/classes/c1');
    expect(onDeleted).toHaveBeenCalledWith(false);
    expect(noticeText()).toBe('Class deleted.');
    expect(q('.learning-class-empty')).not.toBeNull();
  });

  it('tells the host when the folder went with it, without reloading', async () => {
    const onDeleted = await startDelete();
    overrides['DELETE /classes/c1'] = { body: { folder_deleted: true } };
    const before = calls.length;
    await press('Delete', dialog());
    expect(onDeleted).toHaveBeenCalledWith(true);
    expect(calls.slice(before).map(call => call.method)).toEqual(['DELETE']);
  });

  it('shows the refusal when learner activity blocks the delete', async () => {
    await startDelete();
    overrides['DELETE /classes/c1'] = { status: 409, body: { detail: 'Learner activity exists' } };
    await press('Delete', dialog());
    expect(alertText()).toBe('Learner activity exists');
  });

  it('is available from an open class', async () => {
    await openClass({ can_delete: true });
    await press('Delete class');
    await press('Delete', dialog());
    expect(noticeText()).toBe('Class deleted.');
    expect(q('.learning-class-header')).toBeNull();
  });
});

describe('class editor', () => {
  it('creates a class assigned to a chosen lead teacher, then opens it', async () => {
    await mount({ canAssignTeacher: true });
    await press('Create class');
    expect(q('form h2')?.textContent).toBe('Create class');
    expect(q('select[aria-label="Lead teacher"] option')?.textContent).toBe('Assign to myself');
    await type(labelled('Title'), 'Chemistry');
    await type(q('textarea[aria-label="Description"]'), 'Atoms');
    await type(q('select[aria-label="Lead teacher"]'), 'tess');
    await submit();
    expect(sent('POST')[0]).toMatchObject({ url: `/folders/${FOLDER}/classes`, body: { title: 'Chemistry', description: 'Atoms', teacher_username: 'tess' } });
    expect(noticeText()).toBe('Changes saved.');
    expect(q('.learning-class-header')).not.toBeNull();
  });

  it('omits a teacher when none is chosen', async () => {
    await mount({ canAssignTeacher: true });
    await press('Create class');
    await type(labelled('Title'), 'Chemistry');
    await submit();
    expect(sent('POST')[0].body).toEqual({ title: 'Chemistry', description: '' });
  });

  it('keeps the create button disabled without a title', async () => {
    await mount();
    await press('Create class');
    expect(button('Create').disabled).toBe(true);
    await type(labelled('Title'), 'Named');
    expect(button('Create').disabled).toBe(false);
  });

  it('edits a class with revision and archive flag', async () => {
    await openClass({ teacher_display_name: 'Tess' }, { canAssignTeacher: true });
    expect(q('.learning-class-lead')?.textContent).toContain('Tess');
    await press('Edit class');
    expect(q('form h2')?.textContent).toBe('Edit class');
    expect(q('select[aria-label="Lead teacher"] option')?.textContent).toBe('Keep the assigned teacher');
    await click(labelled('Archive this class'));
    await submit();
    expect(sent('PUT')[0]).toMatchObject({ url: '/classes/c1', body: { expected_revision: 3, archived: true, title: 'Physics' } });
  });

  it('keeps the editor open with the error on a save failure', async () => {
    await mount();
    await press('Create class');
    await type(labelled('Title'), 'X');
    overrides[`POST /folders/${FOLDER}/classes`] = { status: 400, body: { detail: 'Duplicate' } };
    await submit();
    expect(alertText()).toBe('Duplicate');
    expect(q('form')).not.toBeNull();
    expect(button('Create').disabled).toBe(false);
  });
});

describe('overview and calendar', () => {
  it('shows the empty announcements state and creates one', async () => {
    await openClass();
    expect(host.textContent).toContain('No announcements yet.');
    await press('Add announcement');
    await type(labelled('Title'), 'Hello');
    await type(q('textarea[aria-label="Announcement"]'), 'Welcome all');
    await submit();
    expect(sent('POST')[0]).toEqual({ url: '/classes/c1/announcements', method: 'POST', body: { title: 'Hello', body: 'Welcome all' } });
  });

  it('edits an announcement with its revision and displays its date', async () => {
    state.announcements = [{ id: 'n1', title: 'Old', body: 'Text', revision: 5, created_at: '2026-01-01T00:00:00Z' }, { id: 'n2', title: 'No date', body: 'T2', revision: 1 }];
    await openClass();
    expect(host.querySelectorAll('.learning-class-card .learning-muted')).toHaveLength(1);
    await press('Edit announcement', host.querySelectorAll('.learning-class-card')[0]);
    await submit();
    expect(sent('PUT')[0]).toMatchObject({ url: '/classes/c1/announcements/n1', body: { expected_revision: 5 } });
  });

  it('rejects an invalid session date without calling the server', async () => {
    await openClass();
    await goTab('Class calendar');
    expect(host.textContent).toContain('No class sessions scheduled.');
    await press('Schedule a session');
    await type(labelled('Title'), 'Lab');
    await submit();
    expect(alertText()).toBe('Enter a valid session start.');
    expect(sent('POST')).toHaveLength(0);
  });

  it('schedules a session with ISO times', async () => {
    await openClass();
    await goTab('Class calendar');
    await press('Schedule a session');
    await type(labelled('Title'), 'Lab');
    await type(q('textarea[aria-label="Description"]'), 'Bring goggles');
    await type(labelled('Course section'), 'Unit 1');
    await type(labelled('Starts at'), '2026-03-01T09:00');
    await type(labelled('Ends at'), '2026-03-01T10:00');
    await submit();
    const { body, url } = sent('POST')[0];
    expect(url).toBe('/classes/c1/sessions');
    expect(body).toMatchObject({ title: 'Lab', description: 'Bring goggles', section: 'Unit 1' });
    expect(body.starts_at).toBe(new Date('2026-03-01T09:00').toISOString());
  });

  it('sorts sessions, converts times for editing and lists deadlines linking to assignments', async () => {
    state.sessions = [
      { id: 's2', title: 'Later', description: 'd', starts_at: '2026-03-02T09:00:00Z', ends_at: '2026-03-02T10:00:00Z', section: '', revision: 1 },
      { id: 's1', title: 'Sooner', description: 'd', starts_at: '2026-03-01T09:00:00Z', ends_at: '2026-03-01T10:00:00Z', section: 'Unit 1', revision: 1 },
    ];
    state.assignments = [assignment({ id: 'a2', title: 'Due later', due_at: '2026-04-02T00:00:00Z' }), assignment({ id: 'a3', title: 'Due first', due_at: '2026-04-01T00:00:00Z' }), assignment({ id: 'a4', title: 'Undated' })];
    await openClass();
    await goTab('Class calendar');
    expect([...host.querySelectorAll('.learning-class-card h3')].map(item => item.textContent)).toEqual(['Sooner', 'Later']);
    expect([...host.querySelectorAll('.learning-class-card h4')].map(item => item.textContent)).toEqual(['Due first', 'Due later']);
    expect(host.querySelectorAll('.learning-class-eyebrow')[1].textContent).toBe('Unit 1');
    await press('Edit session', host.querySelector('.learning-class-card')!);
    expect((labelled('Starts at') as HTMLInputElement).value).toMatch(/^2026-03-01T\d\d:00$/);
    await press('Discard changes');
    await press('View assignments');
    expect(button('Assignments', q('.learning-class-tabs')!).getAttribute('aria-current')).toBe('page');
  });

  it('renders the completion tab for teachers and learners with fitting labels', async () => {
    await openClass();
    await goTab('Learner progress');
    expect(q('[data-completion]')?.textContent).toBe('c1:true');
    await act(async () => root.unmount());
    root = createRoot(host);
    await openClass({ can_manage: false });
    await goTab('Course completion');
    expect(q('[data-completion]')?.textContent).toBe('c1:false');
    expect(hasButton('Class members')).toBe(false);
  });

  it('returns to all classes', async () => {
    await openClass();
    await press('← All classes');
    expect(q('.learning-class-grid')).not.toBeNull();
  });

  it('marks archived classes read-only for teachers', async () => {
    state.announcements = [{ id: 'n1', title: 'Old', body: 'Text', revision: 5 }];
    await openClass({ archived: true });
    expect(q('.learning-class-header .learning-class-eyebrow')?.textContent).toBe('ARCHIVED CLASS');
    expect(host.textContent).toContain('This class is archived.');
    expect(hasButton('Add announcement')).toBe(false);
    expect(button('Edit announcement').disabled).toBe(true);
  });
});

describe('assignment authoring', () => {
  const startCreate = async () => {
    await openClass();
    await goTab('Assignments');
    await press('Create assignment');
    await type(labelled('Title'), 'Task');
    await type(q('textarea[aria-label="Instructions"]'), 'Do it');
  };

  it('saves written homework with defaults', async () => {
    await startCreate();
    await submit();
    expect(sent('POST')[0]).toMatchObject({ url: '/classes/c1/assignments', body: { title: 'Task', instructions: 'Do it', due_at: null, resource_type: 'none', resource_id: null, allow_late: true, required: true, minimum_score_percent: 0 } });
  });

  it.each([
    ['book', 'b1', ['Select material', 'Book One']],
    ['lesson', 'l1', ['Select material', 'Live lesson']],
    ['quiz', 'q1', ['Select material', 'Quiz One']],
  ])('links a %s, offering only assignable material', async (kind, id, options) => {
    await startCreate();
    await type(q('select[aria-label="Learning material"]'), kind);
    expect([...q('select[aria-label="Choose material"]')!.querySelectorAll('option')].map(item => item.textContent)).toEqual(options);
    await type(q('select[aria-label="Choose material"]'), id);
    await submit();
    expect(sent('POST')[0].body).toMatchObject({ resource_type: kind, resource_id: id });
  });

  it('records quiz score, optional status, deadline and closed late work', async () => {
    await startCreate();
    await type(q('select[aria-label="Learning material"]'), 'quiz');
    await type(q('select[aria-label="Choose material"]'), 'q1');
    await type(q('input[aria-label="Minimum quiz score for completion (%)"]'), '70');
    await click(labelled('Required for course completion'));
    await click(labelled('Allow late submissions'));
    await type(labelled('Due date'), '2026-05-01T12:00');
    await type(labelled('Course section'), 'Unit 2');
    await submit();
    expect(sent('POST')[0].body).toMatchObject({ minimum_score_percent: 70, required: false, allow_late: false, section: 'Unit 2', due_at: new Date('2026-05-01T12:00').toISOString() });
  });

  it('resets the quiz score when the material type changes', async () => {
    await startCreate();
    await type(q('select[aria-label="Learning material"]'), 'quiz');
    await type(q('input[aria-label="Minimum quiz score for completion (%)"]'), '70');
    await type(q('select[aria-label="Learning material"]'), 'none');
    expect(q('input[aria-label="Minimum quiz score for completion (%)"]')).toBeNull();
    await submit();
    expect(sent('POST')[0].body.minimum_score_percent).toBe(0);
  });

  it('edits an assignment, loading its local due date and linked material', async () => {
    state.assignments = [assignment({ due_at: '2026-05-01T10:00:00Z', resource_type: 'book', resource_id: 'b1' })];
    await openClass();
    await goTab('Assignments');
    await press('Edit assignment');
    expect((labelled('Due date') as HTMLInputElement).value).toMatch(/^2026-05-01T/);
    expect((q('select[aria-label="Choose material"]') as HTMLSelectElement).value).toBe('b1');
    await submit();
    expect(sent('PUT')[0]).toMatchObject({ url: '/classes/c1/assignments/a1', body: { expected_revision: 2, resource_id: 'b1' } });
  });
});

describe('assignment display', () => {
  it('summarises completion rules for teachers', async () => {
    state.assignments = [
      assignment({ id: 'a', title: 'Graded', section: 'Unit 3', required: false, resource_type: 'quiz', resource_id: 'q1', minimum_score_percent: 60, due_at: '2026-05-01T10:00:00Z', allow_late: true, resource_version: 4, submission_count: 7 }),
      assignment({ id: 'b', title: 'Closed', due_at: '2026-05-01T10:00:00Z' }),
    ];
    await openClass();
    await goTab('Assignments');
    const [first, second] = [...host.querySelectorAll('.learning-class-card')];
    expect(first.querySelector('.learning-class-eyebrow')?.textContent).toBe('Unit 3');
    expect(first.textContent).toContain('Optional assignment. Minimum quiz score: 60%. Due');
    expect(first.textContent).toContain('Late submissions allowed. Assigned material version 4.');
    expect(first.textContent).toContain('7 submitted');
    expect(second.textContent).toContain('Required for course completion.');
    expect(second.textContent).toContain('Submissions close at the deadline.');
    expect(second.textContent).toContain('0 submitted');
  });

  it('prompts by role when there are no assignments', async () => {
    await openClass();
    await goTab('Assignments');
    expect(host.textContent).toContain('Assign reading, an existing interactive lesson');
    await act(async () => root.unmount());
    root = createRoot(host);
    await openClass({ can_manage: false });
    await goTab('Assignments');
    expect(host.textContent).toContain('Your teacher has not added assignments yet.');
  });

  it.each([
    ['book', 'b1'], ['lesson', 'l1'], ['quiz', 'q1'],
  ])('opens an assigned %s through the host', async (kind, id) => {
    const onOpenResource = vi.fn();
    state.assignments = [assignment({ resource_type: kind, resource_id: id })];
    await openClass({}, { onOpenResource });
    await goTab('Assignments');
    await press(`Open assigned ${kind}`);
    expect(onOpenResource).toHaveBeenCalledWith(kind, id);
  });

  it.each([
    ['book', 'b1', `/learning/folders/${FOLDER}/books/b1`],
    ['lesson', 'l1', `/learning/folders/${FOLDER}?tab=lessons&lesson=l1`],
    ['quiz', 'q1', `/learning/folders/${FOLDER}/quizzes/q1`],
  ])('navigates to an assigned %s without a host handler', async (kind, id, target) => {
    const assign = vi.fn();
    state.assignments = [assignment({ resource_type: kind, resource_id: id })];
    await openClass();
    await goTab('Assignments');
    vi.stubGlobal('location', { ...window.location, assign });
    await press(`Open assigned ${kind}`);
    expect(assign).toHaveBeenCalledWith(target);
  });
});

describe('learner work', () => {
  const asLearner = async (items: unknown[], detail: Record<string, unknown> = {}) => {
    state.assignments = items;
    await openClass({ can_manage: false, ...detail });
    await goTab('Assignments');
  };
  const workField = () => q<HTMLTextAreaElement>('.learning-class-card textarea');

  it('submits new work with the revision and confirms', async () => {
    await asLearner([assignment()]);
    expect(button('Submit work').disabled).toBe(true);
    expect(workField()?.getAttribute('aria-label')).toBe('Your work or completion notes');
    await type(workField(), 'My answer');
    expect(button('Submit work').disabled).toBe(false);
    await submit(q('.learning-class-card form'));
    expect(sent('POST')[0]).toEqual({ url: '/classes/c1/assignments/a1/submit', method: 'POST', body: { text: 'My answer', expected_revision: 2 } });
    expect(noticeText()).toBe('Your work was submitted to your teacher.');
  });

  it('warns on unload for unsent work', async () => {
    await asLearner([assignment()]);
    const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    expect(unload()).toBe(false);
    await type(workField(), 'Unsaved');
    expect(unload()).toBe(true);
  });

  it('allows editing a pending submission', async () => {
    await asLearner([assignment({ my_submission: submission() })]);
    expect(workField()?.value).toBe('My work');
    expect(workField()?.getAttribute('aria-label')).toBe('Your submitted work (editable until reviewed)');
    expect(button('Update submission').disabled).toBe(false);
    expect(host.textContent).toContain('Awaiting teacher feedback.');
  });

  it.each([
    ['mark with maximum', { mark: 8, max_mark: 10 }, 'Mark: 8 / 10'],
    ['mark only', { mark: 8, max_mark: null }, 'Mark: 8'],
  ])('shows returned feedback with %s', async (_name, marks, text) => {
    await asLearner([assignment({ my_submission: submission({ reviewed_at: '2026-02-02T00:00:00Z', feedback: 'Good', ...marks }) })]);
    const feedback = q('.learning-class-feedback');
    expect(feedback?.textContent).toContain('Good');
    expect(feedback?.textContent).toContain(text);
    expect(feedback?.textContent).toContain('My work');
    expect(workField()).toBeNull();
  });

  it('omits the mark when feedback has none', async () => {
    await asLearner([assignment({ my_submission: submission({ reviewed_at: '2026-02-02T00:00:00Z', feedback: 'Good', mark: null }) })]);
    expect(q('.learning-class-feedback')?.textContent).not.toContain('Mark:');
  });

  it.each([
    ['quiz', 'q1', 'Your quiz answers and marks are recorded automatically'],
    ['lesson', 'l1', 'Your progress is saved in the interactive lesson.'],
  ])('explains how %s progress is recorded', async (kind, id, text) => {
    await asLearner([assignment({ resource_type: kind, resource_id: id })]);
    expect(host.textContent).toContain(text);
  });

  it('blocks submissions in an archived class', async () => {
    await asLearner([assignment()], { archived: true });
    expect(workField()?.disabled).toBe(true);
    expect(button('Submit work').disabled).toBe(true);
  });
});

describe('teacher review', () => {
  const startReview = async (items: unknown[], detail: Record<string, unknown> = {}) => {
    state.assignments = [assignment()];
    state.submissions = items;
    await openClass(detail);
    await goTab('Assignments');
    await press('Review learner work');
  };

  it('explains when nothing was submitted and goes back', async () => {
    await startReview([]);
    expect(host.textContent).toContain('No learners have submitted work yet.');
    await press('Back to assignments');
    expect(host.textContent).toContain('Create assignment');
  });

  it('shows the original instructions for work on an older revision', async () => {
    await startReview([
      submission({ assignment_revision: 1, assignment_snapshot: { instructions: 'Original brief' } }),
      submission({ id: 's2', username: 'max', assignment_revision: 1 }),
      submission({ id: 's3', username: 'zoe' }),
    ]);
    const cards = [...host.querySelectorAll('form.learning-class-card')];
    expect(cards[0].textContent).toContain('Original brief');
    expect(cards[1].textContent).toContain('No original instructions available.');
    expect(cards[2].querySelector('.learning-class-feedback')).toBeNull();
  });

  it('returns feedback with marks and the revision', async () => {
    await startReview([submission({ feedback: 'Draft', mark: 5, max_mark: 10 })]);
    expect((labelled('Mark (optional)') as HTMLInputElement).value).toBe('5');
    await type(q('textarea[aria-label="Teacher feedback"]'), 'Great');
    await type(labelled('Mark (optional)'), '9');
    await type(labelled('Maximum mark'), '10');
    await submit(q('form.learning-class-card'));
    expect(sent('PUT')[0]).toEqual({ url: '/classes/c1/assignments/a1/submissions/s1/feedback', method: 'PUT', body: { feedback: 'Great', mark: 9, max_mark: 10, expected_revision: 4 } });
    expect(noticeText()).toBe('Teacher feedback saved.');
  });

  it('sends null marks when they are blank', async () => {
    await startReview([submission()]);
    await type(q('textarea[aria-label="Teacher feedback"]'), 'Fine');
    await submit(q('form.learning-class-card'));
    expect(sent('PUT')[0].body).toMatchObject({ mark: null, max_mark: null });
  });

  it('reports a failed review load', async () => {
    state.assignments = [assignment()];
    overrides['GET /classes/c1/assignments/a1/submissions'] = { status: 500, body: { detail: 'Load failed' } };
    await openClass();
    await goTab('Assignments');
    await press('Review learner work');
    expect(alertText()).toBe('Load failed');
  });

  it('keeps feedback read-only in an archived class', async () => {
    await startReview([submission({ feedback: 'Done' })], { archived: true });
    expect(button('Return feedback').disabled).toBe(true);
  });
});

describe('class members', () => {
  const openMembers = async (candidates: unknown[], members: unknown[], detail: Record<string, unknown> = {}) => {
    state.candidates = candidates;
    state.members = members;
    await openClass(detail);
    await goTab('Class members');
  };
  const box = (name: string) => labelled(name);

  it('explains missing candidates', async () => {
    await openMembers([], []);
    expect(host.textContent).toContain('No eligible learners were found.');
    expect(button('Save class members').disabled).toBe(true);
  });

  it('flags members who lost folder access, allowing removal only', async () => {
    await openMembers([{ username: 'ana', display_name: 'Ana' }], [{ username: 'old', display_name: 'Old Timer' }]);
    expect(host.textContent).toContain('1 enrolled');
    expect(box('Old Timer')?.parentElement?.textContent).toContain('(folder access unavailable)');
    expect((box('Old Timer') as HTMLInputElement).disabled).toBe(false);
    await click(box('Old Timer'));
    expect((box('Old Timer') as HTMLInputElement).disabled).toBe(true);
  });

  it('saves a changed roster', async () => {
    await openMembers([{ username: 'ana', display_name: 'Ana' }, { username: 'bo', display_name: 'Bo' }], [{ username: 'bo', display_name: 'Bo' }]);
    await click(box('Ana'));
    await click(box('Bo'));
    await press('Save class members');
    expect(sent('PUT')[0]).toEqual({ url: '/classes/c1/members', method: 'PUT', body: { usernames: ['ana'] } });
    expect(noticeText()).toBe('Class roster saved.');
    expect(button('Save class members').disabled).toBe(true);
  });

  it('warns on unload with unsaved roster changes', async () => {
    await openMembers([{ username: 'ana', display_name: 'Ana' }], []);
    await click(box('Ana'));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('honours the initial tab on an auto-opened class, hiding members from learners', async () => {
    state.detail = klass({ can_manage: false });
    state.list = [klass({ can_manage: false })];
    await mount({ initialTab: 'members', autoOpenFolderClass: true });
    expect(q('.learning-class-header')).not.toBeNull();
    expect(host.textContent).not.toContain('Save class members');
  });
});
