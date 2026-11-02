// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../src/components/Sidebar', () => ({ Sidebar: (p: any) => <aside>
  <button onClick={() => p.onSelectSession('s1')}>Select s1</button>
  <button onClick={() => p.onDeleteSession({id:'s1', title:'First'})}>Delete s1</button>
  <button onClick={() => p.onDeleteFile('notes/a.txt')}>Delete file</button>
  <output data-testid="selected">{p.selectedSessionId}</output>
</aside> }));
vi.mock('../../src/components/ChatView', () => ({ ChatView: (p: any) => {
  const [error, setError] = React.useState('');
  const approval = {job_id:'job 1', approval_id:'approval/1'};
  return <section>
  <button onClick={() => p.onDeleteMessage('m1')}>Delete message</button>
  <button onClick={() => void p.onApprovalDecision(approval, 'approve_task').catch((e: Error) => setError(e.message))}>Approve task</button>
  <button onClick={() => void p.onApprovalDecision(approval, 'reject').catch((e: Error) => setError(e.message))}>Reject action</button>
  <output data-testid="messages">{p.messages.map((m: any) => m.content).join('|')}</output>
  <output data-testid="approval">{p.messages.flatMap((m: any) => m.approvals || []).map((a: any) => `${a.status}:${a.scope}`).join('|')}</output>
  <output data-testid="approval-error">{error}</output>
</section>; } }));
vi.mock('../../src/components/AppDialog', () => ({ AppDialog: () => null, appConfirm: vi.fn(), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock('../../src/components/ConversationDocumentViewer', () => ({ ConversationDocumentViewer: (p: any) => <div data-testid="document-preview">{p.sessionId}:{p.path}<button onClick={p.onClose}>Close document</button></div> }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: (p: any) => {
  const [error, setError] = React.useState('');
  return <div data-testid="tasks-view"><span>{p.selectedId}</span><button onClick={p.onEnableNotifications}>Enable notifications</button><button onClick={() => p.onOpenConversation('missing')}>Open missing conversation</button><button onClick={() => void p.onStop('job /1').catch((e: Error) => setError(e.message))}>Stop task</button><output>{error}</output></div>;
} }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
import { App } from '../../src/App';
import { appAlert, appConfirm } from '../../src/components/AppDialog';

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let sessions: any[];
let history: any[];

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {'Content-Type':'application/json'} });
const click = async (label: string) => { await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click(); }); };

beforeEach(async () => {
  sessionStorage.clear(); localStorage.clear(); sessionStorage.setItem('buddy-welcome-seen', 'true');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({matches:false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  vi.stubGlobal('WebSocket', class { static OPEN = 1; static CONNECTING = 0; readyState = 1; send() {} close() {} addEventListener() {} removeEventListener() {} });
  vi.mocked(appConfirm).mockReset().mockResolvedValue(true); vi.mocked(appAlert).mockReset();
  sessions = [{id:'s1', title:'First', updated_at:1}, {id:'s2', title:'Second', updated_at:2}];
  history = [{type:'request', prompt:'Original request', user_message_id:'m1', assistant_message_id:'a1'}, {type:'delta', text:'Original answer'}, {type:'approval', job_id:'job 1', approval_id:'approval/1', status:'pending'}];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method || 'GET';
    if (url === '/auth/status') return response({user:{username:'alice',is_admin:false}});
    if (url === '/api/apps') return response({apps:[]});
    if (url === '/api/plugins') return response({});
    if (url.startsWith('/auth/microsoft/status')) return response({configured:false,connected:false});
    if (url === '/sessions' && method === 'GET') return response(sessions);
    if (url === '/sessions' && method === 'POST') return response({id:'new-session'});
    if (url === '/sessions/s1/history') return response(history);
    if (url === '/sessions/s2/history') return response([]);
    if (url === '/sessions/s1' && method === 'DELETE') { sessions = sessions.filter(s => s.id !== 's1'); return response({}); }
    if (url === '/sessions/s1/messages/m1' && method === 'DELETE') { history = []; return response({cleanup_pending:true}); }
    if (url === '/jobs/job%201/approvals/approval%2F1' && method === 'POST') return response({});
    if (url.startsWith('/sessions/s1/file?') && method === 'DELETE') return response({});
    return response(url.startsWith('/api/') ? {} : []);
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<App />); });
  await vi.waitFor(() => expect(host.textContent).toContain('Select s1'));
  await click('Select s1');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="messages"]')?.textContent).toContain('Original request'));
});

test('approval decision uses encoded identifiers and applies task scope to the message', async () => {
  await click('Approve task');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="approval"]')?.textContent).toBe('approved:task'));
  const request = fetchMock.mock.calls.find(([url]) => String(url) === '/jobs/job%201/approvals/approval%2F1');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({decision:'approve_task'});
});

test('rejected approval request leaves pending status visible and reports its error', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('/jobs/') ? response({detail:'Approval expired'}, 409) : fallback(input, init));
  await click('Reject action');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="approval-error"]')?.textContent).toBe('Approval expired'));
  expect(host.querySelector('[data-testid="approval"]')?.textContent).toBe('pending:undefined');
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });

test('message deletion requires confirmation and refreshes conversation on success', async () => {
  vi.mocked(appConfirm).mockResolvedValueOnce(false);
  await click('Delete message');
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/messages/m1') && init?.method === 'DELETE')).toBe(false);
  expect(host.querySelector('[data-testid="messages"]')?.textContent).toContain('Original request');
  await click('Delete message');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="messages"]')?.textContent).not.toContain('Original request'));
  expect(appAlert).toHaveBeenCalledWith(expect.stringContaining('cleanup is pending'));
});

test('failed message deletion preserves history and displays server error', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/messages/m1') ? response({detail:'Cannot delete right now'}, 503) : fallback(input, init));
  await click('Delete message');
  await vi.waitFor(() => expect(appAlert).toHaveBeenCalledWith('Cannot delete right now'));
  expect(host.querySelector('[data-testid="messages"]')?.textContent).toContain('Original request');
});

test('deleting the selected conversation opens the next available one', async () => {
  await click('Delete s1');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe('s2'));
  expect(appConfirm).toHaveBeenCalledWith(expect.stringContaining('uploaded files and generated presentations'));
  expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/sessions/s1' && init?.method === 'DELETE')).toBe(true);
});

test('file deletion cancellation preserves the file, while confirmed deletion refreshes history', async () => {
  vi.mocked(appConfirm).mockResolvedValueOnce(false);
  await click('Delete file');
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/file?') && init?.method === 'DELETE')).toBe(false);
  await click('Delete file');
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/sessions/s1/file?path=notes%2Fa.txt' && init?.method === 'DELETE')).toBe(true));
  expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/sessions/s1/history').length).toBeGreaterThanOrEqual(2);
});

test('deleting the last conversation creates a fresh one', async () => {
  sessions = [sessions[0]];
  await click('Delete s1');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe('new-session'));
  expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/sessions' && init?.method === 'POST')).toBe(true);
});

test('deletion errors leave the current conversation selected and report the failure', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/sessions/s1' && init?.method === 'DELETE') return response({detail:'Conversation could not be removed'}, 500);
    if (url.startsWith('/sessions/s1/file?') && init?.method === 'DELETE') return response({detail:'File is locked'}, 409);
    return fallback(input, init);
  });
  await click('Delete s1');
  await vi.waitFor(() => expect(appAlert).toHaveBeenCalledWith('Conversation could not be removed'));
  expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe('s1');
  await click('Delete file');
  await vi.waitFor(() => expect(appAlert).toHaveBeenCalledWith('File is locked'));
  expect(host.querySelector('[data-testid="messages"]')?.textContent).toContain('Original request');
});

test('document events are scoped to the selected conversation and remember the opened document', async () => {
  await act(async () => window.dispatchEvent(new CustomEvent('buddy-open-artifact', { detail: {sessionId:'other', path:'notes/other.pdf'} })));
  expect(host.querySelector('[data-testid="document-preview"]')).toBeNull();
  await act(async () => window.dispatchEvent(new CustomEvent('buddy-open-artifact', { detail: {sessionId:'s1', path:'notes/report.pdf'} })));
  expect(host.querySelector('[data-testid="document-preview"]')?.textContent).toContain('s1:notes/report.pdf');
  const recent = JSON.parse(localStorage.getItem('buddy-recent-documents:alice') || '[]');
  expect(recent[0]).toMatchObject({path:'notes/report.pdf', sessionId:'s1'});
  await click('Close document');
  expect(host.querySelector('[data-testid="document-preview"]')).toBeNull();
});

test('artifact metadata failure is reported without opening a preview', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/artifacts/source?') ? response({}, 503) : fallback(input, init));
  await act(async () => window.dispatchEvent(new CustomEvent('buddy-open-artifact', { detail: {sessionId:'s1', path:'diagram.svg'} })));
  await vi.waitFor(() => expect(appAlert).toHaveBeenCalledWith('Could not open this file. Refresh the workspace and retry.'));
  expect(host.querySelector('[data-testid="document-preview"]')).toBeNull();
});

test('task event opens requested task, handles missing conversations and unavailable notifications', async () => {
  await act(async () => window.dispatchEvent(new CustomEvent('buddy-open-task', { detail: 'task-42' })));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="tasks-view"]')?.textContent).toContain('task-42'));
  await click('Open missing conversation');
  await vi.waitFor(() => expect(appAlert).toHaveBeenCalledWith('This conversation is no longer available.'));
  await click('Enable notifications');
  expect(appAlert).toHaveBeenCalledWith(expect.stringContaining('Desktop notifications are unavailable'));
});

test('task cancellation sends encoded job id and exposes a server failure', async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/jobs/job%20%2F1/cancel' ? response({}, 503) : fallback(input, init));
  await act(async () => window.dispatchEvent(new CustomEvent('buddy-open-task', { detail: 'task-42' })));
  await click('Stop task');
  await vi.waitFor(() => expect(host.querySelector('[data-testid="tasks-view"] output')?.textContent).toBe('Could not stop task.'));
  expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/jobs/job%20%2F1/cancel' && init?.method === 'POST')).toBe(true);
});

test.each([
  ['granted', 'Desktop notifications enabled'],
  ['denied', 'Desktop notifications can be enabled in your browser settings'],
])('reports notification permission %s', async (permission, message) => {
  vi.stubGlobal('Notification', {requestPermission: vi.fn().mockResolvedValue(permission)});
  await act(async () => window.dispatchEvent(new CustomEvent('buddy-open-task', { detail: 'task-42' })));
  await click('Enable notifications');
  await vi.waitFor(() => expect(appAlert).toHaveBeenCalledWith(expect.stringContaining(message)));
});
