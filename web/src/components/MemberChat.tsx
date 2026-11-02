import { brandText } from '../lib/brand';
import { scrollBehavior } from '../lib/motion';
import { usePeopleVoice, type PeopleVoice } from '../lib/usePeopleVoice';
import { PeopleVoiceCall } from './PeopleVoiceCall';
import { Toolbar } from './Toolbar';
import { t, useLanguage, getLocale } from '../lib/i18n';
import { usePeopleDraft, messageDayKey } from '../lib/peopleDrafts';
import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './MemberChat.css';
import { CommunityNotificationTracker } from '../lib/communityNotifications';
import MemberChatAway from './MemberChatAway';
import { PeopleChatTools, SharedPeopleCard, PeopleTaskCard, peopleRequest, type PeopleTool, type PeopleMessage, type PeopleTask } from './PeopleChatTools';

type Member = { username: string; display_name: string };
type Room = { id: number; kind: string; name: string; subscribed: boolean; unread_count: number; visibility?: 'open' | 'private'; member_count?: number; latest_incoming_id?: number | null; latest_incoming_sender_name?: string | null; latest_incoming_automated?: boolean | null; is_owner?: boolean; notification_mode?: 'all' | 'mentions' | 'muted'; notification_incoming_id?: number | null; notification_sender_name?: string | null; notifications_paused?: boolean };
type Message = PeopleMessage & { voice_call_id?: string | null; automated?: boolean; mentions?: string[]; reactions?: { emoji: string; count: number; mine: boolean }[]; tasks?: PeopleTask[] };
type Receipt = Member & { last_read: number; seen_message_ids?: number[] };
type ChatNotice = { room: Room; key: number };
type RoomRequest = { roomId: number; kind: string; version: number };
type Note = { id: number; title: string };
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/community${path}`, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(typeof detail.detail === 'string' ? detail.detail : 'The request could not be completed. Please try again.');
  }
  return response.status === 204 ? undefined as T : response.json();
}
export function useCommunityUnread(username?: string, viewedRoomId: number | null = null) {
  const [unread, setUnread] = useState(0);
  const [notices, setNotices] = useState<ChatNotice[]>([]);
  const viewed = useRef(viewedRoomId);
  viewed.current = viewedRoomId;
  useEffect(() => {
    setUnread(0); setNotices([]);
    if (!username) return;
    const tracker = new CommunityNotificationTracker(true);
    const controller = new AbortController();
    let running = false, queued = false;
    const refresh = async () => {
      if (document.hidden) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        const rooms = await request<Room[]>('/rooms', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setUnread(rooms.reduce((total, room) => total + room.unread_count, 0));
          const active = document.hasFocus() ? viewed.current : null;
          const arrivals = tracker.update(rooms, active);
          setNotices(previous => {
            const next = previous.filter(notice => rooms.some(room => room.id === notice.room.id && room.subscribed && room.unread_count > 0 && room.notification_mode !== 'muted' && !room.notifications_paused) && notice.room.id !== active);
            for (const room of arrivals) {
              const index = next.findIndex(notice => notice.room.id === room.id);
              const notice = { room: { ...room, latest_incoming_sender_name: room.notification_sender_name || room.latest_incoming_sender_name, latest_incoming_automated: room.notification_incoming_id && room.notification_incoming_id !== room.latest_incoming_id ? false : room.latest_incoming_automated }, key: room.notification_incoming_id || room.latest_incoming_id! };
              if (index < 0) next.push(notice); else next[index] = notice;
            }
            return next.slice(-3);
          });
        }
      } catch { /* The open widget reports connection errors. */ }
      finally { running = false; if (queued && !controller.signal.aborted) { queued = false; void refresh(); } }
    };
    void refresh();
    let socket: WebSocket | null = null;
    let reconnect: number | undefined;
    let stopped = false;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/community/ws?messages=1`);
      socket.onopen = () => window.dispatchEvent(new Event('community-updated'));
      socket.onmessage = event => {
        try { const data = JSON.parse(event.data); if (data.type === 'message') { window.dispatchEvent(new CustomEvent('community-message', {detail:data})); window.dispatchEvent(new Event('community-updated')); } else if (data.type === 'refresh') window.dispatchEvent(new Event('community-updated')); else if (data.type === 'typing') window.dispatchEvent(new CustomEvent('community-typing', { detail: data })); } catch { /* Ignore malformed events. */ }
      };
      socket.onclose = () => { if (!stopped) reconnect = window.setTimeout(connect, 3000); };
    };
    connect();
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('community-updated', refresh);
    window.addEventListener('community-read', refresh);
    return () => { stopped = true; socket?.close(); window.clearTimeout(reconnect); controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('community-updated', refresh); window.removeEventListener('community-read', refresh); };
  }, [username]);
  return { unread, notices, dismissNotice: (roomId: number) => setNotices(previous => previous.filter(notice => notice.room.id !== roomId)) };
}

type IconName = 'chat' | 'close' | 'expand' | 'compact' | 'back' | 'plus' | 'search' | 'lock' | 'file' | 'note' | 'send' | 'trash' | 'people' | 'emoji' | 'bot' | 'more';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-4 3V11.5a10 10 0 0 1 20 0Z"/><path d="M6 10h10M6 14h6"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>, expand: <path d="M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7"/>,
    compact: <path d="M21 3l-7 7m0-7v7h7M3 21l7-7m0 7v-7H3"/>, back: <path d="m14 5-7 7 7 7"/>,
    plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    file: <path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/>,
    note: <><path d="M5 3h14v12l-6 6H5Z"/><path d="M13 21v-6h6M8 8h8M8 11h6"/></>,
    send: <><path d="m3 3 19 9-19 9 4-9-4-9ZM7 12h15"/></>, trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    emoji: <><circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01"/></>,
    bot: <><rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8M1 12v5M23 12v5"/></>,
    people: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M17 13a5 5 0 0 1 4 5v3"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function friendlyName(value?: string) {
  const name = value?.trim();
  return name && !/^kc-/i.test(name) && !name.includes('@') ? name : 'Member';
}
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(); }

function MessageToast({ notice, displayName, onOpen, onDismiss }: { notice: ChatNotice; displayName?: string; onOpen: () => void; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    let timer: number | undefined;
    const schedule = () => { window.clearTimeout(timer); if (!document.hidden) timer = window.setTimeout(() => dismiss.current(), 10000); };
    schedule(); document.addEventListener('visibilitychange', schedule);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [notice.key, paused]);
  const { room } = notice;
  const name = friendlyName(displayName);
  const greeting = name === 'Member' ? 'Hi' : `Hi ${name.split(/\s+/)[0]}`;
  const sender = friendlyName(room.latest_incoming_sender_name || (room.kind === 'direct' ? room.name : undefined));
  return <article className="member-chat-toast" role="status" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}>
    <div className="member-chat-toast-top"><span><Icon name="chat"/>{brandText("Buddy")} · {room.kind === 'direct' ? 'Private message' : room.visibility === 'private' ? 'Group message' : 'Channel message'}</span><button type="button" aria-label="Dismiss notification" onClick={onDismiss}><Icon name="close"/></button></div>
    <div className="member-chat-toast-content"><span className="member-chat-avatar">{room.kind === 'direct' ? initials(sender) : <Icon name="people"/>}</span><div><strong>{room.kind === 'direct' ? sender : `# ${room.name}`}</strong><p>{greeting}, you have {room.latest_incoming_automated ? 'an automatic reply' : 'a message'} {room.kind === 'direct' ? `from ${sender}` : `from ${sender} in ${room.name}`}.</p></div></div>
    <div className="member-chat-toast-bottom"><span>{room.unread_count > 1 ? `${room.unread_count} unread messages` : 'New message'}</span><button type="button" onClick={onOpen}>Open chat<Icon name="back"/></button></div>
  </article>;
}

/** Mounted independently of the active workspace; hiding it pauses message reads. */
export function MemberChatWidget({ username, displayName }: { username: string; displayName?: string }) {
  const voice = usePeopleVoice(username);
  const widget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let composer: HTMLElement | null = null;
    const update = () => {
      // Measure the whole footer, including shortcuts and selected references.
      // Rects are viewport pixels; CSS divides these offsets by UI zoom once.
      const viewportTop = window.visualViewport?.offsetTop || 0;
      const viewportBottom = Math.min(window.innerHeight, viewportTop + (window.visualViewport?.height || window.innerHeight));
      const rect = composer?.getBoundingClientRect();
      const composerVisible = rect && rect.width > 0 && rect.height > 0;
      const bottom = composerVisible
        ? Math.max(12, window.innerHeight - Math.min(rect.top, viewportBottom) + 12)
        : window.innerHeight - viewportBottom + 22;
      const launcherHeight = widget.current?.querySelector('.member-chat-launcher')?.getBoundingClientRect().height || 50;
      const panelBottom = bottom + launcherHeight + 12;
      widget.current?.style.setProperty('--member-chat-bottom', `${bottom}px`);
      widget.current?.style.setProperty('--member-chat-panel-bottom', `${panelBottom}px`);
      widget.current?.style.setProperty('--member-chat-panel-space', `${Math.max(0, window.innerHeight - panelBottom - viewportTop - 12)}px`);
    };
    const observer = new ResizeObserver(update);
    const attach = () => {
      const next = document.querySelector<HTMLElement>('.composer-wrap');
      if (next !== composer) {
        observer.disconnect();
        composer = next;
        if (composer) observer.observe(composer);
      }
      const launcherElement = widget.current?.querySelector('.member-chat-launcher');
      if (launcherElement) observer.observe(launcherElement);
      update();
    };
    const mutations = new MutationObserver(attach);
    mutations.observe(document.getElementById('root')!, { childList: true, subtree: true });
    const displayChanges = new MutationObserver(update);
    displayChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-ui-density'] });
    window.addEventListener('resize', update);
    window.addEventListener('workspace-motion-settled', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    attach();
    return () => {
      observer.disconnect(); mutations.disconnect(); displayChanges.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('workspace-motion-settled', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);
  const [viewedRoomId, setViewedRoomId] = useState<number | null>(null);
  const [awayOpen, setAwayOpen] = useState(false);
  const [awayActive, setAwayActive] = useState(false);
  const [roomRequest, setRoomRequest] = useState<RoomRequest | null>(null);
  const [open, setOpen] = useState(false);
  const { unread, notices, dismissNotice } = useCommunityUnread(username, open && !awayOpen ? viewedRoomId : null);
  const [expanded, setExpanded] = useState(false);
  const [hasConversation, setHasConversation] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => request<{ active: boolean }>('/away', { signal: controller.signal }).then(settings => { if (!controller.signal.aborted) setAwayActive(!!settings.active); }).catch(() => {});
    void refresh(); const timer = window.setInterval(refresh, 60000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [username]);
  useEffect(() => {
    const show = () => { void voice.enableSound(); setAwayOpen(false); setOpen(true); };
    const showRoom = (event: Event) => { const detail = (event as CustomEvent).detail; if (Number.isInteger(detail?.roomId) && detail.roomId > 0) { setRoomRequest({ roomId: detail.roomId, kind: detail.kind || 'direct', version: Date.now() }); setAwayOpen(false); setOpen(true); } };
    window.addEventListener('community-open', show); window.addEventListener('community-open-room', showRoom);
    return () => { window.removeEventListener('community-open', show); window.removeEventListener('community-open-room', showRoom); };
  }, []);
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);
  function minimize() { setOpen(false); setExpanded(false); launcher.current?.focus({ preventScroll: true }); }
  return createPortal(<div ref={widget} className={`member-chat-widget ${open ? 'is-chat-open' : ''} ${expanded && !awayOpen ? 'is-chat-expanded' : ''}`}>
    <div className="people-notification-stack" aria-label="People notifications">
    <PeopleVoiceCall voice={voice} onOpen={roomId => { setRoomRequest({roomId, kind: 'direct', version: Date.now()}); setAwayOpen(false); setOpen(true); }} />
    <div className="member-chat-toast-stack" aria-label="New message notifications">{notices.map(notice => <MessageToast key={notice.room.id} notice={notice} displayName={displayName} onDismiss={() => dismissNotice(notice.room.id)} onOpen={() => { dismissNotice(notice.room.id); setRoomRequest({ roomId: notice.room.id, kind: notice.room.kind, version: Date.now() }); setAwayOpen(false); setOpen(true); }}/>)}</div>
    </div>
    <section ref={panel} hidden={!open} tabIndex={-1} id="member-chat-panel" className={`member-chat-panel ${expanded ? 'is-expanded' : ''} ${hasConversation && !awayOpen ? 'has-conversation' : ''} ${awayOpen ? 'is-away' : ''}`} role="dialog" aria-modal="false" aria-labelledby="member-chat-title" onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); minimize(); } }}>
      <Toolbar as="header" className="member-chat-panel-header">
        <div className="member-chat-brand"><Icon name="chat"/><div><h2 id="member-chat-title">Member chat</h2><small>{brandText("Buddy")}</small></div></div>
        <div className="member-chat-panel-actions"><button type="button" className={awayActive ? 'member-chat-away-indicator' : ''} aria-label={brandText("People Buddy away assistant")} title={brandText("People Buddy away assistant")} onClick={() => setAwayOpen(value => !value)}><Icon name="bot"/>{awayActive && <span/>}</button><button type="button" className="member-chat-expand" aria-label={expanded ? 'Compact chat' : 'Expand chat'} onClick={() => setExpanded(value => !value)} title={expanded ? 'Compact chat' : 'Expand chat'}><Icon name={expanded ? 'compact' : 'expand'}/></button><button type="button" aria-label="Minimize chat" onClick={minimize} title="Minimize chat"><Icon name="close"/></button></div>
      </Toolbar>
      {awayOpen && <MemberChatAway onBack={() => setAwayOpen(false)} onSaved={setAwayActive}/>}
      <div className="member-chat-panel-body" hidden={awayOpen}><MemberChat voice={voice} username={username} visible={open && !awayOpen} onConversationChange={setHasConversation} onViewedRoomChange={setViewedRoomId} roomRequest={roomRequest}/></div>
    </section>
    <button ref={launcher} type="button" className={`member-chat-launcher ${notices.length ? 'has-new-message' : ''}`} aria-label={`${open ? 'Minimize member chat' : 'Open member chat'}${unread ? `, ${unread} unread messages` : ''}`} title={unread ? `Member chat · ${unread} unread messages` : 'Member chat'} aria-expanded={open} aria-controls="member-chat-panel" onClick={() => { void voice.enableSound(); open ? minimize() : setOpen(true); }}><Icon name="chat"/><span className="sr-only">Member chat</span>{unread > 0 && <span className="member-chat-unread" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}</button>
  </div>, document.body);
}

function MemberChat({ voice, username, visible, onConversationChange, onViewedRoomChange, roomRequest }: { voice: PeopleVoice; username: string; visible: boolean; onConversationChange: (active: boolean) => void; onViewedRoomChange: (id: number | null) => void; roomRequest: RoomRequest | null }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loadedRoomId, setLoadedRoomId] = useState<number | null>(null);
  const [visibleMessage, setVisibleMessage] = useState<{ roomId: number; ids: number[] } | null>(null);
  const [ackRetry, setAckRetry] = useState(0);
  const [focused, setFocused] = useState(() => !document.hidden && document.hasFocus());
  const acknowledged = useRef<Record<number, Set<number>>>({});
  const stickToBottom = useRef(true);
  const [tool, setTool] = useState<PeopleTool | null>(null);
  const [toolMessage, setToolMessage] = useState<Message | null>(null);
  const [toolMenu, setToolMenu] = useState(false);
  const [messageMenu, setMessageMenu] = useState<number | null>(null);
  const [threadRoot, setThreadRoot] = useState<number | null>(null);
  const [bobPrompt, setBobPrompt] = useState('');
  const [typists, setTypists] = useState<Record<string, { name: string; expires: number }>>({});
  const lastTypingSignal = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);
  const typingActive = useRef(false);
  const {body,setBody,mentioned,setMentioned} = usePeopleDraft(username,activeId,threadRoot);
  const [unreadOnly,setUnreadOnly] = useState(false);
  const [showLatest,setShowLatest] = useState(false);
  useLanguage();
  const [actionNotice, setActionNotice] = useState('');
  const [tab, setTab] = useState<'direct' | 'channel'>('direct');
  const [search, setSearch] = useState('');
  const [compose, setCompose] = useState<'direct' | 'channel' | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [channelName, setChannelName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'open'>('private');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [audience, setAudience] = useState<Member[] | null>(null);
  const [showAudience, setShowAudience] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteId, setNoteId] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const roomGeneration = useRef(0);
  const messageRevision = useRef(0);
  const active = rooms.find(room => room.id === activeId);
  const canSend = !!active && active.subscribed;
  const conversationVisible = activeId !== null && !compose;
  const readingConversation = conversationVisible && !tool;
  const displayedMessages = messages.filter(message => threadRoot ? message.id === threadRoot || message.parent_id === threadRoot : !message.parent_id);
  function continuesMessage(index: number) {
    const current = displayedMessages[index];
    const previous = displayedMessages[index - 1];
    if (!previous || current.voice_call_id || previous.voice_call_id || current.sender !== previous.sender || current.automated || previous.automated || current.shared || previous.shared) return false;
    const elapsed = Date.parse(current.created_at) - Date.parse(previous.created_at);
    return messageDayKey(current.created_at) === messageDayKey(previous.created_at) && elapsed >= 0 && elapsed < 5 * 60 * 1000;
  }
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!visible || !canSend || detail?.room_id !== activeId || !detail.message || typeof detail.message.id !== 'number') return;
      messageRevision.current++;
      setMessages(current => [...current.filter(message => message.id !== detail.message.id), detail.message].sort((a,b) => a.id-b.id));
    };
    window.addEventListener('community-message', receive);
    return () => window.removeEventListener('community-message', receive);
  }, [visible, canSend, activeId]);
  function refreshConversation() { window.dispatchEvent(new Event('community-updated')); }
  function sendTyping(typing: boolean, force = false) {
    if (!activeId || !canSend || (typing && (!visible || !readingConversation || document.hidden || !document.hasFocus()))) return;
    if (typing && !force && Date.now() - lastTypingSignal.current < 2500) return;
    if (!typing && !typingActive.current) return;
    lastTypingSignal.current = Date.now(); typingActive.current = typing;
    void peopleRequest(`/rooms/${activeId}/typing`, 'POST', { typing, parent_id: threadRoot }).catch(() => {});
  }
  function draftChanged(value: string) {
    setBody(value); setMentioned(previous => previous.filter(member => value.includes(`@${friendlyName(member.display_name)}`)));
    window.clearTimeout(typingTimer.current);
    if (value.trim()) { sendTyping(true); typingTimer.current = window.setTimeout(() => sendTyping(false), 3500); }
    else sendTyping(false);
  }
  useEffect(() => {
    setTypists({}); lastTypingSignal.current = 0; typingActive.current = false;
    if (!visible || !readingConversation || !canSend || !activeId) return;
    const update = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.room_id !== activeId || data.username === username || (data.parent_id || null) !== threadRoot) return;
      setTypists(previous => {
        const next = { ...previous };
        if (data.typing) next[data.username] = { name: friendlyName(data.display_name), expires: Date.now() + 6500 };
        else delete next[data.username];
        return next;
      });
    };
    const stop = () => {
      window.clearTimeout(typingTimer.current);
      if (typingActive.current) void peopleRequest(`/rooms/${activeId}/typing`, 'POST', { typing: false, parent_id: threadRoot }).catch(() => {});
      typingActive.current = false;
    };
    const hidden = () => { if (document.hidden) { stop(); setTypists({}); } };
    const timer = window.setInterval(() => setTypists(previous => {
      const entries = Object.entries(previous).filter(([, value]) => value.expires > Date.now());
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    }), 1000);
    window.addEventListener('community-typing', update); window.addEventListener('blur', stop); document.addEventListener('visibilitychange', hidden);
    return () => { stop(); window.clearInterval(timer); window.removeEventListener('community-typing', update); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', hidden); };
  }, [activeId, visible, readingConversation, canSend, threadRoot, username]);
  const typingNames = Object.values(typists).map(person => person.name);
  const typingLabel = !typingNames.length ? '' : typingNames.length === 1 ? `${typingNames[0]} is typing…` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…` : `${typingNames[0]}, ${typingNames[1]} and ${typingNames.length - 2} ${typingNames.length === 3 ? 'other is' : 'others are'} typing…`;

  function openTool(mode: PeopleTool, message?: Message) { setTool(mode); setToolMessage(message || null); setToolMenu(false); setMessageMenu(null); }
  function jumpToMessage(message: PeopleMessage) {
    if (message.room_id && message.room_id !== activeId) { window.dispatchEvent(new CustomEvent('community-open-room', { detail: { roomId: message.room_id } })); setTool(null); return; }
    setThreadRoot(message.parent_id || null); setTool(null);
    requestAnimationFrame(() => requestAnimationFrame(() => scroll.current?.querySelector(`[data-message-id="${message.id}"]`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })));
  }
  async function messageAction(message: Message, action: 'pin' | 'save-note' | 'reaction', emoji?: string) {
    if (!active) return;
    await act(async () => { await peopleRequest(`/rooms/${active.id}/messages/${message.id}/${action === 'reaction' ? 'reactions' : action}`, 'POST', action === 'pin' ? { pinned: !message.pinned } : action === 'save-note' ? { title: message.shared?.title || message.body.slice(0, 80) || 'Saved message' } : { emoji }); setMessageMenu(null); if (action === 'save-note') setActionNotice('Saved a private note linked to this message. Deleting the source removes this copy.'); refreshConversation(); });
  }
  function insertMention(member: Member) {
    const name = friendlyName(member.display_name);
    setBody(previous => `${previous}${previous && !/\s$/.test(previous) ? ' ' : ''}@${name} `);
    setMentioned(previous => previous.some(item => item.username === member.username) ? previous : [...previous, member]); setTool(null); requestAnimationFrame(() => messageInput.current?.focus());
  }

  useEffect(() => { onConversationChange(conversationVisible); }, [conversationVisible, onConversationChange]);
  useEffect(() => { onViewedRoomChange(visible && readingConversation ? activeId : null); }, [activeId, visible, readingConversation, onViewedRoomChange]);
  useEffect(() => {
    if (activeId !== null && !loading && !active) setActiveId(null);
    if (toolMessage && loadedRoomId === activeId && !messages.some(message => message.id === toolMessage.id)) { setTool(null); setToolMessage(null); }
  }, [activeId, active, loading, messages, toolMessage, loadedRoomId]);
  useEffect(() => {
    if (roomRequest) { setActiveId(roomRequest.roomId); setTab(roomRequest.kind === 'direct' ? 'direct' : 'channel'); setCompose(null); setError(''); }
  }, [roomRequest]);
  useEffect(() => {
    const updateFocus = () => setFocused(!document.hidden && document.hasFocus());
    const blur = () => setFocused(false);
    window.addEventListener('focus', updateFocus);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', updateFocus);
    updateFocus();
    return () => { window.removeEventListener('focus', updateFocus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', updateFocus); };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (document.hidden || running) return;
      running = true;
      try {
        const [nextRooms, nextMembers] = await Promise.all([request<Room[]>('/rooms', { signal: controller.signal }), request<Member[]>('/members', { signal: controller.signal })]);
        if (alive) { setRooms(nextRooms); setMembers(nextMembers); }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally { running = false; if (alive) setLoading(false); }
    };
    void refresh(); const timer = window.setInterval(refresh, 15000);
    window.addEventListener('community-updated', refresh);
    window.addEventListener('community-read', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { alive = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('community-updated', refresh); window.removeEventListener('community-read', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [visible]);
  useEffect(() => {
    roomGeneration.current++;
    setLoadedRoomId(null); setVisibleMessage(null); setReceipts([]); stickToBottom.current = true; setTool(null); setThreadRoot(null); setShowLatest(false); setMessageMenu(null); setActionNotice('');
    setMessages([]); setFile(null); setNoteId(''); setShowNotes(false); setShowEmoji(false); setDeleteId(null); setShowAudience(false); setAudience(null); setConfirmLeave(false);
    if (fileInput.current) fileInput.current.value = '';
  }, [activeId]);
  useEffect(() => { setFile(null); setNoteId(''); setShowNotes(false); setShowEmoji(false); setShowLatest(false); if (fileInput.current) fileInput.current.value=''; }, [threadRoot]);
  useEffect(() => {
    if (!visible || !conversationVisible || !canSend || activeId === null) return;
    let alive = true;
    const controller = new AbortController();
    let running = false;
    let queued = false;
    setLoadingMessages(true);
    const refresh = async () => {
      if (document.hidden) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        const revision = messageRevision.current;
        // Replace a complete snapshot so deletions also reach peers/reconnecting clients.
        let page: Message[], after = 0;
        const snapshot: Message[] = [];
        do {
          page = await request<Message[]>(`/rooms/${activeId}/messages?after=${after}`, { signal: controller.signal });
          if (!alive) return;
          snapshot.push(...page);
          if (page.length) after = page[page.length - 1].id;
        } while (page.length >= 200);
        const nextReceipts = await request<Receipt[]>(`/rooms/${activeId}/receipts`, { signal: controller.signal });
        if (!alive) return;
        if (revision !== messageRevision.current) { queued = true; return; }
        setMessages(snapshot); setReceipts(nextReceipts); setLoadedRoomId(activeId);
      } catch (e) { if (alive) setError((e as Error).message); }
      finally {
        running = false;
        if (alive) {
          setLoadingMessages(false);
          if (queued) { queued = false; void refresh(); }
        }
      }
    };
    void refresh(); const timer = window.setInterval(refresh, 15000);
    window.addEventListener('community-updated', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { alive = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('community-updated', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [activeId, canSend, conversationVisible, visible]);
  useEffect(() => {
    if (visible && loadedRoomId === activeId && stickToBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
  }, [messages.length, activeId, loadedRoomId, visible, tool, threadRoot]);
  useEffect(() => {
    const log = scroll.current;
    if (!log) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) {
        log.scrollTop = log.scrollHeight;
        setShowLatest(false);
      }
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, [activeId, visible, tool, threadRoot, canSend]);
  useEffect(() => {
    if (!visible || !focused || !readingConversation || loadedRoomId !== activeId || activeId === null || !canSend || !scroll.current) return;
    const existing = new Set(messages.map(message => message.id));
    setVisibleMessage(previous => {
      if (previous?.roomId !== activeId) return previous;
      const ids = previous.ids.filter(id => existing.has(id));
      return ids.length === previous.ids.length ? previous : { roomId: activeId, ids };
    });
    const observer = new IntersectionObserver(entries => {
      const ids = entries.filter(entry => entry.isIntersecting && entry.intersectionRect.height >= Math.min(24, entry.boundingClientRect.height)).map(entry => Number((entry.target as HTMLElement).dataset.messageId));
      if (ids.length) setVisibleMessage(previous => {
        const known = new Set(previous?.roomId === activeId ? previous.ids : []);
        const added = ids.filter(id => !known.has(id));
        return added.length ? { roomId: activeId, ids: [...known, ...added] } : previous;
      });
    }, { root: scroll.current, threshold: [0, .01, .05, .1, .25, .5, .75, 1] });
    scroll.current.querySelectorAll('[data-message-id]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [messages, activeId, loadedRoomId, visible, focused, canSend, readingConversation, threadRoot]);
  useEffect(() => {
    if (!visible || !focused || !readingConversation || !canSend || !visibleMessage || visibleMessage.roomId !== activeId) return;
    const { roomId } = visibleMessage;
    const sent = acknowledged.current[roomId] ||= new Set<number>();
    const ids = visibleMessage.ids.filter(id => !sent.has(id)).slice(0, 200);
    if (!ids.length) return;
    let started = false;
    const timer = window.setTimeout(() => {
      if (document.hidden || !document.hasFocus()) return;
      started = true; ids.forEach(id => sent.add(id));
      request(`/rooms/${roomId}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_ids: ids }) })
        .then(() => { window.dispatchEvent(new Event('community-read')); setAckRetry(value => value + 1); })
        .catch(() => { ids.forEach(id => sent.delete(id)); window.setTimeout(() => setAckRetry(value => value + 1), 3000); });
    }, 120);
    // Once submitted, all IDs were visibly displayed; let that acknowledgement finish.
    return () => { if (!started) window.clearTimeout(timer); };
  }, [visibleMessage, activeId, visible, focused, canSend, readingConversation, ackRetry]);
  useEffect(() => {
    if (!visible || !showAudience || activeId === null || !canSend) return;
    const controller = new AbortController();
    setAudience(null);
    request<Member[]>(`/rooms/${activeId}/members`, { signal: controller.signal }).then(setAudience).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [activeId, showAudience, canSend, visible]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function selectRoom(room: Room) { setActiveId(room.id); setTab(room.kind === 'direct' ? 'direct' : 'channel'); setCompose(null); setError(''); }
  async function openDirect(peer: string) {
    await act(async () => {
      const room = await request<{ id: number }>('/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'direct', peer }) });
      setRooms(await request<Room[]>('/rooms')); setActiveId(room.id); setCompose(null); setTab('direct');
    });
  }
  async function createGroup() {
    if (!channelName.trim() || (visibility === 'private' && !selectedMembers.length)) return;
    await act(async () => {
      const room = await request<{ id: number }>('/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'channel', name: channelName.trim(), visibility, members: visibility === 'private' ? selectedMembers : [] }) });
      setRooms(await request<Room[]>('/rooms')); setActiveId(room.id); setCompose(null); setChannelName(''); setSelectedMembers([]); setTab('channel');
    });
  }
  async function toggleSubscription() {
    if (!active) return;
    await act(async () => {
      await request(`/rooms/${active.id}/subscribe`, { method: active.subscribed ? 'DELETE' : 'POST' });
      setRooms(await request<Room[]>('/rooms'));
      if (active.subscribed) setActiveId(null);
      setConfirmLeave(false);
    });
  }
  async function loadNotes() {
    if (showNotes) { setShowNotes(false); setNoteId(''); return; }
    setShowNotes(true);
    await act(async () => {
      const response = await fetch('/api/notes');
      if (!response.ok) throw new Error('Your notes could not be loaded.');
      const result = await response.json(); setNotes(result.items || []);
    });
  }
  async function send() {
    if (busy || !active || !canSend || (!body.trim() && !file && !noteId)) return;
    if (/^@(?:bob|buddy|people[-_]?buddy)(?:\s|$)/i.test(body.trim())) { setBobPrompt(body.trim().replace(/^@(?:bob|buddy|people[-_]?buddy)\s*/i, '')); openTool('bob'); return; }
    sendTyping(false); window.clearTimeout(typingTimer.current);
    const roomId = active.id;
    const generation = roomGeneration.current;
    await act(async () => {
      const data = new FormData(); data.append('body', body.trim()); if (threadRoot) data.append('parent_id', String(threadRoot)); data.append('mention_ids', JSON.stringify(mentioned.filter(member => body.includes(`@${friendlyName(member.display_name)}`)).map(member => member.username)));
      if (file) data.append('file', file);
      if (noteId) data.append('note_id', noteId);
      const saved = await request<Message>(`/rooms/${roomId}/messages`, { method: 'POST', body: data });
      if (generation === roomGeneration.current) {
        setBody(''); setMentioned([]);
        if (typeof saved.body === 'string' && typeof saved.id === 'number') { messageRevision.current++; setMessages(current => [...current.filter(message => message.id !== saved.id), saved].sort((a,b) => a.id-b.id)); }
        setFile(null); setNoteId(''); setShowNotes(false); setShowEmoji(false);
        if (fileInput.current) fileInput.current.value = '';
      }
      window.dispatchEvent(new Event('community-updated'));
    });
  }
  async function deleteMessage(messageId: number) {
    if (!active) return;
    await act(async () => {
      await request(`/rooms/${active.id}/messages/${messageId}`, { method: 'DELETE' });
      setMessages(previous => previous.filter(message => message.id !== messageId)); setDeleteId(null);
      window.dispatchEvent(new Event('community-updated'));
    });
  }
  function newConversation(kind: 'direct' | 'channel') { setCompose(kind); setMemberSearch(''); setSelectedMembers([]); setVisibility('private'); setChannelName(''); setError(''); }
  const filteredMembers = members.filter(member => friendlyName(member.display_name).toLocaleLowerCase().includes(memberSearch.toLocaleLowerCase()));
  const filteredRooms = rooms.filter(room => room.kind === tab && room.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const audienceLabel = active?.kind === 'direct' ? 'Private conversation' : active?.visibility === 'private' ? `Private group · ${active.member_count ?? ''} members` : 'Open channel · Any member can join';
  function insertEmoji(emoji: string) {
    const input = messageInput.current;
    const start = input?.selectionStart ?? body.length;
    const end = input?.selectionEnd ?? start;
    if (body.length - (end - start) + emoji.length > 20000) return;
    setBody(previous => previous.slice(0, start) + emoji + previous.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
  }
  function receiptStatus(message: Message) {
    const readers = receipts.filter(receipt => receipt.username !== username && (receipt.seen_message_ids ? receipt.seen_message_ids.includes(message.id) : receipt.last_read >= message.id));
    const label = readers.length ? active?.kind === 'direct' ? 'Seen' : `Seen by ${readers.length}` : 'Sent';
    return <span className={`member-chat-receipt ${readers.length ? 'is-seen' : ''}`} title={readers.length ? `Seen by ${readers.map(reader => friendlyName(reader.display_name)).join(', ')}` : 'Message saved. Not yet seen by the recipient.'}>{readers.length ? '✓✓' : '✓'} {label}</span>;
  }
  const roomButton = (room: Room) => <button key={room.id} type="button" disabled={busy} className={`member-chat-room ${activeId === room.id ? 'is-active' : ''}`} onClick={() => selectRoom(room)}>
    <span className={`member-chat-avatar ${room.kind === 'channel' ? 'is-channel' : ''}`}>{room.kind === 'channel' ? <Icon name={room.visibility === 'private' ? 'people' : 'chat'}/> : initials(friendlyName(room.name))}</span>
    <span className="member-chat-room-copy"><strong>{room.kind === 'direct' ? friendlyName(room.name) : room.name}</strong><small>{room.kind === 'direct' ? 'Private message' : room.visibility === 'private' ? `Private group · ${room.member_count ?? ''} members` : room.subscribed ? 'Open channel · Joined' : 'Open channel · Join'}</small></span>
    {room.unread_count > 0 && <span className="member-chat-unread" aria-label={`${room.unread_count} unread messages`}>{room.unread_count}</span>}
  </button>;
  return <>
    {error && <div className="member-chat-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close"/></button></div>}
    <div className="member-chat-workspace">
      <aside className="member-chat-sidebar" aria-label="Conversations">
        {compose ? <div className="member-chat-new">
          <div className="member-chat-list-heading"><button type="button" disabled={busy} onClick={() => setCompose(null)} aria-label="Back to conversations"><Icon name="back"/>Back</button><h3>{compose === 'direct' ? 'New message' : 'Create group'}</h3></div>
          {compose === 'channel' && <>
            <label className="member-chat-field">Group name<input autoComplete="off" aria-label="Group name" maxLength={80} value={channelName} onChange={e => setChannelName(e.target.value)} placeholder="e.g. Project team" disabled={busy}/></label>
            <label className="member-chat-field">Who can join?<select aria-label="Group privacy" value={visibility} disabled={busy} onChange={e => setVisibility(e.target.value as 'private' | 'open')}><option value="private">Private group · Selected members only</option><option value="open">Open channel · Any signed-in member</option></select></label>
            <p className="member-chat-muted">{visibility === 'private' ? 'You are included. Choose who else can read and share here.' : 'All signed-in members can discover and join this channel.'}</p>
          </>}
          {(compose === 'direct' || visibility === 'private') && <>
            <label className="member-chat-search"><Icon name="search"/><input aria-label="Search members" placeholder="Search members by name…" value={memberSearch} onChange={e => setMemberSearch(e.target.value)} autoComplete="off"/></label>
            {compose === 'channel' && <><p className="member-chat-selected-count" role="status">{selectedMembers.length} selected + you</p>{selectedMembers.length > 0 && <div className="member-chat-selected" aria-label="Selected group members">{selectedMembers.map(id => { const name = friendlyName(members.find(member => member.username === id)?.display_name); return <button type="button" key={id} disabled={busy} aria-label={`Remove ${name} from group`} onClick={() => setSelectedMembers(previous => previous.filter(memberId => memberId !== id))}>{name}<Icon name="close"/></button>; })}</div>}</>}
            <div className="member-chat-member-picker" aria-label="Choose recipients">{filteredMembers.map(member => compose === 'direct' ? <button type="button" key={member.username} className="member-chat-room" disabled={busy} onClick={() => void openDirect(member.username)}><span className="member-chat-avatar">{initials(friendlyName(member.display_name))}</span><span className="member-chat-room-copy"><strong>{friendlyName(member.display_name)}</strong><small>Start private conversation</small></span><Icon name="plus"/></button> : <label className="member-chat-member-option" key={member.username}><input type="checkbox" checked={selectedMembers.includes(member.username)} disabled={busy || (selectedMembers.length >= 100 && !selectedMembers.includes(member.username))} onChange={e => setSelectedMembers(previous => e.target.checked ? [...previous, member.username] : previous.filter(name => name !== member.username))}/><span className="member-chat-avatar">{initials(friendlyName(member.display_name))}</span><span>{friendlyName(member.display_name)}</span></label>)}{!filteredMembers.length && <p className="member-chat-list-empty">No members match your search.</p>}</div>
          </>}
          {compose === 'channel' && <button type="button" className="member-chat-primary" disabled={busy || !channelName.trim() || (visibility === 'private' && !selectedMembers.length)} onClick={() => void createGroup()}>{busy ? 'Creating…' : visibility === 'private' ? `Create group${selectedMembers.length ? ` · ${selectedMembers.length + 1} members` : ''}` : 'Create open channel'}</button>}
        </div> : <>
          <div className="member-chat-tabs" aria-label="Conversation type"><button type="button" className={tab === 'direct' ? 'is-active' : ''} aria-pressed={tab === 'direct'} onClick={() => { setTab('direct'); setSearch(''); }}>Messages</button><button type="button" className={tab === 'channel' ? 'is-active' : ''} aria-pressed={tab === 'channel'} onClick={() => { setTab('channel'); setSearch(''); }}>Channels</button></div>
          <div className="people-inbox-filters" role="group" aria-label={t('Conversation filters')}><button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>{t('All conversations')}</button><button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>{t('Unread')}</button></div>
          <label className="member-chat-search"><Icon name="search"/><input aria-label="Search conversations" placeholder={tab === 'direct' ? 'Find a conversation…' : 'Find a channel…'} value={search} onChange={e => setSearch(e.target.value)}/></label>
          <div className="member-chat-list-heading"><h3>{tab === 'direct' ? 'Your conversations' : 'Groups & channels'}</h3><button type="button" disabled={busy} onClick={() => newConversation(tab)}><Icon name="plus"/>{tab === 'direct' ? 'New message' : 'Create group'}</button></div>
          <div className="member-chat-room-list">{filteredRooms.filter(room => !unreadOnly || room.unread_count > 0 || room.id === activeId).map(roomButton)}{!filteredRooms.filter(room => !unreadOnly || room.unread_count > 0 || room.id === activeId).length && <div className="member-chat-list-empty">{loading ? 'Loading…' : unreadOnly ? t('No unread conversations.') : search ? 'No matching conversations.' : tab === 'direct' ? 'Start a private conversation with a member.' : 'Create a group for your team or join an open channel.'}</div>}</div>
          <div className="member-chat-privacy"><Icon name="lock"/>Choose your recipients. Share notes and files only when you send.</div>
        </>}
      </aside>
      <section className="member-chat-conversation" aria-label={active?.name || 'Messages'}>
        {!active || compose ? <div className="member-chat-empty"><Icon name="chat"/><h2>Keep the conversation close</h2><p>Choose a member or group.<br/>Your work stays right where you left it.</p></div> : <>
          <Toolbar as="header" className="member-chat-conversation-header"><button type="button" className="member-chat-back" disabled={busy} aria-label="Back to conversations" onClick={() => setActiveId(null)}><Icon name="back"/></button><span className={`member-chat-avatar ${active.kind === 'channel' ? 'is-channel' : ''}`}>{active.kind === 'channel' ? <Icon name="people"/> : initials(friendlyName(active.name))}</span><div><h2 title={active.kind === 'direct' ? friendlyName(active.name) : active.name}>{active.kind === 'direct' ? friendlyName(active.name) : active.name}</h2><p>{audienceLabel}</p></div>{active.kind === 'direct' && canSend && <button type="button" className="member-chat-call" disabled={!voice.ready || !!voice.call} aria-label="Start voice call" title={voice.ready ? 'Start voice call' : 'Connecting voice calls…'} onClick={() => void voice.start(active.id, friendlyName(active.name))}>☏</button>}{active.kind === 'channel' && <>{canSend && <button type="button" aria-label="View group members" aria-expanded={showAudience} onClick={() => setShowAudience(value => !value)}><Icon name="people"/></button>}<button type="button" disabled={busy} onClick={() => active.subscribed && active.visibility === 'private' ? setConfirmLeave(value => !value) : void toggleSubscription()}>{active.subscribed ? 'Leave' : 'Join'}</button></>}{canSend && <button type="button" aria-label="Conversation tools" aria-expanded={toolMenu} onClick={() => setToolMenu(value => !value)}><Icon name="more"/></button>}</Toolbar>
          {canSend && <Toolbar as="nav" className="people-room-shortcuts" aria-label={t('Conversation shortcuts')}><button type="button" aria-pressed={!tool} onClick={() => setTool(null)}>{t('Messages')}</button><button type="button" aria-pressed={tool === 'files'} onClick={() => openTool('files')}>{t('Shared files')}</button><button type="button" aria-pressed={tool === 'search'} onClick={() => openTool('search')}><Icon name="search"/>{t('Search')}</button></Toolbar>}
          {toolMenu && <Toolbar menu className="people-conversation-menu">{(['members','files','tasks','search','pins','notifications','bob-settings'] as PeopleTool[]).map(mode => <button type="button" key={mode} onClick={() => openTool(mode)}>{{ members: 'Members', files: 'Shared files', tasks: 'Tasks', search: 'Search', pins: 'Pinned', notifications: 'Notifications', 'bob-settings': brandText('People Buddy for this inbox'), bob: '', 'create-task': '', mention: '' }[mode]}</button>)}</Toolbar>}
          {actionNotice && <div className="people-action-notice" role="status">{actionNotice}<button type="button" aria-label="Dismiss action notice" onClick={() => setActionNotice('')}>×</button></div>}
          {confirmLeave && <div className="member-chat-leave-confirm"><p>Leave this private group? You will lose access and cannot rejoin from the channel list.</p><div><button type="button" disabled={busy} onClick={() => setConfirmLeave(false)}>Stay</button><button type="button" disabled={busy} onClick={() => void toggleSubscription()}>Leave group</button></div></div>}
          {showAudience && <div className="member-chat-audience"><strong>Conversation members</strong><ul>{audience ? audience.map(member => <li key={member.username}>{member.username === username ? 'You' : friendlyName(member.display_name)}</li>) : <li>Loading members…</li>}</ul>{active.visibility === 'private' && <small>Only these members can access this group.</small>}</div>}
          {canSend ? tool ? <PeopleChatTools key={`${active.id}:${tool}:${toolMessage?.id || ''}`} mode={tool} room={active} username={username} directory={members} messages={messages} selectedMessage={toolMessage} initialPrompt={bobPrompt} onClose={() => setTool(null)} onChanged={refreshConversation} onJump={jumpToMessage} onMention={insertMention} onBobDone={() => { setBody(''); setBobPrompt(''); refreshConversation(); }}/> : <>
            {threadRoot && <div className="people-thread-heading"><span>Thread · replies stay with this message</span><button type="button" onClick={() => setThreadRoot(null)}>Back to conversation</button></div>}
            <div className="member-chat-messages" ref={scroll} onScroll={e => { const log = e.currentTarget; stickToBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight < 40; setShowLatest(!stickToBottom.current); }} role="log" aria-label="Conversation messages" aria-live="polite">
              {!displayedMessages.length && <p className="member-chat-muted member-chat-first">{loadingMessages ? 'Loading messages…' : 'No messages yet. Say hello.'}</p>}
              {displayedMessages.map((message,index) => <Fragment key={message.id}>{messageDayKey(message.created_at) && (index === 0 || messageDayKey(message.created_at) !== messageDayKey(displayedMessages[index-1].created_at)) && <div className="people-date-separator" role="separator" aria-label={new Date(message.created_at).toLocaleDateString(getLocale(),{dateStyle:'full'})}><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleDateString(getLocale(),{weekday:'short',day:'numeric',month:'long',year:'numeric'})}</time></div>}<article data-message-id={message.id} className={`member-chat-message ${message.sender === username ? 'is-own' : ''} ${continuesMessage(index) ? 'is-continuation' : ''}`}>
                <div className="member-chat-message-meta"><strong>{message.voice_call_id ? `☎ Voice call · ${message.sender === username ? 'You' : friendlyName(message.sender_name)}` : message.shared?.kind === 'bob' ? brandText(`People Buddy · requested by ${message.sender === username ? 'you' : friendlyName(message.sender_name)}`) : message.automated ? brandText(`People Buddy · automatic reply${message.sender === username ? ' for you' : ` for ${friendlyName(message.sender_name)}`}`) : message.sender === username ? 'You' : friendlyName(message.sender_name || members.find(member => member.username === message.sender)?.display_name)}</strong><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString([], { hour: '2-digit', minute: '2-digit' })}</time>{message.pinned && <span title="Pinned message">📌</span>}<button type="button" className="people-message-more" aria-label="Message actions" disabled={busy} onClick={() => setMessageMenu(value => value === message.id ? null : message.id)}><Icon name="more"/></button>{message.sender === username && <button type="button" className="member-chat-delete" disabled={busy} aria-label="Delete message" title="Delete message" onClick={() => setDeleteId(message.id)}><Icon name="trash"/></button>}</div>
                {message.shared && message.shared.kind !== 'bob' && <SharedPeopleCard item={message.shared} attachment={message.attachment} roomId={active.id}/>}
                {message.body && (!message.shared || message.shared.kind === 'bob') && <p>{message.body}</p>}
                {messageMenu === message.id && <Toolbar menu className="people-message-menu"><div>{['👍','❤️','😂','🎉','✅','👀'].map(emoji => <button type="button" key={emoji} aria-label={`React ${emoji}`} onClick={() => void messageAction(message, 'reaction', emoji)}>{emoji}</button>)}</div><button type="button" onClick={() => { setThreadRoot(message.parent_id || message.id); setMessageMenu(null); }}>Reply in thread</button><button type="button" onClick={() => void messageAction(message, 'pin')}>{message.pinned ? 'Unpin' : 'Pin'} message</button>{message.body && <button type="button" onClick={() => void messageAction(message, 'save-note')}>Save as private note</button>}<button type="button" onClick={() => openTool('create-task', message)}>Create task / reminder</button><button type="button" onClick={() => { setBobPrompt(''); openTool('bob', message); }}>Ask People {brandText("Buddy")} about this</button></Toolbar>}
                {!!message.reactions?.length && <div className="people-reactions">{message.reactions.map(reaction => <button type="button" key={reaction.emoji} aria-pressed={reaction.mine} aria-label={`${reaction.emoji}, ${reaction.count} reactions`} onClick={() => void messageAction(message, 'reaction', reaction.emoji)}>{reaction.emoji} {reaction.count}</button>)}</div>}
                {message.tasks?.map(task => <PeopleTaskCard key={task.id} task={task} username={username} members={members} onChanged={refreshConversation}/>)}
                {!threadRoot && messages.some(reply => reply.parent_id === message.id) && <button type="button" className="people-thread-link" onClick={() => setThreadRoot(message.id)}>{messages.filter(reply => reply.parent_id === message.id).length} replies · Open thread</button>}
                {message.attachment && !message.shared && <a className="member-chat-attachment" href={`/api/community/rooms/${active.id}/attachments/${message.attachment.id}`} download><Icon name="file"/>{message.attachment.filename}</a>}
                {message.sender === username && receiptStatus(message)}
                {deleteId === message.id && <div className="member-chat-delete-confirm"><p>Permanently delete this message{message.attachment ? ' and its shared file' : ''}, linked saved copies, tasks and People {brandText("Buddy")} responses across the app?</p><p className="people-delete-limits">Downloaded files, screenshots, external services and existing backups cannot be revoked.</p><button type="button" disabled={busy} onClick={() => setDeleteId(null)}>Cancel</button><button type="button" disabled={busy} onClick={() => void deleteMessage(message.id)}>Delete</button></div>}
              </article></Fragment>)}
            </div>
            {showLatest && displayedMessages.length > 0 && <button type="button" className="people-jump-latest" onClick={() => {stickToBottom.current=true;setShowLatest(false);scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});}}>{t('Jump to latest')} ↓</button>}
            {typingLabel && <div className="member-chat-typing" role="status" aria-live="polite"><span aria-hidden="true"><i/><i/><i/></span>{typingLabel}</div>}
            {!!body.trim() && <small className="people-draft-hint sr-only">{t(threadRoot ? 'Thread text draft' : 'Conversation text draft')} · {t('Only text drafts are kept in this tab.')}</small>}
            <form className="member-chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
              <textarea ref={messageInput} rows={1} aria-label={`Message to ${active.kind === 'direct' ? friendlyName(active.name) : active.name}`} placeholder={`Message ${active.kind === 'channel' ? '# ' : ''}${active.kind === 'direct' ? friendlyName(active.name) : active.name}…`} readOnly={busy} value={body} onChange={e => draftChanged(e.target.value)} onBlur={() => { sendTyping(false); window.clearTimeout(typingTimer.current); }} onKeyDown={e => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                e.preventDefault();
                if (!e.repeat && !busy) void send();
              }} maxLength={20000}/>
              {!!mentioned.length && <div className="people-mentioned">Notifying: {mentioned.map(member => friendlyName(member.display_name)).join(', ')}</div>}
              {file && <div className="member-chat-selection"><Icon name="file"/>{file.name}<button type="button" disabled={busy} aria-label="Remove attachment" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}><Icon name="close"/></button></div>}
              {showNotes && <label className="member-chat-note-picker">Share a copy of a saved note<select aria-label="Note to share" disabled={busy} value={noteId} onChange={e => { setNoteId(e.target.value); setFile(null); if (fileInput.current) fileInput.current.value = ''; }}><option value="">Choose a note…</option>{notes.map(note => <option value={note.id} key={note.id}>{note.title || 'Untitled note'}</option>)}</select></label>}
              {showEmoji && <div className="member-chat-emoji-picker" role="group" aria-label="Choose emoji" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setShowEmoji(false); messageInput.current?.focus(); } }}><header><strong>Add an emoji</strong><button type="button" aria-label="Close emoji picker" onClick={() => { setShowEmoji(false); messageInput.current?.focus(); }}><Icon name="close"/></button></header><div>{[['😊','Smile'],['😀','Happy'],['😂','Laughing'],['😉','Wink'],['😍','Love'],['🤔','Thinking'],['😅','Relieved'],['😎','Cool'],['🥳','Celebrate'],['😢','Sad'],['🙏','Thanks'],['👍','Thumbs up'],['👎','Thumbs down'],['👏','Applause'],['🙌','Hooray'],['👋','Hello'],['🤝','Handshake'],['💪','Strength'],['❤️','Heart'],['💜','Purple heart'],['✅','Done'],['🎉','Celebration'],['🚀','Launch'],['💡','Idea'],['👀','Looking'],['🔥','Great'],['⭐','Star'],['📌','Pin'],['📅','Calendar'],['⏰','Reminder'],['☕','Coffee'],['📊','Chart']].map(([emoji, label]) => <button type="button" key={label} aria-label={label} title={label} disabled={busy} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}</div></div>}
              <div className="member-chat-compose-actions"><div><button type="button" disabled={busy} aria-label="Mention a member" title="Mention a member" onClick={() => openTool('mention')}>@</button><button type="button" disabled={busy} aria-label={brandText("Ask People Buddy in this conversation")} title={brandText("Ask People Buddy using selected messages")} onClick={() => { setBobPrompt(''); openTool('bob'); }}><Icon name="bot"/></button><button type="button" aria-label="Add emoji" aria-expanded={showEmoji} disabled={busy} title="Add emoji" onClick={() => setShowEmoji(value => !value)}><Icon name="emoji"/></button><input ref={fileInput} type="file" hidden onChange={e => { const selected = e.target.files?.[0]; if (selected && selected.size > 20 * 1024 * 1024) { setError('Files must be 20 MB or smaller.'); e.target.value = ''; return; } setFile(selected || null); setNoteId(''); setShowNotes(false); }}/><button type="button" disabled={busy} onClick={() => fileInput.current?.click()} title="Attach a file or presentation, up to 20 MB"><Icon name="file"/>File</button><button type="button" disabled={busy} onClick={() => void loadNotes()}><Icon name="note"/>Note</button></div><button type="submit" className="member-chat-send" disabled={busy || (!body.trim() && !file && !noteId)}><Icon name="send"/>{busy ? 'Sending…' : 'Send'}</button></div>
              <p className="member-chat-sharing-hint sr-only">{active.kind === 'direct' ? `Only shared with ${friendlyName(active.name)}` : active.visibility === 'private' ? `Shared with ${active.member_count ?? ''} selected group members` : 'Shared with everyone who joins this channel'} · Enter to send · Shift+Enter for a new line</p>
            </form>
          </> : <div className="member-chat-join-prompt"><Icon name="people"/><p>Join this open channel to read messages and share with its members.</p><button type="button" className="member-chat-primary" disabled={busy} onClick={() => void toggleSubscription()}>Join channel</button></div>}
        </>}
      </section>
    </div>
  </>;
}
