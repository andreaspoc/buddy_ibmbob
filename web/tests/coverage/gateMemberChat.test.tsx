// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const voice = vi.hoisted(() => ({ value: { ready: true, call: null as any, start: vi.fn(), enableSound: vi.fn(async () => {}) } as any }));
vi.mock('../../src/lib/usePeopleVoice', () => ({ usePeopleVoice: () => voice.value }));
vi.mock('../../src/components/PeopleVoiceCall', () => ({ PeopleVoiceCall: ({ onOpen }: any) => <button onClick={() => onOpen(1)}>Open call room</button> }));
vi.mock('../../src/components/MemberChatAway', () => ({ default: ({ onBack, onSaved }: any) => <div className="fake-away"><button onClick={onBack}>Away back</button><button onClick={() => onSaved(true)}>Away save</button></div> }));
vi.mock('../../src/components/PeopleChatTools', async importOriginal => {
  const actual: any = await importOriginal();
  return { ...actual, PeopleChatTools: (p: any) => <div className="fake-tools" data-mode={p.mode} data-selected={p.selectedMessage?.id ?? ''} data-prompt={p.initialPrompt}>
    <button onClick={p.onClose}>Tool close</button>
    <button onClick={() => p.onJump({ id: 10, parent_id: 10 })}>Tool jump thread</button>
    <button onClick={() => p.onJump({ id: 99, room_id: 2 })}>Tool jump room</button>
    <button onClick={() => p.onMention({ username: 'alice', display_name: 'Alice Cooper' })}>Tool mention</button>
    <button onClick={p.onBobDone}>Tool bob done</button>
  </div> };
});
import { MemberChatWidget, useCommunityUnread } from '../../src/components/MemberChat';

class FakeSocket { static list: FakeSocket[] = []; onopen: any; onmessage: any; onclose: any; close = vi.fn(); constructor(public url: string) { FakeSocket.list.push(this); } }
class FakeIntersection { static list: FakeIntersection[] = []; targets: Element[] = []; observe = (el: Element) => { this.targets.push(el); }; disconnect = vi.fn(); constructor(public cb: any) { FakeIntersection.list.push(this); } }
class FakeResize { static list: FakeResize[] = []; observe = vi.fn(); disconnect = vi.fn(); constructor(public cb: any) { FakeResize.list.push(this); } }

const dm = { id: 1, kind: 'direct', name: 'Alice Cooper', subscribed: true, unread_count: 0, latest_incoming_id: 0 };
const group = { id: 2, kind: 'channel', name: 'Team', subscribed: true, unread_count: 0, visibility: 'private', member_count: 3, latest_incoming_id: 0 };
const open = { id: 3, kind: 'channel', name: 'Lobby', subscribed: false, unread_count: 0, visibility: 'open', latest_incoming_id: 0 };
const NOW = '2026-10-30T10:00:00Z';
const msg = (id: number, extra: Record<string, unknown> = {}) => ({ id, sender: 'alice', sender_name: 'Alice Cooper', body: `Body ${id}`, created_at: NOW, ...extra });
const json = (data: unknown, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => data });

let root: Root; let host: HTMLDivElement; let rooms: any[]; let messages: any[]; let receipts: any[]; let requests: Array<{ path: string; method: string; body: any }>;
let overrides: Record<string, (init?: RequestInit) => unknown>;
const pause = (ms = 5) => new Promise(r => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const byText = (text: string) => $$('button').find(b => b.textContent?.trim() === text) as HTMLButtonElement;
const label = (name: string) => $$('[aria-label]').find(el => el.getAttribute('aria-label') === name) as HTMLButtonElement;
const click = async (el: Element | null | undefined) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click(); await pause(); }); };
const type = (el: Element, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  await pause();
});
const fire = (name: string, detail?: unknown) => act(async () => { window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail })); await pause(); });
const mount = async (props: Record<string, unknown> = {}) => { await act(async () => { root.render(<MemberChatWidget username="tester" {...props} />); await pause(); }); };
const openWidget = async () => { await mount(); await fire('community-open'); };
const openRoom = async (roomId = 2, kind = 'channel') => { await mount(); await fire('community-open-room', { roomId, kind }); await act(async () => { await pause(); }); };
const composer = () => $<HTMLTextAreaElement>('.member-chat-composer textarea')!;
const posted = (path: string) => requests.filter(r => r.path === path && r.method !== 'GET');
const article = (id: number) => $<HTMLElement>(`[data-message-id="${id}"]`)!;
const within = (id: number, s: string) => article(id).querySelector<HTMLElement>(s);
const menuFor = async (id: number) => { await click(within(id, '.people-message-more')); };
const menuButton = (text: string) => [...$$('.people-message-menu button')].find(b => b.textContent === text);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  FakeSocket.list = []; FakeIntersection.list = []; FakeResize.list = [];
  vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('IntersectionObserver', FakeIntersection); vi.stubGlobal('ResizeObserver', FakeResize);
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollTo = vi.fn(); Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  sessionStorage.clear();
  voice.value = { ready: true, call: null, start: vi.fn(), enableSound: vi.fn(async () => {}) };
  rooms = [dm, group, open]; messages = []; receipts = []; requests = []; overrides = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/api/community', ''), method = init?.method || 'GET';
    requests.push({ path, method, body: init?.body });
    for (const [key, make] of Object.entries(overrides)) if (`${method} ${path}`.startsWith(key)) return make(init);
    if (path === '/rooms') return json(method === 'POST' ? { id: 2 } : rooms);
    if (path === '/rooms/2/messages' && method === 'POST') { const saved = msg(900 + requests.length, { sender: 'tester', body: (init?.body as FormData).get('body') }); messages = [...messages, saved]; return json(saved); }
    if (path === '/members') return json([{ username: 'alice', display_name: 'Alice Cooper' }, { username: 'bo', display_name: 'Bo Ray' }, { username: 'kc-1', display_name: 'kc-1' }]);
    if (path === '/away') return json({ active: false });
    if (path.endsWith('/members')) return json([{ username: 'tester', display_name: 'Tester' }, { username: 'alice', display_name: 'Alice Cooper' }]);
    if (path.includes('/messages?')) return json(path.endsWith('after=0') ? messages : []);
    if (path.endsWith('/receipts')) return json(receipts);
    if (url === '/api/notes') return json({ items: [{ id: 5, title: 'Note five' }, { id: 6, title: '' }] });
    return json({}, true, 204);
  }));
  host = document.createElement('div'); host.id = 'root'; document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); document.querySelectorAll('.composer-wrap').forEach(n => n.remove()); });

describe('launcher and notifications', () => {
  it('shows unread totals on launcher, capped at 99+', async () => {
    rooms = [{ ...dm, unread_count: 150, latest_incoming_id: 4, latest_incoming_sender_name: 'Alice Cooper' }];
    await mount({ displayName: 'Tess Tester' });
    const launcher = $('.member-chat-launcher')!;
    expect(launcher.getAttribute('aria-label')).toBe('Open member chat, 150 unread messages');
    expect(launcher.querySelector('.member-chat-unread')?.textContent).toBe('99+');
    expect(launcher.className).toContain('has-new-message');
  });
  it.each([
    [{ ...dm, unread_count: 1, latest_incoming_id: 4 }, 'Tess Tester', 'Private message', 'Hi Tess, you have a message from Alice Cooper.', 'New message'],
    [{ ...group, unread_count: 2, latest_incoming_id: 4, latest_incoming_sender_name: 'kc-abc', latest_incoming_automated: true }, undefined, 'Group message', 'Hi, you have an automatic reply from Member in Team.', '2 unread messages'],
    [{ ...open, subscribed: true, unread_count: 1, latest_incoming_id: 4, latest_incoming_sender_name: 'Bo' }, 'a@b', 'Channel message', 'Hi, you have a message from Bo in Lobby.', 'New message'],
  ])('renders toast %#', async (room, displayName, kind, sentence, foot) => {
    rooms = [room];
    await mount({ displayName });
    const toast = $('.member-chat-toast')!;
    expect(toast.textContent).toContain(kind);
    expect(toast.textContent).toContain(sentence);
    expect(toast.querySelector('.member-chat-toast-bottom span')?.textContent).toBe(foot);
  });
  it('uses mention notification fields rather than latest automation', async () => {
    rooms = [{ ...group, unread_count: 3, latest_incoming_id: 9, latest_incoming_automated: true, notification_incoming_id: 7, notification_sender_name: 'Mina' }];
    await mount();
    expect($('.member-chat-toast')?.textContent).toContain('a message from Mina');
  });
  it('dismisses, opens chat from a toast, and auto-dismisses unless hovered', async () => {
    rooms = [{ ...dm, unread_count: 1, latest_incoming_id: 4 }];
    await mount();
    await click(byText('Open chat'));
    expect($('.member-chat-toast')).toBeNull();
    expect($('.member-chat-widget')?.className).toContain('is-chat-open');
    expect($('.member-chat-conversation h2')?.textContent).toBe('Alice Cooper');
  });
  it('dismiss button closes the toast', async () => {
    rooms = [{ ...dm, unread_count: 1, latest_incoming_id: 4 }];
    await mount();
    await click(label('Dismiss notification'));
    expect($('.member-chat-toast')).toBeNull();
  });
  it('auto-dismisses after 10s, pausing on hover and focus', async () => {
    rooms = [{ ...dm, unread_count: 1, latest_incoming_id: 4 }];
    await mount();
    vi.useFakeTimers();
    const toast = $('.member-chat-toast')!;
    await act(async () => { toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(11000); });
    expect($('.member-chat-toast')).not.toBeNull();
    await act(async () => { toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    await act(async () => { toast.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    await act(async () => { toast.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10500); });
    expect($('.member-chat-toast')).toBeNull();
  });
  it('keeps the newest three notices and drops read rooms', async () => {
    rooms = [1, 2, 3, 4].map(id => ({ ...dm, id, name: `N${id}`, unread_count: 1, latest_incoming_id: 10 + id }));
    await mount();
    expect($$('.member-chat-toast')).toHaveLength(3);
    rooms = rooms.map(room => ({ ...room, unread_count: 0 }));
    await fire('community-updated');
    expect($$('.member-chat-toast')).toHaveLength(0);
  });
  it('refreshes a notice when a newer message arrives', async () => {
    rooms = [{ ...dm, unread_count: 1, latest_incoming_id: 4 }];
    await mount();
    rooms = [{ ...dm, unread_count: 2, latest_incoming_id: 5 }];
    await fire('community-updated');
    expect($$('.member-chat-toast')).toHaveLength(1);
    expect($('.member-chat-toast')?.textContent).toContain('2 unread');
  });
  it('routes websocket events and reconnects after close', async () => {
    await mount();
    const socket = FakeSocket.list[0];
    expect(socket.url).toContain('/api/community/ws?messages=1');
    const seen: string[] = [];
    for (const name of ['community-message', 'community-typing']) window.addEventListener(name, e => seen.push(e.type), { once: true });
    await act(async () => {
      socket.onopen(); await pause();
      socket.onmessage({ data: 'not-json' });
      socket.onmessage({ data: JSON.stringify({ type: 'other' }) });
      socket.onmessage({ data: JSON.stringify({ type: 'refresh' }) });
      socket.onmessage({ data: JSON.stringify({ type: 'typing' }) });
      socket.onmessage({ data: JSON.stringify({ type: 'message' }) });
      await pause();
    });
    expect(seen).toEqual(['community-typing', 'community-message']);
    vi.useFakeTimers();
    await act(async () => { socket.onclose(); await vi.advanceTimersByTimeAsync(3100); });
    expect(FakeSocket.list).toHaveLength(2);
  });
  it('coalesces overlapping refreshes and skips hidden documents', async () => {
    await mount();
    const count = () => requests.filter(r => r.path === '/rooms').length;
    const before = count();
    await act(async () => { window.dispatchEvent(new Event('community-read')); window.dispatchEvent(new Event('community-read')); window.dispatchEvent(new Event('community-read')); await pause(10); });
    expect(count()).toBe(before + 2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await fire('community-read');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    expect(count()).toBe(before + 2);
  });
  it('does nothing without a user', async () => {
    let seen: any;
    const Probe = () => { seen = useCommunityUnread(undefined); return null; };
    await act(async () => { root.render(<Probe />); await pause(); });
    expect(seen.unread).toBe(0);
    expect(FakeSocket.list).toHaveLength(0);
  });
  it('tolerates failed refresh and non-string error details', async () => {
    overrides['GET /rooms'] = () => ({ ok: false, status: 500, json: async () => { throw new Error('html'); } });
    await openWidget();
    expect($('[role=alert]')?.textContent).toContain('The request could not be completed');
  });
});

describe('panel chrome and layout', () => {
  it('positions above the composer and tracks layout changes', async () => {
    await mount();
    const wrap = document.createElement('div'); wrap.className = 'composer-wrap';
    wrap.getBoundingClientRect = () => ({ width: 100, height: 40, top: 500 } as DOMRect);
    host.append(wrap);
    await act(async () => { await pause(); });
    const widget = $('.member-chat-widget')!;
    expect(widget.style.getPropertyValue('--member-chat-bottom')).toBe(`${window.innerHeight - 500 + 12}px`);
    wrap.remove();
    await act(async () => { await pause(); });
    expect(widget.style.getPropertyValue('--member-chat-bottom')).toBe('22px');
  });
  it('toggles, expands, minimizes with Escape, and tracks away status', async () => {
    overrides['GET /away'] = () => json({ active: true });
    await mount();
    await click($('.member-chat-launcher'));
    expect(voice.value.enableSound).toHaveBeenCalled();
    expect(label('People Buddy away assistant').className).toContain('member-chat-away-indicator');
    await click(label('Expand chat'));
    expect($('.member-chat-widget')?.className).toContain('is-chat-expanded');
    expect(label('Compact chat')).toBeTruthy();
    await click(label('People Buddy away assistant'));
    expect($('.fake-away')).not.toBeNull();
    expect($('.member-chat-widget')?.className).not.toContain('is-chat-expanded');
    await click(byText('Away back'));
    expect($('.fake-away')).toBeNull();
    await act(async () => { $('#member-chat-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect($('.member-chat-widget')?.className).not.toContain('is-chat-open');
    await click($('.member-chat-launcher'));
    await click($('.member-chat-launcher'));
    expect($('.member-chat-launcher')?.getAttribute('aria-expanded')).toBe('false');
  });
  it('saves the away state from the assistant panel', async () => {
    await openWidget();
    await click(label('People Buddy away assistant'));
    await click(byText('Away save'));
    expect(label('People Buddy away assistant').className).toContain('member-chat-away-indicator');
  });
  it('ignores invalid open-room requests and opens the call room', async () => {
    await mount();
    await fire('community-open-room', { roomId: -1 });
    await fire('community-open-room', { roomId: 'x' });
    expect($('.member-chat-widget')?.className).not.toContain('is-chat-open');
    await click(byText('Open call room'));
    expect($('.member-chat-conversation h2')?.textContent).toBe('Alice Cooper');
  });
});

describe('conversation list', () => {
  it('switches tabs, filters and shows empty states', async () => {
    rooms = [dm, { ...group, unread_count: 2 }, open];
    await openWidget();
    expect($('.member-chat-room-list')?.textContent).toContain('Alice Cooper');
    expect($('.member-chat-list-heading h3')?.textContent).toBe('Your conversations');
    await type(label('Search conversations'), 'zzz');
    expect($('.member-chat-list-empty')?.textContent).toBe('No matching conversations.');
    await click(byText('Channels'));
    expect(label('Search conversations').getAttribute('placeholder')).toBe('Find a channel…');
    const list = $('.member-chat-room-list')!.textContent!;
    expect(list).toContain('Private group · 3 members');
    expect(list).toContain('Open channel · Join');
    await click(byText('Unread'));
    expect($$('.member-chat-room-list button')).toHaveLength(1);
    expect($('.member-chat-room-list .member-chat-unread')?.getAttribute('aria-label')).toBe('2 unread messages');
    await click(byText('All conversations'));
    expect($$('.member-chat-room-list button')).toHaveLength(2);
    await click(byText('Messages'));
    await click(byText('Unread'));
    expect($('.member-chat-list-empty')?.textContent).toBe('No unread conversations.');
  });
  it.each([
    ['Messages', 'Start a private conversation with a member.'],
    ['Channels', 'Create a group for your team or join an open channel.'],
  ])('prompts on an empty %s tab', async (tab, text) => {
    rooms = [];
    await openWidget();
    await click(byText(tab));
    expect($('.member-chat-list-empty')?.textContent).toBe(text);
  });
  it('labels joined open channels and anonymises direct room names', async () => {
    rooms = [{ ...open, subscribed: true }, { ...dm, id: 9, name: 'kc-1234' }];
    await openWidget();
    expect($('.member-chat-room-list strong')?.textContent).toBe('Member');
    await click(byText('Channels'));
    expect($('.member-chat-room-list')?.textContent).toContain('Open channel · Joined');
  });
  it('drops a selected room that disappears', async () => {
    await openRoom(1, 'direct');
    expect(composer()).toBeTruthy();
    rooms = [group];
    await fire('community-updated');
    await act(async () => { await pause(); });
    expect($('.member-chat-empty')).not.toBeNull();
  });
  it('selects via the list and returns with Back', async () => {
    await openWidget();
    await click($('.member-chat-room'));
    expect($('.member-chat-room')?.className).toContain('is-active');
    await click($('.member-chat-back'));
    expect($('.member-chat-empty')).not.toBeNull();
  });
});

describe('creating conversations', () => {
  it('starts a private conversation from search', async () => {
    await openWidget();
    await click(byText('New message'));
    expect($('.member-chat-new h3')?.textContent).toBe('New message');
    await type(label('Search members'), 'nobody');
    expect($('.member-chat-member-picker')?.textContent).toContain('No members match');
    await type(label('Search members'), 'ali');
    await click($('.member-chat-member-picker button'));
    expect(JSON.parse(posted('/rooms')[0].body)).toEqual({ kind: 'direct', peer: 'alice' });
    expect($('.member-chat-new')).toBeNull();
  });
  it('creates a private group with selected members', async () => {
    await openWidget();
    await click(byText('Channels'));
    await click(byText('Create group'));
    const create = () => byText('Create group') as HTMLButtonElement;
    expect(create().disabled).toBe(true);
    await type(label('Group name'), '  Crew  ');
    expect(create().disabled).toBe(true);
    const checks = () => $$('.member-chat-member-option input') as HTMLInputElement[];
    await click(checks()[0]); await click(checks()[1]);
    expect($('.member-chat-selected-count')?.textContent).toBe('2 selected + you');
    expect(byText('Create group · 3 members')).toBeTruthy();
    await click(label('Remove Alice Cooper from group'));
    await click(checks()[1]);
    await click(checks()[0]);
    await click(byText('Create group · 2 members'));
    expect(JSON.parse(posted('/rooms')[0].body)).toEqual({ kind: 'channel', name: 'Crew', visibility: 'private', members: ['alice'] });
    expect($('.member-chat-new')).toBeNull();
  });
  it('creates an open channel with no member picker', async () => {
    await openWidget();
    await click(byText('Channels'));
    await click(byText('Create group'));
    await type(label('Group privacy'), 'open');
    expect($('.member-chat-member-picker')).toBeNull();
    expect($('.member-chat-new')?.textContent).toContain('All signed-in members');
    await type(label('Group name'), 'Open one');
    await click(byText('Create open channel'));
    expect(JSON.parse(posted('/rooms')[0].body).members).toEqual([]);
  });
  it('shows creation errors and returns via Back', async () => {
    overrides['POST /rooms'] = () => json({ detail: 'Refused' }, false);
    await openWidget();
    await click(byText('New message'));
    await click($('.member-chat-member-picker button'));
    expect($('[role=alert]')?.textContent).toContain('Refused');
    await click($('.member-chat-new button'));
    expect($('.member-chat-new')).toBeNull();
    await click(label('Dismiss error'));
    expect($('[role=alert]')).toBeNull();
  });
});

describe('room header', () => {
  it('starts a voice call in direct rooms when ready', async () => {
    await openRoom(1, 'direct');
    await click(label('Start voice call'));
    expect(voice.value.start).toHaveBeenCalledWith(1, 'Alice Cooper');
    expect($('.member-chat-conversation-header p')?.textContent).toBe('Private conversation');
  });
  it('disables calling while connecting', async () => {
    voice.value = { ...voice.value, ready: false };
    await openRoom(1, 'direct');
    expect(label('Start voice call').disabled).toBe(true);
    expect(label('Start voice call').title).toBe('Connecting voice calls…');
  });
  it('joins an open channel then can leave immediately', async () => {
    await openRoom(3, 'channel');
    expect($('.member-chat-join-prompt')?.textContent).toContain('Join this open channel');
    expect($('.member-chat-conversation-header p')?.textContent).toContain('Open channel');
    rooms = [dm, group, { ...open, subscribed: true }];
    await click(byText('Join channel'));
    expect(posted('/rooms/3/subscribe')[0].method).toBe('POST');
    expect(composer()).toBeTruthy();
    rooms = [dm, group, open];
    await click(byText('Leave'));
    expect(posted('/rooms/3/subscribe')[1].method).toBe('DELETE');
    expect($('.member-chat-empty')).not.toBeNull();
  });
  it('shows group members with loading and failure', async () => {
    let release = (_: unknown) => {};
    overrides['GET /rooms/2/members'] = () => new Promise(r => { release = r; });
    await openRoom();
    await click(label('View group members'));
    expect($('.member-chat-audience')?.textContent).toContain('Loading members…');
    await act(async () => { release(json([{ username: 'tester', display_name: 'T' }, { username: 'alice', display_name: 'Alice Cooper' }])); await pause(); });
    expect([...$$('.member-chat-audience li')].map(li => li.textContent)).toEqual(['You', 'Alice Cooper']);
    expect($('.member-chat-audience small')?.textContent).toContain('Only these members');
    await click(label('View group members'));
    overrides['GET /rooms/2/members'] = () => json({ detail: 'Forbidden' }, false);
    await click(label('View group members'));
    expect($('[role=alert]')?.textContent).toContain('Forbidden');
  });
  it('opens each conversation tool and shortcuts', async () => {
    await openRoom();
    await click(label('Conversation tools'));
    for (const name of ['Members', 'Tasks', 'Pinned', 'Notifications', 'People Buddy for this inbox']) {
      await click(byText(name));
      expect($('.fake-tools')).not.toBeNull();
      await click(byText('Tool close'));
      await click(label('Conversation tools'));
    }
    await click(label('Conversation tools'));
    await click($('[aria-label="Conversation shortcuts"] button:nth-child(2)'));
    expect($('.fake-tools')?.dataset.mode).toBe('files');
    await click($('[aria-label="Conversation shortcuts"] button:nth-child(3)'));
    expect($('.fake-tools')?.dataset.mode).toBe('search');
    await click($('[aria-label="Conversation shortcuts"] button:nth-child(1)'));
    expect($('.fake-tools')).toBeNull();
  });
});

describe('message rendering', () => {
  it.each([
    [{ voice_call_id: 'v', sender: 'alice' }, '☎ Voice call · Alice Cooper'],
    [{ voice_call_id: 'v', sender: 'tester' }, '☎ Voice call · You'],
    [{ shared: { kind: 'bob' }, sender: 'alice' }, 'People Buddy · requested by Alice Cooper'],
    [{ shared: { kind: 'bob' }, sender: 'tester' }, 'People Buddy · requested by you'],
    [{ automated: true, sender: 'alice' }, 'People Buddy · automatic reply for Alice Cooper'],
    [{ automated: true, sender: 'tester' }, 'People Buddy · automatic reply for you'],
    [{ sender: 'tester' }, 'You'],
    [{ sender: 'bo', sender_name: undefined }, 'Bo Ray'],
    [{ sender: 'ghost', sender_name: undefined }, 'Member'],
  ])('labels sender %j', async (extra, text) => {
    messages = [msg(10, extra)];
    await openRoom();
    expect(within(10, '.member-chat-message-meta strong')?.textContent).toBe(text);
  });
  it('groups continuation messages but breaks on day, automation and long gaps', async () => {
    messages = [
      msg(10), msg(11, { created_at: '2026-10-30T10:02:00Z' }),
      msg(12, { created_at: '2026-10-30T10:30:00Z' }),
      msg(13, { created_at: '2026-10-30T10:31:00Z', automated: true }),
      msg(14, { created_at: '2026-10-31T10:32:00Z' }),
      msg(15, { created_at: '2026-10-31T10:33:00Z', sender: 'bo' }),
    ];
    await openRoom();
    expect(article(11).className).toContain('is-continuation');
    for (const id of [10, 12, 13, 14, 15]) expect(article(id).className).not.toContain('is-continuation');
    expect($$('.people-date-separator')).toHaveLength(2);
  });
  it('shows pins, reactions, tasks, attachments and shared cards', async () => {
    messages = [
      msg(10, { pinned: true, reactions: [{ emoji: '👍', count: 2, mine: true }], attachment: { id: 7, filename: 'f.txt' }, tasks: [{ id: 1, room_id: 2, title: 'Do it', assignee: 'tester', creator: 'alice', status: 'todo' }] }),
      msg(11, { shared: { kind: 'note', title: 'Shared note', body: 'hidden body' }, body: 'not shown' }),
      msg(12, { shared: { kind: 'bob' }, body: 'Bob said' }),
    ];
    await openRoom();
    expect(within(10, '[title="Pinned message"]')).not.toBeNull();
    expect(within(10, '.member-chat-attachment')?.getAttribute('href')).toBe('/api/community/rooms/2/attachments/7');
    expect(within(10, '.people-task-card')?.textContent).toContain('Do it');
    expect(within(11, '.people-shared-card')?.textContent).toContain('Shared note');
    expect(article(11).textContent).not.toContain('not shown');
    expect(within(12, 'p')?.textContent).toBe('Bob said');
    await click(label('👍, 2 reactions'));
    expect(JSON.parse(posted('/rooms/2/messages/10/reactions')[0].body)).toEqual({ emoji: '👍' });
  });
  it.each([
    [[], '✓ Sent'],
    [[{ username: 'tester', display_name: 'Me', last_read: 99 }], '✓ Sent'],
    [[{ username: 'alice', display_name: 'Alice', last_read: 10 }, { username: 'bo', display_name: 'Bo', last_read: 1, seen_message_ids: [10] }], '✓✓ Seen by 2'],
    [[{ username: 'alice', display_name: 'Alice', last_read: 1, seen_message_ids: [9] }], '✓ Sent'],
  ])('reports group receipts %#', async (value, text) => {
    messages = [msg(10, { sender: 'tester' })]; receipts = value;
    await openRoom();
    expect(within(10, '.member-chat-receipt')?.textContent).toBe(text);
  });
  it('reports Seen in direct rooms', async () => {
    messages = [msg(10, { sender: 'tester' })]; receipts = [{ username: 'alice', display_name: 'Alice', last_read: 10 }];
    await openRoom(1, 'direct');
    expect(within(10, '.member-chat-receipt')?.textContent).toBe('✓✓ Seen');
    expect(within(10, '.member-chat-receipt')?.title).toBe('Seen by Alice');
  });
  it('pages through complete snapshots', async () => {
    const page = Array.from({ length: 200 }, (_, i) => msg(i + 1));
    overrides['GET /rooms/2/messages?after=0'] = () => json(page);
    overrides['GET /rooms/2/messages?after=200'] = () => json([msg(201)]);
    await openRoom();
    expect(article(201)).not.toBeNull();
    expect($$('[data-message-id]')).toHaveLength(201);
  });
  it('merges realtime messages only for the active room', async () => {
    await openRoom();
    expect($('.member-chat-first')?.textContent).toBe('No messages yet. Say hello.');
    await fire('community-message', { room_id: 99, message: msg(50) });
    await fire('community-message', { room_id: 2, message: { id: 'bad' } });
    expect(article(50)).toBeNull();
    await fire('community-message', { room_id: 2, message: msg(52) });
    await fire('community-message', { room_id: 2, message: msg(51) });
    expect($$('[data-message-id]').map(a => a.dataset.messageId)).toEqual(['51', '52']);
  });
  it('shows message load failures', async () => {
    overrides['GET /rooms/2/messages'] = () => json({ detail: 'Load failed' }, false);
    await openRoom();
    expect($('[role=alert]')?.textContent).toContain('Load failed');
  });
});

describe('message actions', () => {
  beforeEach(() => { messages = [msg(10), msg(11, { parent_id: 10, body: 'Reply' }), msg(12, { sender: 'tester', attachment: { id: 3, filename: 'a.txt' } })]; });
  it('pins, unpins, reacts and saves notes', async () => {
    await openRoom();
    await menuFor(10);
    await click(menuButton('Pin message'));
    expect(JSON.parse(posted('/rooms/2/messages/10/pin')[0].body)).toEqual({ pinned: true });
    expect($('.people-message-menu')).toBeNull();
    await menuFor(10);
    await click(label('React 🎉'));
    expect(JSON.parse(posted('/rooms/2/messages/10/reactions')[0].body)).toEqual({ emoji: '🎉' });
    await menuFor(10);
    await click(menuButton('Save as private note'));
    expect(JSON.parse(posted('/rooms/2/messages/10/save-note')[0].body)).toEqual({ title: 'Body 10' });
    expect($('.people-action-notice')?.textContent).toContain('Saved a private note');
    await click(label('Dismiss action notice'));
    expect($('.people-action-notice')).toBeNull();
    await menuFor(10);
    await click(within(10, '.people-message-more'));
    expect($('.people-message-menu')).toBeNull();
  });
  it('titles saved shared notes and offers unpin', async () => {
    messages = [msg(10, { pinned: true, shared: { kind: 'note', title: 'Shared title' } }), msg(11, { body: '', attachment: { id: 1, filename: 'a' } })];
    await openRoom();
    await menuFor(10);
    await click(menuButton('Unpin message'));
    expect(JSON.parse(posted('/rooms/2/messages/10/pin')[0].body)).toEqual({ pinned: false });
    await menuFor(10);
    await click(menuButton('Save as private note'));
    expect(JSON.parse(posted('/rooms/2/messages/10/save-note')[0].body).title).toBe('Shared title');
    await menuFor(11);
    expect(menuButton('Save as private note')).toBeUndefined();
  });
  it('opens threads through the menu and link, then sends to the root', async () => {
    await openRoom();
    expect(article(11)).toBeNull();
    await click(byText('1 replies · Open thread'));
    expect($('.people-thread-heading')).not.toBeNull();
    expect(article(11)).not.toBeNull();
    await menuFor(11);
    await click(menuButton('Reply in thread'));
    await type(composer(), 'In thread');
    expect($('.people-draft-hint')?.textContent).toContain('Thread text draft');
    await click($('.member-chat-send'));
    const sent = posted('/rooms/2/messages')[0].body as FormData;
    expect(sent.get('parent_id')).toBe('10');
    await click(byText('Back to conversation'));
    expect($('.people-thread-heading')).toBeNull();
  });
  it('creates tasks and asks People Buddy about a message', async () => {
    await openRoom();
    await menuFor(10);
    await click(menuButton('Create task / reminder'));
    expect($('.fake-tools')?.dataset).toMatchObject({ mode: 'create-task', selected: '10' });
    await click(byText('Tool close'));
    await menuFor(10);
    await click(menuButton('Ask People Buddy about this'));
    expect($('.fake-tools')?.dataset).toMatchObject({ mode: 'bob', selected: '10' });
  });
  it('closes the tool when its message disappears', async () => {
    await openRoom();
    await menuFor(10);
    await click(menuButton('Create task / reminder'));
    messages = [];
    await fire('community-updated');
    await act(async () => { await pause(); });
    expect($('.fake-tools')).toBeNull();
  });
  it('confirms deletion and explains files', async () => {
    await openRoom();
    await click(within(12, '.member-chat-delete'));
    expect($('.member-chat-delete-confirm')?.textContent).toContain('and its shared file');
    await click(byText('Cancel'));
    expect($('.member-chat-delete-confirm')).toBeNull();
    await click(within(12, '.member-chat-delete'));
    messages = messages.filter(m => m.id !== 12);
    await click(byText('Delete'));
    expect(posted('/rooms/2/messages/12')[0].method).toBe('DELETE');
    expect(article(12)).toBeNull();
  });
  it('jumps inside the room, to thread roots and other rooms', async () => {
    await openRoom();
    await click(label('Mention a member'));
    await click(byText('Tool jump thread'));
    expect($('.people-thread-heading')).not.toBeNull();
    await click(label('Mention a member'));
    const seen = vi.fn(); window.addEventListener('community-open-room', seen, { once: true });
    await click(byText('Tool jump room'));
    expect(($('.fake-tools'))).toBeNull();
    expect(seen).not.toHaveBeenCalled();
    await act(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
  it('asks to open a different room for off-room jumps', async () => {
    await openRoom(1, 'direct');
    await click(label('Mention a member'));
    const seen = vi.fn(); window.addEventListener('community-open-room', seen, { once: true });
    await click(byText('Tool jump room'));
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ roomId: 2 });
  });
  it('shows jump to latest on scroll up, returns on click', async () => {
    await openRoom();
    // The resize observer attaches on tool/thread changes; see report for the fresh-open gap.
    await click($('[aria-label="Conversation shortcuts"] button:nth-child(2)'));
    await click($('[aria-label="Conversation shortcuts"] button:nth-child(1)'));
    const log = $('.member-chat-messages')!;
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 }, scrollTop: { configurable: true, writable: true, value: 0 } });
    await act(async () => { log.dispatchEvent(new Event('scroll', { bubbles: true })); });
    const jump = $('.people-jump-latest')!;
    expect(jump).not.toBeNull();
    await click(jump);
    expect($('.people-jump-latest')).toBeNull();
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
    const observer = FakeResize.list.filter(o => o.observe.mock.calls.some(call => call[0] === log)).at(-1)!;
    await act(async () => { observer.cb(); });
    expect(log.scrollTop).toBe(1000);
  });
});

describe('auto-scroll', () => {
  it('keeps a room opened before the room list loads pinned to the bottom', async () => {
    await openRoom();
    const log = $('.member-chat-messages')!;
    expect(log).not.toBeNull();
    const observer = FakeResize.list.filter(o => o.observe.mock.calls.some(call => call[0] === log)).at(-1);
    expect(observer).toBeDefined();
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, scrollTop: { configurable: true, writable: true, value: 0 } });
    await act(async () => { observer!.cb(); });
    expect(log.scrollTop).toBe(1000);
  });
});

describe('composer', () => {
  it('sends with Enter, keeps mentions in draft and ignores IME and Shift+Enter', async () => {
    await openRoom();
    await click(label('Mention a member'));
    await click(byText('Tool mention'));
    expect(composer().value).toBe('@Alice Cooper ');
    expect($('.people-mentioned')?.textContent).toContain('Alice Cooper');
    await click(label('Mention a member'));
    await click(byText('Tool mention'));
    expect(composer().value).toBe('@Alice Cooper @Alice Cooper ');
    expect($('.people-mentioned')?.textContent).toBe('Notifying: Alice Cooper');
    const key = (init: KeyboardEventInit) => act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })); await pause(); });
    await key({ shiftKey: true });
    await key({ isComposing: true });
    await key({ repeat: true });
    expect(posted('/rooms/2/messages')).toHaveLength(0);
    await key({});
    const form = posted('/rooms/2/messages')[0].body as FormData;
    expect(JSON.parse(form.get('mention_ids') as string)).toEqual(['alice']);
    expect(composer().value).toBe('');
  });
  it('removes mentions no longer present and adds separators after text', async () => {
    await openRoom();
    await type(composer(), 'hi');
    await click(label('Mention a member'));
    await click(byText('Tool mention'));
    expect(composer().value).toBe('hi @Alice Cooper ');
    await type(composer(), 'hi');
    expect($('.people-mentioned')).toBeNull();
  });
  it.each(['@bob summarise', '@Buddy summarise', '@people-buddy summarise'])('routes %s to People Buddy', async text => {
    await openRoom();
    await type(composer(), text);
    await click($('.member-chat-send'));
    expect($('.fake-tools')?.dataset).toMatchObject({ mode: 'bob', prompt: 'summarise' });
    expect(posted('/rooms/2/messages')).toHaveLength(0);
    await click(byText('Tool bob done'));
    await click(byText('Tool close'));
    expect(composer().value).toBe('');
  });
  it('opens People Buddy via toolbar and clears the prompt', async () => {
    await openRoom();
    await click(label('Ask People Buddy in this conversation'));
    expect($('.fake-tools')?.dataset).toMatchObject({ mode: 'bob', prompt: '' });
  });
  it('attaches files with limit and removal', async () => {
    await openRoom();
    const input = $<HTMLInputElement>('input[type=file]')!;
    const pick = (file: File) => act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); await pause(); });
    const big = new File(['x'], 'big.bin'); Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await pick(big);
    expect($('[role=alert]')?.textContent).toContain('Files must be 20 MB or smaller.');
    await pick(new File(['x'], 'ok.txt'));
    expect($('.member-chat-selection')?.textContent).toContain('ok.txt');
    await click(label('Remove attachment'));
    expect($('.member-chat-selection')).toBeNull();
    await pick(new File(['x'], 'ok.txt'));
    await click($('.member-chat-send'));
    expect((posted('/rooms/2/messages')[0].body as FormData).get('file')).toBeInstanceOf(File);
    expect($('.member-chat-selection')).toBeNull();
    const clicked = vi.spyOn(input, 'click').mockImplementation(() => {});
    await click(byText('File'));
    expect(clicked).toHaveBeenCalled();
  });
  it('shares a saved note, replacing a selected file and toggling off', async () => {
    await openRoom();
    await click(byText('Note'));
    const picker = label('Note to share') as unknown as HTMLSelectElement;
    expect([...picker.options].map(o => o.textContent)).toEqual(['Choose a note…', 'Note five', 'Untitled note']);
    await type(picker, '5');
    await click(byText('Note'));
    expect($('.member-chat-note-picker')).toBeNull();
    await click(byText('Note'));
    await type(label('Note to share'), '6');
    await click($('.member-chat-send'));
    expect((posted('/rooms/2/messages')[0].body as FormData).get('note_id')).toBe('6');
  });
  it('tolerates note response with no items', async () => {
    overrides['GET /api/notes'] = () => json({});
    await openRoom();
    await click(byText('Note'));
    expect([...(label('Note to share') as unknown as HTMLSelectElement).options]).toHaveLength(1);
  });
  it('inserts emoji at the caret and closes with Escape', async () => {
    await openRoom();
    await type(composer(), 'ac');
    composer().setSelectionRange(1, 1);
    await click(label('Add emoji'));
    await click(label('Smile'));
    expect(composer().value).toBe('a😊c');
    await act(async () => { $('.member-chat-emoji-picker')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect($('.member-chat-emoji-picker')).toBeNull();
    await click(label('Add emoji'));
    await click(label('Close emoji picker'));
    expect($('.member-chat-emoji-picker')).toBeNull();
  });
  it('refuses emoji beyond the length limit', async () => {
    await openRoom();
    await type(composer(), 'x'.repeat(20000));
    await click(label('Add emoji'));
    await click(label('Smile'));
    expect(composer().value).toHaveLength(20000);
  });
  it.each([
    [1, 'direct', 'Only shared with Alice Cooper', 'Message Alice Cooper…'],
    [2, 'channel', 'Shared with 3 selected group members', 'Message # Team…'],
  ])('describes audience for room %i', async (id, kind, hint, placeholder) => {
    await openRoom(id, kind);
    expect($('.member-chat-sharing-hint')?.textContent).toContain(hint);
    expect(composer().placeholder).toBe(placeholder);
  });
  it('describes open channel audience', async () => {
    rooms = [{ ...open, subscribed: true }];
    await openRoom(3, 'channel');
    expect($('.member-chat-sharing-hint')?.textContent).toContain('Shared with everyone who joins this channel');
  });
  it('ignores server replies without an id but still clears', async () => {
    overrides['POST /rooms/2/messages'] = () => json({ ok: true });
    await openRoom();
    await type(composer(), 'Hello');
    await click($('.member-chat-send'));
    expect(composer().value).toBe('');
    expect($$('[data-message-id]')).toHaveLength(0);
  });
  it('appends replies from the server', async () => {
    await openRoom();
    await type(composer(), 'Hello');
    await click($('.member-chat-send'));
    expect($$('[data-message-id]')).toHaveLength(1);
    expect($('.member-chat-message p')?.textContent).toBe('Hello');
  });
});

describe('typing indicators', () => {
  const typing = (username: string, name: string, on = true, extra = {}) => fire('community-typing', { room_id: 2, username, display_name: name, typing: on, ...extra });
  it.each([
    [['A'], 'A is typing…'],
    [['A', 'B'], 'A and B are typing…'],
    [['A', 'B', 'C'], 'A, B and 1 other is typing…'],
    [['A', 'B', 'C', 'D'], 'A, B and 2 others are typing…'],
  ])('summarises %j', async (names, text) => {
    await openRoom();
    for (const name of names) await typing(name, name);
    expect($('.member-chat-typing')?.textContent).toBe(text);
  });
  it('ignores self, other rooms and threads; stops on signal, hide and expiry', async () => {
    await openRoom();
    await typing('tester', 'Me');
    await fire('community-typing', { room_id: 9, username: 'x', typing: true });
    await typing('thread', 'T', true, { parent_id: 5 });
    expect($('.member-chat-typing')).toBeNull();
    await typing('alice', 'Alice');
    await typing('alice', 'Alice', false);
    expect($('.member-chat-typing')).toBeNull();
    await typing('alice', 'Alice');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await pause(); });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await pause(); });
    expect($('.member-chat-typing')).toBeNull();
  });
  it('expires stale typists', async () => {
    await openRoom();
    await typing('alice', 'Alice');
    expect($('.member-chat-typing')).not.toBeNull();
    const later = Date.now() + 10000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await act(async () => { await pause(1100); });
    expect($('.member-chat-typing')).toBeNull();
  });
  it('signals own typing with throttling and stop on blur', async () => {
    await openRoom();
    const typingPosts = () => posted('/rooms/2/typing').map(r => JSON.parse(r.body).typing);
    await type(composer(), 'h');
    await type(composer(), 'he');
    expect(typingPosts()).toEqual([true]);
    await type(composer(), '');
    expect(typingPosts()).toEqual([true, false]);
    await type(composer(), 'x');
    await act(async () => { composer().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await pause(); });
    expect(typingPosts().at(-1)).toBe(false);
  });
  it('sends stop on window blur', async () => {
    await openRoom();
    await type(composer(), 'h');
    await fire('blur');
    expect(posted('/rooms/2/typing').map(r => JSON.parse(r.body).typing)).toEqual([true, false]);
  });
  it('does not signal typing when the window lost focus', async () => {
    await openRoom();
    (document.hasFocus as any).mockReturnValue(false);
    await type(composer(), 'h');
    expect(posted('/rooms/2/typing')).toHaveLength(0);
  });
});

describe('read receipts', () => {
  const intersect = (ids: number[], extra: Record<string, unknown> = {}) => act(async () => {
    FakeIntersection.list.at(-1)!.cb(ids.map(id => ({ isIntersecting: true, intersectionRect: { height: 40 }, boundingClientRect: { height: 40 }, target: article(id), ...extra })));
    await pause();
  });
  const reads = () => posted('/rooms/2/read');
  beforeEach(() => { messages = [msg(10), msg(11)]; });
  it('acknowledges visible messages once', async () => {
    await openRoom();
    const read = vi.fn(); window.addEventListener('community-read', read, { once: true });
    await intersect([10]);
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
    expect(JSON.parse(reads()[0].body as string)).toEqual({ message_ids: [10] });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await intersect([10]);
    await act(async () => { await pause(160); });
    expect(reads()).toHaveLength(1);
    await intersect([11]);
    await vi.waitFor(() => expect(reads()).toHaveLength(2));
    expect(JSON.parse(reads()[1].body as string)).toEqual({ message_ids: [11] });
  });
  it('ignores non-visible entries', async () => {
    await openRoom();
    await intersect([10], { isIntersecting: false });
    await intersect([10], { intersectionRect: { height: 2 } });
    await act(async () => { await pause(160); });
    expect(reads()).toHaveLength(0);
  });
  it('retries after a failed acknowledgement', async () => {
    overrides['POST /rooms/2/read'] = () => json({}, false);
    await openRoom();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { FakeIntersection.list.at(-1)!.cb([{ isIntersecting: true, intersectionRect: { height: 40 }, boundingClientRect: { height: 40 }, target: article(10) }]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(130); });
    expect(reads()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(reads()).toHaveLength(2);
  });
  it('holds acknowledgement when the window is unfocused', async () => {
    await openRoom();
    await intersect([10]);
    (document.hasFocus as any).mockReturnValue(false);
    await act(async () => { await pause(160); });
    expect(reads()).toHaveLength(0);
  });
  it('forgets visible messages that were deleted', async () => {
    await openRoom();
    await intersect([10]);
    messages = [msg(11)];
    await fire('community-updated');
    await act(async () => { await pause(160); });
    expect(article(10)).toBeNull();
    expect(article(11)).not.toBeNull();
  });
});
