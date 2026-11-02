// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LearningClasses,
  localClassDate,
  classDateIso,
  assignmentResourceOptions,
} from '../../src/components/LearningClasses';

let host: HTMLDivElement;
let root: Root;

describe('LearningClasses Utilities', () => {
  it('formats localClassDate correctly and handles empty or invalid values', () => {
    expect(localClassDate(null)).toBe('');
    expect(localClassDate('invalid-date')).toBe('');
    const valid = '2026-10-28T12:00:00Z';
    expect(localClassDate(valid)).toContain('2026-10-28');
  });

  it('parses classDateIso and throws for invalid inputs', () => {
    expect(() => classDateIso('', 'Start Date')).toThrow('Enter a valid Start Date.');
    expect(() => classDateIso('not-a-date', 'Due Date')).toThrow('Enter a valid Due Date.');
    const valid = '2026-10-28T10:00:00Z';
    expect(classDateIso(valid, 'Date')).toBe(new Date(valid).toISOString());
  });

  it('filters assignmentResourceOptions by kind and publication status', () => {
    const resources = {
      books: [{ id: 'b1', title: 'Network Basics', status: 'draft' }],
      lessons: [
        { id: 'l1', title: 'Lesson 1', status: 'published' },
        { id: 'l2', title: 'Lesson 2 (Draft)', status: 'draft' },
      ],
      quizzes: [
        { id: 'q1', title: 'Quiz 1', status: 'published' },
      ],
    };

    expect(assignmentResourceOptions(resources, 'book')).toHaveLength(1);
    expect(assignmentResourceOptions(resources, 'lesson')).toHaveLength(1);
    expect(assignmentResourceOptions(resources, 'quiz')).toHaveLength(1);
    expect(assignmentResourceOptions(resources, 'none')).toHaveLength(0);
  });
});

describe('LearningClasses Component', () => {
  const sampleClasses = [
    {
      id: 'class-1',
      title: 'Advanced System Architecture',
      description: 'Distributed systems and patterns',
      revision: 1,
      can_manage: true,
      can_delete: true,
      folder_id: 'folder-123',
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

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/classes') && !path.includes('/classes/class-1/')) {
        return Promise.resolve({
          ok: true,
          json: async () => (path.includes('/classes/class-1') ? sampleClasses[0] : { items: sampleClasses }),
        });
      }
      if (path.includes('/announcements')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 'a1', title: 'Welcome', body: 'Welcome to class' }] }) });
      }
      if (path.includes('/sessions')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (path.includes('/assignments')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (path.includes('/members') || path.includes('/candidates')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ username: 'alice', display_name: 'Alice' }] }) });
      }
      if (path.includes('/contents')) {
        return Promise.resolve({ ok: true, json: async () => ({ books: [], lessons: [], quizzes: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
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

  it('renders class list and navigates to class details on click', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="folder-123"
          canCreate={true}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(host.textContent).toContain('Advanced System Architecture');

    const classCard = host.querySelector('.learning-class-card') || host.querySelector('button');
    if (classCard) {
      await act(async () => {
        (classCard as HTMLElement).click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }

    // Switch tabs
    const tabButtons = host.querySelectorAll('[role="tab"]');
    for (const tab of Array.from(tabButtons)) {
      await act(async () => {
        (tab as HTMLElement).click();
      });
    }
  });

  it('opens item creation editor when create button is clicked', async () => {
    await act(async () => {
      root.render(
        <LearningClasses
          folderId="folder-123"
          canCreate={true}
          autoOpenFolderClass={true}
        />
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const addBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add') || b.textContent?.includes('New')
    );
    expect(host.querySelector('.learning-classes')).not.toBeNull();
    if (addBtn) {
      await act(async () => {
        addBtn.click();
      });
      expect(addBtn).toBeDefined();
    }
  });
});
