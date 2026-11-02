// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/components/ResearchReport', () => ({ ResearchReport: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('../../src/lib/pluginCapabilities', () => ({ usePluginCapabilities: () => ({ office: false }) }));
vi.mock('../../src/components/AppDialog', () => ({ appConfirm: vi.fn(async () => true) }));
import { appConfirm } from '../../src/components/AppDialog';
import { ResearchManager } from '../../src/components/ResearchManager';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const report = (status: string, extra = {}) => ({ title: 'Report', status, job_id: 'job-1', can_resume: false, report: '', plan: null, evidence: [], review: null, files: [], activity: [], ...extra });
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });

async function open(detail: Record<string, unknown>, routes: Record<string, () => unknown> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Array<[string, string]> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([init?.method || 'GET', url]);
    if (routes[url]) return routes[url]();
    if (url === '/research/capabilities') return reply({ web_search: true, knowledge: true, office: false });
    if (url === '/research') return reply([{ session_id: 's1', title: 'Report', job_id: 'job-1', status: detail.status, updated_at: '2026-10-31' }]);
    return reply(detail);
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ResearchManager initialSessionId="s1" onClose={() => {}} onTask={() => {}} />));
  await act(async () => { await Promise.resolve(); });
  return calls;
}
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label);

test('a running report offers Stop and stops only after confirmation', async () => {
  const calls = await open(report('running'), { '/jobs/job-1/cancel': () => reply({ status: 'stopped' }) });
  expect(button('Resume research')).toBeUndefined();
  vi.mocked(appConfirm).mockResolvedValueOnce(false);
  await act(async () => button('Stop research')!.click());
  expect(calls.some(([method, url]) => method === 'POST' && url.endsWith('/cancel'))).toBe(false);
  await act(async () => button('Stop research')!.click());
  expect(calls).toContainEqual(['POST', '/jobs/job-1/cancel']);
});

test('a failed stop is reported to the user', async () => {
  await open(report('running'), { '/jobs/job-1/cancel': () => reply({ detail: 'nope' }, false) });
  await act(async () => button('Stop research')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Research could not be stopped');
});

test('an unfinished report offers Resume and posts to the resume route', async () => {
  const calls = await open(report('failed', { can_resume: true }), { '/research/s1/resume': () => reply({ job_id: 'job-2', session_id: 's1' }) });
  expect(button('Stop research')).toBeUndefined();
  await act(async () => button('Resume research')!.click());
  expect(calls).toContainEqual(['POST', '/research/s1/resume']);
});

test('a resume refusal is shown and a completed report offers neither action', async () => {
  await open(report('failed', { can_resume: true }), { '/research/s1/resume': () => reply({ detail: 'This research report is still running' }, false) });
  await act(async () => button('Resume research')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('This research report is still running');
  act(() => root.unmount()); host.remove();
  await open(report('completed', { report: 'Finished report' }));
  expect(button('Stop research')).toBeUndefined();
  expect(button('Resume research')).toBeUndefined();
  expect(host.textContent).toContain('Finished report');
});

test('the form says closing the tab is safe', async () => {
  await open(report('running'));
  await act(async () => button('New research')!.click());
  expect(host.textContent).toContain('You can close this tab');
});

type Handler = (url: string, init?: RequestInit) => unknown;
const summary = { session_id: 's1', title: 'Saved report', job_id: 'job-1', status: 'completed', updated_at: '2026-10-31' };

async function mountForm(capabilities: Record<string, boolean>, handler: Handler = () => undefined, props: Partial<React.ComponentProps<typeof ResearchManager>> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const handled = handler(url, init);
    if (handled) return handled;
    if (url === '/research/capabilities') return reply(capabilities);
    if (url === '/research' && init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return reply({ session_id: 's9' }); }
    if (url === '/research') return reply([summary]);
    return reply(report('running', { title: 'Opened report' }));
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ResearchManager onClose={() => {}} onTask={() => {}} {...props} />));
  await act(async () => { await Promise.resolve(); });
  return posts;
}

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const field = <T extends Element>(label: string, selector: string) => [...host.querySelectorAll('label')].find(item => item.textContent?.includes(label))!.querySelector<T>(selector)!;
const submit = () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const alertText = () => host.querySelector('[role="alert"]')?.textContent;

test('starting research sends every chosen setting and opens the new report', async () => {
  const requestPermission = vi.fn();
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const posts = await mountForm({ web_search: true, knowledge: true, office: true });
  const web = field<HTMLInputElement>('Public web', 'input');
  expect(web.checked).toBe(true);
  await act(async () => {
    change(field('What decision', 'textarea'), '  Compare two network designs  ');
    change(field('Report title', 'input'), '  Network choice  ');
    change(field('Report format', 'select'), 'analyst');
    change(field('Time budget', 'select'), '900');
    change(field('Investigation depth', 'select'), '3');
  });
  await act(async () => {
    field<HTMLInputElement>('Public web', 'input').click();
    field<HTMLInputElement>('Knowledge base', 'input').click();
    field<HTMLInputElement>('Office documents', 'input').click();
    field<HTMLInputElement>('Carbon charts', 'input').click();
    field<HTMLInputElement>('Website screenshots', 'input').click();
  });
  await submit();
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(posts).toEqual([{
    topic: 'Compare two network designs', title: 'Network choice', style: 'analyst', diagrams: false, screenshots: true,
    web_search: false, knowledge: true, office: true, max_rounds: 3, timeout_seconds: 900, ui_language: expect.any(String),
  }]);
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain('Opened report');
});

test('a blank title falls back to the first part of the topic, without asking again for notifications', async () => {
  const requestPermission = vi.fn();
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  const posts = await mountForm({ web_search: true });
  const topic = 'x'.repeat(150);
  await act(async () => change(field('What decision', 'textarea'), topic));
  await submit();
  expect(posts[0].title).toBe('x'.repeat(100));
  expect(requestPermission).not.toHaveBeenCalled();
});

test('a refused start stays on the form and shows the reason', async () => {
  await mountForm({ web_search: true }, (url, init) => (url === '/research' && init?.method === 'POST' ? reply({ detail: 'Daily limit reached' }, false) : undefined));
  await act(async () => change(field('What decision', 'textarea'), 'Compare two network designs'));
  await submit();
  expect(alertText()).toBe('Daily limit reached');
  expect(host.querySelector('form')).not.toBeNull();
  expect(button('Start research report')!.disabled).toBe(false);
});

test('research cannot start without an available source', async () => {
  await mountForm({ web_search: false, knowledge: false, office: false });
  expect(button('Start research report')!.disabled).toBe(true);
  expect(field<HTMLInputElement>('Public web', 'input').disabled).toBe(true);
  expect(host.textContent).toContain('Search provider unavailable');
});

test('a server error without a readable reason uses the fallback message', async () => {
  await mountForm({}, url => (url === '/research/capabilities' ? reply({ detail: { code: 1 } }, false) : undefined));
  expect(alertText()).toBe('Research could not be loaded');
});

test('the report list refreshes, selects a report and reports load failures', async () => {
  let failing = false;
  const onOpenConversation = vi.fn();
  await mountForm({ web_search: true }, url => (url === '/research' && failing ? reply({ detail: 'List offline' }, false) : undefined), { onOpenConversation });
  await act(async () => button('Your reports')!.click());
  expect(host.textContent).toContain('Select a report to see findings and sources.');
  await act(async () => host.querySelector<HTMLButtonElement>('.research-report-item')!.click());
  expect(host.textContent).toContain('Opened report');
  await act(async () => button('Open conversation')!.click());
  expect(onOpenConversation).toHaveBeenCalledWith('s1');
  failing = true;
  await act(async () => button('Refresh reports')!.click());
  expect(alertText()).toBe('List offline');
  await act(async () => button('Your reports')!.click());
  expect(alertText()).toBe('List offline');
});

test('an empty library invites a first report', async () => {
  await mountForm({ web_search: true }, url => (url === '/research' ? reply([]) : undefined));
  await act(async () => button('Your reports')!.click());
  expect(host.textContent).toContain('No reports yet.');
});

test('View task progress closes the dialog and opens the task', async () => {
  const onClose = vi.fn();
  const onTask = vi.fn();
  await mountForm({}, undefined, { onClose, onTask, initialSessionId: 's1' });
  await act(async () => button('View task progress')!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onTask).toHaveBeenCalledWith('job-1');
  await act(async () => button('Close')!.click());
  expect(onClose).toHaveBeenCalledTimes(2);
});

test('spending is shown per phase and missing figures are labelled', async () => {
  await open(report('completed', { report: 'Body', usage: { bobcoins: 1.5, tokens: 2000, phases: [{ phase: 'plan', cost: 0.25, tokens: 5 }, { phase: '', cost: null, tokens: null }] } }));
  const usage = host.querySelector('.research-usage')!;
  expect(usage.textContent).toContain('1.5 Bobcoins');
  expect(usage.textContent).toContain('context tokens');
  expect(usage.textContent).toContain('Total reported spending');
  expect(usage.textContent).toContain('plan: 0.25 Bobcoins');
  expect(usage.textContent).toContain('not reported');
});

test('spending not reported yet is labelled while the job runs', async () => {
  await open(report('running', { usage: { bobcoins: null, tokens: null, phases: [] } }));
  const usage = host.querySelector('.research-usage')!;
  expect(usage.textContent).toContain('Bobcoin usage not reported yet');
  expect(usage.textContent).not.toContain('context tokens');
  expect(usage.textContent).toContain('Reported spending so far');
  expect(usage.querySelector('details')).toBeNull();
});

test('only safe links are rendered for activity and evidence', async () => {
  const fileUrl = '/knowledge/12345678-1234-1234-1234-123456789abc/file';
  await open(report('completed', {
    report: 'Body', progress: 'Finished', review: { verdict: 'ok' }, plan: { step: 'one' },
    activity: [
      { phase: 'search', message: 'Looked', status: 'done', query: 'wifi 7', url: 'https://example.test/a', timestamp: '2026-10-31T10:00:00Z' },
      { phase: '', message: '', status: '', query: '', url: 'javascript:alert(1)', timestamp: '2026-10-31T10:00:01Z' },
    ],
    evidence: [
      { id: 'a', title: 'Named', url: 'http://example.test/b', text: 'Collected text' },
      { source: 'Source name', url: 'javascript:alert(1)', excerpt: 'Excerpt text' },
      { id: 'c', url: fileUrl },
      { id: 'd', url: 'not a url' },
    ],
  }));
  const hrefs = [...host.querySelectorAll('a')].map(link => link.getAttribute('href'));
  expect(hrefs).toEqual(expect.arrayContaining(['https://example.test/a', 'http://example.test/b', fileUrl, '/research/s1/export?format=markdown']));
  expect(hrefs.join()).not.toContain('javascript:');
  expect(host.textContent).toContain('search · Looked · done');
  expect(host.textContent).toContain('wifi 7');
  expect(host.textContent).toContain('Research activity');
  expect(host.textContent).toContain('"verdict": "ok"');
  expect(host.textContent).toContain('"step": "one"');
  expect(host.textContent).toContain('Saved verified evidence (4)');
  for (const text of ['Named', 'Source name', 'Source 3', 'Collected text', 'Excerpt text', 'No collected text available.']) expect(host.textContent).toContain(text);
});

test('activity shows only the latest twelve entries and running evidence is explained', async () => {
  const activity = Array.from({ length: 14 }, (_, index) => ({ phase: '', message: `Step ${index}`, status: '', query: '', url: '', timestamp: '2026-10-31T10:00:00Z' }));
  await open(report('running', { activity, evidence: undefined }));
  expect(host.querySelectorAll('.research-live-activity li')).toHaveLength(12);
  expect(host.textContent).not.toContain('Step 0');
  expect(host.textContent).toContain('Step 13');
  expect(host.textContent).toContain('Live research activity');
  expect(host.textContent).toContain('Saved verified evidence (0)');
  expect(host.textContent).toContain('Evidence files are saved when the task finishes');
  expect(host.textContent).toContain('The final report is not ready yet.');
});

test('a report that cannot be loaded shows the reason', async () => {
  await open(report('running'), { '/research/s1': () => reply({ detail: 'Report not found' }, false) });
  expect(alertText()).toBe('Report not found');
});

test('a running report is refreshed every three seconds until the dialog closes', async () => {
  vi.useFakeTimers();
  try {
    const calls = await open(report('running'));
    const reads = () => calls.filter(([, url]) => url === '/research/s1').length;
    const before = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(reads()).toBe(before + 1);
    act(() => root.unmount());
    await vi.advanceTimersByTimeAsync(9000);
    expect(reads()).toBe(before + 1);
  } finally { vi.useRealTimers(); }
});

test('answers arriving after the dialog closes are ignored', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const pending: Array<(value: unknown) => void> = [];
  const failed: Array<(error: Error) => void> = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise((resolve, reject) => { pending.push(resolve); failed.push(reject); void url; })));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ResearchManager initialSessionId="s1" onClose={() => {}} onTask={() => {}} />));
  act(() => root.unmount());
  await act(async () => {
    pending[0](reply({ web_search: true }));
    failed[1](new Error('late failure'));
    failed[2](new Error('late failure'));
  });
  expect(consoleError).not.toHaveBeenCalled();
  expect(host.textContent).toBe('');
});
