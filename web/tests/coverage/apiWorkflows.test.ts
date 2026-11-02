import { afterEach, expect, test, vi } from 'vitest';
import * as api from '../../src/api';
const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
afterEach(() => vi.unstubAllGlobals());
test('hooks fall back to the alternate route and preserve server errors', async () => {
  const f = vi.fn().mockResolvedValueOnce(reply(404)).mockResolvedValueOnce(reply(200, { hooks: [{ id: 'one' }], templates: [] })); vi.stubGlobal('fetch', f);
  const result = await api.fetchHooks(); expect(result.hooks).toEqual([{ id: 'one' }]); expect(result.templates.length).toBeGreaterThan(0);
  expect(f.mock.calls.map(call => call[0])).toEqual(['/hooks', '/api/hooks']);
  f.mockReset().mockRejectedValueOnce(new TypeError('fetch unavailable')); expect((await api.fetchHooks()).templates.length).toBeGreaterThan(0);
  f.mockReset().mockResolvedValueOnce(reply(403, { detail: 'Denied' })); await expect(api.fetchHooks()).rejects.toThrow('Denied');
  f.mockReset().mockResolvedValueOnce(reply(404)).mockResolvedValueOnce(reply(200)); await api.toggleHook('a/b', true);
  expect(f.mock.calls[1][0]).toBe('/api/hooks/a%2Fb/toggle'); expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ enabled: true });
});
test('workspace file fallback retains scope and reports failure', async () => {
  const f = vi.fn().mockResolvedValueOnce(reply(404, {detail:'Missing'})).mockResolvedValueOnce(reply(200)); vi.stubGlobal('fetch', f);
  await api.saveSessionFile('s/1', 'folder/note.md', 'body'); expect(f.mock.calls.map(call => call[0])).toEqual(['/sessions/s%2F1/file', '/workspace/page?session_id=s%2F1']);
  expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ path:'folder/note.md', content:'body' });
  f.mockReset().mockResolvedValueOnce(reply(404, {detail:'Missing'})).mockResolvedValueOnce(reply(500)); await expect(api.saveSessionFile('', 'x', 'body')).rejects.toThrow('Missing');
  f.mockReset().mockResolvedValueOnce(reply(403, {detail:'Not yours'})); await expect(api.deleteSessionFile('s/1', 'a b')).rejects.toThrow('Not yours'); expect(f.mock.calls[0][0]).toBe('/sessions/s%2F1/file?path=a%20b');
});
test('latest deck returns only a successfully retrieved deck', async () => {
  const f = vi.fn().mockResolvedValueOnce(reply(200, [{path:'a/b.bobdeck'}])).mockResolvedValueOnce(reply(200, {slides:[1]})); vi.stubGlobal('fetch', f);
  expect(await api.fetchLatestDeck('s 1')).toEqual({slides:[1]}); expect(f.mock.calls[1][0]).toBe('/presentation/deck?path=a%2Fb.bobdeck&session_id=s%201');
  f.mockReset().mockResolvedValueOnce(reply(200, [])); expect(await api.fetchLatestDeck('s')).toBeNull();
  f.mockReset().mockRejectedValueOnce(new Error('offline')); expect(await api.fetchDeckByPath('a', 's')).toBeNull();
});
test('skill and guidance failures show safe errors and encode identifiers', async () => {
  const f = vi.fn().mockResolvedValue(reply(403, {detail:'No access'})); vi.stubGlobal('fetch', f);
  await expect(api.fetchSkill('a/b')).rejects.toThrow('No access'); expect(f.mock.calls[0][0]).toBe('/skills/a%2Fb');
  await expect(api.sendChatGuidance('job/1', 'continue')).rejects.toThrow('No access'); expect(f.mock.calls[1][0]).toBe('/jobs/job%2F1/guidance');
  await expect(api.deleteSkill('a/b')).rejects.toThrow('No access');
});
test('folder upload excludes private and dependency directories', async () => {
  const f = vi.fn().mockResolvedValue(reply(200, { id: 'project' })); vi.stubGlobal('fetch', f);
  const file = (path: string, text: string) => ({ webkitRelativePath: path, size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as File;
  const result = await api.uploadProjectFolder('My Project', [file('repo/src/main.py', 'print(1)'), file('repo/.git/config', 'secret'), file('repo/node_modules/pkg/index.js', 'dependency')]);
  expect(result).toEqual({ id:'project' }); expect(f.mock.calls[0][0]).toBe('/projects/upload?name=My%20Project');
  const { unzipSync } = await import('fflate');
  const archive = new Uint8Array(await f.mock.calls[0][1].body.arrayBuffer());
  expect(Object.keys(unzipSync(archive))).toEqual(['repo/src/main.py']);
  await expect(api.uploadProjectFolder('empty', [file('repo/.home/key', 'secret')])).rejects.toThrow('Choose a folder');
  await expect(api.uploadProjectFolder('big', [{ webkitRelativePath:'repo/huge', size:201 * 1024 * 1024 } as File])).rejects.toThrow('200 MB');
});
test('hook mutations report backend failures and test results', async () => {
  const f = vi.fn().mockResolvedValue(reply(500, {detail:'Server refused'})); vi.stubGlobal('fetch', f);
  await expect(api.saveHook({name:'sample'})).rejects.toThrow('Server refused');
  await expect(api.deleteHook('x')).rejects.toThrow('Server refused');
  await expect(api.testHook({event:'Stop'})).rejects.toThrow('Server refused');
  f.mockResolvedValueOnce(reply(200, {exit_code:0, stdout:'ok', stderr:'', blocked:false, allowed:true}));
  expect((await api.testHook({event:'Stop'})).stdout).toBe('ok');
});
test('session upload preserves file and prevents errors from being swallowed', async () => {
  const f = vi.fn().mockResolvedValueOnce(reply(200, {filename:'note.txt', path:'note.txt'})).mockResolvedValueOnce(reply(413, {detail:'Too large'})); vi.stubGlobal('fetch', f);
  const file = new File(['hello'], 'note.txt', {type:'text/plain'});
  expect((await api.uploadSessionFile('s/1', file)).filename).toBe('note.txt');
  expect(f.mock.calls[0][0]).toBe('/sessions/s%2F1/upload');
  const data = f.mock.calls[0][1].body as FormData; expect((data.get('file') as File).name).toBe('note.txt');
  await expect(api.uploadSessionFile('', file)).rejects.toThrow('Too large'); expect(f.mock.calls[1][0]).toBe('/sessions/legacy/upload');
});
test('presentation and file discovery handle unavailable servers', async () => {
  const f = vi.fn().mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, {presentation:true})); vi.stubGlobal('fetch', f);
  expect(await api.fetchSessionFiles('s')).toEqual([]);
  await expect(api.presentationIntent('prepare slides')).rejects.toThrow('Could not load presentation setup');
  expect(await api.presentationIntent('prepare slides', 'agent')).toEqual({presentation:true});
  expect(JSON.parse(f.mock.calls[2][1].body)).toMatchObject({prompt:'prepare slides', mode:'agent'});
});
