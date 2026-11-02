// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SlideViewer } from '../../src/components/SlideViewer';
import * as api from '../../src/api';
import * as bobdeck from '../../src/lib/bobdeck.js';

vi.mock('../../src/api', () => ({
  saveSessionFile: vi.fn().mockResolvedValue({ ok: true }),
  fetchDeckByPath: vi.fn().mockResolvedValue({ slides: [] }),
}));

vi.mock('../../src/lib/bobdeck.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    exportDeckToPptx: vi.fn().mockResolvedValue(undefined),
    buildDeckPptxBlob: vi.fn().mockResolvedValue(new Blob(['test-pptx'], { type: 'application/vnd.ms-powerpoint' })),
  };
});

let host: HTMLDivElement;
let root: Root;

describe('SlideViewer Component', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders loading or unavailable fallback when deckData is null or not an object', async () => {
    await act(async () => {
      root.render(<SlideViewer deckData={null} />);
    });
    expect(host.textContent).toContain('Presentation deck is loading or unavailable');
  });

  it('renders empty slides notification when slides list is empty', async () => {
    await act(async () => {
      root.render(<SlideViewer deckData={{ title: 'Empty Deck', slides: [] }} />);
    });
    expect(host.textContent).toContain('Presentation deck has no slides yet');
  });

  it('renders presentation deck with navigation controls and advances slides', async () => {
    const sampleDeck = {
      title: 'Quarterly Review',
      slides: [
        {
          elements: [
            { type: 'title', text: 'Slide 1 Title', x: 50, y: 50, w: 500, h: 50 },
            { type: 'body', text: 'Content of Slide 1', x: 50, y: 120, w: 500, h: 100 },
          ],
        },
        {
          elements: [
            { type: 'title', text: 'Slide 2 Title', x: 50, y: 50, w: 500, h: 50 },
          ],
        },
      ],
    };

    await act(async () => {
      root.render(<SlideViewer deckData={sampleDeck} />);
    });
    expect(host.textContent).toContain('Quarterly Review');
    expect(host.textContent).toMatch(/Slide1 of2/i);

    const prevBtn = host.querySelector('button[title="Previous Slide"]') as HTMLButtonElement;
    const nextBtn = host.querySelector('button[title="Next Slide"]') as HTMLButtonElement;

    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);

    await act(async () => {
      nextBtn.click();
    });
    expect(host.textContent).toMatch(/Slide2 of2/i);
    expect(nextBtn.disabled).toBe(true);
    expect(prevBtn.disabled).toBe(false);

    await act(async () => {
      prevBtn.click();
    });
    expect(host.textContent).toMatch(/Slide1 of2/i);
  });

  it('allows entering edit mode and triggers saving via onSaveJson callback', async () => {
    const onSaveJson = vi.fn().mockResolvedValue(undefined);
    const onDirtyChange = vi.fn();
    const sampleDeck = {
      title: 'Editable Deck',
      slides: [
        {
          elements: [
            { type: 'title', text: 'Header', x: 10, y: 10, w: 200, h: 40 },
          ],
        },
      ],
    };

    await act(async () => {
      root.render(
        <SlideViewer
          deckData={sampleDeck}
          sessionId="sess-123"
          onSaveJson={onSaveJson}
          onDirtyChange={onDirtyChange}
        />
      );
    });

    const editBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Edit')
    );
    expect(editBtn).toBeDefined();

    await act(async () => {
      editBtn?.click();
    });
    expect(host.textContent).toContain('Done Editing');

    const input = host.querySelector('input') || host.querySelector('textarea');
    if (input) {
      await act(async () => {
        input.value = 'Updated Header';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onDirtyChange).toHaveBeenCalled();
    }
  });

  it('handles fullscreen toggle and keyboard navigation keys', async () => {
    const sampleDeck = {
      title: 'Keyboard Deck',
      slides: [
        { elements: [{ type: 'title', text: 'First' }] },
        { elements: [{ type: 'title', text: 'Second' }] },
      ],
    };

    await act(async () => {
      root.render(<SlideViewer deckData={sampleDeck} />);
    });

    const fullscreenBtn = host.querySelector('button[title*="Presentation"]') as HTMLButtonElement;
    expect(fullscreenBtn).toBeDefined();

    await act(async () => {
      fullscreenBtn?.click();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  it('invokes PPTX download and export functions when clicked', async () => {
    const sampleDeck = {
      title: 'Downloadable Deck',
      slides: [{ elements: [{ type: 'title', text: 'Hello' }] }],
    };

    await act(async () => {
      root.render(<SlideViewer deckData={sampleDeck} />);
    });

    const pptxBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Download PPTX')
    );
    expect(pptxBtn).toBeDefined();

    await act(async () => {
      pptxBtn?.click();
    });
    expect(bobdeck.exportDeckToPptx).toHaveBeenCalled();
  });

  it('handles Save to Office Suite upload via mock fetch', async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'file-123', name: 'Presentation.pptx' }),
    });
    global.fetch = mockFetch;

    const sampleDeck = {
      title: 'Cloud Deck',
      slides: [{ elements: [{ type: 'title', text: 'Cloud' }] }],
    };

    await act(async () => {
      root.render(<SlideViewer deckData={sampleDeck} />);
    });

    const saveOfficeBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save to Office Suite')
    );
    expect(saveOfficeBtn).toBeDefined();

    await act(async () => {
      saveOfficeBtn?.click();
    });

    expect(mockFetch).toHaveBeenCalled();
    global.fetch = originalFetch;
  });
});
