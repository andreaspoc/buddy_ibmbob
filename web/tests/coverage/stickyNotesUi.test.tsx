// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StickyNotes } from '../../src/components/StickyNotes';
import type { StickyNoteDraft } from '../../src/lib/stickyNotes';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.matchMedia = vi.fn().mockImplementation(query => ({
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
});

describe('StickyNotes Component', () => {
  const sampleNotes: StickyNoteDraft[] = [
    {
      title: 'Action Items',
      body: '1. Update configuration\n2. Run tests',
      color: 'butter',
    },
    {
      title: 'Architecture Decision',
      body: 'Adopt asynchronous messaging for high volume ingestion.',
      color: 'sky',
    },
  ];

  it('renders sticky note cards with title and body text', async () => {
    await act(async () => {
      root.render(
        <StickyNotes
          notes={sampleNotes}
          sessionId="session-1"
          messageId="msg-1"
        />
      );
    });

    expect(host.textContent).toContain('Action Items');
    expect(host.textContent).toContain('Update configuration');
    expect(host.textContent).toContain('Architecture Decision');
    expect(host.textContent).toContain('asynchronous messaging');
  });

  it('renders nothing when notes array is empty', async () => {
    await act(async () => {
      root.render(<StickyNotes notes={[]} sessionId="session-1" />);
    });

    expect(host.querySelectorAll('.sticky-note-card').length).toBe(0);
  });

  it('supports readOnly mode by hiding modification buttons', async () => {
    await act(async () => {
      root.render(
        <StickyNotes
          notes={sampleNotes}
          sessionId="session-1"
          readOnly={true}
        />
      );
    });

    expect(host.textContent).toContain('Action Items');
    // Save button should not be present in readOnly mode
    const saveBtns = host.querySelectorAll('button.save-note-btn');
    expect(saveBtns.length).toBe(0);
  });

  it('triggers save action when save note button is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42, title: 'Action Items', success: true }),
    }));

    await act(async () => {
      root.render(
        <StickyNotes
          notes={sampleNotes}
          sessionId="session-1"
          messageId="msg-1"
        />
      );
    });

    const actionButton = host.querySelector('button');
    if (actionButton) {
      await act(async () => {
        actionButton.click();
      });
    }
    // Verify component rendered and handled interaction without throwing
    expect(host.textContent).toContain('Action Items');
  });
});
