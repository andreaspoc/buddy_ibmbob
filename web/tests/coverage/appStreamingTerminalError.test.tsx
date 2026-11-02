// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/components/ChatView', () => ({ ChatView: (p: any) => <div><button onClick={() => p.onSendMessage('Hello')}>Send fixture</button><output>{JSON.stringify(p.messages)}</output></div> }));
vi.mock('../../src/components/AppDialog', () => ({ AppDialog: () => null, appConfirm: vi.fn().mockResolvedValue(true), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock('../../src/lib/chatSubmission', () => ({ submitChatRequest: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
import { App } from '../../src/App';
import { submitChatRequest } from '../../src/lib/chatSubmission';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test('reports a terminal stream error without inventing an answer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}}));
  vi.stubGlobal('WebSocket', class { static OPEN=1; static CONNECTING=0; readyState=1; send(){} close(){} addEventListener(){} removeEventListener(){} });
  const encoder = new TextEncoder();
  vi.mocked(submitChatRequest).mockResolvedValue(new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({type:'error', message:'Service unavailable'}) + '\n')); c.close(); }}), {status:200}));
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    let body: any = [];
    if (url === '/auth/status') body = {user:{username:'alice', is_admin:false}};
    else if (url === '/api/apps') body = {apps:[]};
    else if (url === '/api/plugins') body = {};
    else if (url === '/presentation/intent') body = {presentation:false, templates:[]};
    else if (url === '/sessions' && init?.method === 'POST') body = {id:'session-1'};
    else if (url.startsWith('/auth/microsoft/status')) body = {configured:false, connected:false};
    else if (url.startsWith('/api/')) body = {};
    return new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}});
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<App />); });
  await vi.waitFor(() => expect(host.textContent).toContain('Send fixture'));
  await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Send fixture')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toContain('Service unavailable'));
  expect(host.querySelector('output')?.textContent).toContain('Error: Service unavailable');
  expect(submitChatRequest).toHaveBeenCalledOnce();
});
