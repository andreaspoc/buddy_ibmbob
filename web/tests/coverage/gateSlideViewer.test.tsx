// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SlideViewer } from '../../src/components/SlideViewer';
import { saveSessionFile, fetchDeckByPath } from '../../src/api';
import { appAlert, appConfirm } from '../../src/components/AppDialog';
import { navigateOffice } from '../../src/lib/officeUrl';
import { exportDeckToPptx, buildDeckPptxBlob, resolveDeckLayout, renderSlideToSvg } from '../../src/lib/bobdeck.js';

vi.mock('../../src/api', () => ({ saveSessionFile: vi.fn(), fetchDeckByPath: vi.fn() }));
vi.mock('../../src/components/AppDialog', () => ({ appAlert: vi.fn(), appConfirm: vi.fn() }));
vi.mock('../../src/lib/officeUrl', () => ({ navigateOffice: vi.fn() }));
vi.mock('../../src/components/ArtifactReviewComments', () => ({ SavedArtifactReview: ({ disabled }: { disabled: boolean }) => <div data-testid="review">{String(disabled)}</div> }));
vi.mock('../../src/lib/bobdeck.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    exportDeckToPptx: vi.fn(),
    buildDeckPptxBlob: vi.fn(),
    resolveDeckLayout: vi.fn(actual.resolveDeckLayout as (d: unknown) => unknown),
    renderSlideToSvg: vi.fn(actual.renderSlideToSvg as (...a: unknown[]) => unknown),
  };
});

let host: HTMLDivElement;
let root: Root;

const textElement = (text: string) => ({ type: 'text', text, x: 1, y: 1, w: 4, h: 1 });
const deck = (over: object = {}) => ({
  title: 'Quarterly Review',
  slides: [{ elements: [textElement('First'), textElement('Other')] }, { elements: [textElement('Second')] }, { elements: [textElement('Third')] }],
  ...over,
});
type Props = React.ComponentProps<typeof SlideViewer>;
const render = (props: Partial<Props> = {}) => act(async () => { root.render(<SlideViewer deckData={deck()} {...props} />); });
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.replace(/\s+/g, ' ').trim().includes(text));
const byTitle = (title: string) => host.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
const counter = () => host.querySelector('.bobdeck-counter')!.textContent;
const pressKey = (key: string, target: EventTarget = window) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
function setFullscreenElement(value: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', { value, configurable: true });
}
async function enterFullscreen() {
  const container = host.querySelector<HTMLElement>('.bobdeck-viewer')!;
  (container as any).requestFullscreen = undefined;
  await click(byTitle('Maximize Presentation'));
  return container;
}
async function makeEdit(value = 'Edited') {
  await click(button('Edit')!);
  const textarea = host.querySelector<HTMLTextAreaElement>('.bobdeck-edit-panel textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const actual = await vi.importActual<Record<string, any>>('../../src/lib/bobdeck.js');
  vi.mocked(resolveDeckLayout).mockReset().mockImplementation(actual.resolveDeckLayout);
  vi.mocked(renderSlideToSvg).mockReset().mockImplementation(actual.renderSlideToSvg);
  // jsdom has no canvas; text measurement only needs a font slot and widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 8 }) } as never);
  vi.mocked(saveSessionFile).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(fetchDeckByPath).mockReset().mockResolvedValue(null as never);
  vi.mocked(appAlert).mockReset();
  vi.mocked(appConfirm).mockReset();
  vi.mocked(navigateOffice).mockReset();
  vi.mocked(exportDeckToPptx).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(buildDeckPptxBlob).mockReset().mockResolvedValue(new Blob(['pptx']) as never);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'file-1', name: 'Deck.pptx' }) }));
  setFullscreenElement(null);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as any).fullscreenElement;
  delete (document as any).exitFullscreen;
});

describe('SlideViewer unusual inputs', () => {
  it('shows an unavailable message for non-object decks', async () => {
    await render({ deckData: 'nope' });
    expect(host.textContent).toContain('loading or unavailable');
  });
  it('survives circular deck data without crashing', async () => {
    const circular: any = { title: 'Loop', slides: [] };
    circular.self = circular;
    await render({ deckData: circular });
    expect(host.textContent).toContain('has no slides yet');
  });
  it('treats layout failures as an empty deck', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(resolveDeckLayout).mockImplementation(() => { throw new Error('layout'); });
    await render();
    expect(host.textContent).toContain('has no slides yet');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
  it('reports a slide that cannot render, and recovers on the next slide', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const working = vi.mocked(renderSlideToSvg).getMockImplementation()!;
    vi.mocked(renderSlideToSvg).mockImplementation(() => { throw new Error('svg'); });
    await render();
    expect(host.querySelector('.bobdeck-canvas-inner')!.textContent).toContain('Could not render slide 1');
    vi.mocked(renderSlideToSvg).mockImplementation(working);
    await click(byTitle('Next Slide'));
    expect(host.querySelector('.bobdeck-canvas-inner svg')).not.toBeNull();
    error.mockRestore();
  });
  it('falls back on title and brand defaults and shows source JSON', async () => {
    await render({ deckData: { slides: [{ elements: [] }], metadata: { brand: 'Acme' } }, rawJson: '{}' });
    expect(host.querySelector('.bobdeck-brand-pill')!.textContent).toBe('Acme');
    expect(host.querySelector('.bobdeck-title')!.textContent).toBe('Executive Presentation');
    expect(host.querySelector('.bobdeck-source-details code')!.textContent).toContain('"slides"');
  });
  it('shows review comments only for saved session files and disables them while dirty', async () => {
    await render({ sessionId: 's1', filename: 'a.bobdeck' });
    await flush();
    expect(host.querySelector('[data-testid="review"]')!.textContent).toBe('false');
    await makeEdit();
    expect(host.querySelector('[data-testid="review"]')!.textContent).toBe('true');
  });
});

describe('SlideViewer saved copies', () => {
  it('loads the saved deck for a session, once, and enables editing afterward', async () => {
    const saved = deck({ title: 'Saved title' });
    vi.mocked(fetchDeckByPath).mockResolvedValueOnce(saved as never);
    await render({ sessionId: 's1', filename: 'a.bobdeck' });
    await flush();
    expect(fetchDeckByPath).toHaveBeenCalledWith('a.bobdeck', 's1');
    expect(host.querySelector('.bobdeck-title')!.textContent).toBe('Saved title');
    expect(button('Edit')!.disabled).toBe(false);
    expect(host.textContent).not.toContain('Unsaved changes');
  });
  it.each([
    ['a missing deck', () => Promise.resolve(null)],
    ['a deck without slides', () => Promise.resolve({ title: 'Bad' })],
    ['a failed read', () => Promise.reject(new Error('404'))],
  ])('keeps the inline deck on %s', async (_n, reply) => {
    vi.mocked(fetchDeckByPath).mockImplementationOnce(reply as never);
    await render({ sessionId: 's1' });
    await flush();
    expect(host.querySelector('.bobdeck-title')!.textContent).toBe('Quarterly Review');
    expect(button('Edit')!.disabled).toBe(false);
  });
  it('derives a stable artifact name for inline decks', async () => {
    await render({ sessionId: 's1' });
    await flush();
    expect(vi.mocked(fetchDeckByPath).mock.calls[0][0]).toMatch(/^presentation-[0-9a-f]+\.bobdeck$/);
  });
  it('ignores a late read after unmount', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    vi.mocked(fetchDeckByPath).mockImplementationOnce((() => new Promise(r => { resolve = r; })) as never);
    await render({ sessionId: 's1' });
    await act(async () => root.unmount());
    await act(async () => { resolve(deck({ title: 'Late' })); });
    expect(host.textContent).toBe('');
    root = createRoot(host);
  });
  it('does not read when the host supplies its own save', async () => {
    await render({ sessionId: 's1', onSaveJson: vi.fn() });
    await flush();
    expect(fetchDeckByPath).not.toHaveBeenCalled();
  });
  const savedEvent = (detail: object) => act(async () => { window.dispatchEvent(new CustomEvent('buddy-deck-saved', { detail })); });
  it('adopts saves made in another viewer of the same file', async () => {
    await render({ sessionId: 's1', filename: 'a.bobdeck' });
    await flush();
    await savedEvent({ sessionId: 's1', path: 'other.bobdeck', deck: deck({ title: 'Wrong path' }) });
    await savedEvent({ sessionId: 's2', path: 'a.bobdeck', deck: deck({ title: 'Wrong session' }) });
    expect(host.querySelector('.bobdeck-title')!.textContent).toBe('Quarterly Review');
    await savedEvent({ sessionId: 's1', path: 'a.bobdeck', deck: deck({ title: 'From peer' }) });
    expect(host.querySelector('.bobdeck-title')!.textContent).toBe('From peer');
  });
  it('protects local edits from peer saves', async () => {
    await render({ sessionId: 's1', filename: 'a.bobdeck' });
    await flush();
    await makeEdit();
    await savedEvent({ sessionId: 's1', path: 'a.bobdeck', deck: deck({ title: 'From peer' }) });
    expect(host.querySelector('.bobdeck-title')!.textContent).toBe('Quarterly Review');
    expect(host.textContent).toContain('Unsaved changes');
  });
});

describe('SlideViewer editing', () => {
  it('tracks dirtiness and tells conversationless users saving is unavailable', async () => {
    const onDirtyChange = vi.fn();
    await render({ onDirtyChange });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await makeEdit();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(host.textContent).toContain('Save is available in a conversation.');
    expect(button('Save')!.disabled).toBe(true);
    expect(button('Done Editing')).toBeDefined();
  });
  it('selects an element by clicking the slide while editing', async () => {
    await render();
    await click(button('Edit')!);
    const elements = host.querySelectorAll<SVGElement>('[data-element-index]');
    expect(elements.length).toBeGreaterThan(1);
    expect(elements[1].style.cursor).toBe('pointer');
    await click(elements[1]);
    expect(host.querySelector<HTMLSelectElement>('.bobdeck-edit-panel select')!.value).toBe('1');
  });
  it('saves to the session file and announces the save', async () => {
    const onSaved = vi.fn();
    const announced = vi.fn();
    window.addEventListener('buddy-deck-saved', announced);
    await render({ sessionId: 's1', filename: 'a.bobdeck', onSaved });
    await flush();
    await makeEdit();
    await click(button('Save')!);
    await flush();
    window.removeEventListener('buddy-deck-saved', announced);
    const [session, path, json] = vi.mocked(saveSessionFile).mock.calls[0];
    expect([session, path]).toEqual(['s1', 'a.bobdeck']);
    expect(json).toContain('Edited');
    expect((announced.mock.calls[0][0] as CustomEvent).detail.deck.slides[0].elements[0].text).toBe('Edited');
    expect(onSaved).toHaveBeenCalled();
    expect(host.textContent).not.toContain('Unsaved changes');
  });
  it('prefers the host save callback', async () => {
    const onSaveJson = vi.fn().mockResolvedValue(undefined);
    await render({ sessionId: 's1', onSaveJson });
    await makeEdit();
    await click(button('Save')!);
    await flush();
    expect(onSaveJson.mock.calls[0][0]).toContain('Edited');
    expect(saveSessionFile).not.toHaveBeenCalled();
  });
  it.each([
    [new Error('Disk full'), 'Disk full'],
    [{}, 'Could not save presentation'],
  ])('shows save failures and stays dirty (%#)', async (failure, message) => {
    vi.mocked(saveSessionFile).mockRejectedValueOnce(failure);
    await render({ sessionId: 's1', filename: 'a.bobdeck' });
    await flush();
    await makeEdit();
    await click(button('Save')!);
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(message);
    expect(host.textContent).toContain('Unsaved changes');
  });
  it('reverts only after confirmation', async () => {
    await render();
    await makeEdit();
    vi.mocked(appConfirm).mockResolvedValueOnce(false);
    await click(button('Revert')!);
    await flush();
    expect(host.textContent).toContain('Unsaved changes');
    vi.mocked(appConfirm).mockResolvedValueOnce(true);
    await click(button('Revert')!);
    await flush();
    expect(host.textContent).not.toContain('Unsaved changes');
  });
});

describe('SlideViewer exports', () => {
  it('names PPTX downloads from a sanitised title', async () => {
    await render({ deckData: deck({ title: 'My Deck 2026!' }) });
    await click(button('Download PPTX')!);
    await flush();
    expect(vi.mocked(exportDeckToPptx).mock.calls[0][1]).toBe('my_deck_2026_.pptx');
  });
  it('falls back to a generic PPTX name', async () => {
    await render({ deckData: deck({ title: undefined }) });
    await click(button('Download PPTX')!);
    await flush();
    expect(vi.mocked(exportDeckToPptx).mock.calls[0][1]).toBe('presentation.pptx');
  });
  it.each([
    [new Error('No zip'), 'PPTX Export failed: No zip'],
    ['plain', 'PPTX Export failed: plain'],
  ])('alerts on export failure %#', async (failure, message) => {
    vi.mocked(exportDeckToPptx).mockRejectedValueOnce(failure);
    await render();
    await click(button('Download PPTX')!);
    await flush();
    expect(appAlert).toHaveBeenCalledWith(message);
    expect(button('Download PPTX')!.disabled).toBe(false);
  });
  it.each([
    ['Quarterly Review', 'quarterly_review.bobdeck'],
    [undefined, 'presentation.bobdeck'],
  ])('downloads JSON for title %s', async (title, name) => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: string[] = [];
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    await render({ deckData: deck({ title }) });
    await click(byTitle('Download raw .bobdeck JSON file'));
    anchorClick.mockRestore();
    expect(clicked).toEqual([name]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});

describe('SlideViewer Office Suite', () => {
  const uploadedName = () => (vi.mocked(fetch).mock.calls[0][1]!.body as FormData).get('file') as File;
  it.each([
    ['Plain Title', 'Plain Title.pptx'],
    ['Already.PPTX', 'Already.PPTX'],
    ['bad/name:with*chars', 'bad name with chars.pptx'],
    ['///', 'Presentation.pptx'],
    [undefined, 'Presentation.pptx'],
  ])('uploads title %s as %s', async (title, expected) => {
    await render({ deckData: deck({ title }) });
    await click(button('Save to Office Suite')!);
    await flush();
    expect(uploadedName().name).toBe(expected);
    expect(host.querySelector('.bobdeck-edit-notice[role="status"]')!.textContent).toContain('Deck.pptx');
    expect(button('✓ Saved in Office Suite')).toBeDefined();
  });
  it('opens the saved file from the notice', async () => {
    await render();
    await click(button('Save to Office Suite')!);
    await flush();
    await click(button('Open in Office Suite →')!);
    expect(navigateOffice).toHaveBeenCalledWith('/office/files/file-1');
  });
  it('saves then opens, leaving fullscreen first', async () => {
    await render();
    setFullscreenElement(document.body);
    (document as any).exitFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    await click(byTitle('Save to Office Suite and open in ONLYOFFICE PowerPoint editor'));
    await flush();
    expect((document as any).exitFullscreen).toHaveBeenCalled();
    expect(navigateOffice).toHaveBeenCalledWith('/office/files/file-1');
  });
  it('reopens an already saved clean file without re-uploading, but re-uploads when dirty', async () => {
    await render();
    await click(button('Save to Office Suite')!);
    await flush();
    const open = byTitle('Save to Office Suite and open in ONLYOFFICE PowerPoint editor');
    await click(open);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(navigateOffice).toHaveBeenCalledTimes(1);
    await makeEdit();
    await click(open);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(navigateOffice).toHaveBeenCalledTimes(2);
  });
  it('does not navigate when the upload returns no id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: 'n' }) } as never);
    await render();
    await click(byTitle('Save to Office Suite and open in ONLYOFFICE PowerPoint editor'));
    await flush();
    expect(navigateOffice).not.toHaveBeenCalled();
  });
  it.each([
    ['a server detail', { ok: false, status: 400, json: async () => ({ detail: 'Too big' }) }, 'Too big'],
    ['a non-string detail', { ok: false, status: 500, json: async () => ({ detail: 1 }) }, 'Could not upload PowerPoint to Office Suite.'],
    ['unparseable errors', { ok: false, status: 500, json: async () => { throw new Error('html'); } }, 'Could not upload PowerPoint to Office Suite.'],
  ])('shows upload failures with %s', async (_n, reply, message) => {
    vi.mocked(fetch).mockResolvedValueOnce(reply as never);
    await render();
    await click(button('Save to Office Suite')!);
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(message);
  });
  it('announces expired sessions on upload', async () => {
    const expired = vi.fn();
    window.addEventListener('buddy-auth-expired', expired);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as never);
    await render();
    await click(button('Save to Office Suite')!);
    await flush();
    window.removeEventListener('buddy-auth-expired', expired);
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it('shows build failures, including non-Error throws', async () => {
    vi.mocked(buildDeckPptxBlob).mockRejectedValueOnce('boom');
    await render();
    await click(button('Save to Office Suite')!);
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('boom');
  });
  it('locks Office actions while the assistant is working', async () => {
    await render({ isWorking: true });
    expect(button('Save to Office Suite')!.disabled).toBe(true);
    expect(button('Open in Office Suite')!.disabled).toBe(true);
  });
});

describe('SlideViewer fullscreen', () => {
  it('enters via the Fullscreen API and sets state when it resolves', async () => {
    await render();
    const container = host.querySelector<HTMLElement>('.bobdeck-viewer')!;
    container.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    await click(byTitle('Maximize Presentation'));
    await flush();
    expect(container.classList.contains('fullscreen')).toBe(true);
    expect(byTitle('Exit Fullscreen (Esc)')).not.toBeNull();
  });
  it('falls back to CSS fullscreen if the API rejects or is missing', async () => {
    await render();
    const container = host.querySelector<HTMLElement>('.bobdeck-viewer')!;
    container.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    await click(byTitle('Maximize Presentation'));
    await flush();
    expect(container.classList.contains('fullscreen')).toBe(true);
    await click(byTitle('Exit Fullscreen (Esc)'));
    expect(container.classList.contains('fullscreen')).toBe(false);
    await enterFullscreen();
    expect(container.classList.contains('fullscreen')).toBe(true);
  });
  it.each([
    ['resolves', () => Promise.resolve()],
    ['rejects', () => Promise.reject(new Error('no'))],
  ])('leaves when exitFullscreen %s', async (_n, exit) => {
    await render();
    const container = await enterFullscreen();
    setFullscreenElement(container);
    (document as any).exitFullscreen = vi.fn(exit);
    await click(byTitle('Exit Fullscreen (Esc)'));
    await flush();
    expect(container.classList.contains('fullscreen')).toBe(false);
  });
  it('syncs with browser fullscreen changes', async () => {
    await render();
    const container = host.querySelector<HTMLElement>('.bobdeck-viewer')!;
    setFullscreenElement(container);
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(container.classList.contains('fullscreen')).toBe(true);
    setFullscreenElement(document.body);
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(container.classList.contains('fullscreen')).toBe(false);
  });
  it.each(['ArrowRight', 'PageDown', ' '])('advances with %j and clamps at the end', async key => {
    await render();
    await enterFullscreen();
    await pressKey(key);
    expect(counter()).toContain('2');
    await pressKey(key);
    await pressKey(key);
    expect(counter()).toContain('3');
    expect(host.querySelector('.bobdeck-stage-arrow-right')).toBeNull();
  });
  it.each(['ArrowLeft', 'PageUp'])('goes back with %j and clamps at the start', async key => {
    await render();
    await enterFullscreen();
    await pressKey('ArrowRight');
    await pressKey(key);
    expect(counter()).toContain('1');
    await pressKey(key);
    expect(counter()).toContain('1');
    expect(host.querySelector('.bobdeck-stage-arrow-left')).toBeNull();
  });
  it('ignores keys outside fullscreen or typed into fields', async () => {
    await render();
    await pressKey('ArrowRight');
    expect(counter()).toContain('1');
    await enterFullscreen();
    const input = document.createElement('input');
    host.appendChild(input);
    await pressKey('ArrowRight', input);
    expect(counter()).toContain('1');
    input.remove();
    await pressKey('z');
    expect(counter()).toContain('1');
  });
  it('escape leaves, exiting the browser mode when active', async () => {
    await render();
    const container = await enterFullscreen();
    setFullscreenElement(container);
    (document as any).exitFullscreen = vi.fn().mockRejectedValue(new Error('no'));
    await pressKey('Escape');
    await flush();
    expect((document as any).exitFullscreen).toHaveBeenCalled();
    expect(container.classList.contains('fullscreen')).toBe(false);
  });
  it('escape leaves CSS fullscreen without the browser API', async () => {
    await render();
    const container = await enterFullscreen();
    await pressKey('Escape');
    expect(container.classList.contains('fullscreen')).toBe(false);
  });
  it('stage arrows and dots navigate with a keyboard hint shown', async () => {
    await render();
    await enterFullscreen();
    expect(host.textContent).toContain('(Navigate with ← / → or Space)');
    await click(host.querySelector('.bobdeck-stage-arrow-right')!);
    expect(counter()).toContain('2');
    await click(host.querySelector('.bobdeck-stage-arrow-left')!);
    expect(counter()).toContain('1');
    await click(host.querySelectorAll('.bobdeck-dot')[2]);
    expect(counter()).toContain('3');
    expect(host.querySelectorAll('.bobdeck-dot')[2].classList.contains('active')).toBe(true);
  });
});
