// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { CreateItemModal } from '../../src/components/CreateItemModal';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
function change(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {bubbles:true})); });
}
test('stdio connection parses quoted command and environment before saving', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const f = vi.fn().mockResolvedValueOnce({ok:true, json:async()=>({items:[]})}).mockResolvedValueOnce({ok:true, json:async()=>({})}).mockResolvedValueOnce({ok:true, json:async()=>({status:'ok', message:'Connected'})}); vi.stubGlobal('fetch', f);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const success = vi.fn();
  await act(async () => root.render(<CreateItemModal kind="mcp" isOpen onClose={vi.fn()} onSuccess={success} />));
  change(host.querySelector('input[placeholder="my-service"]')!, 'sample-service');
  const select = [...host.querySelectorAll('select')].find(el => [...el.options].some(o => o.value === 'stdio'))!; change(select, 'stdio');
  change(host.querySelector('input[placeholder^="npx"]')!, 'node "server file.js" --flag');
  change(host.querySelector('textarea[placeholder^="{\\"DATABASE_URL"]') || [...host.querySelectorAll('textarea')].find(el => el.placeholder.includes('DATABASE_URL'))!, '# comment\nREGION=eu\nDEBUG: true');
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); });
  const saves = () => f.mock.calls.filter(call => call[0] !== '/access/groups'); expect(saves()).toHaveLength(2); const payload = JSON.parse(saves()[0][1].body);
  expect(payload.command).toBe('node'); expect(payload.args).toEqual(['server file.js', '--flag']);
  expect(payload.env).toEqual({ REGION:'eu', DEBUG:'true' }); expect(payload.api_key_name).toBe('API_KEY');
  expect(success).toHaveBeenCalledOnce(); expect(host.textContent).toContain('Connected');
});
test('invalid connection parameters are rejected before a network request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); const f = vi.fn(); vi.stubGlobal('fetch', f);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CreateItemModal kind="mcp" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />));
  change(host.querySelector('input[placeholder="my-service"]')!, 'sample-service');
  const params = [...host.querySelectorAll('textarea')].find(el => el.placeholder.includes('region'))!; change(params, 'bad-line');
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); });
  expect(host.textContent).toContain('Invalid line in URL parameters'); expect(f.mock.calls.filter(call => call[0] !== '/access/groups')).toEqual([]);
});
test('HTTP connection normalizes JSON headers and preserves the URL parameters', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const f = vi.fn().mockResolvedValueOnce({ok:true, json:async()=>({items:[]})}).mockResolvedValueOnce({ok:true, json:async()=>({})}).mockResolvedValueOnce({ok:true, json:async()=>({status:'ok', message:'Connected'})}); vi.stubGlobal('fetch', f);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CreateItemModal kind="mcp" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />));
  change(host.querySelector('input[placeholder="my-service"]')!, 'remote-service');
  change(host.querySelector('input[placeholder^="https://example.com/mcp"]')!, 'https://example.com/mcp');
  const params = [...host.querySelectorAll('textarea')].find(el => el.placeholder.includes('region'))!;
  const headers = [...host.querySelectorAll('textarea')].find(el => el.placeholder.includes('X-Tenant-ID'))!;
  change(params, '{"region":"eu","limit":50}'); change(headers, 'X-Tenant-ID: company');
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); });
  const payload = JSON.parse(f.mock.calls.filter(call => call[0] !== '/access/groups')[0][1].body);
  expect(payload.parameters).toEqual({region:'eu', limit:'50'}); expect(payload.headers).toEqual({'X-Tenant-ID':'company'});
  expect(payload.transport).toBe('http'); expect(payload.url).toBe('https://example.com/mcp');
});
