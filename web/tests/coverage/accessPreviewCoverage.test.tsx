// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AccessPreview } from '../../src/components/AccessPreview';

describe('AccessPreview Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('offers created groups and previews access for the selected ones', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => url === '/access/groups' ? { ok: true, json: async () => ({ items: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Engineering' }] }) } : ({
      ok: true,
      json: async () => ({
        documents: [
          { id: 'doc-1', filename: 'network-policy.pdf', knowledge_base: 'company', audience: 'both', status: 'ready' },
          { id: 'doc-2', filename: 'regional-software-hub.pdf', knowledge_base: 'company', audience: '11111111-1111-4111-8111-111111111111', status: 'queued' },
        ],
        mcps: [
          { name: 'microsoft-onedrive', allowed: true },
          { name: 'restricted-catalog', allowed: false },
        ],
      }),
    }));

    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(<AccessPreview />);
    });

    expect(host.textContent).toContain('Access preview');

    expect(host.querySelector('select')).toBeNull();
    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.parentElement?.textContent).toContain('Engineering');
    await act(async () => {
      checkbox.click();
    });

    // Submit form
    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith('/admin/access-preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ groups: ['11111111-1111-4111-8111-111111111111'] }),
    }));

    // Verify rendered documents
    expect(host.textContent).toContain('network-policy.pdf');
    expect(host.textContent).toContain('regional-software-hub.pdf');
    expect(host.textContent).toContain('Engineering');
    expect(host.textContent).toContain('microsoft-onedrive');
    // Filtered disallowed mcp
    expect(host.textContent).not.toContain('restricted-catalog');

    act(() => root.unmount());
  });

  it('handles empty results and server errors', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ detail: 'Access service unavailable' }),
    });

    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(<AccessPreview />);
    });

    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(host.textContent).toContain('Access service unavailable');

    // Test empty success
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ documents: [], mcps: [] }),
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(host.textContent).toContain('No documents are available for this group.');
    expect(host.textContent).toContain('No MCP connections are available for this group.');

    act(() => root.unmount());
  });
});
