// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { PeopleSocketAudio } from '../../src/lib/peopleSocketAudio';
class Socket {
  static OPEN = 1; static instance: Socket;
  readyState = 1; bufferedAmount = 0; binaryType = '';
  onopen!: () => void; onmessage!: (event: { data: unknown }) => void; onerror!: () => void; onclose!: () => void;
  send = vi.fn(); close = vi.fn();
  constructor() { Socket.instance = this; }
}
class Worklet {
  static instance: Worklet;
  port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null } = { onmessage: null };
  connect = vi.fn(); disconnect = vi.fn();
  constructor() { Worklet.instance = this; }
}
afterEach(() => vi.unstubAllGlobals());
test('encrypts captured audio with a different counter for each frame', async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('AudioWorkletNode', Worklet);
  const callbacks = { connected: vi.fn(), error: vi.fn(), blocked: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = { state: 'running', resume: vi.fn().mockResolvedValue(undefined), audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) }, createMediaStreamSource: vi.fn().mockReturnValue(source), destination: {} };
  const call = new PeopleSocketAudio(context as unknown as AudioContext, {} as MediaStream, 'call-1', 'client-1', 'caller', callbacks);
  await call.start(); const socket = Socket.instance; socket.onopen();
  const hello = JSON.parse(socket.send.mock.calls[0][0]);
  expect(hello.client_id).toBe('client-1');
  const peer = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const publicKey = await webcrypto.subtle.exportKey('jwk', peer.publicKey);
  socket.onmessage({ data: JSON.stringify({ type: 'audio_peer', public_key: publicKey }) });
  await vi.waitFor(() => expect(Worklet.instance?.port.onmessage).toBeTypeOf('function'));
  Worklet.instance.port.onmessage!({ data: new Uint8Array([1, 2]).buffer });
  Worklet.instance.port.onmessage!({ data: new Uint8Array([3, 4]).buffer });
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(3));
  const packets = socket.send.mock.calls.slice(1).map(([packet]) => new Uint8Array(packet));
  expect(packets[0].slice(0, 8)).toEqual(packets[1].slice(0, 8));
  expect(new DataView(packets[0].buffer).getUint32(8)).toBe(0);
  expect(new DataView(packets[1].buffer).getUint32(8)).toBe(1);
  const callerKey = await webcrypto.subtle.importKey('jwk', hello.public_key, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await webcrypto.subtle.deriveKey({ name: 'ECDH', public: callerKey }, peer.privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: packets[0].slice(0, 12), additionalData: new TextEncoder().encode('call-1:caller') }, key, packets[0].slice(12));
  expect([...new Uint8Array(plaintext)]).toEqual([1, 2]);
  expect(callbacks.error).not.toHaveBeenCalled(); call.stop();
  expect(socket.close).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce();
});
test('reports a connection error only once and closes the socket', async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('WebSocket', Socket);
  const callbacks = { connected: vi.fn(), error: vi.fn(), blocked: vi.fn() };
  const call = new PeopleSocketAudio({} as AudioContext, {} as MediaStream, 'id', 'client', 'callee', callbacks);
  await call.start(); const socket = Socket.instance; socket.onerror(); socket.onerror();
  expect(callbacks.error).toHaveBeenCalledTimes(1); expect(socket.close).toHaveBeenCalledOnce();
});

test('plays authenticated peer audio once and rejects replayed frames', async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('AudioWorkletNode', Worklet);
  const callbacks = { connected: vi.fn(), error: vi.fn(), blocked: vi.fn() };
  const playback = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null, buffer: null };
  const samples = new Float32Array(2048);
  const context = { state: 'running', currentTime: 10, resume: vi.fn().mockResolvedValue(undefined), audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) }, createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }), createBuffer: vi.fn().mockReturnValue({ getChannelData: () => samples, duration: 0.128 }), createBufferSource: vi.fn().mockReturnValue(playback), destination: {} };
  const call = new PeopleSocketAudio(context as unknown as AudioContext, {} as MediaStream, 'call-2', 'client-2', 'caller', callbacks);
  await call.start(); const socket = Socket.instance; socket.onopen();
  const hello = JSON.parse(socket.send.mock.calls[0][0]);
  const peer = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const publicKey = await webcrypto.subtle.exportKey('jwk', peer.publicKey);
  const remote = await webcrypto.subtle.importKey('jwk', hello.public_key, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await webcrypto.subtle.deriveKey({ name: 'ECDH', public: remote }, peer.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  socket.onmessage({ data: JSON.stringify({ type: 'audio_peer', public_key: publicKey }) });
  await vi.waitFor(() => expect(Worklet.instance.port.onmessage).toBeTypeOf('function'));
  const iv = new Uint8Array(12); iv[0] = 0x80;
  const pcm = new Uint8Array(4096); new DataView(pcm.buffer).setInt16(0, 16384, true);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('call-2:callee') }, key, pcm);
  const packet = new Uint8Array(12 + encrypted.byteLength); packet.set(iv); packet.set(new Uint8Array(encrypted), 12);
  socket.onmessage({ data: packet.buffer }); socket.onmessage({ data: packet.buffer });
  await vi.waitFor(() => expect(callbacks.connected).toHaveBeenCalledOnce());
  expect(samples[0]).toBe(0.5); expect(playback.start).toHaveBeenCalledOnce();
  expect(playback.start).toHaveBeenCalledWith(10.03); expect(callbacks.error).not.toHaveBeenCalled();
  call.stop(); expect(playback.stop).toHaveBeenCalledOnce();
});
