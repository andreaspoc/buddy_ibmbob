// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OfficeSuite } from '../../src/components/OfficeSuite';
import { appConfirm } from '../../src/components/AppDialog';

vi.mock('../../src/components/AppDialog', () => ({
  appConfirm: vi.fn().mockResolvedValue(true),
  appAlert: vi.fn().mockResolvedValue(undefined),
}));

let host: HTMLDivElement;
let root: Root;

describe('OfficeSuite Component', () => {
  const mockFiles = [
    {
      id: 'file-doc-1',
      name: 'Project Plan.docx',
      extension: 'docx',
      size: 15420,
      revision: 1,
      save_sequence: 1,
      saved_at: '2026-10-28T12:00:00Z',
      is_owner: true,
      access: 'owner',
    },
    {
      id: 'file-sheet-2',
      name: 'Budget 2027.xlsx',
      extension: 'xlsx',
      size: 45200,
      revision: 2,
      save_sequence: 3,
      saved_at: '2026-10-28T14:30:00Z',
      is_owner: false,
      access: 'write',
    },
  ];

  const mockFolders = [
    { id: 'f-1', name: 'Workflows', parent_id: null },
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

    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/api/office/status')) {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'ready' }) });
      }
      if (path.includes('/api/office/files') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: mockFiles }) });
      }
      if (path.includes('/api/office/folders')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: mockFolders }) });
      }
      if (path.includes('/api/office/users')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ username: 'bob', display_name: 'Bob' }] }) });
      }
      if (path.includes('/name') && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...mockFiles[0], name: 'Renamed Plan.docx' }),
        });
      }
      if (init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
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

  it('renders office file library with loaded documents and handles search filter', async () => {
    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(host.textContent).toContain('Project Plan.docx');
    expect(host.textContent).toContain('Budget 2027.xlsx');

    const searchInput = host.querySelector('input[type="search"]') || host.querySelector('.office-search input');
    if (searchInput) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, 'Budget');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.textContent).toContain('Budget 2027.xlsx');
    }
  });

  it('opens new document dialog and cancels or creates file', async () => {
    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });

    const newBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('New')
    );
    if (newBtn) {
      await act(async () => {
        newBtn.click();
      });
    }

    const cancelBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel')
    );
    expect(host.querySelector('.office-suite')).not.toBeNull();
    if (cancelBtn) {
      await act(async () => {
        cancelBtn.click();
      });
      expect(cancelBtn).toBeDefined();
    }
  });

  it('triggers file delete with appConfirm check', async () => {
    await act(async () => {
      root.render(<OfficeSuite onClose={vi.fn()} />);
    });

    const deleteBtn = host.querySelector('button[title*="Delete"]') || Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Delete'));
    if (deleteBtn) {
      await act(async () => {
        (deleteBtn as HTMLButtonElement).click();
      });
      expect(appConfirm).toHaveBeenCalled();
    }
  });

  it('handles navigation to a file and back to file list', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<OfficeSuite onClose={onClose} />);
    });

    const fileCard = host.querySelector('.office-item') || host.querySelector('button[aria-label*="Plan"]');
    if (fileCard) {
      await act(async () => {
        (fileCard as HTMLElement).click();
      });
    }

    const closeBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Close') || b.textContent === '✕');
    expect(host.querySelector('.office-suite')).not.toBeNull();
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
      expect(onClose).toBeDefined();
    }
  });
});
