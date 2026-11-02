// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPCatalog, MCPServerCatalog, CatalogIcon } from '../../src/components/MCPCatalog';

const base = { description: 'Synthetic server', icon: 'plug', transport: 'http', url: 'https://mcp.example.test', command: '', args: [], fields: [{ key: 'token', label: 'API token', location: 'header', target: 'Authorization', prefix: 'Bearer ', required: true }], knowledge_base: 'company', audience: 'both', access_mode: 'grants', groups: [], users: [], enabled: true, allowed: true, ready: true, connected: false };
const tpl = (id: string, extra: Record<string, unknown> = {}) => ({ ...base, id, name: id.toUpperCase(), ...extra });
const json = (value: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => value });

let host: HTMLDivElement; let root: Root; let items: any[]; let calls: Array<{ url: string; method: string; body?: any }>;
let overrides: Record<string, () => unknown>;

function fetchRouter() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const [key, make] of Object.entries(overrides)) if (url.startsWith(key)) return make();
    if (url === '/admin/users') return json({ users: [{ username: 'ana', display_name: 'Ana Lee' }, { username: 'bo' }] });
    if (url.endsWith('/check')) return json({ status: 'working', message: 'All good', tools: ['one', 'two'], checked_at: '2026-01-01T10:00:00Z' });
    if (url === '/access/groups') return json({ items: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Engineering' }] });
    if (url === '/mcp-catalog') return json(items);
    return json({}, true, 204);
  });
}
const btn = (label: string) => {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}: ${[...host.querySelectorAll('button')].map(b => b.textContent).join('|')}`);
  return found;
};
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const labelled = (text: string) => {
  const label = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith(text));
  if (!label) throw new Error(`no label ${text}`);
  return label.querySelector('input,select,textarea') as HTMLInputElement;
};
const setValue = (el: HTMLElement, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const submit = (form: Element) => act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const render = async (node: React.ReactNode) => { await act(async () => { root.render(node); }); await act(async () => { await Promise.resolve(); }); };
const catalog = (isAdmin = true, onChanged = vi.fn(), standalone = false) => render(<MCPCatalog isAdmin={isAdmin} onChanged={onChanged} standalone={standalone} />);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  items = []; calls = []; overrides = {};
  vi.stubGlobal('fetch', fetchRouter());
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('catalog access summaries for legacy templates', () => {
  it.each([
    [{ groups: undefined, access_mode: 'users', users: ['ana'] }, 'No groups · 1 selected users'],
    [{ groups: undefined, access_mode: 'groups', audience: 'both', users: ['x'] }, 'Everyone · 0 selected users'],
    [{ groups: undefined, access_mode: 'groups', audience: '11111111-1111-4111-8111-111111111111' }, 'Engineering'],
    [{ groups: ['unknown_group'] }, 'unknown_group'],
  ])('summarises %j', async (extra, text) => {
    items = [tpl('legacy', extra)];
    await catalog();
    expect(host.querySelector('.catalog-access-hint')?.textContent).toContain(text);
  });
});

describe('card status labels', () => {
  it.each([
    [{ enabled: false }, 'Disabled by administrator'],
    [{ ready: false }, 'Administrator setup required'],
    [{ allowed: false }, 'Assign access before connecting'],
    [{ connected: true, auth_mode: 'none' }, 'Connected'],
    [{ connected: true, auth_mode: 'keycloak' }, 'Account connected'],
    [{ connected: true, auth_mode: 'credentials' }, 'Connected with your credentials'],
    [{}, 'Available'],
  ])('labels %j', async (extra, text) => {
    items = [tpl('one', extra)];
    await catalog(false);
    expect(host.querySelector('.catalog-heading span:not(.catalog-icon)')?.textContent).toBe(text);
  });
});

describe('catalog loading', () => {
  it('shows the load error from the catalog and account requests', async () => {
    overrides['/mcp-catalog'] = () => json({ detail: 'Catalog down' }, false);
    await catalog(false);
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Catalog down');
    expect(host.textContent).toContain('No catalog entries are available');
  });
  it('uses a generic message for structured validation errors', async () => {
    overrides['/mcp-catalog'] = () => json({ detail: [{ msg: 'bad' }] }, false);
    await catalog(false);
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Please check the catalog fields and try again.');
  });
  it('reports account load failures to administrators', async () => {
    overrides['/admin/users'] = () => json({}, false);
    await catalog();
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Could not load accounts for access assignment.');
  });
  it('refreshes standalone catalog and notifies parent', async () => {
    const changed = vi.fn(); items = [tpl('one')];
    await catalog(false, changed, true);
    items = [tpl('one'), tpl('two')];
    await click(btn('Refresh catalog'));
    expect(changed).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('.catalog-card')).toHaveLength(2);
  });
  it('filters on search query and category, treating missing category as productivity', async () => {
    items = [tpl('alpha', { category: 'search' }), tpl('beta', { category: undefined })];
    await catalog(false);
    await setValue(labelled('Category'), 'productivity');
    expect([...host.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['BETA']);
    await setValue(labelled('Category'), '');
    await setValue(labelled('Search catalog'), 'alp');
    expect([...host.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['ALPHA']);
  });
  it('only links safe provider documentation and shows setup requirements', async () => {
    items = [tpl('safe', { docs_url: 'https://docs.example.test', setup_instructions: 'Ask admin' }), tpl('bad', { docs_url: 'javascript:alert(1)' })];
    await catalog(false);
    const links = host.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toContain('docs.example.test');
    expect(host.querySelector('details')?.textContent).toContain('Ask admin');
  });
});

describe('connection health', () => {
  it('reports details and re-tests online servers', async () => {
    items = [tpl('one', { connected: true })];
    await catalog(false);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('.mcp-status')?.textContent).toBe('Online');
    expect(host.querySelector('.catalog-connection-health details')?.textContent).toContain('2 tools');
    const before = calls.filter(c => c.url.endsWith('/check')).length;
    await click(btn('Test again'));
    expect(calls.filter(c => c.url.endsWith('/check')).length).toBeGreaterThan(before);
  });
  it('shows offline without tool details when the check fails', async () => {
    overrides['/mcp-catalog/one/check'] = () => json({ status: 'error', message: 'Nope' });
    items = [tpl('one', { connected: true })];
    await catalog(false);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('.mcp-status')?.textContent).toBe('Offline');
    expect(host.querySelector('.catalog-connection-health details')?.textContent).not.toContain('tools');
  });
});

describe('credential connection', () => {
  it('saves credentials privately and cancels clear the form', async () => {
    const changed = vi.fn(); items = [tpl('one')];
    await catalog(false, changed);
    await click(btn('Connect'));
    expect(host.querySelector('form')?.textContent).toContain('Credentials are private');
    const input = labelled('API token');
    expect(input.required).toBe(true);
    await setValue(input, 'synthetic-value');
    await click(btn('Cancel'));
    expect(host.querySelector('form')).toBeNull();
    await click(btn('Connect'));
    expect(labelled('API token').value).toBe('');
    await setValue(labelled('API token'), 'synthetic-value');
    await submit(host.querySelector('form')!);
    expect(calls.find(c => c.url === '/mcp-catalog/one/connect')?.body).toEqual({ credentials: { token: 'synthetic-value' } });
    expect(changed).toHaveBeenCalledOnce();
    expect(host.querySelector('[role=status]:not(.mcp-status)')?.textContent).toContain('Connection saved');
  });
  it('explains public servers and labels connected actions', async () => {
    items = [tpl('pub', { auth_mode: 'none', fields: [] }), tpl('upd', { connected: true })];
    await catalog(false);
    expect(btn('Update credentials')).toBeTruthy();
    await click(btn('Connect'));
    expect(host.querySelector('form')?.textContent).toContain('does not require account sign-in');
  });
  it('surfaces save errors and keeps the form open', async () => {
    overrides['/mcp-catalog/one/connect'] = () => json({ detail: 'Bad token' }, false);
    items = [tpl('one')];
    await catalog(false);
    await click(btn('Connect'));
    await submit(host.querySelector('form')!);
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Bad token');
    expect(host.querySelector('form')).not.toBeNull();
  });
  it('disconnects via catalog API', async () => {
    const changed = vi.fn(); items = [tpl('one', { connected: true, allowed: false })];
    await catalog(false, changed);
    await click(btn('Disconnect'));
    expect(calls.find(c => c.method === 'DELETE')?.url).toBe('/mcp-catalog/one/connection');
    expect(changed).toHaveBeenCalled();
  });
  it('disconnects Microsoft through its auth endpoint and reports failure', async () => {
    items = [tpl('ms', { auth_mode: 'microsoft', connected: true, allowed: false })];
    overrides['/auth/microsoft/disconnect'] = () => json({}, false);
    await catalog(false);
    await click(btn('Disconnect'));
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Could not disconnect Microsoft.');
    overrides['/auth/microsoft/disconnect'] = () => json({});
    await click(btn('Disconnect'));
    expect(host.querySelector('[role=alert]')).toBeNull();
  });
});

describe('browser sign-in', () => {
  const popupWindow = () => ({ closed: false, focus: vi.fn() });
  const signInFlow = async (item: any, onChanged = vi.fn()) => {
    const popup = popupWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as any);
    items = [item];
    await catalog(false, onChanged);
    await click(btn(item.connected ? 'Reconnect account' : 'Sign in to connect'));
    return { popup, open, onChanged };
  };
  const post = (popup: unknown, data: unknown, origin = window.location.origin) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { origin, source: popup as any, data }));
    await new Promise(r => setTimeout(r, 0));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports a blocked popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    items = [tpl('o', { auth_mode: 'oauth' })];
    await catalog(false);
    await click(btn('Sign in to connect'));
    expect(host.querySelector('[role=alert]')?.textContent).toContain('popup was blocked');
  });
  it('opens the correct url for oauth and microsoft', async () => {
    const { open, popup } = await signInFlow(tpl('a b', { auth_mode: 'oauth' }));
    expect(open.mock.calls[0][0]).toBe('/mcp-oauth/a%20b/start');
    expect(popup.focus).toHaveBeenCalled();
    expect(btn('Waiting for sign-in…').disabled).toBe(true);
  });
  it('uses microsoft business login', async () => {
    const { open } = await signInFlow(tpl('ms', { auth_mode: 'microsoft', connected: true }));
    expect(open.mock.calls[0][0]).toBe('/auth/microsoft/login?business=true');
  });
  it('handles success message and reloads', async () => {
    const { popup, onChanged } = await signInFlow(tpl('o', { auth_mode: 'oauth' }));
    await post(popup, { type: 'buddy-mcp-oauth', template_id: 'o', status: 'success' });
    expect(host.querySelector('[role=status]:not(.mcp-status)')?.textContent).toContain('Account connected');
    expect(onChanged).toHaveBeenCalled();
  });
  it.each([
    [{ message: 'Denied by IdP' }, 'Denied by IdP'],
    [{ message: 42 }, 'Could not connect this account. Try again.'],
  ])('shows error status %j', async (extra, text) => {
    const { popup } = await signInFlow(tpl('o', { auth_mode: 'oauth' }));
    await post(popup, { type: 'buddy-mcp-oauth', template_id: 'o', status: 'error', ...extra });
    expect(host.querySelector('[role=alert]')?.textContent).toBe(text);
    expect(btn('Sign in to connect').disabled).toBe(false);
  });
  it('ignores spoofed origins, sources, templates and unknown statuses', async () => {
    const { popup } = await signInFlow(tpl('o', { auth_mode: 'oauth' }));
    await post(popup, { type: 'buddy-mcp-oauth', template_id: 'o', status: 'success' }, 'https://evil.example.test');
    await post(window, { type: 'buddy-mcp-oauth', template_id: 'o', status: 'success' });
    await post(popup, { type: 'other', template_id: 'o', status: 'success' });
    await post(popup, { type: 'buddy-mcp-oauth', template_id: 'zzz', status: 'success' });
    await post(popup, { type: 'buddy-mcp-oauth', template_id: 'o', status: 'pending' });
    expect(btn('Waiting for sign-in…')).toBeTruthy();
    expect(host.querySelector('[role=alert]')).toBeNull();
  });
  it('resets when the popup is closed by the user', async () => {
    vi.useFakeTimers();
    const popup = popupWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as any);
    const changed = vi.fn(); items = [tpl('o', { auth_mode: 'oauth' })];
    await catalog(false, changed);
    await click(btn('Sign in to connect'));
    popup.closed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(btn('Sign in to connect').disabled).toBe(false);
    expect(changed).toHaveBeenCalled();
  });
});

describe('administrator editors', () => {
  it('assigns groups and users, filters accounts and saves access', async () => {
    const changed = vi.fn(); items = [tpl('one', { groups: ['11111111-1111-4111-8111-111111111111'], users: ['bo'] })];
    await catalog(true, changed);
    await click(btn('Assign access'));
    const form = host.querySelector('form[aria-label="Assign MCP server access"]')!;
    const check = (text: string) => [...form.querySelectorAll('label')].find(l => l.textContent?.includes(text))!.querySelector('input')!;
    await click(check('Everyone'));
    await click(check('Engineering'));
    await setValue(labelled('Find users'), 'ana');
    expect(form.querySelector('.catalog-user-list')?.textContent).toContain('Ana Lee (ana)');
    expect(form.querySelector('.catalog-user-list')?.textContent).not.toContain('bo');
    await click(check('Ana Lee'));
    await setValue(labelled('Find users'), '');
    await click(check('bo (bo)'));
    await click(check('Enable catalog entry'));
    await submit(form);
    expect(calls.find(c => c.url === '/mcp-catalog/one/access')?.body).toEqual({ groups: ['company'], users: ['ana'], enabled: false });
    expect(host.textContent).toContain('MCP server access saved');
  });
  it('cancels access editing', async () => {
    items = [tpl('one')];
    await catalog();
    await click(btn('Assign access'));
    await click(btn('Cancel'));
    expect(host.querySelector('form')).toBeNull();
  });
  it('creates a template with credential editing and stdio transport', async () => {
    const changed = vi.fn();
    await catalog(true, changed);
    await click(btn('Create template'));
    await setValue(labelled('Identifier'), 'new_one');
    await setValue(labelled('Name'), 'New one');
    await setValue(labelled('Description'), 'Described');
    await setValue(labelled('Icon'), 'notion');
    await setValue(labelled('Server URL'), 'https://x.example.test');
    await setValue(labelled('Transport'), 'stdio');
    expect(labelled('Environment variable').value).toBe('API_KEY');
    await setValue(labelled('Installed server command'), 'run-mcp');
    await setValue(labelled('Arguments'), 'a\n\nb');
    await setValue(labelled('key'), 'secret');
    await click(labelled('Required'));
    await click(btn('Add credential field'));
    expect(host.querySelectorAll('fieldset legend')[0].textContent).toBe('API token');
    await click(btn('Remove field'));
    await setValue(host.querySelector('form')!.querySelector('select:not([disabled]) option[value="knowledge"]')!.parentElement!, 'search');
    await setValue(labelled('Provider documentation URL'), 'https://d.example.test');
    await setValue(labelled('Setup instructions'), 'Install it');
    await submit(host.querySelector('form')!);
    const sent = calls.find(c => c.url === '/mcp-catalog/new_one' && c.method === 'PUT')!.body;
    expect(sent).toMatchObject({ name: 'New one', description: 'Described', icon: 'notion', transport: 'stdio', command: 'run-mcp', args: ['a', 'b'], category: 'search', docs_url: 'https://d.example.test', setup_instructions: 'Install it' });
    expect(sent.fields).toHaveLength(1);
    expect(sent.fields[0]).toMatchObject({ key: 'token2', location: 'env', target: 'API_KEY' });
    expect(changed).toHaveBeenCalled();
    expect(host.textContent).toContain('Template and access saved');
  });
  it('limits credential fields to twelve', async () => {
    items = [tpl('one', { fields: Array.from({ length: 12 }, (_, i) => ({ ...base.fields[0], key: `k${i}` })) })];
    await catalog();
    await click(btn('Edit template & access'));
    expect(btn('Add credential field').disabled).toBe(true);
    expect(labelled('Identifier').readOnly).toBe(true);
  });
  it('switches authentication and exposes oauth client fields', async () => {
    items = [tpl('one', { transport: 'sse', args: ['x'] })];
    await catalog();
    await click(btn('Edit template & access'));
    await setValue(labelled('Authentication'), 'oauth');
    expect(labelled('Transport').value).toBe('http');
    expect(host.textContent).not.toContain('Credential fields');
    await setValue(labelled('OAuth client ID'), 'cid');
    await setValue(labelled('Requested scopes'), 'read');
    expect(host.textContent).not.toContain('Server environment variable');
    await setValue(labelled('Client authentication'), 'client_secret_post');
    await setValue(labelled('Server environment variable'), 'BOB_MCP_OAUTH_X');
    await setValue(labelled('Authentication'), 'credentials');
    expect(labelled('key').value).toBe('token');
    await setValue(labelled('Authentication'), 'none');
    expect(host.textContent).not.toContain('Credential fields');
    await setValue(labelled('Authentication'), 'credentials');
    await click([...host.querySelectorAll('label')].find(l => l.textContent === 'Enable catalog entry')!.querySelector('input')!);
    await submit(host.querySelector('form')!);
    const sent = calls.find(c => c.method === 'PUT')!.body;
    expect(sent).toMatchObject({ oauth_client_id: 'cid', oauth_scopes: 'read', oauth_client_secret_env: 'BOB_MCP_OAUTH_X', enabled: false });
    expect(sent).not.toHaveProperty('connected');
  });
  it.each([
    ['keycloak', 'Keycloak account sign-in', true],
    ['microsoft', 'Microsoft account sign-in', false],
  ])('locks managed %s identity templates', async (auth_mode, option, realm) => {
    items = [tpl('one', { auth_mode, transport: 'stdio', command: 'cmd', args: ['z'] })];
    await catalog();
    await click(btn('Edit template & access'));
    expect(labelled('Authentication').disabled).toBe(true);
    expect(labelled('Transport').disabled).toBe(true);
    expect(labelled('Installed server command').readOnly).toBe(true);
    expect(labelled('Arguments').readOnly).toBe(true);
    expect(labelled('Authentication').textContent).toContain(option);
    expect(host.textContent.includes('Keycloak realm issuer URL')).toBe(realm);
    if (realm) await setValue(labelled('Keycloak realm issuer URL'), 'https://kc.example.test/realms/a');
    await click(btn('Cancel'));
    expect(host.querySelector('form')).toBeNull();
  });
  it('sets field details for http transports and resets on sse', async () => {
    items = [tpl('one', { transport: 'stdio', fields: [{ ...base.fields[0], location: 'env', target: 'API_KEY', prefix: '' }] })];
    await catalog();
    await click(btn('Edit template & access'));
    await setValue(labelled('Transport'), 'sse');
    expect(labelled('HTTP header').value).toBe('Authorization');
    expect(labelled('Prefix').value).toBe('Bearer ');
    await setValue(labelled('label'), 'Secret');
    await setValue(labelled('Prefix'), 'Token ');
    await click(btn('Add credential field'));
    expect(host.querySelectorAll('fieldset legend')[0].textContent).toBe('Secret');
    expect(labelled('Prefix').value).toBe('Token ');
  });
});

describe('server dialog', () => {
  const dialog = () => host.querySelector('[role=dialog]') as HTMLElement;
  const tab = (shiftKey = false) => act(async () => { dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })); });
  it('traps focus, closes on Escape and lists shared servers', async () => {
    const close = vi.fn();
    await render(<MCPServerCatalog isAdmin={false} onChanged={vi.fn()} onClose={close} servers={[{ name: 'shared', transport: 'http', enabled: true } as any]} />);
    expect(host.textContent).toContain('Shared MCP connections');
    expect(document.activeElement).toBe(dialog());
    const controls = dialog().querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)');
    await tab();
    expect(document.activeElement).toBe(controls[0]);
    dialog().focus();
    await tab(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    await tab();
    expect(document.activeElement).toBe(controls[0]);
    await tab(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    await act(async () => { dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(close).toHaveBeenCalledOnce();
  });
  it('renders provider monograms and unknown icons safely', async () => {
    await render(<><CatalogIcon kind="gitlab" /><CatalogIcon kind="not-real" /><CatalogIcon /></>);
    expect(host.querySelector('.catalog-provider-icon')?.textContent).toBe('GL');
    expect(host.querySelectorAll('svg path')[0].getAttribute('d')).toBe(host.querySelectorAll('svg path')[1].getAttribute('d'));
  });
});
