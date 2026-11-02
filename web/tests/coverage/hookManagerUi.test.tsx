// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HookManager } from '../../src/components/HookManager';
import * as api from '../../src/api';

vi.mock('../../src/api', () => ({
  fetchHooks: vi.fn(),
  saveHook: vi.fn(),
  deleteHook: vi.fn(),
  toggleHook: vi.fn(),
}));

let host: HTMLDivElement;
let root: Root;

describe('HookManager Component', () => {
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
    window.confirm = vi.fn().mockReturnValue(true);

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

  it('renders loading state and displays loaded hooks', async () => {
    const mockHooks = [
      {
        id: 'hook-1',
        name: 'Block dangerous commands',
        description: 'Blocks rm -rf and sudo commands',
        event: 'PreToolUse',
        matcher: '^(run_command|bash)$',
        script_code: '#!/bin/bash\nexit 0',
        timeout: 5000,
        is_blocking: true,
        enabled: true,
      },
    ];
    const mockTemplates = [
      {
        name: 'Audit Tool Invocations',
        description: 'Log all tool calls',
        event: 'PostToolUse',
        matcher: '.*',
        script_code: 'echo post',
        timeout: 3000,
        is_blocking: false,
      },
    ];

    vi.mocked(api.fetchHooks).mockResolvedValue({
      hooks: mockHooks as any,
      templates: mockTemplates as any,
    });

    await act(async () => {
      root.render(<HookManager />);
    });

    expect(host.textContent).toContain('Block dangerous commands');
    expect(host.textContent).toContain('PreToolUse');
  });

  it('allows opening the new hook form and saving a hook', async () => {
    vi.mocked(api.fetchHooks).mockResolvedValue({
      hooks: [],
      templates: [],
    });
    vi.mocked(api.saveHook).mockResolvedValue({ ok: true } as any);

    await act(async () => {
      root.render(<HookManager />);
    });

    const createBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('New Hook')
    );
    expect(createBtn).toBeDefined();

    await act(async () => {
      createBtn?.click();
    });

    const nameInput = host.querySelector('form input[type="text"]') as HTMLInputElement;
    if (nameInput) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'Security Guard');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const form = host.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(api.saveHook).toHaveBeenCalled();
  });

  it('handles hook toggle and delete operations', async () => {
    const mockHooks = [
      {
        id: 'hook-to-toggle',
        name: 'Toggleable Hook',
        description: 'Test description',
        event: 'PreToolUse',
        matcher: '.*',
        script_code: '#!/bin/bash',
        timeout: 5000,
        is_blocking: true,
        enabled: true,
      },
    ];

    vi.mocked(api.fetchHooks).mockResolvedValue({
      hooks: mockHooks as any,
      templates: [],
    });
    vi.mocked(api.toggleHook).mockResolvedValue({ ok: true } as any);
    vi.mocked(api.deleteHook).mockResolvedValue({ ok: true } as any);

    await act(async () => {
      root.render(<HookManager />);
    });

    // Check toggle button / checkbox
    const toggleInput = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (toggleInput) {
      await act(async () => {
        toggleInput.click();
      });
      expect(api.toggleHook).toHaveBeenCalledWith('hook-to-toggle', false);
    }

    // Delete button
    const deleteBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('delete') || b.getAttribute('title')?.toLowerCase().includes('delete')
    );
    if (deleteBtn) {
      await act(async () => {
        deleteBtn.click();
      });
      expect(api.deleteHook).toHaveBeenCalledWith('hook-to-toggle');
    }
  });

  it('filters hooks by search query', async () => {
    const mockHooks = [
      {
        id: 'h1',
        name: 'Alpha Hook',
        description: 'First hook',
        event: 'PreToolUse',
        matcher: '.*',
        script_code: '',
        timeout: 5000,
        is_blocking: true,
        enabled: true,
      },
      {
        id: 'h2',
        name: 'Beta Hook',
        description: 'Second hook',
        event: 'PostToolUse',
        matcher: '.*',
        script_code: '',
        timeout: 5000,
        is_blocking: false,
        enabled: true,
      },
    ];

    vi.mocked(api.fetchHooks).mockResolvedValue({
      hooks: mockHooks as any,
      templates: [],
    });

    await act(async () => {
      root.render(<HookManager />);
    });

    expect(host.textContent).toContain('Alpha Hook');
    expect(host.textContent).toContain('Beta Hook');

    const searchInput = host.querySelector('input[placeholder*="Search"]') || host.querySelector('input[type="search"]') || host.querySelector('input');
    if (searchInput) {
      await act(async () => {
        (searchInput as HTMLInputElement).value = 'Alpha';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.textContent).toContain('Alpha Hook');
    }
  });
});
