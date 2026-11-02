// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const props = vi.hoisted(() => ({ current: {} as Record<string, any> }));

function stubModule(name: string) {
  return {
    default: (received: any) => {
      props.current[name] = received;
      return null;
    },
  };
}

vi.mock('../../../decisions-buddy/src/components/SimulatorTab.jsx', () => stubModule('simulator'));
vi.mock('../../../decisions-buddy/src/components/DecisionTableTab.jsx', () => stubModule('table'));
vi.mock('../../../decisions-buddy/src/components/canvas/VisualGraphEditor.jsx', () => stubModule('editor'));
vi.mock('../../../decisions-buddy/src/components/ReplTab.jsx', () => stubModule('repl'));
vi.mock('../../../decisions-buddy/src/components/AuditLogsTab.jsx', () => stubModule('audit'));
vi.mock('../../../decisions-buddy/src/components/CP4DGovernanceTab.jsx', () => stubModule('governance'));
vi.mock('../../../decisions-buddy/src/components/VersionDiffModal.jsx', () => stubModule('diff'));
vi.mock('../../../decisions-buddy/src/components/BobFlowDesigner.jsx', () => stubModule('bob'));
vi.mock('../../../decisions-buddy/src/components/AdminGovernanceSettings.jsx', () => stubModule('admin'));

// @ts-expect-error plain JS JSX component outside web tsconfig
import App from '../../../decisions-buddy/src/App.jsx';

const GRAPH = { nodes: [{ id: 'i', type: 'inputNode' }], edges: [] };

function saved(overrides: Record<string, any> = {}) {
  return { id: 'd1', name: 'Saved decision', version: 3, owner: 'owner', status: 'draft', environment: 'development',
    graph: GRAPH, defaultInput: { age: 1 }, updatedAt: '2026-01-01T00:00:00Z', ...overrides };
}

type Handler = (url: string, init?: RequestInit) => any;

function json(body: any, status = 200) {
  return { ok: status < 400, status, statusText: 'x', json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }) };
}

describe('Decisions App workspace', () => {
  let host: HTMLDivElement;
  let root: Root;
  let sockets: any[];
  let me: any;
  let list: any[];
  let records: Record<string, any>;
  let extra: Handler | null;
  let calls: { url: string; init?: RequestInit }[];

  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === label || b.textContent?.includes(label)) as HTMLButtonElement;
  const click = (label: string) => act(async () => { button(label).click(); });
  const post = (fragment: string) => calls.filter(call => call.url.includes(fragment) && call.init?.method === 'POST');
  const mount = () => act(async () => { root.render(<App />); });
  const notification = () => document.querySelector('.cds--inline-notification')?.textContent ?? '';

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    props.current = {};
    sockets = [];
    calls = [];
    extra = null;
    me = { username: 'owner', isAdmin: false, canAuthor: true };
    list = [{ id: 'd1' }];
    records = { d1: saved() };
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    vi.stubGlobal('WebSocket', class {
      close = vi.fn();
      onopen: any; onmessage: any; onclose: any; onerror: any;
      constructor(public url: string) { sockets.push(this); }
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const override = extra?.(url, init);
      if (override) return override;
      if (url.endsWith('/me')) return json(me);
      if (url.endsWith('/models') && init?.method !== 'POST') return json(list);
      const match = url.match(/\/models\/([^/]+)$/);
      if (match) return json(records[match[1]]);
      return json({});
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.documentElement.removeAttribute('style');
  });

  describe('loading', () => {
    it('shows saved metadata and subtitle for the first model', async () => {
      await mount();
      expect(host.querySelector('h1')?.textContent).toBe('Saved decision');
      expect(host.textContent).toContain('Version 3');
      expect(props.current.simulator.backendConnected).toBe(true);
      expect(props.current.simulator.inputJson).toContain('"age": 1');
    });

    it('falls back to "Saved decision" subtitle without an update time', async () => {
      records.d1 = saved({ updatedAt: null });
      await mount();
      expect(host.textContent).toContain('Version 3 · Saved decision');
    });

    it('shows the empty state when nothing is saved', async () => {
      list = [];
      await mount();
      expect(host.textContent).toContain('No decision selected');
      expect(button('Export Model').disabled).toBe(true);
    });

    it('reports a failed service', async () => {
      extra = url => (url.endsWith('/me') ? json({ detail: 'service down' }, 503) : null);
      await mount();
      expect(notification()).toContain('Decision service request failed');
      expect(host.textContent).toContain('Service unavailable');
    });

    it('marks models owned by others read-only and hides save', async () => {
      records.d1 = saved({ owner: 'other' });
      await mount();
      expect(host.textContent).toContain('Read-only · owned by other');
      expect(button('Save decision')).toBeUndefined();
      expect(props.current.table.onSaveToDb).toBeUndefined();
      await act(async () => { props.current.table.onUpdateModel({ ...records.d1, name: 'Hacked' }); });
      expect(host.querySelector('h1')?.textContent).toBe('Saved decision');
    });
  });

  describe('live updates', () => {
    const socket = () => sockets[sockets.length - 1];

    it('connects, marks live, and refreshes when another session changes models', async () => {
      await mount();
      await act(async () => { socket().onopen(); });
      expect(host.textContent).toContain('Live Sync');
      expect(socket().url).toContain('/api/decisions/ws');
      records.d1 = saved({ version: 4, name: 'Remote edit' });
      await act(async () => { socket().onmessage({ data: JSON.stringify({ type: 'models_changed' }) }); });
      await flush();
      expect(host.textContent).toContain('Saved decisions changed in another session');
      expect(host.querySelector('h1')?.textContent).toBe('Remote edit');
    });

    it('ignores keepalive frames and unrelated messages', async () => {
      await mount();
      const before = calls.length;
      await act(async () => {
        socket().onmessage({ data: 'not json' });
        socket().onmessage({ data: JSON.stringify({ type: 'other' }) });
      });
      expect(calls.length).toBe(before);
    });

    it('reconnects after close and closes on error', async () => {
      vi.useFakeTimers();
      await mount();
      const first = socket();
      await act(async () => { first.onopen(); });
      await act(async () => { first.onerror(); });
      expect(first.close).toHaveBeenCalled();
      await act(async () => { first.onclose(); });
      expect(host.textContent).not.toContain('Live Sync');
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(sockets).toHaveLength(2);
    });

    it('retries when the socket constructor throws', async () => {
      vi.useFakeTimers();
      let attempts = 0;
      vi.stubGlobal('WebSocket', class { constructor() { attempts += 1; throw new Error('blocked'); } });
      await mount();
      expect(attempts).toBe(1);
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(attempts).toBe(2);
    });

    it('stays silent for socket events after unmount', async () => {
      await mount();
      const last = socket();
      await act(async () => { root.unmount(); });
      expect(last.close).toHaveBeenCalled();
      const before = calls.length;
      last.onopen();
      last.onmessage({ data: JSON.stringify({ type: 'models_changed' }) });
      last.onclose();
      last.onerror();
      expect(calls.length).toBe(before);
      root = createRoot(host);
    });
  });

  describe('embedding messages', () => {
    const style = () => document.documentElement.style;

    it.each([[0.25, ''], [3, ''], ['1.5', '']])('ignores out of range scale %s', async value => {
      await mount();
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: window, data: { type: 'SET_UI_SCALE', scale: value } }));
      });
      expect(style().getPropertyValue('--ui-scale')).toBe('');
    });

    it('ignores scale messages from other origins', async () => {
      await mount();
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.invalid', source: window, data: { type: 'SET_UI_SCALE', scale: 1.5 } }));
      });
      expect(style().getPropertyValue('--ui-scale')).toBe('');
    });

    it('applies a scale query parameter', async () => {
      window.history.pushState({}, '', '?scale=1.5');
      await mount();
      expect(style().getPropertyValue('--ui-scale')).toBe('1.5');
      window.history.pushState({}, '', '/');
    });

    it('forces scale 1 when embedded', async () => {
      vi.spyOn(window, 'top', 'get').mockReturnValue({} as any);
      await mount();
      expect(style().getPropertyValue('--ui-scale')).toBe('1');
      vi.restoreAllMocks();
    });

    describe('chrome theme from the parent frame', () => {
      let parent: any;

      beforeEach(() => {
        parent = { postMessage: vi.fn() };
        vi.spyOn(window, 'parent', 'get').mockReturnValue(parent);
        vi.stubGlobal('CSS', { supports: (_: string, value: string) => value !== 'not-a-color' });
      });

      afterEach(() => { vi.restoreAllMocks(); });

      const send = (data: any, origin = window.location.origin, source: any = parent) => act(async () => {
        const event = new MessageEvent('message', { origin, data });
        Object.defineProperty(event, 'source', { value: source });
        window.dispatchEvent(event);
      });

      it('announces readiness and applies only allowed valid colors', async () => {
        await mount();
        expect(parent.postMessage).toHaveBeenCalledWith({ type: 'BUDDY_CHROME_READY' }, window.location.origin);
        await send({ type: 'BUDDY_CHROME_THEME', colors: { '--toolbar-text': '#123456', '--evil': '#000000', '--toolbar-hover': 'not-a-color', '--sidebar-text': 5, '--sidebar-border': 'x'.repeat(200) } });
        expect(style().getPropertyValue('--toolbar-text')).toBe('#123456');
        expect(style().getPropertyValue('--evil')).toBe('');
        expect(style().getPropertyValue('--toolbar-hover')).toBe('');
        expect(style().getPropertyValue('--sidebar-text')).toBe('');
        expect(style().getPropertyValue('--sidebar-border')).toBe('');
      });

      it.each([
        ['other source', { type: 'BUDDY_CHROME_THEME', colors: { '--toolbar-text': '#111111' } }, window.location.origin, {}],
        ['other origin', { type: 'BUDDY_CHROME_THEME', colors: { '--toolbar-text': '#111111' } }, 'https://evil.invalid', null],
        ['other type', { type: 'OTHER', colors: { '--toolbar-text': '#111111' } }, window.location.origin, null],
        ['missing colors', { type: 'BUDDY_CHROME_THEME' }, window.location.origin, null],
        ['non object colors', { type: 'BUDDY_CHROME_THEME', colors: 'red' }, window.location.origin, null],
      ])('ignores %s', async (_label, data, origin, source) => {
        await mount();
        await send(data, origin as string, source ?? parent);
        expect(style().getPropertyValue('--toolbar-text')).toBe('');
      });
    });
  });

  describe('evaluation', () => {
    const evaluated = { result: { score: 1 }, performance: {}, trace: [] };

    function withEvaluation(result: any = evaluated) {
      extra = url => (url.endsWith('/evaluate') ? result : null);
    }

    it('sends saved identity for clean models', async () => {
      withEvaluation(json(evaluated));
      await mount();
      await act(async () => { await props.current.simulator.onEvaluate(); });
      const body = JSON.parse(post('/evaluate')[0].init!.body as string);
      expect(body).toEqual({ decisionId: 'd1', expectedVersion: 3, input: { age: 1 } });
      expect(props.current.simulator.evaluationResult).toEqual(evaluated);
    });

    it('sends the draft graph for dirty models', async () => {
      withEvaluation(json(evaluated));
      await mount();
      await act(async () => { props.current.table.onUpdateModel({ ...records.d1, name: 'Edited' }); });
      await act(async () => { await props.current.simulator.onEvaluate(); });
      expect(JSON.parse(post('/evaluate')[0].init!.body as string)).toEqual({ graph: GRAPH, input: { age: 1 } });
      expect(host.textContent).toContain('Unsaved draft');
    });

    it.each([['[1]'], ['null'], ['"text"']])('refuses non object input %s', async input => {
      await mount();
      await act(async () => { props.current.simulator.setInputJson(input); });
      await act(async () => { await props.current.simulator.onEvaluate(); });
      expect(notification()).toContain('Input must be a JSON object.');
      expect(post('/evaluate')).toHaveLength(0);
    });

    it('reports invalid JSON and failed requests', async () => {
      withEvaluation(json({ detail: 'engine refused' }, 422));
      await mount();
      await act(async () => { props.current.simulator.setInputJson('{bad'); });
      await act(async () => { await props.current.simulator.onEvaluate(); });
      expect(notification()).not.toBe('');
      await act(async () => { props.current.simulator.setInputJson('{}'); });
      await act(async () => { await props.current.simulator.onEvaluate(); });
      expect(notification()).toContain('engine refused');
    });

    it('refuses evaluation without the service', async () => {
      extra = url => (url.endsWith('/me') ? json({}, 500) : null);
      await mount();
      await act(async () => { await props.current.editor?.onEvaluate?.(saved()); });
      expect(notification()).toContain('Decision service');
    });

    it('drops results superseded by a newer edit', async () => {
      let release: any;
      extra = url => (url.endsWith('/evaluate') ? new Promise(resolve => { release = () => resolve(json(evaluated)); }) : null);
      await mount();
      let pending: any;
      await act(async () => { pending = props.current.simulator.onEvaluate(); });
      await act(async () => { props.current.table.onUpdateModel({ ...records.d1, name: 'Edited' }); });
      await act(async () => { release(); await pending; });
      expect(props.current.simulator.evaluationResult).toBeNull();
    });
  });

  describe('saving', () => {
    function saveResponse() {
      extra = (url, init) => {
        if (url.endsWith('/models') && init?.method === 'POST') return json({ decision: saved({ version: 4, name: 'Edited' }) });
        if (url.endsWith('/evaluate')) return json({ result: { ok: true } });
        return null;
      };
    }

    const dirty = () => act(async () => { props.current.table.onUpdateModel({ ...records.d1, name: 'Edited' }); });

    it('saves a dirty draft and confirms the version', async () => {
      saveResponse();
      await mount();
      await dirty();
      await click('Save decision');
      expect(JSON.parse(post('/models')[0].init!.body as string).expectedVersion).toBe(3);
      expect(host.textContent).toContain('Saved Edited, version 4.');
    });

    it('save and run evaluates the saved version', async () => {
      saveResponse();
      await mount();
      await dirty();
      await act(async () => { await props.current.editor.onSaveAndRun({ ...records.d1, _dirty: true, name: 'Edited' }); });
      expect(JSON.parse(post('/evaluate')[0].init!.body as string).expectedVersion).toBe(4);
      expect(host.textContent).toContain('Saved and ran Edited, version 4.');
    });

    it('save failure surfaces and does not evaluate', async () => {
      extra = (url, init) => (url.endsWith('/models') && init?.method === 'POST' ? json({ detail: 'conflict' }, 409) : null);
      await mount();
      await dirty();
      await act(async () => { await props.current.editor.onSaveAndRun({ ...records.d1, _dirty: true }); });
      expect(notification()).toContain('conflict');
      expect(post('/evaluate')).toHaveLength(0);
    });

    it('refresh waits for an in-flight save', async () => {
      let release: any;
      extra = (url, init) => (url.endsWith('/models') && init?.method === 'POST'
        ? new Promise(resolve => { release = () => resolve(json({ decision: saved({ version: 4 }) })); }) : null);
      await mount();
      await dirty();
      const before = calls.filter(call => call.url.endsWith('/me')).length;
      let saving: any;
      await act(async () => { saving = props.current.table.onSaveToDb({ ...records.d1, _dirty: true }); });
      expect(host.textContent).toContain('Saving…');
      let refreshing: any;
      await act(async () => { refreshing = props.current.governance.onGovernanceChanged(); });
      expect(calls.filter(call => call.url.endsWith('/me')).length).toBe(before);
      await act(async () => { release(); await saving; await refreshing; });
      expect(calls.filter(call => call.url.endsWith('/me')).length).toBe(before + 1);
    });

    it('warns before unload only with unsaved work', async () => {
      await mount();
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);
      await dirty();
      const pending = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(pending);
      expect(pending.defaultPrevented).toBe(true);
    });
  });

  describe('Bob designer', () => {
    it('applies a flow into the selected draft and opens the visual editor', async () => {
      await mount();
      await act(async () => { props.current.bob.onApplyFlow({ name: 'Bob flow', description: 'D', graph: GRAPH, defaultInput: { a: 1 } }); });
      expect(host.querySelector('h1')?.textContent).toBe('Bob flow');
      expect(props.current.simulator.inputJson).toContain('"a": 1');
      expect(props.current.editor.active).toBe(true);
      expect(host.textContent).toContain('Bob applied "Bob flow"');
    });

    it('creates a draft when nothing is selected and keeps defaults', async () => {
      list = [];
      await mount();
      await act(async () => { props.current.bob.onApplyFlow({ graph: GRAPH }); });
      expect(host.querySelector('h1')?.textContent).toBe('Untitled decision');
      expect(host.textContent).toContain('Bob applied "flow"');
    });

    it('opens from the toolbar and editor', async () => {
      await mount();
      expect(props.current.bob.isOpen).toBe(false);
      await click('Design with Bob');
      expect(props.current.bob.isOpen).toBe(true);
      await act(async () => { props.current.bob.onClose(); });
      expect(props.current.bob.isOpen).toBe(false);
      await act(async () => { props.current.editor.onOpenBobDesigner(); });
      expect(props.current.bob.isOpen).toBe(true);
    });
  });

  describe('governance promotion', () => {
    const promote = (label: string) => act(async () => {
      const control = document.querySelector('.decisions-header .cds--btn--tertiary') as HTMLButtonElement;
      expect(control.closest('.cds--tooltip, .cds--popover-container')?.textContent).toContain(label);
      control.click();
    });

    it.each([
      ['draft', 'Submit for review', 'in_review', 'development'],
      ['in_review', 'Approve version', 'approved', 'staging'],
      ['approved', 'Publish version', 'published', 'production'],
      ['published', 'Start revision', 'draft', 'development'],
    ])('moves %s through the next stage', async (status, label, target, environment) => {
      records.d1 = saved({ status });
      extra = (url, init) => (url.includes('/governance') && init?.method === 'POST' ? json({ decision: saved({ status: target }) }) : null);
      await mount();
      await promote(label);
      expect(host.textContent).toContain(`Requested stage: ${target}. Environment: ${environment}.`);
      await click('Confirm transition');
      const body = JSON.parse(post('/governance')[0].init!.body as string);
      expect(body).toEqual({ status: target, environment, expectedVersion: 3 });
      expect(host.textContent).toContain('The requested governance transition was recorded.');
    });

    it('refreshes models when the response has no record', async () => {
      extra = (url, init) => (url.includes('/governance') && init?.method === 'POST' ? json({ status: 'ok' }) : null);
      await mount();
      await promote('Submit for review');
      const before = calls.filter(call => call.url.endsWith('/me')).length;
      await click('Confirm transition');
      expect(calls.filter(call => call.url.endsWith('/me')).length).toBe(before + 1);
    });

    it('reports a refused transition', async () => {
      extra = (url, init) => (url.includes('/governance') && init?.method === 'POST' ? json({ detail: 'needs reviewer' }, 403) : null);
      await mount();
      await promote('Submit for review');
      await click('Confirm transition');
      expect(notification()).toContain('needs reviewer');
    });

    it('can be cancelled', async () => {
      await mount();
      await promote('Submit for review');
      expect(host.textContent).toContain('Requested stage: in_review');
      await click('Cancel');
      expect(host.textContent).not.toContain('Requested stage: in_review');
    });
  });

  describe('import, export and shell', () => {
    async function importFile(file: any) {
      const input = host.querySelector('.decisions-file-input') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
      await flush();
    }

    it('accepts a wrapped graph and strips the extension', async () => {
      await mount();
      await importFile(new File([JSON.stringify({ graph: GRAPH })], 'wrapped.json'));
      expect(host.querySelector('h1')?.textContent).toBe('wrapped');
    });

    it.each([
      ['oversized', { size: 2 * 1024 * 1024, name: 'a.json', text: async () => '{}' }, 'smaller than 1 MB'],
      ['no graph', new File(['{}'], 'a.json'), 'decision graph with nodes and edges'],
      ['invalid edges', new File([JSON.stringify({ nodes: [], edges: 'x' })], 'a.json'), 'decision graph with nodes and edges'],
    ])('refuses %s files', async (_label, file, message) => {
      await mount();
      await importFile(file);
      expect(notification()).toContain(message);
    });

    it('ignores an empty file selection', async () => {
      await mount();
      await importFile(null);
      expect(host.querySelector('h1')?.textContent).toBe('Saved decision');
      expect(notification()).toBe('');
    });

    it('toggles theme and sidebar and dismisses notifications', async () => {
      await mount();
      await act(async () => { (document.querySelector('[aria-label="Use dark theme"]') as HTMLElement).click(); });
      expect(document.querySelector('[aria-label="Use light theme"]')).not.toBeNull();
      expect(host.querySelector('.carbon-doc-shell')?.children).toHaveLength(2);
      await act(async () => { (document.querySelector('[aria-label="Collapse navigation"]') as HTMLElement).click(); });
      expect(host.querySelector('.carbon-doc-shell')?.children).toHaveLength(1);
      await importFile(new File(['{}'], 'a.json'));
      await act(async () => { (document.querySelector('.cds--inline-notification__close-button') as HTMLElement).click(); });
      expect(notification()).toBe('');
    });

    it('switches between models from the sidebar and closes it on narrow screens', async () => {
      list = [{ id: 'd1' }, { id: 'd2' }];
      records.d2 = saved({ id: 'd2', name: 'Second decision' });
      window.innerWidth = 600;
      await mount();
      expect(host.querySelector('.carbon-doc-shell')?.children).toHaveLength(1);
      await act(async () => { (document.querySelector('[aria-label="Expand navigation"]') as HTMLElement).click(); });
      const item = Array.from(host.querySelectorAll('.sidebar-nav-item')).find(el => el.textContent?.includes('Second decision')) as HTMLElement;
      await act(async () => { item.click(); });
      expect(host.querySelector('h1')?.textContent).toBe('Second decision');
      expect(host.querySelector('.carbon-doc-shell')?.children).toHaveLength(1);
      window.innerWidth = 1024;
    });

    it('edits the name inline and shows results from the editor', async () => {
      await mount();
      const input = host.querySelector('#decision-name') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(input, 'Renamed'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(host.querySelector('h1')?.textContent).toBe('Renamed');
      await act(async () => { props.current.editor.onShowResults(); });
      expect(props.current.editor.active).toBe(false);
    });

    it('opens and closes version history', async () => {
      await mount();
      expect(props.current.diff.isOpen).toBe(false);
      await act(async () => { button('Version history').click(); });
      expect(props.current.diff.isOpen).toBe(true);
      expect(props.current.diff.decisionId).toBe('d1');
      await act(async () => { props.current.diff.onClose(); });
      expect(props.current.diff.isOpen).toBe(false);
    });
  });
});
