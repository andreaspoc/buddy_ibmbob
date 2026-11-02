// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../src/components/ChatView', () => ({
  ChatView: (props: any) => {
    const [result, setResult] = useState('');
    return <div><button onClick={() => void props.onUploadFile(new File(['content'], 'notes.txt', {type: 'text/plain'})).then((value: any) => setResult(value.path), (error: Error) => setResult(error.message))}>Attach fixture</button><output>{result}</output></div>;
  },
}));
vi.mock('../../src/components/AppDialog', () => ({ AppDialog: () => null, appConfirm: vi.fn().mockResolvedValue(true), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
import { App } from '../../src/App';

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  sessionStorage.clear(); localStorage.clear();
  sessionStorage.setItem('buddy-welcome-seen', 'true');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  vi.stubGlobal('WebSocket', class { static OPEN = 1; static CONNECTING = 0; readyState = 1; send() {} close() {} addEventListener() {} removeEventListener() {} });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: any = [];
    if (url === '/auth/status') body = {user: {username: 'alice', is_admin: false}};
    else if (url === '/api/apps') body = {apps: []};
    else if (url === '/api/plugins') body = {};
    else if (url === '/sessions' && init?.method === 'POST') body = {id: 'new-session'};
    else if (url === '/sessions/new-session/upload') body = {path: 'notes.txt'};
    else if (url.startsWith('/auth/microsoft/status')) body = {configured: false, connected: false};
    else if (url.startsWith('/api/')) body = {};
    return new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<App />); });
  await vi.waitFor(() => expect(host.textContent).toContain('Attach fixture'));
});

afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  sessionStorage.clear(); localStorage.clear();
});

test('creates a conversation before uploading the first attachment', async () => {
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Attach fixture')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toBe('notes.txt'));
  const requests = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
  const creation = requests.findIndex(([url, init]) => url === '/sessions' && init?.method === 'POST');
  const upload = requests.findIndex(([url]) => url === '/sessions/new-session/upload');
  expect(creation).toBeGreaterThanOrEqual(0);
  expect(upload).toBeGreaterThan(creation);
  const file = (requests[upload][1]?.body as FormData).get('file') as File;
  expect(file.name).toBe('notes.txt');
});

test('reports session creation failure and never uploads the attachment', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/sessions' && init?.method === 'POST') return new Response('{}', {status: 500});
    return fallback(input, init);
  });
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Attach fixture')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toBe('Failed to create session'));
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/upload'))).toBe(false);
});

test('surfaces upload rejection after creating a conversation', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/sessions/new-session/upload') return new Response(JSON.stringify({detail: 'File is too large'}), {status: 413});
    return fallback(input, init);
  });
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Attach fixture')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toBe('File is too large'));
  expect(fetchMock.mock.calls.some(([url]) => String(url) === '/sessions/new-session/upload')).toBe(true);
});
