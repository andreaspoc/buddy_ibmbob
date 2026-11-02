// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OfficeFolderBrowser } from '../../src/components/OfficeFolderBrowser';
import { appConfirm } from '../../src/components/AppDialog';

vi.mock('../../src/components/AppDialog', () => ({ appConfirm: vi.fn() }));
const folders = [
  { id: 'root', name: 'Projects', parent_id: null },
  { id: 'child', name: 'Reports', parent_id: 'root' },
  { id: 'other', name: 'Archive', parent_id: null },
];
let root: Root;
let host: HTMLDivElement;
let mutate: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(appConfirm).mockReset().mockResolvedValue(true);
  mutate = vi.fn().mockResolvedValue(undefined);
  select = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<OfficeFolderBrowser folders={folders} current={null} onSelect={select} mutate={mutate} />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = [...document.querySelectorAll('button')].find(item => item.textContent?.trim().endsWith(label));
  expect(result, `Missing button: ${label}`).toBeDefined();
  return result!;
}
async function click(target: HTMLElement) { await act(async () => target.click()); }
async function key(target: Element, value: string) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); });
}
async function name(value: string) {
  const input = document.querySelector('form input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  const form = document.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function openMenu() {
  const actual = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === 'Rename or move folder "Projects"')!;
  await click(actual);
  return actual;
}

test('shows only immediate child folders and opens the selected folder', async () => {
  expect(host.querySelector('[title="Reports"]')).toBeNull();
  await click(host.querySelector('[title="Projects"]') as HTMLElement);
  expect(select).toHaveBeenCalledWith('root');
  await click(button('My files'));
  expect(select).toHaveBeenLastCalledWith(null);
});

test('new-folder dialog accepts keyboard dismissal without a request', async () => {
  await click(button('New folder'));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-label')).toBe('New folder');
  expect(document.activeElement).toBe(dialog.querySelector('input'));
  await key(dialog.querySelector('input')!, 'Escape');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mutate).not.toHaveBeenCalled();
});

test('creates a trimmed folder in the chosen destination', async () => {
  await click(button('New folder'));
  await name('  Quarter reports  ');
  const destination = document.querySelector('form select') as HTMLSelectElement;
  await act(async () => { destination.value = 'root'; destination.dispatchEvent(new Event('change', { bubbles: true })); });
  await submit();
  expect(mutate).toHaveBeenCalledWith('/folders', 'POST', { name: 'Quarter reports', parent_id: 'root' });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('preserves edits on request failure and permits retry', async () => {
  mutate.mockRejectedValueOnce(new Error('Synthetic save failure'));
  await click(button('New folder'));
  await name('Fixture');
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Synthetic save failure');
  expect((document.querySelector('form input') as HTMLInputElement).value).toBe('Fixture');
  await submit();
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('busy dialogs ignore Escape until their request completes', async () => {
  let finish!: () => void;
  mutate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await click(button('New folder'));
  await name('Fixture');
  await submit();
  expect((document.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await key(document.querySelector('form input')!, 'Escape');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finish());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('folder menu supports arrows, Home, End and focus return', async () => {
  const trigger = await openMenu();
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  expect(document.activeElement).toBe(items[0]);
  await key(items[0], 'ArrowDown');
  expect(document.activeElement).toBe(items[1]);
  await key(items[1], 'End');
  expect(document.activeElement).toBe(items.at(-1));
  await key(items.at(-1)!, 'Home');
  expect(document.activeElement).toBe(items[0]);
  await key(items[0], 'Escape');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('rename prevents moving a folder into itself or descendants', async () => {
  await openMenu();
  await click(button('Rename / move'));
  const options = [...document.querySelectorAll('form option')].map(option => option.textContent);
  expect(options).not.toContain('Projects');
  expect(options).not.toContain('Projects / Reports');
  await name('Renamed');
  await submit();
  expect(mutate).toHaveBeenCalledWith('/folders/root', 'PATCH', { name: 'Renamed', parent_id: null });
});

test('declining deletion makes no request; confirmed errors are shown', async () => {
  vi.mocked(appConfirm).mockResolvedValueOnce(false);
  await openMenu();
  await click(button('Delete'));
  expect(mutate).not.toHaveBeenCalled();
  mutate.mockRejectedValueOnce(new Error('Folder is not empty'));
  await openMenu();
  await click(button('Delete'));
  expect(mutate).toHaveBeenCalledWith('/folders/root', 'DELETE');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Folder is not empty');
});
