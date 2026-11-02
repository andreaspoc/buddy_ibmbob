// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNoteSaveFlight, type NoteSavedEvent } from '../../src/lib/useNoteSaveFlight';

const fly = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/noteFlight', () => ({ flyNoteToNotes: fly }));
let save: (event: NoteSavedEvent) => Promise<void>;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Harness() { save = useNoteSaveFlight(); return null; }
function card(title: string, saved = false) {
  const el = document.createElement('article');
  el.className = `sticky-note${saved ? ' is-saved' : ''}`;
  el.dataset.noteTitle = title;
  el.dataset.noteSession = 'session'; el.dataset.noteMessage = 'message'; el.dataset.noteKey = title;
  el.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
  return el;
}
beforeEach(async () => {
  fly.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.querySelectorAll('[data-sticky-notes]').forEach(el => el.remove()); vi.unstubAllGlobals(); });

it('matches the unsaved title and emits the original card identity', async () => {
  const notes = document.createElement('div'); notes.dataset.stickyNotes = '';
  const saved = card('Plan', true), target = card(' Plan '); notes.append(saved, target); document.body.append(notes);
  const moved = vi.fn(), changed = vi.fn();
  window.addEventListener('buddy-note-moved', moved); window.addEventListener('buddy-notes-changed', changed);
  try {
    await act(async () => { await save({ note_id: 7, note_title: 'PLAN' }); });
    expect(fly).toHaveBeenCalledWith(target, expect.any(Map));
    expect(moved.mock.calls[0][0].detail).toEqual({ sessionId: 'session', messageId: 'message', key: ' Plan ' });
    expect(changed).toHaveBeenCalledOnce();
    expect(target.hasAttribute('data-note-flight-queued')).toBe(false);
  } finally { window.removeEventListener('buddy-note-moved', moved); window.removeEventListener('buddy-notes-changed', changed); }
});

it('chooses partial matches, then the last unmatched card, and ignores invalid events', async () => {
  const notes = document.createElement('div'); notes.dataset.stickyNotes = '';
  const first = card('Detailed project plan'), last = card('Other'); notes.append(first, last); document.body.append(notes);
  await save({ note_id: 1, note_title: 'project plan' });
  await save({ note_id: 2, note_title: 'unmatched' });
  await save({ note_title: 'invalid' });
  expect(fly.mock.calls.map(call => call[0])).toEqual([first, last]);
});

it('creates and removes a decorative seed if no draft exists, even if animation fails', async () => {
  fly.mockImplementation(async (seed: HTMLElement) => {
    expect(seed.textContent).toBe('Saved note');
    expect(seed.dataset.noteColor).toBe('mint');
    expect(seed.getAttribute('aria-hidden')).toBe('true');
    throw new Error('animation unavailable');
  });
  const changed = vi.fn(); window.addEventListener('buddy-notes-changed', changed);
  try {
    await save({ note_id: 3, note_title: 'Saved note', note_color: 'mint' });
    expect(document.querySelector('.sticky-note-save-seed')).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('buddy-notes-changed', changed); }
});

it('scrolls offscreen cards using reduced-motion behavior', async () => {
  const notes = document.createElement('div'); notes.dataset.stickyNotes = '';
  const target = card('Offscreen'); target.getBoundingClientRect = () => ({ top: 0, bottom: 20 }) as DOMRect;
  target.scrollIntoView = vi.fn(); notes.append(target); document.body.append(notes);
  await save({ note_id: 4, note_title: 'Offscreen' });
  expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'instant' });
  expect(target.classList.contains('is-preparing-to-send')).toBe(false);
});
