// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CitationPreview } from '../../src/components/CitationPreview';

const preview = '/knowledge/12345678-1234-1234-1234-123456789abc/preview';
let host: HTMLDivElement;
let root: Root;
let anchor: HTMLAnchorElement;
async function open() { await act(async () => { anchor.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })); }); }
async function close() { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); }

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const ref = createRef<HTMLDivElement>();
  await act(async () => { root.render(<><div ref={ref}><a data-source-url="https://example.com/source" data-citation-preview={preview}>Report</a></div><CitationPreview rootRef={ref} contentKey="one" sessionId="one" /></>); });
  anchor = host.querySelector('a')!;
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals(); });

describe('citation previews', () => {
  it('loads safe passages, filters invalid passages, caches and dismisses accessibly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ filename: 'Report.pdf', exact: true, passages: [{ location: 'Page 1', text: 'Evidence' }, { text: 42 }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await open();
    expect(fetchMock).toHaveBeenCalledWith(preview, expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(document.body.textContent).toContain('Report.pdf');
    expect(document.body.textContent).toContain('Evidence');
    expect(document.querySelectorAll('.citation-preview-passage')).toHaveLength(1);
    expect(anchor.getAttribute('aria-describedby')).toBe(document.querySelector('[role="tooltip"]')?.id);
    await close();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(anchor.hasAttribute('aria-describedby')).toBe(false);
    await open();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects external preview requests and shows supplied web metadata', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    anchor.dataset.citationPreview = 'https://attacker.example/knowledge/12345678-1234-1234-1234-123456789abc/preview';
    anchor.dataset.sourceKind = 'web';
    await open();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Web source');
    expect(document.querySelector('.citation-preview a')?.getAttribute('href')).toBe('https://example.com/source');
  });
  it('reports missing and malformed previews', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({ ok: true, json: async () => ({ filename: 'bad' }) });
    vi.stubGlobal('fetch', fetchMock);
    await open(); expect(document.body.textContent).toContain('This source passage is no longer available.');
    await close(); await open(); expect(document.body.textContent).toContain('This source returned an invalid preview.');
  });
  it('ignores disabled links and aborts pending requests on dismissal', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); vi.stubGlobal('fetch', fetchMock);
    anchor.setAttribute('aria-disabled', 'true'); await open(); expect(fetchMock).not.toHaveBeenCalled();
    anchor.removeAttribute('aria-disabled'); await open();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false); await close(); expect(signal.aborted).toBe(true);
  });
});
