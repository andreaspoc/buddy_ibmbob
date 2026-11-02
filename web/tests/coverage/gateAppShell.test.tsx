// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ props: {} as Record<string, any> }));
const stub = vi.hoisted(() => (name: string) => (p: any) => { cap.props[name] = p; return <div data-panel={name}>{p.children}</div>; });
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock('../../src/components/AppDialog', () => ({ AppDialog: () => null, appConfirm: vi.fn(), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock('../../src/lib/chatSubmission', () => ({ submitChatRequest: vi.fn() }));
vi.mock('../../src/lib/artifactSocket', () => ({ watchArtifacts: vi.fn() }));
vi.mock('../../src/lib/gatewaySocket', () => ({ connectGatewaySocket: vi.fn() }));
vi.mock('../../src/lib/workspaceDevice', () => ({ useDesktopWorkspace: () => true }));
vi.mock('../../src/lib/officeIntegration', () => ({ useOfficeIntegrationAvailable: () => true }));
vi.mock('../../src/components/Sidebar', () => ({ Sidebar: stub('Sidebar') }));
vi.mock('../../src/components/ChatView', () => ({ ChatView: stub('ChatView') }));
vi.mock('../../src/components/WorkspaceHub', () => ({ WorkspaceHub: stub('WorkspaceHub') }));
vi.mock('../../src/components/Topbar', () => ({ formatTokens: (v: number) => `${v} tokens`, formatBobcoins: (v: number) => `${v} coins`, Topbar: (p: any) => { cap.props.Topbar = p; return <div data-panel="Topbar">{p.buddyAction}{p.navigation}</div>; } }));
vi.mock('../../src/components/WorkspaceTools', () => ({ WorkspaceTools: ({ children }: any) => <div>{children}</div> }));
vi.mock('../../src/components/LanguageSelector', () => ({ LanguageSelector: () => null }));
vi.mock('../../src/components/MemberChat', () => ({ MemberChatWidget: () => null }));
vi.mock('../../src/components/MissedCallPin', () => ({ MissedCallPin: () => null }));
vi.mock('../../src/components/StickyNotes', () => ({ NotesWorkspace: stub('NotesWorkspace') }));
vi.mock('../../src/components/KnowledgeDocuments', () => ({ KnowledgeDocuments: stub('KnowledgeDocuments') }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: stub('TasksView') }));
vi.mock('../../src/components/SkillsGuide', () => ({ SkillsGuide: stub('SkillsGuide') }));
vi.mock('../../src/components/SkillsManager', () => ({ SkillsManager: stub('SkillsManager') }));
vi.mock('../../src/components/SkillEditModal', () => ({ SkillEditModal: stub('SkillEditModal') }));
vi.mock('../../src/components/ProjectModal', () => ({ ProjectModal: stub('ProjectModal') }));
vi.mock('../../src/components/AgentEditModal', () => ({ AgentEditModal: stub('AgentEditModal') }));
vi.mock('../../src/components/TemplatePickerModal', () => ({ TemplatePickerModal: stub('TemplatePickerModal') }));
vi.mock('../../src/components/MCPManager', () => ({ MCPManager: stub('MCPManager') }));
vi.mock('../../src/components/MCPCatalog', () => ({ MCPServerCatalog: stub('MCPServerCatalog') }));
vi.mock('../../src/components/CreateItemModal', () => ({ CreateItemModal: stub('CreateItemModal') }));
vi.mock('../../src/components/WorkflowManager', () => ({ WorkflowManager: stub('WorkflowManager') }));
vi.mock('../../src/components/UnifiedSearch', () => ({ UnifiedSearch: stub('UnifiedSearch') }));
vi.mock('../../src/components/DocumentComparison', () => ({ DocumentComparison: stub('DocumentComparison') }));
vi.mock('../../src/components/MyAccessPanel', () => ({ MyAccessPanel: stub('MyAccessPanel') }));
vi.mock('../../src/components/AgentCatalog', () => ({ AgentCatalog: stub('AgentCatalog') }));
vi.mock('../../src/components/NotificationInbox', () => ({ NotificationInbox: stub('NotificationInbox') }));
vi.mock('../../src/components/ProductivityWorkspace', () => ({ ProductivityWorkspace: stub('ProductivityWorkspace') }));
vi.mock('../../src/components/ResearchManager', () => ({ ResearchManager: stub('ResearchManager') }));
vi.mock('../../src/components/ProjectsWorkspace', () => ({ ProjectsWorkspace: stub('ProjectsWorkspace') }));
vi.mock('../../src/components/DecisionsWorkspace', () => ({ DecisionsWorkspace: stub('DecisionsWorkspace') }));
vi.mock('../../src/components/DocmostPanel', () => ({ DocmostPanel: stub('DocmostPanel') }));
vi.mock('../../src/components/InstalledApps', () => ({ InstalledApps: stub('InstalledApps') }));
vi.mock('../../src/components/ConversationDocumentViewer', () => ({ ConversationDocumentViewer: stub('ConversationDocumentViewer') }));
vi.mock('../../src/components/ConversationSharing', () => ({ ConversationSharing: stub('ConversationSharing') }));
vi.mock('../../src/components/ProjectMemoryPanel', () => ({ ProjectMemoryPanel: stub('ProjectMemoryPanel') }));
vi.mock('../../src/components/ArtifactWorkspacePanel', () => ({ ArtifactWorkspacePanel: stub('ArtifactWorkspacePanel') }));
vi.mock('../../src/components/ArtifactEditor', () => ({ ArtifactEditor: stub('ArtifactEditor') }));
vi.mock('../../src/mods', async importOriginal => ({ ...(await importOriginal() as object), ModRegistryModal: (p: any) => { cap.props.ModRegistryModal = p; return p.isOpen ? <div data-panel="ModRegistryModal" data-tab={p.initialTab} /> : null; } }));
vi.mock('../../src/mods/PresentationPreviewPanel', () => ({ PresentationPreviewPanel: stub('PresentationPreviewPanel') }));
vi.mock('../../src/components/PersonalizationManager', async importOriginal => ({ ...(await importOriginal() as object), PersonalizationManager: stub('PersonalizationManager') }));
import { App } from '../../src/App';
import { appAlert, appConfirm } from '../../src/components/AppDialog';
import { submitChatRequest } from '../../src/lib/chatSubmission';

const app = (id: string, kind: string, extra: Record<string, unknown> = {}, launch: Record<string, unknown> = {}) => ({ id, name: id, kind: 'installed', launch: { kind, ...launch }, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let host: HTMLDivElement; let root: Root; let apps: any[]; let requests: Array<{ url: string; method: string; body: any }>; let overrides: Record<string, () => Response | Promise<Response>>; let user: any;
const P = (name: string) => cap.props[name];
const panel = (name: string) => host.querySelector(`[data-panel="${name}"]`);
const byText = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); });
const run = async (fn: () => unknown) => { let result: unknown; await act(async () => { result = await fn(); }); await settle(); return result; };
const called = (url: string, method = 'GET') => requests.some(r => r.url === url && r.method === method);
const mount = async () => { await act(async () => { root.render(<App />); }); await settle(); await settle(); await vi.waitFor(() => expect(P('Sidebar')?.user ?? null).toEqual(user)); };
const action = (id: string) => P('WorkspaceHub').actions.find((a: any) => a.id === id);
const send = (prompt: string, ...rest: unknown[]) => run(() => P('ChatView').onSendMessage(prompt, ...rest));
const hanging = () => new Response(new ReadableStream({ start() { /* The response stays open until cancelled. */ } }), { status: 200, headers: { 'X-Bob-Job-Id': 'job1' } });

beforeEach(() => {
  cap.props = {};
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('WebSocket', class { static OPEN = 1; static CONNECTING = 0; readyState = 1; send() {} close() {} addEventListener() {} removeEventListener() {} });
  sessionStorage.clear(); localStorage.clear(); sessionStorage.setItem('buddy-welcome-seen', 'true');
  window.history.replaceState({}, '', '/');
  vi.mocked(appConfirm).mockReset().mockResolvedValue(true); vi.mocked(appAlert).mockReset(); vi.mocked(submitChatRequest).mockReset();
  apps = []; requests = []; overrides = {}; user = { username: 'alice', is_admin: true };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method || 'GET';
    requests.push({ url, method, body: init?.body });
    for (const [key, make] of Object.entries(overrides)) if (`${method} ${url}`.startsWith(key)) return make();
    if (url === '/auth/status') return json({ user });
    if (url === '/api/apps') return json({ apps });
    if (url === '/api/plugins') return json({});
    if (url.startsWith('/auth/microsoft/status')) return json({ configured: true, connected: false });
    if (url === '/sessions' || url.startsWith('/sessions?')) return json(method === 'POST' ? { id: 'new-s' } : [{ id: 's1', title: 'One', updated_at: 2 }, { id: 's2', title: 'Two', updated_at: 1 }]);
    if (url === '/projects' && method === 'POST') return json({ id: 'p-new', name: 'Projects' });
    if (url === '/projects') return json([{ id: 'p1', name: 'Alpha' }]);
    if (url === '/skills') return json([{ name: 'alpha-skill', description: 'd' }, { name: 'presentation-buddy', description: 'd' }, { name: 'research-buddy', description: 'd' }]);
    if (url === '/modes') return json([{ slug: 'agent', name: 'Agent' }, { slug: 'presentation', name: 'Presentation' }]);
    if (url === '/agents') return json([{ slug: 'ag1', name: 'Agent One' }]);
    if (url === '/mcps') return json([]);
    if (url === '/presentation/templates') return json([{ id: 't1', title: 'T1' }]);
    if (url === '/presentation/intent') return json({ presentation: false, templates: [] });
    if (url.endsWith('/history')) return json([]);
    if (url.includes('/personal/') || url.includes('personal')) return json(url.includes('tutorials') ? { disabled: false } : []);
    return json(url.startsWith('/api/') ? {} : []);
  }));
  host = document.createElement('div'); host.id = 'root'; document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); sessionStorage.clear(); localStorage.clear(); delete (window as any).opener; delete document.documentElement.dataset.uiScale; });

describe('settings and buddy menus', () => {
  it.each([
    ['My access', 'MyAccessPanel'],
    ['Add connections', 'MCPServerCatalog'],
    ['Compare documents', 'DocumentComparison'],
    ['Memory & presets', 'PersonalizationManager'],
  ])('%s opens and closes %s', async (label, name) => {
    await mount();
    await run(() => byText(label).click());
    expect(panel(name)).not.toBeNull();
    await run(() => P(name).onClose());
    expect(panel(name)).toBeNull();
  });
  it('opens connected services manager and refreshes it', async () => {
    await mount();
    requests.length = 0;
    await run(() => byText('Connected services').click());
    expect(panel('MCPManager')).not.toBeNull();
    await run(() => P('MCPManager').onRefresh());
    expect(called('/mcps')).toBe(true);
    await run(() => P('MCPManager').onDelete('srv'));
    expect(called('/mcps/srv', 'DELETE')).toBe(true);
    await run(() => P('MCPManager').onAdd());
    expect(panel('MCPManager')).toBeNull();
    expect(P('CreateItemModal').kind).toBe('mcp');
    await run(() => P('CreateItemModal').onClose());
    expect(panel('MCPManager')).not.toBeNull();
    await run(() => P('MCPManager').onClose());
    expect(panel('MCPManager')).toBeNull();
  });
  it('applies display scale and density settings', async () => {
    await mount();
    const set = (label: string, value: string) => act(async () => { const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); });
    const scale = host.querySelector<HTMLSelectElement>('select[aria-label="Display scale"]')!;
    const option = [...scale.options].find(o => o.value !== 'auto')!.value;
    await set('Display scale', option);
    expect(document.documentElement.dataset.uiScale).toBe(option);
    expect(document.documentElement.style.getPropertyValue('--preferred-ui-scale')).toBe(String(Number(option) / 100));
    await set('Display scale', 'auto');
    expect(document.documentElement.style.getPropertyValue('--preferred-ui-scale')).toBe('');
    await set('Display density', 'comfortable');
    expect(localStorage.getItem('buddy-display-density')).toBe('comfortable');
  });
});

describe('workspace actions', () => {
  it.each([
    ['workflows', 'WorkflowManager'],
    ['search', 'UnifiedSearch'],
    ['research', 'ResearchManager'],
    ['connections', 'MCPManager'],
    ['productivity', 'ProductivityWorkspace'],
  ])('action %s opens %s', async (id, name) => {
    await mount();
    await run(() => action(id).run());
    expect(panel(name)).not.toBeNull();
  });
  it('switches views with navigation actions', async () => {
    await mount();
    for (const [id, view] of [['tasks', 'tasks'], ['notes', 'notes'], ['knowledge', 'knowledge']]) {
      await run(() => action(id).run());
      expect(P('Sidebar').activeView).toBe(view);
    }
  });
  it('opens the apps launcher', async () => {
    await mount();
    await run(() => action('apps').run());
    expect(panel('InstalledApps')).not.toBeNull();
  });
  it('switches to a project from its action', async () => {
    await mount();
    await run(() => action('project:p1').run());
    expect(called('/sessions?project_id=p1') || requests.some(r => r.url.includes('p1'))).toBe(true);
    expect(P('Sidebar').selectedProjectId).toBe('p1');
  });
  it('remembers recent documents and reopens them in another conversation', async () => {
    localStorage.setItem('buddy-recent-documents:alice', JSON.stringify([{ path: 'dir/a.pdf', sessionId: 'other', projectId: 'p1', openedAt: 1 }, { path: 5 }]));
    await mount();
    const doc = P('WorkspaceHub').recent.find((r: any) => r.id.startsWith('document:'));
    expect(doc.label).toBe('a.pdf');
    expect(P('WorkspaceHub').recent.filter((r: any) => r.id.startsWith('document:'))).toHaveLength(1);
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: original.href, pathname: '/', search: '', assign } });
    doc.run();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    expect(assign.mock.calls[0][0]).toContain('conversation=other');
    expect(assign.mock.calls[0][0]).toContain('project=p1');
  });
  it('ignores corrupted stored documents', async () => {
    localStorage.setItem('buddy-recent-documents:alice', '{bad');
    await mount();
    expect(P('WorkspaceHub').recent.some((r: any) => r.id.startsWith('document:'))).toBe(false);
  });
});

describe('installed apps', () => {
  const launch = async (kind: string, launchExtra: Record<string, unknown> = {}) => {
    apps = [app('thing', kind, {}, launchExtra)];
    await mount();
    await run(() => action('thing').run());
  };
  it.each([
    ['research', 'ResearchManager'], ['search', 'UnifiedSearch'], ['workflows', 'WorkflowManager'],
    ['productivity', 'ProductivityWorkspace'], ['connections', 'MCPManager'], ['projects', 'ProjectsWorkspace'],
  ])('launches %s', async (kind, name) => {
    await launch(kind);
    expect(panel(name)).not.toBeNull();
  });
  it.each([['notes', 'notes'], ['tasks', 'tasks'], ['knowledge', 'knowledge'], ['chat', 'chat']])('navigates %s', async (kind, view) => {
    await launch(kind);
    expect(P('Sidebar').activeView).toBe(view);
  });
  it('opens community for people', async () => {
    const seen = vi.fn(); window.addEventListener('community-open', seen, { once: true });
    await launch('people');
    expect(seen).toHaveBeenCalled();
  });
  it('opens links in a new window, or in place for self targets', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await launch('link', { url: 'https://app.example.test' });
    expect(open).toHaveBeenCalledWith('https://app.example.test', '_blank', 'noopener,noreferrer');
  });
  it('opens presentation setup modal', async () => {
    await launch('presentations');
    expect(P('TemplatePickerModal').isOpen).toBe(true);
  });
  it('opens decisions and returns', async () => {
    apps = [app('decisions', 'decisions')];
    await mount();
    await run(() => action('decisions').run());
    expect(panel('DecisionsWorkspace')).not.toBeNull();
    expect(sessionStorage.getItem('buddy-welcome-v1:alice')).toBe('seen');
    expect(panel('Topbar')).toBeNull();
    await run(() => P('DecisionsWorkspace').onBack());
    expect(panel('DecisionsWorkspace')).toBeNull();
    expect(panel('Topbar')).not.toBeNull();
  });
  it('opens docmost from the registry', async () => {
    apps = [app('docmost', 'docmost', {}, { url: 'https://docs.example.test', embed: true })];
    await mount();
    await run(() => action('docmost').run());
    expect(P('DocmostPanel').config).toMatchObject({ enabled: true, url: 'https://docs.example.test' });
    await run(() => P('DocmostPanel').onClose());
    expect(panel('DocmostPanel')).toBeNull();
  });
});

describe('tutorials', () => {
  it('shows the skills guide once when not seen', async () => {
    sessionStorage.clear();
    overrides['GET /api/tutorials'] = () => json({ disabled: false });
    await mount();
    expect(panel('SkillsGuide')).not.toBeNull();
    await run(() => P('SkillsGuide').onSkill('alpha-skill'));
    expect(P('ChatView').guidedSkill).toMatchObject({ name: 'alpha-skill' });
    await run(() => P('SkillsGuide').onMode('agent'));
    await run(() => P('SkillsGuide').onClose());
    expect(panel('SkillsGuide')).toBeNull();
    expect(sessionStorage.getItem('buddy-welcome-v1:alice')).toBe('seen');
  });
  it('saves tutorial preference and shows failures', async () => {
    sessionStorage.clear();
    await mount();
    await vi.waitFor(() => expect(panel('SkillsGuide')).not.toBeNull());
    const saved = await run(() => P('SkillsGuide').onDisable(true));
    expect(saved).toBe(true);
    expect(P('SkillsGuide').disabled).toBe(true);
    overrides['PUT'] = () => json({ detail: 'Nope' }, 500);
    const failed = await run(() => P('SkillsGuide').onDisable(false));
    expect(failed).toBe(false);
    expect(P('SkillsGuide').error).toBeTruthy();
  });
});

describe('microsoft account', () => {
  it('refreshes on storage, focus and same-origin message, disconnects', async () => {
    await mount();
    const statusCalls = () => requests.filter(r => r.url.startsWith('/auth/microsoft/status')).length;
    const start = statusCalls();
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'microsoft_connected' })); });
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'other' })); });
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: 'microsoft-connected' } })); });
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example.test', data: { type: 'microsoft-connected' } })); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(statusCalls() - start).toBe(3);
    await run(() => P('Sidebar').onDisconnectMicrosoft());
    expect(called('/auth/microsoft/disconnect', 'POST')).toBe(true);
  });
  it('logs disconnect failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    overrides['POST /auth/microsoft/disconnect'] = () => { throw new Error('offline'); };
    await run(() => P('Sidebar').onDisconnectMicrosoft());
    expect(log).toHaveBeenCalledWith('Failed to disconnect Microsoft account', expect.any(Error));
  });
  it('notifies the opener and strips the marker after connecting', async () => {
    window.history.replaceState({}, '', '/?microsoft=connected');
    const postMessage = vi.fn();
    (window as any).opener = { postMessage };
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    await mount();
    expect(postMessage).toHaveBeenCalledWith({ type: 'microsoft-connected' }, window.location.origin);
    expect(close).toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(localStorage.getItem('microsoft_connected')).toBeTruthy();
  });
  it('reports sign-in errors to the opener', async () => {
    window.history.replaceState({}, '', '/?microsoft_error=x');
    const postMessage = vi.fn();
    (window as any).opener = { postMessage };
    vi.spyOn(window, 'close').mockImplementation(() => {});
    await mount();
    expect(postMessage.mock.calls[0][0]).toMatchObject({ status: 'error', template_id: 'microsoft365' });
  });
});

describe('workspace files', () => {
  const openPage = async (file: any) => { await mount(); await run(() => P('Sidebar').onSelectSession('s1')); return run(() => P('Sidebar').onOpenPage(file)); };
  it('routes presentations to the studio', async () => {
    await openPage({ path: 'deck.html', name: 'deck.html', size: 1, is_presentation: true });
    expect(panel('PresentationPreviewPanel')).not.toBeNull();
    expect(P('PresentationPreviewPanel').presentationPath).toBe('deck.html');
  });
  it.each([
    [{ path: 'research-report.md', name: 'r', size: 1 }],
    [{ path: 'x.txt', name: 'x', size: 1, kind: 'research' }],
    [{ path: 'research-1.html', name: 'x', size: 1 }],
  ])('routes research file %j', async file => {
    await openPage(file);
    expect(panel('ResearchManager')).not.toBeNull();
  });
  it('opens documents in the viewer and remembers them', async () => {
    await openPage({ path: 'a.pdf', name: 'a', size: 1 });
    expect(P('ConversationDocumentViewer').path).toBe('a.pdf');
    await run(() => P('ConversationDocumentViewer').onClose?.());
    expect(panel('ConversationDocumentViewer')).toBeNull();
  });
  it('resolves unknown artifacts through the server', async () => {
    overrides['GET /sessions/s1/artifacts/source'] = () => json({ is_presentation: false });
    await openPage({ path: 'page.html', name: 'p', size: 1 });
    expect(P('ArtifactEditor').initialPath).toBe('page.html');
  });
  it('alerts on artifact load failures', async () => {
    overrides['GET /sessions/s1/artifacts/source'] = () => json({}, 500);
    const result = await openPage({ path: 'page.html', name: 'p', size: 1 });
    expect(result).toBeNull();
    expect(appAlert).toHaveBeenCalledWith('Could not open this file. Refresh the workspace and retry.');
  });
  it('confirms discarding dirty studio edits', async () => {
    await openPage({ path: 'deck.html', name: 'd', size: 1, is_presentation: true });
    await run(() => P('PresentationPreviewPanel').onDirtyChange(true));
    vi.mocked(appConfirm).mockResolvedValueOnce(false);
    const refused = await run(() => P('Sidebar').onOpenPage({ path: 'other.html', name: 'o', size: 1, is_presentation: false }));
    expect(refused).toBeNull();
    const accepted = await run(() => P('Sidebar').onOpenPage({ path: 'other.html', name: 'o', size: 1, is_presentation: false }));
    expect(accepted).toMatchObject({ path: 'other.html' });
    expect(P('ArtifactEditor').initialPath).toBe('other.html');
  });
  it('routes sidebar file opens by type', async () => {
    await mount();
    await run(() => P('Sidebar').onSelectSession('s1'));
    await run(() => P('Sidebar').onOpenFile('notes.txt'));
    expect(P('ConversationDocumentViewer').path).toBe('notes.txt');
  });
  it('toggles and guards studio from the buddy menu', async () => {
    await mount();
    await run(() => P('Sidebar').onSelectSession('s1'));
    await run(() => P('ChatView').onTogglePanel());
    expect(panel('PresentationPreviewPanel')).not.toBeNull();
    await run(() => P('PresentationPreviewPanel').onDirtyChange(true));
    vi.mocked(appConfirm).mockResolvedValueOnce(false);
    await run(() => P('ChatView').onTogglePanel());
    expect(panel('PresentationPreviewPanel')).not.toBeNull();
    await run(() => byText('Artifact editor').click());
    expect(panel('ArtifactEditor')).not.toBeNull();
  });
});

describe('projects', () => {
  it('deletes the selected project after confirmation and reports failures', async () => {
    await mount();
    await run(() => P('ChatView').onSelectProject('p1'));
    vi.mocked(appConfirm).mockResolvedValueOnce(false);
    await run(() => P('Sidebar').onDeleteProject());
    expect(called('/projects/p1', 'DELETE')).toBe(false);
    overrides['DELETE /projects/p1'] = () => json({ detail: 'Locked' }, 409);
    await run(() => P('Sidebar').onDeleteProject());
    expect(appAlert).toHaveBeenCalled();
    delete overrides['DELETE /projects/p1'];
    await run(() => P('Sidebar').onDeleteProject());
    await vi.waitFor(() => expect(P('Sidebar').selectedProjectId).toBe(''));
  });
  it('shows an empty scope when project conversations cannot load', async () => {
    await mount();
    overrides['GET /sessions'] = () => json({ detail: 'Down' }, 500);
    await run(() => P('ChatView').onSelectProject('p1'));
    expect(P('Sidebar').selectedProjectId).toBe('p1');
    expect(P('Sidebar').sessions).toEqual([]);
  });
  it('refuses to leave dirty studio unless confirmed', async () => {
    await mount();
    await run(() => P('Sidebar').onSelectSession('s1'));
    await run(() => P('ChatView').onTogglePanel());
    await run(() => P('PresentationPreviewPanel').onDirtyChange(true));
    vi.mocked(appConfirm).mockResolvedValueOnce(false);
    await run(() => P('ChatView').onSelectProject('p1'));
    expect(P('Sidebar').selectedProjectId).toBe('');
  });
  it('selects the new project after creation', async () => {
    await mount();
    await run(() => P('ProjectModal').onSuccess({ id: 'p1' }));
    expect(P('Sidebar').selectedProjectId).toBe('p1');
  });
});

describe('modal callbacks', () => {
  it('manages skills', async () => {
    await mount();
    await run(() => P('ChatView').onManageSkills());
    expect(P('SkillsManager').startCreate).toBe(false);
    await run(() => P('SkillsManager').onChanged());
    expect(localStorage.getItem('buddy-skills-changed')).toContain('alice');
    await run(() => P('SkillsManager').onClose());
    await run(() => P('ChatView').onAddSkill());
    expect(P('SkillsManager').startCreate).toBe(true);
  });
  it('edits and deletes skills from the sidebar', async () => {
    await mount();
    await run(() => P('Sidebar').onEditSkill('alpha-skill'));
    expect(P('SkillEditModal')).toMatchObject({ name: 'alpha-skill', startDelete: false });
    requests.length = 0;
    await run(() => P('SkillEditModal').onSaved());
    expect(called('/skills')).toBe(true);
    await run(() => P('SkillEditModal').onClose());
    await run(() => P('Sidebar').onDeleteSkill('alpha-skill'));
    expect(P('SkillEditModal').startDelete).toBe(true);
    await run(() => P('SkillEditModal').onDeleted('alpha-skill'));
    expect(P('ChatView').skills.map((s: any) => s.name)).toEqual(['presentation-buddy', 'research-buddy']);
  });
  it('edits and deletes agents', async () => {
    await mount();
    await run(() => P('Sidebar').onEditAgent({ slug: 'ag1' }));
    expect(P('AgentEditModal').isOpen).toBe(true);
    await run(() => P('AgentEditModal').onSave('ag1', { name: 'N' }));
    expect(requests.some(r => r.url === '/agents/ag1' && r.method !== 'GET')).toBe(true);
    await run(() => P('Sidebar').onSelectAgent('ag1'));
    expect(P('ChatView').activeAgent).toBe('ag1');
    await run(() => P('AgentEditModal').onDelete('ag1'));
    expect(called('/agents/ag1', 'DELETE')).toBe(true);
    expect(P('ChatView').activeAgent).toBe('');
    await run(() => P('AgentEditModal').onClose());
    expect(P('AgentEditModal').isOpen).toBe(false);
  });
  it('honours creation permissions', async () => {
    await mount();
    await run(() => P('Sidebar').onOpenCreate('skill'));
    expect(P('SkillsManager').startCreate).toBe(true);
    await run(() => P('SkillsManager').onClose());
    await run(() => P('Sidebar').onOpenCreate('mcp'));
    expect(P('CreateItemModal').kind).toBe('mcp');
    requests.length = 0;
    await run(() => P('CreateItemModal').onSuccess());
    expect(called('/skills') && called('/modes') && called('/mcps') && called('/agents')).toBe(true);
  });
  it('blocks mcp creation for non-admins', async () => {
    user = { username: 'alice', is_admin: false };
    await mount();
    await run(() => P('Sidebar').onOpenCreate('mcp'));
    expect(P('CreateItemModal').kind ?? null).toBeNull();
  });
  it('switches mode from the sidebar and opens side tools', async () => {
    await mount();
    await run(() => P('Sidebar').onSelectMode('agent'));
    expect(P('ChatView').activeMode).toBe('agent');
    await run(() => P('Sidebar').onOpenWorkflows());
    expect(panel('WorkflowManager')).not.toBeNull();
    await run(() => P('WorkflowManager').onClose());
    await run(() => P('Sidebar').onOpenKnowledge());
    expect(P('Sidebar').activeView).toBe('knowledge');
    await run(() => P('Sidebar').onOpenTasks());
    expect(P('Sidebar').activeView).toBe('tasks');
    await run(() => P('Sidebar').onOpenNotes());
    expect(P('Sidebar').activeView).toBe('notes');
  });
  it('changes chat context from composer', async () => {
    await mount();
    await run(() => P('ChatView').onChangeMode('presentation'));
    expect(P('ChatView').activeMode).toBe('presentation');
    await run(() => P('ChatView').onChangeAgent('ag1'));
    expect(P('ChatView').activeAgent).toBe('ag1');
    await run(() => P('ChatView').onManageTools());
    expect(panel('MCPManager')).not.toBeNull();
    await run(() => P('ChatView').onManageAgents());
    expect(panel('AgentCatalog')).not.toBeNull();
    await run(() => P('ChatView').onChangeAttachedAgents(['ag1']));
    expect(P('ChatView').attachedAgents).toEqual(['ag1']);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    act(() => P('ChatView').onChangeProject());
    vi.useRealTimers();
    expect(P('Sidebar').isOpen).toBe(true);
  });
  it('wires search results to conversation urls', async () => {
    await mount();
    await run(() => action('search').run());
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: original.href, assign } });
    P('UnifiedSearch').onOpen({});
    expect(assign).not.toHaveBeenCalled();
    P('UnifiedSearch').onOpen({ session_id: 's9', project_id: 'p9', path: 'f.txt' });
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    expect(assign.mock.calls[0][0]).toContain('conversation=s9');
    expect(assign.mock.calls[0][0]).toContain('project=p9');
    expect(assign.mock.calls[0][0]).toContain('file=f.txt');
  });
  it('asks compare results in chat', async () => {
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await mount();
    await run(() => byText('Compare documents').click());
    await run(() => P('DocumentComparison').onAsk('compare these'));
    expect(panel('DocumentComparison')).toBeNull();
    expect(submitChatRequest).toHaveBeenCalled();
  });
  it('blocks productivity launches for external agents', async () => {
    await mount();
    await run(() => P('ChatView').onChangeAgent('ag1'));
    await run(() => action('search').run());
    await run(() => P('UnifiedSearch').onClose());
    expect(panel('ProductivityWorkspace')).toBeNull();
    await run(() => action('productivity').run());
    expect(panel('ProductivityWorkspace')).toBeNull();
  });
  it('launches productivity tasks with a composed prompt', async () => {
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await mount();
    await run(() => action('productivity').run());
    await run(() => P('ProductivityWorkspace').onLaunch('Sales numbers', 'spreadsheet'));
    expect(P('ChatView').messages[0].content).toBe('Create an Excel spreadsheet. Sales numbers');
  });
});

describe('slash commands and presentation setup', () => {
  it('opens mods and hooks, toggles studio', async () => {
    await mount();
    await send('/preview');
    expect(panel('PresentationPreviewPanel')).not.toBeNull();
    await send('/mods');
    expect(panel('ModRegistryModal')).not.toBeNull();
    await send('/hooks now');
    expect(panel('ModRegistryModal')).not.toBeNull();
    expect(submitChatRequest).not.toHaveBeenCalled();
  });
  it('changes modes and agents by command without sending', async () => {
    await mount();
    await send('/mode agent');
    expect(P('ChatView').activeMode).toBe('agent');
    await send('/agent ag1');
    expect(P('ChatView').activeAgent).toBe('ag1');
    expect(submitChatRequest).not.toHaveBeenCalled();
  });
  it('expands a skill command and clears presentation mode for other skills', async () => {
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await mount();
    await send('/mode presentation');
    await send('/research-buddy do it');
    expect(P('ChatView').activeMode).toBe('agent');
    const body = vi.mocked(submitChatRequest).mock.calls[0][0] as any;
    expect(JSON.stringify(body)).toContain('research-buddy');
    expect(JSON.stringify(body)).toContain('do it');
  });
  it('rejects more than six skills', async () => {
    await mount();
    await send('Hello', undefined, undefined, undefined, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(appAlert).toHaveBeenCalledWith('Select up to 6 skills.');
  });
  it('alerts when presentation intent is unavailable', async () => {
    overrides['POST /presentation/intent'] = () => json({}, 500);
    await mount();
    await send('Hello');
    expect(appAlert).toHaveBeenCalledWith('Could not load presentation setup. Please retry.');
    expect(submitChatRequest).not.toHaveBeenCalled();
  });
  it('asks for presentation setup and sends after confirming', async () => {
    overrides['POST /presentation/intent'] = () => json({ presentation: true, templates: [{ id: 't1', title: 'T' }], format: 'pptx', slide_count: 12 });
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await mount();
    await send('Make slides');
    const modal = () => P('TemplatePickerModal');
    expect(modal().isOpen).toBe(true);
    expect(modal().prompt).toBe('Make slides');
    expect(modal().slideCount).toBe(12);
    await run(() => modal().onConfirm());
    expect(submitChatRequest).not.toHaveBeenCalled();
    await run(() => modal().onSelect('t1'));
    await run(() => modal().onPromptChange('Make better slides'));
    await run(() => modal().onFormatChange('html'));
    await run(() => modal().onTemplateSaved({ id: 't2', title: 'Two' }));
    expect(modal().templates.map((t: any) => t.id)).toEqual(['t1', 't2']);
    await run(() => modal().onConfirm());
    expect(modal().isOpen).toBe(false);
    expect(P('ChatView').messages[0].content).toBe('Make better slides');
  });
  it('closes setup and can ask Bob for a template', async () => {
    overrides['POST /presentation/intent'] = () => json({ presentation: true, templates: [], format: null });
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await mount();
    await send('Make slides');
    await run(() => P('TemplatePickerModal').onClose());
    expect(P('TemplatePickerModal').isOpen).toBe(false);
    await run(() => P('TemplatePickerModal').onFormatChange('pptx'));
    expect(P('TemplatePickerModal').format).toBe('pptx');
    await run(() => P('TemplatePickerModal').onAskBob('A brief'));
    expect(submitChatRequest).toHaveBeenCalled();
  });
  it('routes html artifact intent to agent mode', async () => {
    overrides['POST /presentation/intent'] = () => json({ presentation: false, html_artifact: true, html_artifact_path: 'x.html', templates: [] });
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await mount();
    await send('Build a page');
    expect(P('ChatView').activeMode).toBe('agent');
    expect(JSON.stringify(vi.mocked(submitChatRequest).mock.calls[0][0])).toContain('x.html');
  });
  it('opens setup when the server requires presentation setup', async () => {
    vi.mocked(submitChatRequest).mockResolvedValue(json({ detail: { code: 'presentation_setup_required', templates: [{ id: 'z' }], format: 'pptx', slide_count: 9 } }, 409));
    await mount();
    await run(() => P('Sidebar').onSelectSession('s1'));
    await send('Plain request');
    expect(P('TemplatePickerModal').isOpen).toBe(true);
    expect(P('TemplatePickerModal').slideCount).toBe(9);
    expect(P('ChatView').messages).toEqual([]);
  });
});

describe('conversation branching', () => {
  it('branches and opens the new conversation', async () => {
    overrides['POST /sessions/s1/branch'] = () => json({ id: 's2' });
    await mount();
    await run(() => P('Sidebar').onSelectSession('s1'));
    await run(() => P('ChatView').onBranch(3));
    expect(JSON.parse(requests.find(r => r.url.endsWith('/branch'))!.body)).toEqual({ turn_index: 3 });
    expect(P('ChatView').sessionId).toBe('s2');
  });
  it.each([[{ detail: 'No branch' }, 'No branch'], [{ detail: {} }, 'Could not branch this conversation.']])('alerts on failure %j', async (body, text) => {
    overrides['POST /sessions/s1/branch'] = () => json(body, 400);
    await mount();
    await run(() => P('Sidebar').onSelectSession('s1'));
    await run(() => P('ChatView').onBranch(1));
    expect(appAlert).toHaveBeenCalledWith(text);
  });
  it('refuses guidance with no active job', async () => {
    await mount();
    await expect(P('ChatView').onGuideResponse('x')).rejects.toThrow('This response is no longer accepting guidance.');
  });
});

describe('project assistant', () => {
  const openProjects = async () => { apps = [app('projects', 'projects')]; await mount(); await run(() => action('projects').run()); };
  beforeEach(() => { overrides['GET /api/projects/context'] = () => json({ portfolio: { projects: [] }, instructions: 'x' }); });
  it('refuses blank questions', async () => {
    await openProjects();
    await expect(P('ProjectsWorkspace').onAskBob('', '   ')).rejects.toThrow('Wait for the current Bob request to finish.');
  });
  it('files the question in a new Projects workspace and sends it', async () => {
    vi.mocked(submitChatRequest).mockResolvedValue(new Response('', { status: 200 }));
    await openProjects();
    await run(() => P('ProjectsWorkspace').onAskBob('', 'What is at risk?'));
    await vi.waitFor(() => expect(submitChatRequest).toHaveBeenCalled());
    expect(called('/projects', 'POST')).toBe(true);
    const sent = JSON.stringify(vi.mocked(submitChatRequest).mock.calls[0][0]);
    expect(sent).toContain('What is at risk?');
    expect(sent).toContain('Project Buddy');
  });
  it('reports failure when the authorized context cannot load', async () => {
    overrides['GET /api/projects/context'] = () => json({}, 500);
    await openProjects();
    await act(async () => { await expect(P('ProjectsWorkspace').onAskBob('', 'Q')).rejects.toThrow('Could not load your authorized project context.'); });
    await settle();
    expect(P('ProjectsWorkspace').bobError).toBe('Could not load your authorized project context.');
    expect(P('ProjectsWorkspace').bobBusy).toBe(false);
  });
  it('closes and clears the preparing state', async () => {
    await openProjects();
    await run(() => P('ProjectsWorkspace').onClose());
    expect(panel('ProjectsWorkspace')).toBeNull();
  });
});

describe('stopping a response', () => {
  const start = async () => {
    vi.mocked(submitChatRequest).mockResolvedValue(hanging());
    await mount();
    await act(async () => { void P('ChatView').onSendMessage('Long task'); });
    await settle();
    await vi.waitFor(() => expect(P('ChatView').canGuideResponse).toBe(true));
  };
  it('loops cancellation until the server confirms the stop', async () => {
    let cancels = 0;
    overrides['POST /jobs/job1/cancel'] = () => json({ status: cancels++ === 0 ? 'stopping' : 'stopped' });
    await start();
    expect(P('ChatView').isStreaming).toBe(true);
    await run(() => P('ChatView').onStop());
    expect(P('ChatView').isStreaming).toBe(false);
    expect(P('ChatView').messages.at(-1).statusText).toBe('Stopped by you');
    expect(cancels).toBe(2);
  });
  it('reports cancel failures and restores working status', async () => {
    overrides['POST /jobs/job1/cancel'] = () => json({}, 500);
    await start();
    await run(() => P('ChatView').onStop());
    expect(appAlert).toHaveBeenCalledWith('Could not stop Buddy. Please try Stop again.');
    expect(P('ChatView').messages.at(-1).isStopping).toBe(false);
  });
  it('handles unknown cancel statuses', async () => {
    overrides['POST /jobs/job1/cancel'] = () => json({ status: 'odd' });
    await start();
    await run(() => P('ChatView').onStop());
    expect(appAlert).toHaveBeenCalledWith('Could not confirm the task status. Please try Stop again.');
  });
  it.each([['completed', 'Done'], ['failed', 'Request failed']])('reports server %s as %s', async (status, text) => {
    overrides['POST /jobs/job1/cancel'] = () => json({ status });
    await start();
    await run(() => P('ChatView').onStop());
    expect(P('ChatView').messages.at(-1).statusText).toBe(text);
  });
});
