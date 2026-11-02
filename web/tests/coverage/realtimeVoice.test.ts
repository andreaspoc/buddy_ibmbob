// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCapture, VoiceSpeaker } from '../../src/lib/realtimeVoice';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  bufferedAmount = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) { Socket.instances.push(this); }
  message(data: unknown) { this.onmessage?.({ data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) }); }
}

describe('realtime voice', () => {
  beforeEach(() => { Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('queues speech until ready, plays PCM and completes after playback', () => {
    const samples = new Float32Array(2);
    const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as null | (() => void), buffer: null };
    const context = { currentTime: 1, destination: {}, createBuffer: vi.fn(() => ({ duration: 0.1, getChannelData: () => samples })), createBufferSource: vi.fn(() => source) };
    const callbacks = { speaking: vi.fn(), done: vi.fn(), error: vi.fn() };
    const speaker = new VoiceSpeaker(context as unknown as AudioContext, 'voice-a', callbacks);
    const socket = Socket.instances[0];
    expect(socket.url).toContain('/voice/speak');
    socket.onopen?.();
    speaker.append('Hello'); speaker.finish();
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.message({ type: 'ready' });
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0]))).toEqual([{ voice_id: 'voice-a' }, { text: 'Hello', flush: true }, { done: true }]);
    socket.message(new Int16Array([-32768, 16384]).buffer);
    expect([...samples]).toEqual([-1, 0.5]);
    expect(source.start).toHaveBeenCalledWith(1.015);
    expect(callbacks.speaking).toHaveBeenCalledOnce();
    socket.message({ type: 'done' });
    expect(callbacks.done).not.toHaveBeenCalled();
    source.onended?.();
    expect(callbacks.done).toHaveBeenCalledOnce();
    expect(callbacks.error).not.toHaveBeenCalled();
    speaker.stop();
  });

  it('reports invalid or missing audio and connection timeouts once', () => {
    vi.useFakeTimers();
    const context = {} as AudioContext;
    for (const [message, expected] of [
      [new ArrayBuffer(1), 'Invalid voice audio received.'],
      [{ type: 'done' }, 'ElevenLabs returned no audio. Check the voice and account credits.'],
    ] as const) {
      const callbacks = { speaking: vi.fn(), done: vi.fn(), error: vi.fn() };
      new VoiceSpeaker(context, 'voice', callbacks);
      const socket = Socket.instances.at(-1)!;
      socket.message(message);
      socket.onerror?.();
      expect(callbacks.error).toHaveBeenCalledExactlyOnceWith(expected);
      expect(socket.close).toHaveBeenCalledOnce();
    }
    const callbacks = { speaking: vi.fn(), done: vi.fn(), error: vi.fn() };
    new VoiceSpeaker(context, 'voice', callbacks);
    vi.advanceTimersByTime(20000);
    expect(callbacks.error).toHaveBeenCalledExactlyOnceWith('Speech connection timed out. Please retry.');
  });

  it('cancels scheduled playback without delivering completion', () => {
    const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as null | (() => void), buffer: null };
    const context = { currentTime: 0, destination: {}, createBuffer: () => ({ duration: 1, getChannelData: () => new Float32Array(1) }), createBufferSource: () => source };
    const callbacks = { speaking: vi.fn(), done: vi.fn(), error: vi.fn() };
    const speaker = new VoiceSpeaker(context as unknown as AudioContext, 'voice', callbacks);
    const socket = Socket.instances[0];
    socket.message({ type: 'ready' });
    socket.message(new ArrayBuffer(2));
    speaker.stop();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(source.onended).toBeNull();
    socket.message({ type: 'done' });
    expect(callbacks.done).not.toHaveBeenCalled();
    expect(callbacks.error).not.toHaveBeenCalled();
  });

  it('cleans up and propagates microphone permission failure', async () => {
    const context = { resume: vi.fn(), close: vi.fn(), state: 'running' };
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('microphone denied')) } });
    const callbacks = { partial: vi.fn(), speech: vi.fn(), turn: vi.fn(), error: vi.fn() };
    await expect(new VoiceCapture(callbacks).start()).rejects.toThrow('microphone denied');
    expect(context.close).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(0);
  });

  it('captures speech, respects mute and backpressure, and cleans up resources', async () => {
    const track = { enabled: true, stop: vi.fn() };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const node = { port: { onmessage: null as null | ((event: { data: unknown }) => void) }, connect: vi.fn(), disconnect: vi.fn() };
    const context = { resume: vi.fn(), close: vi.fn(), state: 'running', destination: {}, audioWorklet: { addModule: vi.fn() }, createMediaStreamSource: vi.fn(() => source) };
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    vi.stubGlobal('AudioWorkletNode', class { constructor() { return node; } });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    const callbacks = { partial: vi.fn(), speech: vi.fn(), turn: vi.fn(), error: vi.fn() };
    const capture = new VoiceCapture(callbacks);
    const starting = capture.start();
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    socket.message({ type: 'ready' });
    await starting;
    socket.message({ type: 'partial', text: ' hello ' });
    socket.message({ type: 'partial', text: 'hello there' });
    socket.message({ type: 'transcript', text: ' hello there ' });
    expect(callbacks.speech).toHaveBeenCalledOnce();
    expect(callbacks.partial.mock.calls).toEqual([['hello'], ['hello there']]);
    expect(callbacks.turn).toHaveBeenCalledExactlyOnceWith('hello there');
    node.port.onmessage?.({ data: 'pcm' });
    socket.bufferedAmount = 128000;
    node.port.onmessage?.({ data: 'dropped' });
    expect(socket.send).toHaveBeenCalledExactlyOnceWith('pcm');
    capture.mute(true);
    expect(track.enabled).toBe(false);
    socket.message({ type: 'partial', text: 'ignored' });
    expect(callbacks.partial).toHaveBeenCalledTimes(2);
    capture.mute(false);
    expect(track.enabled).toBe(true);
    socket.onclose?.();
    expect(callbacks.error).toHaveBeenCalledOnce();
    capture.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(node.disconnect).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
