// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/components/ShareToPeople', () => ({ ShareToPeopleButton: () => null }));
vi.mock('../../src/components/WorkspaceDeckViewer', () => ({ WorkspaceDeckViewer: ({ filename }: any) => <div>Deck: {filename}</div> }));
vi.mock('../../src/components/ArtifactChangeRequest', () => ({ ArtifactChangeRequest: () => null }));
vi.mock('../../src/components/HtmlDeckViewer', () => ({ isCompleteHtmlDeck: () => true, HtmlDeckViewer: ({ htmlContent, onDirtyChange, onSaveHtml }: any) => <div><span>{htmlContent}</span><button onClick={() => onDirtyChange(true)}>Edit</button><button onClick={() => onSaveHtml('updated')}>Save HTML</button></div> }));
vi.mock('../../src/components/AppDialog', () => ({ appConfirm: vi.fn().mockResolvedValue(false) }));
import { PresentationPreviewPanel } from '../../src/mods/PresentationPreviewPanel';
import { appConfirm } from '../../src/components/AppDialog';
let root: ReturnType<typeof createRoot>; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
test('loads and saves selected HTML using its version and protects unsaved edits', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ content: 'original slides', sha256: 'oldhash' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ content: 'updated', sha256: 'newhash' }) });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const close = vi.fn(), refresh = vi.fn(), dirty = vi.fn();
  await act(async () => { root.render(<PresentationPreviewPanel sessionId="session" isStreaming={false} pages={[{ name: 'Slides', path: 'slides.html', size: 10, is_presentation: true } as any]} files={[]} messages={[]} activeMode="presentation" onClose={close} onRefreshPages={refresh} onDirtyChange={dirty} />); });
  await vi.waitFor(() => expect(host.textContent).toContain('original slides'));
  const click = async (text: string) => { const b = [...host.querySelectorAll('button')].find(el => el.textContent === text)!; await act(async () => b.click()); };
  await click('Edit');
  await act(async () => (host.querySelector('[aria-label="Close Presentation Studio"]') as HTMLButtonElement).click());
  expect(appConfirm).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  await click('Save HTML');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ path: 'slides.html', content: 'updated', expected_sha256: 'oldhash' });
  expect(refresh).toHaveBeenCalledOnce(); expect(dirty).toHaveBeenCalledWith(true);
});

test('shows a load error, refreshes and opens the selected deck in fullscreen', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: 'Presentation unavailable' }) }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const refresh = vi.fn(), fullscreen = vi.fn();
  const page = { name: 'Report', path: 'report.html', size: 42, is_presentation: true } as any;
  await act(async () => { root.render(<PresentationPreviewPanel sessionId="session" isStreaming={false} pages={[page]} files={[]} messages={[]} activeMode="presentation" onClose={vi.fn()} onRefreshPages={refresh} onOpenFullscreen={fullscreen} />); });
  await vi.waitFor(() => expect(host.textContent).toContain('Presentation unavailable'));
  await act(async () => (host.querySelector('[aria-label="Expand Presentation Studio"]') as HTMLButtonElement).click());
  expect(fullscreen).toHaveBeenCalledWith(page);
  await act(async () => (host.querySelector('[aria-label="Refresh presentation"]') as HTMLButtonElement).click());
  expect(refresh).toHaveBeenCalledOnce();
});

test('renders the saved bobdeck and closes the panel', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const close = vi.fn();
  await act(async () => { root.render(<PresentationPreviewPanel sessionId="session" isStreaming={false} pages={[]} files={[{ name: 'pitch.bobdeck', size: 10 }]} messages={[]} activeMode="presentation" onClose={close} />); });
  expect(host.textContent).toContain('Deck: pitch.bobdeck');
  await act(async () => (host.querySelector('[aria-label="Close Presentation Studio"]') as HTMLButtonElement).click());
  expect(close).toHaveBeenCalledOnce();
});
