// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/components/AppDialog', () => ({ appConfirm: confirm }));

import { KnowledgeDocuments } from '../../src/components/KnowledgeDocuments';

type Reply = { status?: number; body?: unknown };
const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', filename: 'policy.pdf', description: 'Leave policy', status: 'ready', error: null, chunk_count: 12,
  uploaded_by: 'ana', created_at: '2026-01-02T10:00:00Z', size: 2048, can_manage: true, knowledge_base: 'company', audience: 'both', ...over,
});

let host: HTMLDivElement;
let root: Root;
let documents: unknown[];
let overrides: Record<string, Reply>;
let calls: { url: string; method: string; body: unknown }[];

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
  await flush();
};
const file = (name: string, size = 10) => { const item = new File(['x'], name); Object.defineProperty(item, 'size', { value: size }); return item; };
const pick = async (input: Element | null, files: File[]) => {
  await act(async () => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};
const drag = async (element: Element | null, kind: string, files: File[] = [], types = ['Files']) => {
  await act(async () => {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
    element?.dispatchEvent(event);
  });
};
const alertText = () => q('[role="alert"]')?.textContent || '';
const statusText = () => q('[role="status"]')?.textContent || '';
const listed = () => [...host.querySelectorAll('.knowledge-document > a')].map(item => item.textContent);
const uploadInput = () => q('input[aria-label="Upload knowledge sources"]');
const searchInput = () => q('input[aria-label="Search available knowledge"]');
const requests = (method: string) => calls.filter(call => call.method === method);

async function mount(props: Partial<React.ComponentProps<typeof KnowledgeDocuments>> = {}) {
  await act(async () => root.render(<KnowledgeDocuments isStreaming={false} hasExternalAgent={false} {...props} />));
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  documents = [doc()];
  overrides = {};
  calls = [];
  confirm.mockReset(); confirm.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/access/groups') return { ok: true, status: 200, json: async () => ({ items: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Engineering' }] }) } as Response;
    const method = init?.method || 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const hit = overrides[`${method} ${url}`];
    const status = hit?.status ?? 200;
    return {
      ok: status < 400, status,
      json: async () => { if (hit?.body === 'BAD') throw new Error('bad json'); return hit?.body ?? (method === 'GET' ? documents : {}); },
    };
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('compact indicator', () => {
  it('summarises ready and preparing sources and opens the knowledge panel', async () => {
    documents = [doc(), doc({ id: 'd2', status: 'queued' }), doc({ id: 'd3', status: 'indexing' })];
    const opened = vi.fn();
    window.addEventListener('buddy-open-knowledge', opened);
    await mount({ compact: true });
    const indicator = q('.knowledge-chat-indicator');
    expect(indicator?.textContent).toContain('1 ready sources · 2 preparing');
    await click(indicator);
    window.removeEventListener('buddy-open-knowledge', opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('source list', () => {
  it('shows a load error from the server detail, and a fallback without one', async () => {
    overrides['GET /knowledge'] = { status: 500, body: { detail: 'Library offline' } };
    await mount();
    expect(alertText()).toBe('Library offline');
    await act(async () => root.unmount());
    root = createRoot(host);
    overrides['GET /knowledge'] = { status: 500, body: 'BAD' };
    await mount();
    expect(alertText()).toBe('Could not update the knowledge base');
  });

  it('polls while visible, skips polling while hidden and stops on unmount', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<KnowledgeDocuments isStreaming={false} hasExternalAgent={false} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const initial = calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(calls.length).toBe(initial + 1);
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(calls.length).toBe(initial + 1);
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden;
      vi.useRealTimers();
    }
  });

  it('collapses and expands the panel body', async () => {
    await mount();
    expect(q('.knowledge-body')).not.toBeNull();
    await click(q('.knowledge-toggle'));
    expect(q('.knowledge-body')).toBeNull();
    expect(q('.knowledge-chevron')?.textContent).toBe('+');
    await click(q('.knowledge-toggle'));
    expect(q('.knowledge-chevron')?.textContent).toBe('−');
  });

  it('shows the audience of each source and hides sources left in a retired library', async () => {
    documents = [doc({ audience: '11111111-1111-4111-8111-111111111111' }), doc({ id: 'd2', filename: 'old.docx', knowledge_base: 'retired' as never }), doc({ id: 'd3', filename: 'legacy.txt', knowledge_base: undefined, audience: undefined, status: 'failed', error: 'Parse failed' })];
    await mount();
    expect(listed()).toEqual(['policy.pdf', 'legacy.txt']);
    const metas = [...host.querySelectorAll('.knowledge-meta')].map(item => item.textContent);
    expect(metas.some(text => text?.includes('Engineering'))).toBe(true);
    expect(metas.some(text => text?.includes('Everyone'))).toBe(true);
    expect(host.textContent).not.toContain('Regional');
  });
  it('labels each preparation state', async () => {
    documents = [doc({ id: '2', status: 'queued' }), doc({ id: '3', status: 'indexing' }), doc({ id: '4', status: 'failed' }), doc({ id: '5' })];
    await mount();
    const text = [...host.querySelectorAll('.knowledge-status')].map(item => item.textContent);
    expect(text).toEqual(expect.arrayContaining(['Waiting to prepare', 'Preparing source…', 'Needs attention', 'Ready · 12 passages']));
    expect([...host.querySelectorAll('.knowledge-actions a')].filter(item => item.textContent === 'Read text')).toHaveLength(1);
  });

  it('sorts by name and by newest', async () => {
    documents = [doc({ id: '1', filename: 'b.pdf', created_at: '2026-01-01' }), doc({ id: '2', filename: 'a.pdf', created_at: '2026-01-02' }), doc({ id: '3', filename: 'c.pdf', created_at: '2026-01-03' })];
    await mount();
    expect(listed()).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
    await type(q('select[aria-label="Sort knowledge sources"]'), 'name');
    expect(listed()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('matches the local filter on filename, description and uploader', async () => {
    documents = [doc({ id: '1', filename: 'alpha.pdf', description: '', uploaded_by: 'zed' }), doc({ id: '2', filename: 'beta.pdf', description: 'Quarterly numbers', uploaded_by: 'ana' })];
    await mount();
    await type(searchInput(), 'QUARTERLY');
    expect(listed()).toEqual(['beta.pdf']);
    await type(searchInput(), 'zed');
    expect(listed()).toEqual(['alpha.pdf']);
    await type(searchInput(), 'nothing-here');
    expect(host.textContent).toContain('No sources match your filters.');
    await click(q('button[aria-label="Clear search"]'));
    expect(listed()).toHaveLength(2);
  });

  it('explains an empty library', async () => {
    documents = [];
    await mount();
    expect(q('.knowledge-empty')?.textContent).toContain('Build a library for the appropriate employee groups.');
    expect(button('Select manageable sources').disabled).toBe(true);
  });

  it('shows ownership details, overdue state and last review', async () => {
    documents = [doc({ owner: 'Maria', review_due: '2026-02-01', review_overdue: true, reviewed_at: '2026-01-15T00:00:00Z' }), doc({ id: 'd2', filename: 'x.pdf', review_due: '2026-03-01' })];
    await mount();
    const metas = [...host.querySelectorAll('.knowledge-meta.knowledge-error')];
    expect(metas[0].textContent).toContain('Owner: Maria · Review due: 2026-02-01 · Review overdue · Last reviewed:');
    expect(host.textContent).toContain('Owner: — · Review due: 2026-03-01');
  });

  it('notes external agents do not receive sources and hides manage actions for viewers', async () => {
    documents = [doc({ can_manage: false })];
    await mount({ hasExternalAgent: true });
    expect(q('.knowledge-notice')?.textContent).toContain('External agents do not receive its sources.');
    expect(q('.knowledge-list input[type="checkbox"]')).toBeNull();
    expect(q('.knowledge-remove')).toBeNull();
  });

  it('disables destructive actions while a response streams', async () => {
    await mount({ isStreaming: true });
    expect(q<HTMLButtonElement>('.knowledge-remove')?.disabled).toBe(true);
    expect(button('Replace file').disabled).toBe(true);
    expect(button('Reindex').disabled).toBe(true);
  });
});

describe('content search', () => {
  const searchNow = async (text: string) => {
    await type(searchInput(), text);
    await act(async () => { q('form.knowledge-search')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
  };

  it('returns passages, then goes back to the sources', async () => {
    overrides['POST /knowledge/search'] = { body: [{ id: 'd1', filename: 'policy.pdf', location: 'page 2', text: 'Passage text', citation_id: 'c1' }] };
    await mount();
    await searchNow('how many days');
    expect(calls.find(call => call.url === '/knowledge/search')?.body).toEqual({ query: 'how many days', knowledge_base: 'company' });
    expect(q('.knowledge-results')?.textContent).toContain('1 matching passages');
    expect(q('.knowledge-results article')?.textContent).toContain('Passage text');
    await press('Back to sources');
    expect(q('.knowledge-results')).toBeNull();
    expect(q('.knowledge-toolbar')).not.toBeNull();
  });

  it('explains no results and reports a failed search', async () => {
    overrides['POST /knowledge/search'] = { body: [] };
    await mount();
    await searchNow('nothing');
    expect(q('.knowledge-results')?.textContent).toContain('No relevant passages found');
    overrides['POST /knowledge/search'] = { status: 503, body: { detail: 'Search unavailable now' } };
    await searchNow('again');
    expect(alertText()).toBe('Search unavailable now');
  });

  it('ignores an empty query and keeps the submit disabled without ready sources', async () => {
    documents = [doc({ status: 'queued' })];
    await mount();
    await searchNow('   ');
    expect(calls.some(call => call.url === '/knowledge/search')).toBe(false);
    await type(searchInput(), 'question');
    expect(q<HTMLButtonElement>('form.knowledge-search button[type="submit"]')?.disabled).toBe(true);
  });

  it('drops a late response after the query changes', async () => {
    let release: (value: unknown) => void = () => {};
    await mount();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as Promise<Response>);
    await searchNow('first');
    expect(button('Searching…')).toBeTruthy();
    await type(searchInput(), 'second');
    await act(async () => { release({ ok: true, status: 200, json: async () => [{ id: 'd1', filename: 'late.pdf', location: 'p', text: 'late', citation_id: 'c' }] }); });
    await flush();
    expect(q('.knowledge-results')).toBeNull();
  });
});

describe('managing a source', () => {
  it('removes a source after confirmation and reports failure', async () => {
    await mount();
    confirm.mockResolvedValueOnce(false);
    await click(q('.knowledge-remove'));
    expect(requests('DELETE')).toHaveLength(0);
    await click(q('.knowledge-remove'));
    expect(requests('DELETE')[0].url).toBe('/knowledge/d1');
    overrides['DELETE /knowledge/d1'] = { status: 403, body: { detail: 'Not allowed' } };
    await click(q('.knowledge-remove'));
    expect(alertText()).toBe('Not allowed');
  });

  it('retries a failed source and reindexes a ready one', async () => {
    documents = [doc({ id: 'bad', status: 'failed' }), doc({ id: 'good', filename: 'good.pdf' })];
    await mount();
    await press('Retry');
    await press('Reindex');
    expect(requests('POST').map(call => call.url)).toEqual(['/knowledge/bad/retry', '/knowledge/good/retry']);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('marks a source reviewed preserving owner and due date', async () => {
    documents = [doc({ owner: 'Maria', review_due: '2026-02-01' }), doc({ id: 'd2', filename: 'x.pdf' })];
    await mount();
    const rows = () => [...host.querySelectorAll('.knowledge-list li')];
    await press('Mark reviewed', rows()[0]);
    await press('Mark reviewed', rows()[1]);
    expect(requests('PATCH').map(call => call.body)).toEqual([
      { owner: 'Maria', review_due: '2026-02-01', reviewed: true },
      { owner: '', review_due: null, reviewed: true },
    ]);
    overrides['PATCH /knowledge/d1/freshness'] = { status: 500, body: { detail: 'Review failed' } };
    await press('Mark reviewed', rows()[0]);
    expect(alertText()).toBe('Review failed');
  });

  it('lets a non-admin edit description and freshness only', async () => {
    await mount();
    await press('Edit description');
    expect(q('.knowledge-description-field select')).toBeNull();
    await type(q('textarea[aria-label="Description for policy.pdf"]'), 'Updated');
    await type(q('.knowledge-description-field input[maxlength="200"]'), 'Owner A');
    await type(q('.knowledge-description-field input[type="date"]'), '2026-05-01');
    await press('Save', q('.knowledge-list .knowledge-description-field')!);
    expect(requests('PATCH').map(call => [call.url, call.body])).toEqual([
      ['/knowledge/d1', { description: 'Updated' }],
      ['/knowledge/d1/freshness', { owner: 'Owner A', review_due: '2026-05-01' }],
    ]);
    expect(q('.knowledge-list .knowledge-description-field')).toBeNull();
  });

  it('lets an admin reclassify a source, cancel, and see save errors', async () => {
    documents = [doc({ owner: 'Maria', review_due: '2026-02-01', knowledge_base: undefined, audience: undefined, description: '' })];
    await mount({ isAdmin: true });
    await press('Edit classification & description');
    const field = () => q('.knowledge-list .knowledge-description-field')!;
    const [audienceSelect] = field().querySelectorAll('select');
    expect(audienceSelect.value).toBe('both');
    await type(audienceSelect, '11111111-1111-4111-8111-111111111111');
    overrides['PATCH /knowledge/d1'] = { status: 400, body: { detail: 'Invalid class' } };
    await press('Save', field());
    expect(alertText()).toBe('Invalid class');
    expect(requests('PATCH')[0].body).toEqual({ description: '', knowledge_base: 'company', audience: '11111111-1111-4111-8111-111111111111' });
    await press('Cancel', field());
    expect(q('.knowledge-list .knowledge-description-field')).toBeNull();
  });

  it('deletes selected sources one by one, clearing selection even after a failure', async () => {
    documents = [doc({ id: 'a' }), doc({ id: 'b', filename: 'b.pdf' }), doc({ id: 'c', filename: 'c.pdf', can_manage: false })];
    await mount();
    await click(q('input[aria-label="Select b.pdf"]'));
    await click(q('input[aria-label="Select policy.pdf"]'));
    await click(q('input[aria-label="Select policy.pdf"]'));
    expect(button(/Delete selected/).textContent).toContain('1');
    await press('Clear selection');
    expect(() => button(/Delete selected/)).toThrow();
    await press('Select manageable sources');
    confirm.mockResolvedValueOnce(false);
    await press(/Delete selected/);
    expect(requests('DELETE')).toHaveLength(0);
    overrides['DELETE /knowledge/b'] = { status: 500, body: { detail: 'Second failed' } };
    await press(/Delete selected/);
    expect(requests('DELETE').map(call => call.url)).toEqual(['/knowledge/a', '/knowledge/b']);
    expect(alertText()).toBe('Second failed');
    expect(() => button(/Delete selected/)).toThrow();
  });

  describe('replacing a file', () => {
    const replacement = () => host.querySelectorAll('input[type="file"]')[1];
    const start = async () => { await mount(); await press('Replace file'); };

    it('uploads the replacement with PUT after confirming', async () => {
      await start();
      await pick(replacement(), [file('new.pdf')]);
      expect(confirm.mock.calls[0][0]).toContain('Replace “policy.pdf” with “new.pdf”');
      expect(requests('PUT')[0].url).toBe('/knowledge/d1');
      expect((requests('PUT')[0].body as FormData).get('file')).toBeInstanceOf(File);
    });

    it('does nothing when the confirmation is declined or no file is chosen', async () => {
      await start();
      await pick(replacement(), []);
      confirm.mockResolvedValueOnce(false);
      await pick(replacement(), [file('new.pdf')]);
      expect(requests('PUT')).toHaveLength(0);
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an unsupported type', file('virus.exe')],
      ['an oversized file', file('big.pdf', 21 * 1024 * 1024)],
    ])('refuses %s', async (_name, chosen) => {
      await start();
      await pick(replacement(), [chosen]);
      expect(alertText()).toBe('Choose a supported file no larger than 20 MB.');
      expect(requests('PUT')).toHaveLength(0);
    });

    it('reports a failed replacement', async () => {
      await start();
      overrides['PUT /knowledge/d1'] = { status: 500, body: { detail: 'Replace failed' } };
      await pick(replacement(), [file('new.pdf')]);
      expect(alertText()).toBe('Replace failed');
    });
  });
});

describe('admin uploads', () => {
  it('reviews chosen files, applying default and per-file descriptions', async () => {
    await mount({ isAdmin: true });
    await type(q('.knowledge-description-field select'), '11111111-1111-4111-8111-111111111111');
    await type(q('.knowledge-description-field textarea'), 'Default text');
    await pick(uploadInput(), [file('a.pdf', 3 * 1024 * 1024), file('b.csv', 100)]);
    const review = () => q('.knowledge-upload-review')!;
    expect(review().textContent).toContain('a.pdf · 3.0 MB');
    expect(review().textContent).toContain('b.csv · 1 KB');
    await type(q('textarea[aria-label="Description for upload a.pdf"]'), 'Specific text');
    await press('Upload 2 documents', review());
    const posts = requests('POST').map(call => call.body as FormData);
    expect(posts.map(form => form.get('description'))).toEqual(['Specific text', 'Default text']);
    expect(posts[0].get('audience')).toBe('11111111-1111-4111-8111-111111111111');
    expect(posts[0].get('knowledge_base')).toBe('company');
    expect(statusText()).toContain('2 sources added');
    expect(q('.knowledge-upload-review')).toBeNull();
  });

  it('uses singular wording for one upload and can cancel the review', async () => {
    await mount({ isAdmin: true });
    await pick(uploadInput(), [file('a.pdf')]);
    expect(button('Upload 1 document')).toBeTruthy();
    await press('Cancel', q('.knowledge-upload-review')!);
    expect(q('.knowledge-upload-review')).toBeNull();
    await pick(uploadInput(), [file('a.pdf')]);
    await press('Upload 1 document');
    expect(statusText()).toContain('1 source added');
  });

  it.each([
    ['unsupported files', file('run.exe'), 'run.exe: choose PDF, Word, text, CSV, or Excel files.'],
    ['files over the limit', file('big.pdf', 21 * 1024 * 1024), 'big.pdf exceeds the 20 MB limit.'],
  ])('rejects %s and keeps them for review', async (_name, chosen, text) => {
    await mount({ isAdmin: true });
    await pick(uploadInput(), [chosen]);
    await press(/^Upload 1 document/);
    expect(alertText()).toBe(text);
    expect(requests('POST')).toHaveLength(0);
    expect(q('.knowledge-upload-review')).not.toBeNull();
  });

  it('reports a server upload failure', async () => {
    overrides['POST /knowledge'] = { status: 413, body: {} };
    await mount({ isAdmin: true });
    await pick(uploadInput(), [file('a.pdf')]);
    await press('Upload 1 document');
    expect(alertText()).toBe('Could not update the knowledge base');
  });

  it('opens the file chooser from the header and the dropzone, expanding the panel', async () => {
    await mount({ isAdmin: true });
    const chooser = vi.spyOn(uploadInput() as HTMLInputElement, 'click').mockImplementation(() => {});
    await click(q('.knowledge-toggle'));
    expect(q('.knowledge-body')).toBeNull();
    await press('+ Add sources');
    expect(q('.knowledge-body')).not.toBeNull();
    await click(q('.knowledge-dropzone-trigger'));
    expect(chooser).toHaveBeenCalledTimes(2);
  });

  it('tracks nested drags and accepts dropped files', async () => {
    await mount({ isAdmin: true });
    const zone = () => q('.knowledge-dropzone');
    await drag(zone(), 'dragenter', [], ['text/plain']);
    expect(zone()?.classList.contains('dragging')).toBe(false);
    await drag(zone(), 'dragenter');
    await drag(zone(), 'dragenter');
    expect(zone()?.classList.contains('dragging')).toBe(true);
    expect(q('.knowledge-dropzone-copy strong')?.textContent).toBe('Drop your documents here');
    await drag(zone(), 'dragover');
    await drag(zone(), 'dragover', [], ['text/plain']);
    await drag(zone(), 'dragleave');
    expect(zone()?.classList.contains('dragging')).toBe(true);
    await drag(zone(), 'dragleave');
    expect(zone()?.classList.contains('dragging')).toBe(false);
    await drag(zone(), 'drop');
    expect(q('.knowledge-upload-review')).toBeNull();
    await drag(zone(), 'drop', [file('dropped.pdf')]);
    expect(q('.knowledge-upload-review')?.textContent).toContain('dropped.pdf');
  });
});
