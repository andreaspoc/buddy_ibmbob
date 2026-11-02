// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LearningPeopleAdmin from '../../src/components/LearningPeopleAdmin';

const people = [{ username: 'alice', display_name: 'Alice', email: 'alice@example.test' }, { username: 'bob', display_name: 'Bob', is_admin: true }];
const group = { id: 'group 1', name: 'Editors', description: 'Authors', revision: 3, members: [people[0]] };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof vi.fn>;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
async function toggle(label: string) {
  const picker = [...host.querySelectorAll('fieldset')].find(field => field.textContent?.includes(label));
  const choice = [...(picker?.querySelectorAll('label') || [])].find(item => item.textContent?.includes('Bob'));
  if (!choice) throw new Error(`Bob not found in ${label}`);
  await act(async () => { choice.click(); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/admin/app-groups/directory') return response({ items: people, truncated: false });
    if (url === '/admin/learning-teachers') return response(options?.method === 'PUT' ? {} : { role: 'teacher', revision: 2, items: [people[0]] });
    if (url === '/admin/app-groups') return response(options?.method === 'POST' ? group : { items: [{ ...group, member_count: 1 }] });
    if (url.includes('/members')) return response({ ...group, revision: 4, members: people });
    if (url.startsWith('/admin/app-groups/group%201')) return response(group);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('Learning people administration', () => {
  it('creates and edits group details with revision control', async () => {
    await act(async () => { root.render(<LearningPeopleAdmin />); });
    await click('Create application group');
    expect(button('Save new group').disabled).toBe(true);
    const input = host.querySelector<HTMLInputElement>('[aria-label="Edit application group"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Editors');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Save new group');
    expect(fetchMock).toHaveBeenCalledWith('/admin/app-groups', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Editors', description: '' }) }));
    await click('Save group details');
    expect(fetchMock).toHaveBeenCalledWith('/admin/app-groups/group%201', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Editors', description: '', expected_revision: 3 }) }));
    expect(host.textContent).toContain('Application group saved');
  });

  it('loads a group, saves membership and deletes only after confirmation', async () => {
    const changed = vi.fn();
    await act(async () => { root.render(<LearningPeopleAdmin onChanged={changed} />); });
    await click('Editors');
    expect(host.textContent).toContain('Members of Editors');
    await toggle('Members of Editors');
    await click('Save group membership');
    const memberCall = fetchMock.mock.calls.find(([url]) => url.includes('/members'))!;
    expect(JSON.parse(memberCall[1]!.body as string)).toEqual({ expected_revision: 3, usernames: ['alice', 'bob'] });
    expect(host.textContent).toContain('Group membership saved');
    await click('Delete group…');
    expect(host.querySelector('[aria-label="Confirm group deletion"]')).not.toBeNull();
    await click('Confirm group deletion');
    expect(fetchMock).toHaveBeenCalledWith('/admin/app-groups/group%201?expected_revision=4', expect.objectContaining({ method: 'DELETE' }));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('requires confirmation before replacing teacher roles', async () => {
    await act(async () => { root.render(<LearningPeopleAdmin />); });
    expect(button('Save Learning teacher roles').disabled).toBe(true);
    await toggle('Accounts assigned the Learning teacher role');
    const confirmation = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('I have reviewed'))!;
    await act(async () => { confirmation.click(); });
    await click('Save Learning teacher roles');
    const call = fetchMock.mock.calls.find(([url, options]) => url === '/admin/learning-teachers' && options?.method === 'PUT')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expected_revision: 2, usernames: ['alice', 'bob'] });
    expect(host.textContent).toContain('Learning teacher roles saved');
  });

  it('shows server errors and prevents roster replacement for a truncated directory', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/directory')) return response({ items: people, truncated: true });
      if (url.endsWith('/learning-teachers')) return response({ role: 'teacher', revision: 1, items: [] });
      if (url === '/admin/app-groups') return response({ items: [{ ...group, member_count: 1 }] });
      return response({ detail: 'Group unavailable' }, false);
    });
    await act(async () => { root.render(<LearningPeopleAdmin />); });
    expect(host.textContent).toContain('directory is limited');
    expect(button('Save Learning teacher roles').disabled).toBe(true);
    await click('Editors');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Group unavailable');
  });
});
