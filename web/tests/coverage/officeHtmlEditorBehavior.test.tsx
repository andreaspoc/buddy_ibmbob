// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeHtmlEditor } from '../../src/components/OfficeHtmlEditor';
const mocks = vi.hoisted(() => ({ changed: undefined as (() => void) | undefined, saveSource: vi.fn(), setEditing: vi.fn() }));
vi.mock('../../src/components/Toolbar', () => ({ Toolbar: ({ children, ...props }: any) => <div {...props}>{children}</div> }));
vi.mock('../../src/components/NotesOfficeTransfer', () => ({ OfficeToNoteButton: () => null }));
vi.mock('../../src/components/OfficeAssistant', () => ({ OfficeAssistant: () => <div>Assistant</div> }));
vi.mock('../../src/components/HtmlDeckViewer', () => ({ HtmlDeckViewer: () => <div>Layout editing surface</div> }));
vi.mock('../../src/lib/officeHtmlBridge', () => ({ useOfficeHtmlBridge: () => ({ ready: true }) }));
vi.mock('../../src/lib/officeHtmlRuntime', () => ({ useOfficeHtmlRuntime: (_frame: unknown, _id: unknown, source: string, onChanged: () => void) => { mocks.changed = onChanged; return { ready: true, runtimeError: '', runtimeSource: source, saveSource: mocks.saveSource, setEditing: mocks.setEditing }; } }));
let host: HTMLDivElement, root: Root;
const file = { id: 'file1', name: 'dashboard.html', extension: 'html', size: 100, revision: 3, save_sequence: 1, saved_at: '2026-01-01T00:00:00Z', access: 'owner' as const };
const onDirty = vi.fn(), onUpdated = vi.fn();
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;
const click = async (b: HTMLElement) => act(async () => { b.click(); });
const response = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body });
async function render(access: 'owner' | 'read' = 'owner') { await act(async () => { root.render(<OfficeHtmlEditor file={{ ...file, access }} onBack={vi.fn()} onClose={vi.fn()} onDirty={onDirty} onUpdated={onUpdated} />); }); }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ html: '<html><body>Saved</body></html>', revision: 7 }))); mocks.saveSource.mockReset().mockResolvedValue('<html><body>Edited</body></html>'); mocks.setEditing.mockReset().mockResolvedValue(undefined); onDirty.mockReset(); onUpdated.mockReset(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('Office HTML editor behavior', () => {
 it('loads a sandboxed document and presents it until Escape', async () => { await render(); expect(fetch).toHaveBeenCalledWith('/api/office/files/file1/content', expect.objectContaining({ signal: expect.any(AbortSignal) })); expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts'); expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Saved'); await click(button('Present')); expect(host.querySelector('[role="dialog"]')).not.toBeNull(); await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); expect(host.querySelector('[role="dialog"]')).toBeNull(); });
 it('saves edits with the server revision and clears the dirty state', async () => { await render(); vi.mocked(fetch).mockResolvedValueOnce(response({ id: 'file1', revision: 8 }) as Response); await act(async () => { mocks.changed!(); }); expect(onDirty).toHaveBeenLastCalledWith(true); expect(button('Present').disabled).toBe(true); await click(button('Save to Office Suite')); expect(fetch).toHaveBeenLastCalledWith('/api/office/files/file1/content', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ html: '<html><body>Edited</body></html>', revision: 7 }) })); expect(onUpdated).toHaveBeenCalledWith({ id: 'file1', revision: 8 }); expect(onDirty).toHaveBeenLastCalledWith(false); });
 it('shows save conflicts without clearing unsaved changes', async () => { await render(); vi.mocked(fetch).mockResolvedValueOnce(response({ detail: 'The file changed; reload it.' }, 409) as Response); await act(async () => { mocks.changed!(); }); await click(button('Save to Office Suite')); expect(host.querySelector('[role="alert"]')?.textContent).toContain('The file changed; reload it.'); expect(onUpdated).not.toHaveBeenCalled(); expect(onDirty).toHaveBeenLastCalledWith(true); });
 it('permits read-only presentation without editing controls', async () => { await render('read'); expect(host.textContent).toContain('Read only'); expect(button('Edit text')).toBeUndefined(); expect(button('Save to Office Suite')).toBeUndefined(); expect(button('Present').disabled).toBe(false); });
 it('reports load errors and signals expired sessions', async () => { vi.mocked(fetch).mockResolvedValueOnce(response({ detail: 'Session expired' }, 401) as Response); const expired = vi.fn(); window.addEventListener('buddy-auth-expired', expired); await render(); expect(expired).toHaveBeenCalledOnce(); expect(host.querySelector('[role="alert"]')?.textContent).toBe('Session expired'); expect(button('Present').disabled).toBe(true); window.removeEventListener('buddy-auth-expired', expired); });
 it('switches layouts and displays editing failures', async () => { await render(); mocks.setEditing.mockRejectedValueOnce(new Error('Frame unavailable')); await click(button('Edit text')); expect(host.querySelector('[role="alert"]')?.textContent).toBe('Frame unavailable'); await click(button('Layout editor')); expect(host.textContent).toContain('Layout editing surface'); await click(button('Live presentation')); expect(button('Edit text')).toBeDefined(); });
});
