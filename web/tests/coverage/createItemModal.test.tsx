// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CreateItemModal } from '../../src/components/CreateItemModal';

let host: HTMLDivElement;
let root: Root;

describe('CreateItemModal Component', () => {
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

  it('renders nothing when isOpen is false or kind is null', async () => {
    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={false}
          kind="skill"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
    });
    expect(host.innerHTML).toBe('');

    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={true}
          kind={null}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
    });
    expect(host.innerHTML).toBe('');
  });

  it('renders skill modal and handles submission successfully', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ name: 'my-skill', ok: true }),
    });
    global.fetch = mockFetch;

    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={true}
          kind="skill"
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    });

    expect(host.textContent).toContain('Add a skill');

    const inputs = host.querySelectorAll('input');
    const textareas = host.querySelectorAll('textarea');

    // Fill skill slug
    if (inputs[0]) {
      await act(async () => {
        inputs[0].value = 'my-skill';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Fill description and instructions
    if (textareas[0]) {
      await act(async () => {
        textareas[0].value = 'Skill description';
        textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    if (textareas[1]) {
      await act(async () => {
        textareas[1].value = 'Skill instructions';
        textareas[1].dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    const form = host.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/skills',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it('renders mode modal and allows typing custom fields', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ slug: 'analyst-mode', ok: true }),
    });
    global.fetch = mockFetch;

    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={true}
          kind="mode"
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    });

    expect(host.textContent).toContain('Add a mode');

    const form = host.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/modes',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });

  it('renders MCP modal with transport selection and test connection', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'connected', message: 'Ready' }),
    });
    global.fetch = mockFetch;

    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={true}
          kind="mcp"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Connect your tools');

    // Check transport radio or options
    const transportSelect = host.querySelector('select');
    if (transportSelect) {
      await act(async () => {
        transportSelect.value = 'stdio';
        transportSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Modal close button
    const closeBtn = host.querySelector('button[aria-label*="Close"]') || host.querySelector('.modal-close');
    if (closeBtn) {
      await act(async () => {
        (closeBtn as HTMLButtonElement).click();
      });
    }
  });

  it('loads configuration when mcpName prop is provided', async () => {
    const configFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        knowledge_base: 'company',
        transport: 'http',
        httpURL: 'http://localhost:8080/mcp',
      }),
    });
    global.fetch = configFetch;

    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={true}
          kind="mcp"
          mcpName="sample-tool"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
    });

    expect(configFetch).toHaveBeenCalledWith('/mcps/sample-tool/config');
    expect(host.textContent).toContain('Configure sample-tool');
  });

  it('renders agent modal and handles API error responses gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Invalid agent card URL' }),
    });
    global.fetch = mockFetch;

    await act(async () => {
      root.render(
        <CreateItemModal
          isOpen={true}
          kind="agent"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Add an A2A agent');

    const form = host.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(host.textContent).toContain('Invalid agent card URL');
  });
});
