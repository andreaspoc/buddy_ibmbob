import { afterEach, describe, expect, test, vi } from 'vitest';
import * as api from '../../src/api';

type Reply = { ok?: boolean; status?: number; body?: unknown; badJson?: boolean };

function stubFetch(reply: Reply) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: reply.ok ?? true,
    status: reply.status ?? (reply.ok === false ? 500 : 200),
    json: async () => { if (reply.badJson) throw new SyntaxError('not json'); return reply.body; },
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('list endpoints degrade to an empty list when the server refuses', () => {
  const lists: [string, () => Promise<unknown>, string][] = [
    ['fetchProjects', () => api.fetchProjects(), '/projects'],
    ['fetchSessions', () => api.fetchSessions(), '/sessions'],
    ['fetchSkills', () => api.fetchSkills(), '/skills'],
    ['fetchModes', () => api.fetchModes(), '/modes'],
    ['fetchMcps', () => api.fetchMcps(), '/mcps'],
    ['fetchAgents', () => api.fetchAgents(), '/agents'],
    ['fetchPages', () => api.fetchPages(), '/workspace/pages'],
    ['fetchTemplates', () => api.fetchTemplates(), '/presentation/templates'],
  ];
  test.each(lists)('%s', async (_name, call, url) => {
    const ok = stubFetch({ body: [{ id: 1 }] });
    expect(await call()).toEqual([{ id: 1 }]);
    expect(ok).toHaveBeenCalledWith(url);
    stubFetch({ ok: false, status: 403 });
    expect(await call()).toEqual([]);
  });
});

describe('query parameters are encoded', () => {
  test('session and page scopes', async () => {
    const fetchMock = stubFetch({ body: [] });
    await api.fetchSessions('a b&c');
    await api.fetchPages('s/1');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/sessions?project_id=a%20b%26c');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/workspace/pages?session_id=s%2F1');
  });

  test('createSession posts to the project scope', async () => {
    const fetchMock = stubFetch({ body: { id: 'n1' } });
    expect(await api.createSession('p 1')).toEqual({ id: 'n1' });
    expect(fetchMock).toHaveBeenCalledWith('/sessions?project_id=p%201', { method: 'POST' });
  });
});

describe('failures surface the server detail or a safe fallback message', () => {
  const failing: [string, () => Promise<unknown>, string][] = [
    ['login', () => api.login('u', 'p'), 'Login failed'],
    ['createProjectGit', () => api.createProjectGit('n', 'https://x/r.git'), 'Failed to clone repository'],
    ['createEmptyProject', () => api.createEmptyProject('n'), 'Failed to create project'],
    ['uploadProjectZip', () => api.uploadProjectZip('n', new Blob(['z'])), 'Failed to upload and extract ZIP'],
    ['deleteSession', () => api.deleteSession('s'), 'Failed to delete conversation'],
    ['deleteSessionMessage', () => api.deleteSessionMessage('s', 'm'), 'Could not delete this message.'],
    ['deleteMcp', () => api.deleteMcp('m'), 'Failed to delete MCP server'],
    ['createAgent', () => api.createAgent({ slug: 's', card_url: 'u' }), 'Failed to create agent'],
    ['updateAgent', () => api.updateAgent('s', {}), 'Failed to update agent'],
    ['deleteAgent', () => api.deleteAgent('s'), 'Failed to delete agent'],
  ];

  test.each(failing)('%s uses the detail from the server', async (_name, call) => {
    stubFetch({ ok: false, status: 400, body: { detail: 'Specific reason' } });
    await expect(call()).rejects.toThrow('Specific reason');
  });

  test.each(failing)('%s falls back when the body is not JSON', async (_name, call, fallback) => {
    stubFetch({ ok: false, status: 502, badJson: true });
    await expect(call()).rejects.toThrow(fallback);
  });

  test('deleteSessionMessage ignores a non-string detail', async () => {
    stubFetch({ ok: false, status: 422, body: { detail: [{ loc: ['x'] }] } });
    await expect(api.deleteSessionMessage('s', 'm')).rejects.toThrow('Could not delete this message.');
  });
});

describe('request construction', () => {
  test('login sends JSON credentials and returns the user', async () => {
    const fetchMock = stubFetch({ body: { username: 'alice', is_admin: false } });
    expect(await api.login('alice', 'pw')).toEqual({ username: 'alice', is_admin: false });
    expect(fetchMock).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw' }),
    });
  });

  test('git project omits empty optional fields', async () => {
    const fetchMock = stubFetch({ body: { id: 'p' } });
    await api.createProjectGit('repo', 'https://x/r.git', '', '');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ name: 'repo', url: 'https://x/r.git' });
  });

  test('zip upload encodes the name and sends the raw archive', async () => {
    const fetchMock = stubFetch({ body: { id: 'p' } });
    const file = new Blob(['zip']);
    await api.uploadProjectZip('my project', file);
    expect(fetchMock).toHaveBeenCalledWith('/projects/upload?name=my%20project', {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
    });
  });

  test('identifiers in paths are encoded', async () => {
    const fetchMock = stubFetch({ body: [] });
    await api.fetchSessionHistory('a/b');
    await api.deleteMcp('x y');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/sessions/a%2Fb/history', '/mcps/x%20y']);
  });

  test('deleteAgent treats 204 as success even when the response is not ok', async () => {
    stubFetch({ ok: false, status: 204 });
    await expect(api.deleteAgent('gone')).resolves.toBeUndefined();
  });
});

describe('required reads throw instead of returning stale data', () => {
  test('tasks', async () => {
    stubFetch({ ok: false });
    await expect(api.fetchTasks()).rejects.toThrow('Could not load tasks.');
    await expect(api.fetchTask('t1')).rejects.toThrow('Could not load task results.');
    stubFetch({ ok: false, status: 404 });
    await expect(api.fetchTask('t1')).rejects.toThrow('Task is no longer available.');
  });

  test('auth status, history, session creation and logout', async () => {
    stubFetch({ ok: false });
    await expect(api.fetchAuthStatus()).rejects.toThrow('Failed to fetch auth status');
    await expect(api.fetchSessionHistory('s')).rejects.toThrow('Could not load conversation history.');
    await expect(api.createSession()).rejects.toThrow('Failed to create session');
    await expect(api.logout()).rejects.toThrow('Could not end the server session.');
  });

  test('successful task and auth reads pass abort signals and bodies through', async () => {
    const signal = new AbortController().signal;
    const fetchMock = stubFetch({ body: { id: 't1' } });
    expect(await api.fetchTask('t 1', signal)).toEqual({ id: 't1' });
    expect(fetchMock).toHaveBeenCalledWith('/tasks/t%201', { signal });
    expect(await api.fetchTasks(signal)).toEqual({ id: 't1' });
    expect(await api.fetchAuthStatus()).toEqual({ id: 't1' });
  });
});
