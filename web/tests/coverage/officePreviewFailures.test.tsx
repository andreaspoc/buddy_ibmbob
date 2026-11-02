// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OfficeFilePopup } from '../../src/components/OfficeFilePopup';

let host: HTMLDivElement;
let root: Root;
let config: any;
let destroy: ReturnType<typeof vi.fn>;
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

describe('Office preview error and lifecycle handling', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    HTMLDialogElement.prototype.show = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    destroy = vi.fn(); config = undefined;
    (window as any).DocsAPI = { DocEditor: class { destroyEditor = destroy; constructor(_id: string, value: any) { config = value; } } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ script_url: '/office-editor/web-apps/apps/api/documents/api.js', config: { editorConfig: { mode: 'edit' } } }) })));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as any).DocsAPI; vi.unstubAllGlobals(); });
  async function open() { await act(async () => root.render(<OfficeFilePopup file={{id:'synthetic', name:'example.docx'}} onClose={vi.fn()} />)); await tick(); }

  it('requests a read-only preview and displays vendor errors', async () => {
    await open();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('view_only=true'), expect.objectContaining({ method: 'POST' }));
    expect(config.editorConfig.mode).toBe('view');
    await act(async () => config.events.onError());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Office preview could not load');
  });
  it('transitions from loading to ready and destroys the editor on unmount', async () => {
    await open(); expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading document');
    await act(async () => config.events.onDocumentReady());
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.unmount());
    expect(destroy).toHaveBeenCalledOnce();
    root = createRoot(host);
  });
  it('shows the server error and never initializes an editor on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ detail: 'Editor unavailable' }) })));
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Editor unavailable');
    expect(config).toBeUndefined();
  });
});
