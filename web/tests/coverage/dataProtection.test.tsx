// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DataProtectionSettings } from '../../src/components/DataProtectionSettings';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const policy = (changes = {}) => ({
  categories: { 'Phone number': 'ask', 'Tax': 'ask' }, channels: { email: true, other: true },
  custom_rules: [{ name: 'Atlas', terms: ['a', 'b'], action: 'block' }],
  available_categories: ['Phone number', 'Tax'], available_channels: ['email', 'other'], ...changes,
});
let root: Root;
const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(node); });
};
const change = (element: Element, value: string) => act(async () => {
  const prototype = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('DataProtectionSettings', () => {
  it('edits and saves categories, channels and custom rules', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(200, policy())).mockResolvedValueOnce(json(200, policy({ categories: { 'Phone number': 'block', 'Tax': 'block' } })));
    vi.stubGlobal('fetch', request);
    await mount(<DataProtectionSettings />);
    const selects = document.querySelectorAll('select');
    await change(selects[0], 'block');
    await change(selects[1], 'block');
    await click(document.querySelectorAll('input[type=checkbox]')[0]);
    await change(document.querySelector('.data-protection-rule input')!, 'Renamed');
    await change(document.querySelector('.data-protection-rule textarea')!, 'x\ny');
    await change(document.querySelector('.data-protection-rule select')!, 'ask');
    await click(button('Add rule'));
    expect(document.querySelectorAll('.data-protection-rule')).toHaveLength(2);
    await click(document.querySelectorAll<HTMLButtonElement>('.data-protection-rule button')[1]);
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const body = JSON.parse(request.mock.calls[1][1].body);
    expect(body.categories['Phone number']).toBe('block');
    expect(body.channels.email).toBe(false);
    expect(body.custom_rules).toEqual([{ name: 'Renamed', terms: ['x', 'y'], action: 'ask' }]);
    expect(document.querySelector('[role=status]')?.textContent).toBe('Data protection rules saved.');
  });
  it('shows load and save failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { detail: 'No access' })));
    await mount(<DataProtectionSettings />);
    expect(document.querySelector('[role=alert]')?.textContent).toBe('No access');
    await act(async () => root.unmount());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'));
    await mount(<DataProtectionSettings />);
    expect(document.querySelector('[role=alert]')?.textContent).toBe('Could not load data protection rules.');
    await act(async () => root.unmount());
    const allow = policy();
    const request = vi.fn().mockResolvedValueOnce(json(200, allow)).mockResolvedValueOnce(json(422, { detail: [] })).mockRejectedValueOnce('offline').mockResolvedValueOnce(json(400, { detail: 'Bad' }));
    vi.stubGlobal('fetch', request);
    await mount(<DataProtectionSettings />);
    const submit = () => act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await submit();
    expect(document.querySelector('[role=alert]')?.textContent).toContain('custom rule');
    await submit();
    expect(document.querySelector('[role=alert]')?.textContent).toBe('Could not save data protection rules.');
    await submit();
    expect(document.querySelector('[role=alert]')?.textContent).toBe('Bad');
  });
});
