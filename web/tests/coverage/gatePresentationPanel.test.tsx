// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deckLib = vi.hoisted(() => ({ throwOnResolve: false }));
vi.mock('../../src/components/ShareToPeople', () => ({ ShareToPeopleButton: ({ disabled, title }: any) => <button disabled={disabled} title={title}>Share</button> }));
vi.mock('../../src/components/WorkspaceDeckViewer', () => ({ WorkspaceDeckViewer: ({ filename, onDirtyChange }: any) => <div><span>Deck: {filename}</span><button onClick={() => onDirtyChange(true)}>Dirty deck</button></div> }));
vi.mock('../../src/components/ArtifactChangeRequest', () => ({ ArtifactChangeRequest: ({ path }: any) => <div>Change {path}</div> }));
vi.mock('../../src/components/HtmlDeckViewer', () => ({ isCompleteHtmlDeck: (html: string) => html.includes('</html>'), HtmlDeckViewer: ({ htmlContent, onDirtyChange, onSaveHtml, isWorking }: any) => <div><span data-testid="html">{htmlContent}</span><span>{isWorking ? 'working' : 'idle'}</span><button onClick={() => onDirtyChange(true)}>Edit</button><button onClick={() => { void onSaveHtml('updated').catch((e: Error) => { document.body.dataset.saveError = e.message; }); }}>Save HTML</button></div> }));
vi.mock('../../src/components/AppDialog', () => ({ appConfirm: vi.fn() }));
vi.mock('../../src/lib/bobdeck.js', () => ({
  resolveDeckLayout: (deck: any) => { if (deckLib.throwOnResolve) throw new Error('incomplete'); return { slides: deck.slides, theme: deck.theme }; },
  renderSlideToSvg: (slide: any) => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('data-title', slide.title); return svg; },
}));
import { PresentationPreviewPanel } from '../../src/mods/PresentationPreviewPanel';
import { appConfirm } from '../../src/components/AppDialog';

let host: HTMLDivElement; let root: Root; let props: any; let source: () => any; let page: () => any; let urls: string[];
const render = async (extra: Record<string, unknown> = {}) => { props = { ...props, ...extra }; await act(async () => { root.render(<PresentationPreviewPanel {...props} />); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const pageRow = (name: string) => ({ name, path: name, size: 1, is_presentation: true });
const deckMessage = (count: number, extra: Record<string, unknown> = {}) => ({ id: 'a', role: 'assistant', content: '```bobdeck\n' + JSON.stringify({ title: 'Live', slides: Array.from({ length: count }, (_, i) => ({ title: `S${i + 1}` })) }) + '\n```', isPresentation: true, ...extra });
const labelled = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const svgTitle = () => host.querySelector('svg[data-title]')?.getAttribute('data-title');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  deckLib.throwOnResolve = false; delete document.body.dataset.saveError; urls = [];
  source = () => ({ ok: true, json: async () => ({ content: 'saved slides', sha256: 'h1' }) });
  page = () => ({ ok: true, json: async () => ({ html: '<p>polled</p>' }) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return url.startsWith('/workspace/page') ? page() : source(); }));
  (appConfirm as any).mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  props = { sessionId: 's', isStreaming: false, pages: [], files: [], messages: [], activeMode: 'chat', onClose: vi.fn(), onRefreshPages: vi.fn() };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('live deck preview', () => {
  const live = (count: number) => render({ isStreaming: true, messages: [deckMessage(count)], activeMode: 'presentation' });
  it('follows the newest slide while streaming', async () => {
    await live(2);
    expect(host.textContent).toContain('2 slides ready');
    expect(host.textContent).toContain('Slide 2 of 2');
    expect(svgTitle()).toBe('S2');
    await live(3);
    expect(svgTitle()).toBe('S3');
  });
  it('navigates manually and pauses following until re-enabled', async () => {
    await live(3);
    expect(labelled('Next live slide').disabled).toBe(true);
    await click(labelled('Previous live slide'));
    expect(svgTitle()).toBe('S2');
    await live(4);
    expect(svgTitle()).toBe('S2');
    await click(labelled('Next live slide'));
    expect(svgTitle()).toBe('S3');
    const follow = host.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(follow.checked).toBe(false);
    await click(follow);
    expect(svgTitle()).toBe('S4');
  });
  it('tolerates layouts that cannot yet resolve', async () => {
    deckLib.throwOnResolve = true;
    await live(1);
    expect(host.querySelector('svg[data-title]')).toBeNull();
    expect(host.textContent).toContain('1 slides ready');
  });
  it('uses bobdeck live artifact content for the selected file', async () => {
    const content = JSON.stringify({ title: 'Art', slides: [{ title: 'Artifact one' }] });
    await render({ isStreaming: true, liveArtifact: { path: 'art.bobdeck', name: 'art.bobdeck', content, live: true, is_presentation: true } });
    expect(host.querySelector('.mod-panel-title-group')?.textContent).toBeTruthy();
    expect(host.querySelector('.studio-save-state')?.textContent).toBe('Creating slides');
  });
});

describe('generating state', () => {
  it('shows progress with status text and progress track for presentation mode', async () => {
    await render({ isStreaming: true, activeMode: 'presentation', messages: [{ id: 'a', role: 'assistant', content: '', mode: 'presentation', statusText: 'Designing' }] });
    expect(host.querySelector('.mod-generating-state')?.textContent).toContain('Designing');
    expect(host.querySelector('.mod-progress-bar')).not.toBeNull();
  });
  it('falls back to running work-log step then default copy', async () => {
    await render({ isStreaming: true, messages: [{ id: 'a', role: 'assistant', content: '', isPresentation: true, workLog: [{ state: 'done', text: 'Old' }, { state: 'running', text: 'Researching' }] }] });
    expect(host.querySelector('.mod-panel-subtitle')?.textContent).toBe('Researching');
    await render({ messages: [{ id: 'a', role: 'assistant', content: '', isPresentation: true }] });
    expect(host.querySelector('.mod-generating-state')?.textContent).toContain('The preview appears here');
    expect(host.querySelector('.mod-progress-bar')).toBeNull();
  });
  it('shows onboarding when idle', async () => {
    await render();
    expect(host.querySelectorAll('.studio-empty-steps li')).toHaveLength(3);
    expect(host.querySelector('.studio-save-state')?.textContent).toBe('Ready when you are');
    expect(button('Share').disabled).toBe(true);
  });
});

describe('polling and sources', () => {
  it('polls the selected HTML and shows the live content while streaming', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await render({ isStreaming: true, presentationPath: 'a.html', messages: [{ id: 'a', role: 'assistant', content: '', isPresentation: true }] });
    expect(host.querySelector('[data-testid=html]')?.textContent).toBe('<p>polled</p>');
    expect(host.textContent).toContain('working');
    expect(urls[0]).toBe('/workspace/page?path=a.html&session_id=s');
    page = () => ({ ok: true, json: async () => ({ html: '<p>next</p>' }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(host.querySelector('[data-testid=html]')?.textContent).toBe('<p>next</p>');
  });
  it.each([
    ['non-ok', () => ({ ok: false, json: async () => ({}) })],
    ['throwing', () => { throw new Error('not yet'); }],
    ['non-string', () => ({ ok: true, json: async () => ({ html: 5 }) })],
  ])('keeps waiting on %s poll results', async (_name, response) => {
    page = response;
    await render({ isStreaming: true, presentationPath: 'a.html', messages: [{ id: 'a', role: 'assistant', content: '', isPresentation: true }] });
    expect(host.querySelector('[data-testid=html]')).toBeNull();
    expect(host.querySelector('.mod-generating-state')).not.toBeNull();
  });
  it('refreshes and preserves live complete HTML snapshot on finish', async () => {
    const liveArtifact = { path: 'd.html', name: 'd.html', content: '<html>v1</html>', live: true, is_presentation: true };
    await render({ liveArtifact });
    expect(host.querySelector('[data-testid=html]')?.textContent).toBe('saved slides');
    await render({ isStreaming: true });
    expect(host.querySelector('[data-testid=html]')?.textContent).toBe('<html>v1</html>');
    await render({ isStreaming: false });
    expect(props.onRefreshPages).toHaveBeenCalled();
    expect(host.querySelector('[data-testid=html]')?.textContent).toBe('saved slides');
  });
  it('reports fallback source error when detail is missing', async () => {
    source = () => ({ ok: false, json: async () => ({}) });
    await render({ pages: [pageRow('a.html')] });
    expect(host.textContent).toContain('Unable to load presentation');
    expect(host.querySelector('.studio-empty-steps')).toBeNull();
  });
  it('rejects saving before the version loads and propagates server errors', async () => {
    await render({ isStreaming: true, presentationPath: 'a.html', messages: [{ id: 'a', role: 'assistant', content: '', isPresentation: true }] });
    await click(button('Save HTML'));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(document.body.dataset.saveError).toContain('Refresh the presentation');
    await render({ isStreaming: false });
    source = () => ({ ok: false, json: async () => ({}) });
    await click(button('Save HTML'));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(document.body.dataset.saveError).toBe('Unable to save presentation');
  });
  it('resets when session changes', async () => {
    await render({ pages: [pageRow('a.html')] });
    await render({ sessionId: 's2', pages: [] });
    expect(host.querySelector('.studio-save-state')?.textContent).toBe('Ready when you are');
  });
});

describe('unsaved edit protection', () => {
  const two = [pageRow('a.html'), pageRow('b.html')];
  const select = () => labelled('Select presentation') as unknown as HTMLSelectElement;
  const change = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select(), value);
    select().dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
  });
  it('switches decks freely when clean', async () => {
    await render({ pages: two });
    await change('b.html');
    expect(urls.at(-1)).toContain('b.html');
    expect(appConfirm).not.toHaveBeenCalled();
  });
  it.each([[false, 'a.html'], [true, 'b.html']])('confirm=%s after edits selects %s', async (accept, expected) => {
    (appConfirm as any).mockResolvedValue(accept);
    await render({ pages: two });
    await click(button('Edit'));
    expect(host.querySelector('.studio-save-state')?.textContent).toBe('Unsaved changes');
    expect(button('Share').title).toBe('Save your changes before sharing');
    await change('b.html');
    expect(select().value).toBe(expected);
  });
  it('refresh honours confirmation', async () => {
    (appConfirm as any).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render({ pages: two });
    await click(button('Edit'));
    await click(labelled('Refresh presentation'));
    expect(props.onRefreshPages).not.toHaveBeenCalled();
    await click(labelled('Refresh presentation'));
    expect(props.onRefreshPages).toHaveBeenCalledOnce();
    expect(host.querySelector('.studio-save-state')?.textContent).toBe('Presentation selected');
  });
  it('close proceeds once discard is accepted', async () => {
    (appConfirm as any).mockResolvedValue(true);
    await render({ pages: two });
    await click(button('Edit'));
    await click(labelled('Close Presentation Studio'));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe('fullscreen', () => {
  it('builds a page for unlisted paths and uses Return when expanded', async () => {
    const open = vi.fn();
    await render({ presentationPath: 'dir/x.html', onOpenFullscreen: open, isExpanded: true });
    await click(labelled('Return beside chat'));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: 'x.html', path: 'dir/x.html', is_presentation: true }));
  });
  it('provides a placeholder page when nothing is selected', async () => {
    const open = vi.fn();
    await render({ onOpenFullscreen: open });
    await click(labelled('Expand Presentation Studio'));
    expect(open).toHaveBeenCalledWith({ name: 'Presentation Studio', path: '', size: 0, is_presentation: true });
  });
  it('shows bobdeck editor with change request and tracks dirty', async () => {
    const dirty = vi.fn();
    await render({ files: [{ name: 'p.bobdeck', size: 1 }], onDirtyChange: dirty });
    expect(host.textContent).toContain('Change p.bobdeck');
    await click(button('Dirty deck'));
    expect(dirty).toHaveBeenLastCalledWith(true);
  });
});
