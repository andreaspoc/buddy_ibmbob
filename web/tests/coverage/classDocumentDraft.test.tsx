// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassDocumentField } from '../../src/components/ClassDocumentField';
import { draftLessonFromDocument } from '../../src/lib/classDocumentDraft';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = new File(['Synthetic source'], 'policy.txt', { type: 'text/plain' });
const reply = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe('draftLessonFromDocument', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads the file, brief, and language to the class folder', async () => {
    const fetcher = reply(200, { title: 'Policy', source_truncated: false, untranslated: [] });
    vi.stubGlobal('fetch', fetcher);
    const outcome = await draftLessonFromDocument('a/b', file, 'Focus');
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('“Policy”');
    expect(outcome.message).not.toContain('first part');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/learning/folders/a%2Fb/lesson-document-draft');
    const body = init?.body as FormData;
    expect(body.get('brief')).toBe('Focus');
    expect(body.get('file')).toBeInstanceOf(File);
    expect(body.get('language')).toBeTruthy();
  });

  it('warns about truncation and failed translations', async () => {
    vi.stubGlobal('fetch', reply(200, { title: 'Policy', source_truncated: true, untranslated: ['el', 'hi'] }));
    const { message } = await draftLessonFromDocument('folder', file, '');
    expect(message).toContain('first part');
    expect(message).toContain('el, hi');
  });

  it('keeps the class and reports the server reason', async () => {
    vi.stubGlobal('fetch', reply(422, { detail: 'Unsupported document format' }));
    const outcome = await draftLessonFromDocument('folder', file, '');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Your class was created');
    expect(outcome.message).toContain('Unsupported document format');
  });

  it('falls back when the error has no readable detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway error', { status: 502 })));
    expect((await draftLessonFromDocument('folder', file, '')).message).toContain('502');
  });

  it('reports network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await draftLessonFromDocument('folder', file, '')).message).toContain('offline');
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'unknown'; }));
    expect((await draftLessonFromDocument('folder', file, '')).message).toContain('Request failed.');
  });
});

describe('ClassDocumentField', () => {
  const render = async (props: Partial<Parameters<typeof ClassDocumentField>[0]>) => {
    const host = document.createElement('div');
    const onFile = vi.fn();
    const onBrief = vi.fn();
    const root = createRoot(host);
    await act(async () => { root.render(<ClassDocumentField file={null} brief="" busy={false} onFile={onFile} onBrief={onBrief} {...props} />); });
    return { host, onFile, onBrief };
  };

  it('hides the brief until a document is chosen and reports selection', async () => {
    const { host, onFile } = await render({});
    expect(host.querySelector('textarea')).toBeNull();
    const input = host.querySelector('input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onFile).toHaveBeenCalledWith(file);
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onFile).toHaveBeenLastCalledWith(null);
  });

  it('explains privacy, and shows progress while busy', async () => {
    const idle = await render({ file });
    expect(idle.host.textContent).toContain('the file is not kept');
    const busy = await render({ file, busy: true });
    expect(busy.host.querySelector('[role="status"]')?.textContent).toContain('several minutes');
    expect((busy.host.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('passes the brief to its owner', async () => {
    const { host, onBrief } = await render({ file });
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(area, 'Focus'); area.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(onBrief).toHaveBeenCalledWith('Focus');
  });
});
