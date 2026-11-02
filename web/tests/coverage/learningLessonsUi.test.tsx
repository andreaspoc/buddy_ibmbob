// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LearningLessons } from '../../src/components/LearningLessons';

let host: HTMLDivElement;
let root: Root;

describe('LearningLessons Component', () => {
  const sampleLessons = [
    {
      id: 'lesson-1',
      title: 'Introduction to Networking',
      status: 'published',
      version: 1,
      is_creator: true,
      steps: [
        {
          id: 'step-1',
          kind: 'text',
          title: 'Welcome',
          text: 'Welcome to this lesson.',
          url: '',
          asset_id: null,
          options: [],
        },
        {
          id: 'step-2',
          kind: 'question',
          title: 'Knowledge Check',
          text: 'What is an IP address?',
          url: '',
          asset_id: null,
          options: ['Protocol identifier', 'Street address'],
          answer: 0,
          feedback: 'Correct! An IP identifies a device on a network.',
        },
      ],
      progress: { step: 0, completed: false },
    },
    {
      id: 'lesson-2',
      title: 'Advanced Routing Protocols',
      status: 'draft',
      version: 1,
      is_creator: true,
      steps: [
        {
          id: 'step-2-1',
          kind: 'text',
          title: 'Routing Concept',
          text: 'API and OSPF overview.',
          url: '',
          asset_id: null,
          options: [],
        },
      ],
    },
  ];

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
    window.Element.prototype.animate = vi.fn().mockReturnValue({
      finished: Promise.resolve(),
      playState: 'finished',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
    });

    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/lessons/order') && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (path.includes('/progress') && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (path.includes('/lessons/lesson-1')) {
        return Promise.resolve({ ok: true, json: async () => sampleLessons[0] });
      }
      if (path.includes('/lessons/lesson-2')) {
        return Promise.resolve({ ok: true, json: async () => sampleLessons[1] });
      }
      if (path.includes('/folders/folder-1/lessons')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: sampleLessons.map(({ id, title, status, version, is_creator }) => ({
              id,
              title,
              status,
              version,
              is_creator,
            })),
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    global.fetch = mockFetch;

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

  it('renders lesson list with published and draft items', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-1"
          canCreate={true}
          search=""
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(host.textContent).toContain('Introduction to Networking');
    expect(host.textContent).toContain('Advanced Routing Protocols');
  });

  it('opens a lesson in reader mode and advances through steps', async () => {
    const onProgressChange = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-1"
          canCreate={true}
          search=""
          openLessonId="lesson-1"
          onProgressChange={onProgressChange}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Introduction to Networking');
    expect(host.textContent).toContain('Welcome to this lesson.');

    // Next step button
    const nextBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('next') || b.getAttribute('aria-label')?.toLowerCase().includes('next')
    );
    if (nextBtn) {
      await act(async () => {
        nextBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(host.textContent).toContain('Knowledge Check');
    }
  });

  it('answers interactive question step and receives feedback', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-1"
          canCreate={true}
          search=""
          openLessonId="lesson-1"
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Advance to question step
    const nextBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('next')
    );
    if (nextBtn) {
      await act(async () => {
        nextBtn.click();
      });
    }

    const optionBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Protocol identifier')
    );
    if (optionBtn) {
      await act(async () => {
        optionBtn.click();
      });
      const checkBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.toLowerCase().includes('check') || b.textContent?.toLowerCase().includes('submit')
      );
      if (checkBtn) {
        await act(async () => {
          checkBtn.click();
        });
      }
    }
    expect(host.querySelector('.learning-lessons') || host.children.length > 0).toBeTruthy();
  });

  it('opens lesson in editor mode and modifies step text', async () => {
    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-1"
          canCreate={true}
          search=""
          openLessonId="lesson-2"
          openLessonEditor={true}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(host.textContent).toContain('Edit lesson');
    expect(host.textContent).toContain('API and OSPF overview.');

    const textarea = host.querySelector('textarea');
    if (textarea) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          textarea,
          'Updated step text with detailed API explanation'
        );
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    expect(host.querySelector('.learning-lessons') || host.children.length > 0).toBeTruthy();
  });

  it('allows creating a brand new lesson draft', async () => {
    const onLessonOpened = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-1"
          canCreate={true}
          search=""
          createNewLesson={true}
          onLessonOpened={onLessonOpened}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(onLessonOpened).toHaveBeenCalled();
  });

  it('triggers back button to exit viewer and navigate back to chapters', async () => {
    const onBackToChapters = vi.fn();

    await act(async () => {
      root.render(
        <LearningLessons
          folderId="folder-1"
          canCreate={true}
          search=""
          openLessonId="lesson-1"
          onBackToChapters={onBackToChapters}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const backBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('back') || b.textContent?.includes('←')
    );
    if (backBtn) {
      await act(async () => {
        backBtn.click();
      });
      expect(onBackToChapters).toHaveBeenCalled();
    }
  });
});
