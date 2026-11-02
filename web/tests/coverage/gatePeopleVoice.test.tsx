// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engines = vi.hoisted(() => ({ list: [] as any[], play: true, prime: true }));
vi.mock('../../src/lib/peopleSocketAudio', () => ({
  PeopleSocketAudio: class {
    start = vi.fn(async () => {}); stop = vi.fn();
    constructor(public ctx: any, public stream: any, public id: string, public client: string, public role: string, public callbacks: any) { engines.list.push(this); }
  },
}));
vi.mock('../../src/lib/peopleCallSounds', () => ({
  PeopleCallSounds: class { prime = vi.fn(async () => engines.prime); play = vi.fn(() => engines.play); stop = vi.fn(); dispose = vi.fn(); },
}));
import { usePeopleVoice, type PeopleVoice } from '../../src/lib/usePeopleVoice';

class FakeSocket { static OPEN = 1; static list: FakeSocket[] = []; readyState = 1; sent: any[] = []; onmessage: any; onclose: any; send = (v: string) => { this.sent.push(JSON.parse(v)); }; close = vi.fn(); constructor(public url: string) { FakeSocket.list.push(this); } }
class FakePeer {
  static list: FakePeer[] = [];
  connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'new'; localDescription: any = null; remoteDescription: any = null;
  onicecandidate: any; onicecandidateerror: any; ontrack: any; onconnectionstatechange: any;
  addTrack = vi.fn(); close = vi.fn(); addIceCandidate = vi.fn(async () => {});
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })); createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' }));
  setLocalDescription = vi.fn(async (d: any) => { this.localDescription = d; }); setRemoteDescription = vi.fn(async (d: any) => { this.remoteDescription = d; });
  constructor(public config: any) { FakePeer.list.push(this); }
}
class FakeAudio { state = 'running'; resume = vi.fn(async () => {}); close = vi.fn(async () => { this.state = 'closed'; }); }
class FakeStream { constructor(public tracks: any[]) {} }

let host: HTMLDivElement; let root: Root; let hook: PeopleVoice; let track: any; let getUserMedia: any;
const Harness = () => { hook = usePeopleVoice('me'); return null; };
const socket = () => FakeSocket.list.at(-1)!;
const peer = () => FakePeer.list.at(-1)!;
const emit = (value: unknown, target = socket()) => act(async () => { target.onmessage({ data: JSON.stringify(value) }); await new Promise(r => setTimeout(r, 0)); });
const serverCall = (extra: Record<string, unknown> = {}) => ({ id: 'c1', room_id: 7, status: 'ringing', role: 'caller', owned: true, caller_name: 'Ana', callee_name: 'Bo', created_at: 'now', ...extra });
const state = (extra: Record<string, unknown> = {}) => emit({ type: 'call_state', call: serverCall(extra) });
const ready = (extra: Record<string, unknown> = {}) => emit({ type: 'call_ready', ice_servers: [], client_id: 'client', ...extra });
const startCall = async () => { await ready(); await act(async () => { await hook.start(7, 'Bo'); }); };
const connectedCaller = async () => { await startCall(); await state({ status: 'accepted' }); return peer(); };
const peerState = (p: FakePeer, value: string) => act(async () => { p.connectionState = value; p.onconnectionstatechange(); });
const lastSent = () => socket().sent.at(-1);

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  FakeSocket.list = []; FakePeer.list = []; engines.list = []; engines.play = true; engines.prime = true;
  track = { enabled: true, stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('RTCPeerConnection', FakePeer); vi.stubGlobal('AudioContext', FakeAudio); vi.stubGlobal('MediaStream', FakeStream);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('signalling lifecycle', () => {
  it('connects, becomes ready and answers pings', async () => {
    expect(socket().url).toContain('/api/community/calls/ws?audio=1');
    expect(hook.ready).toBe(false);
    await ready();
    expect(hook.ready).toBe(true);
    await emit({ type: 'call_ping' });
    expect(lastSent()).toEqual({ action: 'ping' });
  });
  it('reconnects after socket close and clears active call with a notice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = socket();
    await act(async () => { first.onmessage({ data: JSON.stringify({ type: 'call_ready' }) }); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await hook.start(7, 'Bo'); });
    await act(async () => { first.onclose(); });
    expect(hook.ready).toBe(false);
    expect(hook.call).toBeNull();
    expect(hook.notice).toContain('Voice signaling disconnected');
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(FakeSocket.list).toHaveLength(2);
  });
  it('turns handler exceptions into an ended call with their message', async () => {
    await startCall();
    await act(async () => { socket().onmessage({ data: '{bad json' }); await new Promise(r => setTimeout(r, 0)); });
    expect(hook.call).toBeNull();
    expect(hook.notice).toBeTruthy();
  });
  it('shows server call errors', async () => {
    await emit({ type: 'call_error' });
    expect(hook.notice).toBe('The call could not be completed');
    await emit({ type: 'call_error', message: 'Busy' });
    expect(hook.notice).toBe('Busy');
    act(() => hook.dismiss());
    expect(hook.notice).toBe('');
  });
});

describe('microphone access', () => {
  it.each([
    [new DOMException('x', 'NotAllowedError'), 'Microphone permission was denied. Allow microphone access to make a voice call.'],
    [new DOMException('x', 'NotFoundError'), 'No microphone was found.'],
    [new Error('Custom'), 'Custom'],
    ['weird', 'Could not access your microphone.'],
  ])('maps %s to notice', async (error, text) => {
    await ready();
    getUserMedia.mockRejectedValueOnce(error);
    await act(async () => { await hook.start(7, 'Bo'); });
    expect(hook.notice).toBe(text);
    expect(hook.call).toBeNull();
  });
  it('requires a secure context', async () => {
    await ready();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    await act(async () => { await hook.start(7, 'Bo'); });
    expect(hook.notice).toBe('Voice calls need HTTPS and a browser with microphone access.');
  });
  it('does not start before ready', async () => {
    await act(async () => { await hook.start(7, 'Bo'); });
    expect(hook.call).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('releases a microphone granted after cancelling', async () => {
    await ready();
    let grant: any; getUserMedia.mockReturnValueOnce(new Promise(r => { grant = r; }));
    let pending: Promise<void>;
    act(() => { pending = hook.start(7, 'Bo'); });
    expect(hook.call?.phase).toBe('preparing');
    await act(async () => { hook.hangup(); });
    await act(async () => { grant({ getTracks: () => [track], getAudioTracks: () => [track] }); await pending; });
    expect(track.stop).toHaveBeenCalled();
    expect(socket().sent).toEqual([]);
    expect(socket().close).toHaveBeenCalledTimes(0);
  });
  it('reports signalling failure when socket is reconnecting at start', async () => {
    await ready();
    socket().readyState = 3;
    await act(async () => { await hook.start(7, 'Bo'); });
    expect(hook.notice).toBe('Voice signaling is reconnecting. Please retry.');
  });
});

describe('call states', () => {
  it('shows outgoing ringing using callee name and blocks sound when play fails', async () => {
    engines.play = false;
    await startCall();
    expect(lastSent()).toEqual({ action: 'start', room_id: 7 });
    await state();
    expect(hook.call).toMatchObject({ id: 'c1', name: 'Bo', phase: 'ringing' });
    expect(hook.soundBlocked).toBe(true);
    engines.play = true;
    await act(async () => { await hook.enableSound(); });
    expect(hook.soundBlocked).toBe(false);
  });
  it('keeps sound blocked when priming fails', async () => {
    engines.play = false;
    await state({ role: 'callee', owned: false });
    engines.prime = false; engines.play = true;
    await act(async () => { await hook.enableSound(); });
    expect(hook.soundBlocked).toBe(true);
  });
  it('ignores other-device caller snapshots and other calls', async () => {
    await state({ owned: false });
    expect(hook.call).toBeNull();
    await state();
    await state({ id: 'other', role: 'callee', owned: false });
    expect(hook.call?.id).toBe('c1');
  });
  it('tells callee when answered in another tab', async () => {
    await state({ role: 'callee', owned: false });
    expect(hook.call?.phase).toBe('incoming');
    await state({ role: 'callee', owned: false, status: 'accepted' });
    expect(hook.notice).toBe('Call answered in another tab');
    expect(hook.call).toBeNull();
    await state({ role: 'callee', owned: false, status: 'accepted' });
    expect(hook.call).toBeNull();
  });
  it.each([
    [{ role: 'callee', owned: false, reason: 'timeout' }, 'Missed voice call from Ana'],
    [{ reason: 'timeout' }, 'Call was not answered'],
    [{ reason: 'timeout', accepted_at: 'x' }, 'The audio connection timed out'],
    [{ reason: 'declined' }, 'Call declined'],
    [{ reason: 'access_removed' }, 'Call ended because conversation access changed'],
    [{ reason: 'unknown' }, 'Call ended'],
    [{}, 'Call ended'],
  ])('announces ended state %j', async (extra, text) => {
    const listener = vi.fn(); window.addEventListener('community-call-ended', listener);
    await state(extra.role ? { role: 'callee', owned: false } : {});
    await state({ ...extra, status: 'ended' });
    window.removeEventListener('community-call-ended', listener);
    expect(hook.notice).toBe(text);
    expect(listener).toHaveBeenCalledOnce();
  });
  it('dispatches ended event but keeps active call for other ids', async () => {
    await state();
    await state({ id: 'zzz', status: 'ended' });
    expect(hook.call?.id).toBe('c1');
  });
  it('declines and notifies server', async () => {
    await state({ role: 'callee', owned: false });
    act(() => hook.decline());
    expect(lastSent()).toEqual({ action: 'decline', call_id: 'c1' });
    expect(hook.notice).toBe('Call declined');
  });
  it('declines locally even if signalling is down', async () => {
    await state({ role: 'callee', owned: false });
    socket().readyState = 3;
    act(() => hook.decline());
    expect(hook.call).toBeNull();
    expect(hook.notice).toBe('Call declined');
  });
  it('sends cancelled when an unowned ringing callee hangs up', async () => {
    await state({ role: 'callee', owned: false });
    act(() => hook.hangup());
    expect(lastSent()).toEqual({ action: 'end', call_id: 'c1', reason: 'cancelled' });
  });
  it('times out unanswered ringing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { socket().onmessage({ data: JSON.stringify({ type: 'call_state', call: serverCall({ ring_remaining_ms: 500 }) }) }); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.call?.phase).toBe('ringing');
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(lastSent()).toMatchObject({ action: 'end', reason: 'timeout' });
    expect(hook.notice).toBe('Call was not answered');
  });
  it('closes the socket when hanging up before the server acknowledges', async () => {
    await startCall();
    act(() => hook.hangup());
    expect(socket().close).toHaveBeenCalled();
    expect(hook.notice).toBe('Call ended');
  });
});

describe('answering', () => {
  it('accepts incoming calls after microphone grant', async () => {
    await state({ role: 'callee', owned: false });
    await act(async () => { await hook.answer(); });
    expect(lastSent()).toEqual({ action: 'accept', call_id: 'c1' });
    expect(hook.call?.phase).toBe('preparing');
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
  it('ends the call when microphone fails while answering', async () => {
    await state({ role: 'callee', owned: false });
    getUserMedia.mockRejectedValueOnce(new DOMException('x', 'NotFoundError'));
    await act(async () => { await hook.answer(); });
    expect(lastSent()).toEqual({ action: 'end', call_id: 'c1', reason: 'media_error' });
    expect(hook.notice).toBe('No microphone was found.');
  });
  it('survives a closed socket when answering fails', async () => {
    await state({ role: 'callee', owned: false });
    socket().readyState = 3;
    await act(async () => { await hook.answer(); });
    expect(hook.notice).toBe('Voice signaling is reconnecting. Please retry.');
    expect(hook.call).toBeNull();
  });
  it('does nothing without an incoming call', async () => {
    await act(async () => { await hook.answer(); });
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('heartbeat keeps preparing phase during permission prompt', async () => {
    await state({ role: 'callee', owned: false });
    getUserMedia.mockReturnValueOnce(new Promise(() => {}));
    act(() => { void hook.answer(); });
    await state({ role: 'callee', owned: false });
    expect(hook.call?.phase).toBe('preparing');
  });
});

describe('WebRTC transport', () => {
  it('caller offers once and completes answer with buffered ICE', async () => {
    const p = await connectedCaller();
    expect(hook.call?.phase).toBe('connecting');
    expect(lastSent()).toEqual({ action: 'offer', call_id: 'c1', sdp: 'offer-sdp' });
    await state({ status: 'accepted' });
    expect(p.createOffer).toHaveBeenCalledOnce();
    await emit({ type: 'call_signal', call_id: 'c1', action: 'ice', candidate: { candidate: 'c' } });
    expect(p.addIceCandidate).not.toHaveBeenCalled();
    await emit({ type: 'call_signal', call_id: 'c1', action: 'answer', sdp: 'remote' });
    expect(p.remoteDescription).toEqual({ type: 'answer', sdp: 'remote' });
    expect(p.addIceCandidate).toHaveBeenCalledWith({ candidate: 'c' });
    await emit({ type: 'call_signal', call_id: 'c1', action: 'ice', candidate: { candidate: 'd' } });
    expect(p.addIceCandidate).toHaveBeenCalledWith({ candidate: 'd' });
  });
  it('callee answers offers; signals for others are ignored', async () => {
    await state({ role: 'callee', owned: true });
    await act(async () => { await hook.answer(); });
    await state({ role: 'callee', owned: true, status: 'accepted' });
    await emit({ type: 'call_signal', call_id: 'other', action: 'offer', sdp: 'x' });
    expect(peer().remoteDescription).toBeNull();
    await emit({ type: 'call_signal', call_id: 'c1', action: 'answer', sdp: 'wrong-role' });
    expect(peer().remoteDescription).toBeNull();
    await emit({ type: 'call_signal', call_id: 'c1', action: 'offer', sdp: 'remote' });
    expect(lastSent()).toEqual({ action: 'answer', call_id: 'c1', sdp: 'answer-sdp' });
  });
  it('fails with a microphone error when a signal arrives before a microphone', async () => {
    await state({ role: 'callee', owned: true });
    await emit({ type: 'call_signal', call_id: 'c1', action: 'offer', sdp: 'x' });
    expect(hook.notice).toBe('Microphone is not ready. Please call again.');
  });
  it('sends ICE candidates and records diagnostics in hangup', async () => {
    const p = await connectedCaller();
    await act(async () => { p.onicecandidate({ candidate: { type: 'relay', toJSON: () => ({ candidate: 'x' }) } }); });
    expect(lastSent()).toEqual({ action: 'ice', call_id: 'c1', candidate: { candidate: 'x' } });
    await act(async () => { p.onicecandidateerror({ errorCode: 701 }); p.onicecandidateerror({ errorCode: 50 }); p.onicecandidate({ candidate: null }); });
    act(() => hook.hangup());
    expect(lastSent().diagnostics).toMatchObject({ local_candidate_types: ['relay'], ice_error_codes: [701], connection_state: 'new' });
  });
  it('ends when ICE cannot be signalled', async () => {
    const p = await connectedCaller();
    socket().readyState = 3;
    await act(async () => { p.onicecandidate({ candidate: { toJSON: () => ({}) } }); });
    expect(hook.notice).toBe('Voice signaling disconnected');
  });
  it('uses the remote stream or wraps a bare track', async () => {
    const p = await connectedCaller();
    const stream = { id: 'remote' };
    await act(async () => { p.ontrack({ streams: [stream], track: {} }); });
    expect(hook.remote).toBe(stream);
    await act(async () => { p.ontrack({ streams: [], track: { id: 't' } }); });
    expect(hook.remote).toBeInstanceOf(FakeStream);
  });
  it('marks connected and notifies server, recovering if signalling fails', async () => {
    const p = await connectedCaller();
    await peerState(p, 'connected');
    expect(hook.call?.phase).toBe('connected');
    expect(lastSent()).toEqual({ action: 'connected', call_id: 'c1' });
    await state({ status: 'active' });
    expect(hook.call?.phase).toBe('connected');
    socket().readyState = 3;
    await peerState(p, 'connected');
    expect(hook.notice).toBe('Voice signaling disconnected');
  });
  it.each([
    [[], undefined, 'An audio relay is not configured for this connection.'],
    [[{ urls: 'stun:example.test' }], undefined, 'An audio relay is not configured for this connection.'],
    [[{ urls: ['turn:example.test'] }], 'relay', 'The audio connection failed after reaching the relay. Please try calling again.'],
    [[{ urls: 'turns:example.test' }], 'host', 'The audio relay could not be reached from this network. Check your VPN or network connection.'],
  ])('explains failure with servers %j', async (ice_servers, candidateType, text) => {
    await ready({ ice_servers });
    await act(async () => { await hook.start(7, 'Bo'); });
    await state({ status: 'accepted' });
    const p = peer();
    expect(p.config.iceServers).toEqual(ice_servers);
    if (candidateType) await act(async () => { p.onicecandidate({ candidate: { type: candidateType, toJSON: () => ({}) } }); });
    await peerState(p, 'failed');
    expect(hook.notice).toBe(text);
  });
  it('ends only after disconnect grace period', async () => {
    const p = await connectedCaller();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await peerState(p, 'disconnected');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(hook.call).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(hook.notice).toBe('Audio connection was lost');
  });
  it('ignores state events from replaced connections', async () => {
    const p = await connectedCaller();
    act(() => hook.hangup());
    await peerState(p, 'failed');
    expect(hook.notice).toBe('Call ended');
    await act(async () => { p.ontrack({ streams: [{ id: 's' }] }); p.onicecandidate({ candidate: { type: 'host', toJSON: () => ({}) } }); });
    expect(hook.remote).toBeNull();
  });
  it('mutes local tracks and ignores mute without a call', async () => {
    act(() => hook.mute());
    expect(hook.call).toBeNull();
    await connectedCaller();
    act(() => hook.mute());
    expect(track.enabled).toBe(false);
    expect(hook.call?.muted).toBe(true);
    await state({ status: 'accepted' });
    expect(hook.call?.muted).toBe(true);
    act(() => hook.mute());
    expect(track.enabled).toBe(true);
  });
});

describe('websocket audio transport', () => {
  const socketCall = async () => {
    await ready({ audio_transport: 'websocket' });
    await act(async () => { await hook.start(7, 'Bo'); });
    await state({ status: 'accepted', transport: 'websocket' });
    return engines.list.at(-1);
  };
  it('uses the socket engine and reports connection', async () => {
    const engine = await socketCall();
    expect(engine.start).toHaveBeenCalled();
    expect(FakePeer.list).toHaveLength(0);
    await act(async () => { engine.callbacks.connected(); });
    expect(hook.call?.phase).toBe('connected');
    expect(lastSent()).toEqual({ action: 'connected', call_id: 'c1' });
    await state({ status: 'active', transport: 'websocket' });
    expect(engines.list).toHaveLength(1);
    await emit({ type: 'call_signal', call_id: 'c1', action: 'offer', sdp: 'ignored' });
    expect(FakePeer.list).toHaveLength(0);
  });
  it('ends on engine errors and reports playback blocks', async () => {
    const engine = await socketCall();
    await act(async () => { engine.callbacks.blocked(true); });
    expect(hook.playbackBlocked).toBe(true);
    await act(async () => { await hook.resumeAudio(); });
    expect(hook.playbackBlocked).toBe(false);
    await act(async () => { engine.callbacks.error('Audio stream failed'); });
    expect(hook.notice).toBe('Audio stream failed');
    expect(engine.stop).toHaveBeenCalled();
  });
  it('ends on signalling loss when connected, and ignores stale engines', async () => {
    const engine = await socketCall();
    socket().readyState = 3;
    await act(async () => { engine.callbacks.connected(); });
    expect(hook.notice).toBe('Buddy’s audio connection disconnected');
    await act(async () => { engine.callbacks.connected(); engine.callbacks.error('stale'); });
    expect(hook.notice).toBe('Buddy’s audio connection disconnected');
  });
  it('requires microphone before opening socket audio', async () => {
    await ready({ audio_transport: 'websocket' });
    await state({ role: 'callee', owned: true, status: 'accepted', transport: 'websocket' });
    expect(hook.notice).toBe('Microphone is not ready. Please call again.');
  });
  it('flags blocked playback when resume rejects', async () => {
    await ready({ audio_transport: 'websocket' });
    const rejecting = class extends FakeAudio { resume = vi.fn(async () => { throw new Error('nope'); }); };
    vi.stubGlobal('AudioContext', rejecting);
    await act(async () => { await hook.start(7, 'Bo'); });
    expect(hook.playbackBlocked).toBe(true);
  });
});
