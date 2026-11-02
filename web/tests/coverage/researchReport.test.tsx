// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/components/MarkdownView', () => ({ MarkdownView: ({ content }: any) => <p>{content}</p> }));
vi.mock('../../src/components/CitationPreview', () => ({ CitationPreview: () => null }));
vi.mock('../../src/components/ShareToPeople', () => ({ ShareToPeople: () => null }));
import { ResearchReport } from '../../src/components/ResearchReport';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('links citations only to safe sources and includes relevant evidence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const sources = [
    { id: 'S1', title: 'Verified source', url: 'https://example.com/evidence', text: 'Renewable energy investment increased substantially during 2025 according to published financial research.' },
    { id: 'S2', title: 'Unsafe source', url: 'javascript:alert(1)', text: 'A second source.' },
    { id: 'S3', title: 'Knowledge file', url: '/knowledge/01234567-89ab-cdef-0123-456789abcdef/file', excerpt: 'Selected excerpt' },
  ];
  await act(async () => root.render(<ResearchReport title="Evidence" sessionId="s1" content="Renewable energy investment increased substantially [S1]. Unsafe [S2]. Knowledge [S3]. Unknown [S4]." sources={sources} />));
  const links = [...host.querySelectorAll<HTMLAnchorElement>('.research-report-body a')];
  expect(links.map(link => link.textContent)).toEqual(['[S1]', '[S3]']);
  expect(links[0].dataset.sourceQuote).toContain('Renewable energy investment');
  expect(links[1].dataset.sourceKind).toBe('knowledge'); expect(links[1].dataset.sourceQuote).toBe('Selected excerpt');
  expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(host.textContent).toContain('[S2]'); expect(host.textContent).toContain('[S4]');
});


test('saves a sanitized report to Office without collected evidence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const originalAppend = document.body.append.bind(document.body);
  const append = vi.spyOn(document.body, 'append').mockImplementation((...nodes: (Node | string)[]) => {
    originalAppend(...nodes);
    for (const node of nodes) if (node instanceof HTMLIFrameElement && node.contentDocument && node.contentWindow) {
      Object.defineProperty(node.contentDocument, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
      node.contentWindow.requestAnimationFrame = callback => { callback(0); return 1; };
    }
  });
  const fetchMock = vi.fn().mockResolvedValue({ ok:true, status:200, json:async () => ({id:'file-1', name:'Report.html'}) }); vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ResearchReport title="Research" sessionId="s1" content="A report [S1]" sources={[{ id:'S1', url:'https://example.com/', excerpt:'private evidence' }]} canSaveToOffice />));
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Save HTML to Office Suite')!;
  await act(async () => { button.click(); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); });
  const [url, options] = fetchMock.mock.calls[0]; expect(url).toBe('/research/s1/office');
  const body = JSON.parse(options.body); expect(body.format).toBe('html'); expect(body.html).toContain('A report'); expect(body.html).not.toContain('private evidence');
  await vi.waitFor(() => expect(host.textContent).toContain('Report.html'));
  expect(document.querySelector('.research-print-frame')).toBeNull(); append.mockRestore();
});

test('includes source evidence when explicitly requested', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const originalAppend = document.body.append.bind(document.body);
  const append = vi.spyOn(document.body, 'append').mockImplementation((...nodes: (Node | string)[]) => {
    originalAppend(...nodes);
    for (const node of nodes) if (node instanceof HTMLIFrameElement && node.contentDocument && node.contentWindow) {
      Object.defineProperty(node.contentDocument, 'fonts', { configurable:true, value:{ready:Promise.resolve()} });
      node.contentWindow.requestAnimationFrame = callback => { callback(0); return 1; };
    }
  });
  const fetchMock = vi.fn().mockResolvedValue({ ok:true, status:200, json:async () => ({id:'f', name:'Report.html'}) }); vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ResearchReport title="Research" sessionId="s" content="Summary" sources={[{id:'S1', url:'https://example.com/', text:'Collected source text'}]} canSaveToOffice />));
  await act(async () => (host.querySelector('input[type=checkbox]') as HTMLInputElement).click());
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Save HTML to Office Suite')!;
  await act(async () => { button.click(); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).html).toContain('Collected source text');
  append.mockRestore();
});
