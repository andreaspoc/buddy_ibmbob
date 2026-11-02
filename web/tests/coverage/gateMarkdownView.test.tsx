// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const panels = vi.hoisted(() => ({ dispose: [] as any[] }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock('../../src/lib/mermaidPanel', () => ({ createMermaidPanel: (host: HTMLElement, source: string) => { host.dataset.rendered = source; const dispose = vi.fn(); panels.dispose.push(dispose); return { panel: host, dispose }; } }));
vi.mock('../../src/components/ChartRenderer', () => ({ renderChartToDOM: (spec: any) => { const el = document.createElement('div'); el.className = 'fake-chart'; el.textContent = spec.title; return el; } }));
vi.mock('../../src/components/MapRenderer', () => ({ renderMapToDOM: (spec: any) => { const el = document.createElement('div'); el.className = 'fake-map'; el.textContent = spec.title; return el; } }));
vi.mock('../../src/components/StructuredDiagram', () => ({ StructuredDiagram: ({ streaming, compact }: any) => <div className="fake-diagram">{`streaming:${streaming} compact:${compact}`}</div> }));
vi.mock('../../src/components/IntelligentAnswer', () => ({ IntelligentAnswer: ({ identity, onPrompt, disabled }: any) => <div className="fake-ui">{`${identity} prompt:${Boolean(onPrompt)} disabled:${disabled}`}</div> }));
vi.mock('../../src/components/GeneratedCodePreview', () => ({ GeneratedCodePreview: () => <div className="fake-code-preview" /> }));
vi.mock('../../src/components/CitationPreview', () => ({ CitationPreview: () => <div className="fake-citation-preview" /> }));
import { MarkdownView } from '../../src/components/MarkdownView';

const UUID = '12345678-1234-1234-1234-123456789abc';
const SESSION = 'a'.repeat(32);
let host: HTMLDivElement; let root: Root;
const view = (content: string, extra: Record<string, unknown> = {}) => act(async () => { root.render(<MarkdownView content={content} {...extra} />); });
const q = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
const qa = (s: string) => [...host.querySelectorAll<HTMLElement>(s)];
const anchor = () => q<HTMLAnchorElement>('.markdown-body a')!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  panels.dispose.length = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('citations', () => {
  const doc = (label = 'Policy, page 3', extra = '') => `[${label}](/knowledge/${UUID}/file${extra})`;
  it('numbers document citations, reuses numbers and lists sources without page detail', async () => {
    await view(`See ${doc()} and ${doc('Policy again')} and [Other, text](/sessions/${SESSION}/knowledge/${UUID.replace('1', '2')}/file).`);
    const markers = qa('a.citation-marker');
    expect(markers.map(m => m.textContent)).toEqual(['[1]', '[1]', '[2]']);
    expect(markers[1].getAttribute('aria-label')).toBe('Source 1: Policy again');
    expect(q('.answer-sources summary')?.textContent).toBe('Sources · 2 documents');
    expect(qa('.answer-sources li a')[0].textContent).toBe('[1] Policy');
  });
  it('uses the singular summary and keeps supporting quote in preview url', async () => {
    await view(`${doc('Doc', ' "supporting line"')}`);
    expect(q('.answer-sources summary')?.textContent).toBe('Sources · 1 document');
    const marker = q('a.citation-marker')!;
    expect(marker.dataset.citationPreview).toContain('/preview?quote=supporting+line');
    expect(marker.hasAttribute('title')).toBe(false);
  });
  it('can omit consolidated sources', async () => {
    await view(doc(), { consolidatedSources: true });
    expect(q('.answer-sources')).toBeNull();
    expect(q('a.citation-marker')?.textContent).toBe('[1]');
  });
  it('treats SharePoint and Teams links as business citations without previews', async () => {
    await view('[Plan](https://corp.sharepoint.com/x "quote") [Call](https://teams.microsoft.com/l/meeting) [Other](https://teams.microsoft.com/other)');
    const markers = qa('a.citation-marker');
    expect(markers).toHaveLength(2);
    expect(markers[0].dataset.citationPreview).toBeUndefined();
    expect(markers[0].hasAttribute('title')).toBe(false);
    expect(qa('.markdown-body a').at(2)?.textContent).toBe('Other');
  });
  it('disables citation still being generated', async () => {
    await view(`Before ${doc('Doc').replace('/file', '/file#stream-pending')}`, { isStreaming: false });
    const marker = q('a.citation-marker')!;
    expect(marker.hasAttribute('href')).toBe(false);
    expect(marker.getAttribute('aria-disabled')).toBe('true');
    expect(marker.getAttribute('aria-label')).toContain('citation being generated');
  });
});

describe('links', () => {
  it('opens external links safely and drops their titles', async () => {
    await view('[Ext](https://example.test/a "tip")');
    expect(anchor().target).toBe('_blank');
    expect(anchor().rel).toBe('noopener noreferrer');
    expect(anchor().hasAttribute('title')).toBe(false);
  });
  it.each([
    ['report.pptx', 'presentation-badge', '📊 Download Report'],
    ['data.csv', 'sheet-badge', '📈 Download Report'],
    ['notes.txt', 'file-download-badge', 'Report'],
  ])('downloads workspace file %s with badge', async (file, cls, text) => {
    await view(`[Report](./dir/${file})`, { sessionId: 'sess 1' });
    expect(anchor().getAttribute('href')).toBe(`/sessions/sess%201/file?path=${encodeURIComponent(`dir/${file}`)}`);
    expect(anchor().classList.contains(cls)).toBe(true);
    expect(anchor().textContent).toBe(text);
    expect(anchor().getAttribute('download')).toBe(file);
  });
  it.each([['deck.bobdeck', '📊 Ready'], ['deck.ppt', '📥 Ready'], ['x.xlsx', '📈 Ready'], ['y.xls', '📥 Ready']])('does not double badge %s', async (file, label) => {
    await view(`[${label}](${file})`);
    expect(anchor().textContent).toBe(label);
    expect(anchor().getAttribute('title')).toContain(file);
  });
  it('uses the legacy session and removes in-page hrefs', async () => {
    await view('[File](a.txt) [Anchor](#top)');
    const [file, hash] = qa('.markdown-body a');
    expect(file.getAttribute('href')).toContain('/sessions/legacy/file');
    expect(hash.hasAttribute('href')).toBe(false);
  });
  it('protects private links in read-only shares', async () => {
    await view(`[Private](a.txt) [Abs](/projects/1) [Ext](https://example.test) [Doc](/knowledge/${UUID}/file) [Home](/about)`, { readOnly: true, sessionId: 's' });
    const [priv, abs, ext, cite, about] = qa('.markdown-body > p a');
    expect(priv.getAttribute('title')).toBe('Private files are not included in shared conversations.');
    expect(priv.hasAttribute('href')).toBe(false);
    expect(abs.getAttribute('aria-disabled')).toBe('true');
    expect(ext.getAttribute('href')).toBe('https://example.test');
    expect(cite.getAttribute('href')).toContain('/knowledge/');
    expect(about.getAttribute('aria-disabled')).toBe('true');
    expect(q('.fake-citation-preview')).toBeNull();
    expect(q('.fake-code-preview')).toBeNull();
  });
});

describe('read-only session citations', () => {
  it('disables citations that point into a private session', async () => {
    await view(`[Doc](/sessions/${SESSION}/knowledge/${UUID}/file)`, { readOnly: true });
    const marker = q('a.citation-marker')!;
    expect(marker.hasAttribute('href')).toBe(false);
    expect(marker.getAttribute('aria-disabled')).toBe('true');
    expect(qa('.answer-sources a').every(link => !link.hasAttribute('href'))).toBe(true);
  });
});

describe('images', () => {
  it.each([
    ['![c](./c.png)', {}, '/sessions/legacy/file?path=c.png'],
    ['![c](https://example.test/c.png)', {}, 'https://example.test/c.png'],
  ])('resolves %s', async (md, extra, src) => {
    await view(md, extra);
    expect(q('img')?.getAttribute('src')).toBe(src);
  });
  it('removes private images when sharing', async () => {
    await view('![c](./c.png)', { readOnly: true });
    expect(q('img')?.hasAttribute('src')).toBe(false);
    expect(q<HTMLImageElement>('img')?.alt).toBe('Private image not included in shared conversation');
  });
});

describe('embedded visuals', () => {
  const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```';
  it.each([['chart', '.fake-chart'], ['bobchart', '.fake-chart'], ['map', '.fake-map'], ['bobmap', '.fake-map'], ['geojson', '.fake-map']])('renders %s', async (lang, cls) => {
    await view(fence(lang, '{"title":"T"}'));
    expect(q(cls)?.textContent).toBe('T');
  });
  it.each(['chart', 'map'])('keeps invalid %s json as a code block', async lang => {
    await view(fence(lang, '{broken'));
    expect(q(`code.language-${lang}`)?.textContent).toContain('{broken');
  });
  it.each([['chart', '.fake-chart'], ['map', '.fake-map']])('waits for following content while streaming %s', async (lang, cls) => {
    await view(fence(lang, '{"title":"T"}'), { isStreaming: true });
    expect(q(cls)).toBeNull();
    await view(`${fence(lang, '{"title":"T"}')}\n\nNext`, { isStreaming: true });
    expect(q(cls)).not.toBeNull();
  });
  it('mounts mermaid only when complete and disposes removed panels', async () => {
    await view(fence('mermaid', 'flowchart TD'), { isStreaming: true });
    expect(q('.mermaid-panel')).toBeNull();
    await view(fence('mermaid', 'flowchart TD'), { sessionId: 's' });
    expect(q<HTMLElement>('.mermaid-panel')?.dataset.rendered).toContain('flowchart TD');
    await view(fence('mermaid', 'flowchart TD'), { sessionId: 's' });
    expect(panels.dispose).toHaveLength(1);
    await view('plain', { sessionId: 's' });
    expect(panels.dispose[0]).toHaveBeenCalledOnce();
    expect(q('.mermaid-panel')).toBeNull();
  });
  it('disposes live panels at unmount', async () => {
    await view(fence('mermaid', 'flowchart LR'));
    act(() => root.render(<div />));
    expect(panels.dispose[0]).toHaveBeenCalledOnce();
  });
  it('wraps tables into interactive cards only when complete', async () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
    await view(table, { isStreaming: true });
    expect(q('.markdown-body > table')).not.toBeNull();
    await view(table);
    expect(q('.markdown-body > table')).toBeNull();
    expect(q('.interactive-table-panel')?.textContent).toContain('1');
  });
  it('mounts structured diagrams with streaming and compact flags', async () => {
    const spec = fence('bobdiagram', '{"nodes":[]}');
    await view(spec, { compactDiagrams: true });
    expect(q('.fake-diagram')?.textContent).toBe('streaming:false compact:true');
    await view('```bobdiagram\n{"nodes"', { isStreaming: true });
    expect(q('.fake-diagram')?.textContent).toContain('streaming:true');
    expect(q('.structured-diagram-host')?.hasAttribute('data-stream-tail')).toBe(false);
  });
});

describe('code windows', () => {
  const code = '```ts\nconst a = 1;\n```';
  const writeText = vi.fn();
  const copyButton = () => qa('.code-subwindow-btn')[0];
  beforeEach(() => { writeText.mockReset(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } }); });
  it.each([['```ts\nx\n```', 'TS'], ['```\nx\n```', 'CODE'], ['```bobdeck\nx\n```', 'presentation.bobdeck']])('titles %s', async (md, title) => {
    await view(md);
    expect(q('.code-subwindow-title')?.textContent).toBe(title);
  });
  it('copies, resets and reports clipboard errors', async () => {
    vi.useFakeTimers();
    writeText.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    await view(code);
    await act(async () => { copyButton().click(); await vi.advanceTimersByTimeAsync(0); });
    expect(writeText).toHaveBeenCalledWith('const a = 1;\n');
    expect(copyButton().dataset.copyState).toBe('copied');
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(copyButton().textContent).toBe('Copy');
    expect(copyButton().dataset.copyState).toBe('idle');
    await act(async () => { copyButton().click(); await vi.advanceTimersByTimeAsync(0); });
    expect(copyButton().dataset.copyState).toBe('error');
  });
  it('collapses and expands', async () => {
    await view(code);
    const toggle = qa('.code-subwindow-btn')[1];
    await act(async () => toggle.click());
    expect(q('.code-subwindow')?.classList.contains('collapsed')).toBe(true);
    expect(toggle.textContent).toBe('Expand');
    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('Collapse');
  });
  it('leaves streaming code unwrapped and marks the tail', async () => {
    await view('Hello\n\n- item', { isStreaming: true });
    expect(q('.code-subwindow')).toBeNull();
    expect(q('li[data-stream-tail], p[data-stream-tail]')?.textContent).toContain('item');
    expect(q('.markdown-body')?.getAttribute('aria-busy')).toBe('true');
  });
  it('removes stale blocks when content shrinks and reuses stable blocks', async () => {
    await view('One\n\nTwo\n\nThree');
    const first = q('.markdown-body p');
    await view('One\n\nTwo');
    expect(qa('.markdown-body p').map(p => p.textContent)).toEqual(['One', 'Two']);
    expect(q('.markdown-body p')).toBe(first);
  });
});

describe('intelligent answers', () => {
  const ui = '```bobui\n{"kind":"steps"}\n```';
  it.each([
    [{ messageId: 'm1', onPrompt: vi.fn() }, 'm1:', 'prompt:true'],
    [{ readOnly: true, onPrompt: vi.fn() }, 'document:', 'prompt:false'],
  ])('mounts with props %#', async (extra, identity, prompt) => {
    await view(ui, extra);
    expect(q('.fake-ui')?.textContent).toContain(identity);
    expect(q('.fake-ui')?.textContent).toContain(prompt);
  });
});

describe('artifact links', () => {
  const opened = () => { const spy = vi.fn(); window.addEventListener('buddy-open-artifact', spy as EventListener); return { spy, stop: () => window.removeEventListener('buddy-open-artifact', spy as EventListener) }; };
  const fire = (el: Element, type: string, init: MouseEventInit = {}) => act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })); });
  it('opens html artifacts inline on click, respecting modifier keys', async () => {
    const { spy, stop } = opened();
    await view('[Deck](deck.html)', { sessionId: 's1' });
    await fire(anchor(), 'click', { ctrlKey: true });
    expect(spy).not.toHaveBeenCalled();
    await fire(anchor(), 'click');
    expect(spy.mock.calls[0][0].detail).toEqual({ path: 'deck.html', sessionId: 's1' });
    stop();
  });
  it('previews on hover after a delay and cancels on leave', async () => {
    vi.useFakeTimers();
    const { spy, stop } = opened();
    await view('[Deck](deck.bobdeck)', { sessionId: 's1' });
    await fire(anchor(), 'mouseover');
    await fire(anchor(), 'mouseout');
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(spy).not.toHaveBeenCalled();
    await fire(anchor(), 'mouseover');
    await fire(anchor(), 'mouseover');
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(spy).toHaveBeenCalledOnce();
    stop();
  });
  it.each([['[Text](a.txt)'], ['[Ext](https://example.test/a.html)'], ['Plain text']])('does not open %s', async md => {
    const { spy, stop } = opened();
    await view(md, { sessionId: 's1' });
    const target = q('.markdown-body a') || q('.markdown-body p')!;
    target.addEventListener('click', e => e.preventDefault());
    await fire(target, 'click');
    expect(spy).not.toHaveBeenCalled();
    stop();
  });
});
