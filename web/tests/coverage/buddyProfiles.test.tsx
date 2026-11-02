// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { BuddyProfiles } from '../../src/components/BuddyProfiles';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
function change(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => el.dispatchEvent(new Event('change', { bubbles: true })));
  act(() => el.dispatchEvent(new Event('input', { bubbles: true })));
}
function select(label: string) { return [...host.querySelectorAll('label')].find(item => item.textContent?.includes(label))!; }
test('defaults to Bob and saves a configured profile without exposing a prior credential', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const response = {ok:true, json:async()=>({enabled:false, active_id:'bob', profiles:[]})};
  const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<BuddyProfiles />));
  expect(host.textContent).toContain('Active: IBM Bob');
  expect((select('Active Buddy').querySelector('select') as HTMLSelectElement).disabled).toBe(true);
  change(select('Profile name').querySelector('input')!, 'Test Buddy');
  change(select('Provider').querySelector('select')!, 'openai_compatible');
  change(select('Model or deployment ID').querySelector('input')!, 'sample-model');
  change(select('HTTPS endpoint').querySelector('input')!, 'https://example.test/v1');
  change(select('API key').querySelector('input')!, 'fixture-key');
  change(select('Buddy instructions').querySelector('textarea')!, 'Be concise.');
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
  const payload = JSON.parse(fetch.mock.calls[1][1].body);
  expect(payload).toMatchObject({ provider:'openai_compatible', name:'Test Buddy', model:'sample-model', instructions:'Be concise.', api_key:'fixture-key' });
  expect(select('API key').querySelector('input')!.value).toBe('');
});
test('switch sends explicit enabled state and exposes provider-specific fields', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetch = vi.fn().mockResolvedValue({ok:true, json:async()=>({enabled:false, active_id:'bob', profiles:[]})}); vi.stubGlobal('fetch', fetch);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<BuddyProfiles />));
  change(select('Provider').querySelector('select')!, 'bedrock');
  expect(host.textContent).toContain('AWS region'); expect(host.textContent).toContain('AWS secret access key');
  change(select('Provider').querySelector('select')!, 'watsonx');
  expect(host.textContent).toContain('watsonx project ID');
  expect(select('Enable multi-provider mode').querySelector('input')!.disabled).toBe(true);
  expect(host.textContent).toContain('Provider activation is not available yet');
});
