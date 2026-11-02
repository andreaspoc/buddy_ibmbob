// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types';

const voice = vi.hoisted(() => ({ captures: [] as any[], speakers: [] as any[], captureError: null as Error | null, deferred: null as Promise<void> | null }));
vi.mock('../../src/lib/realtimeVoice', () => ({
  VoiceCapture: class {
    start = vi.fn(async () => { if (voice.deferred) await voice.deferred; if (voice.captureError) throw voice.captureError; });
    stop = vi.fn(); mute = vi.fn();
    constructor(public callbacks: any) { voice.captures.push(this); }
  },
  VoiceSpeaker: class {
    append = vi.fn(); finish = vi.fn(); stop = vi.fn();
    constructor(public context: any, public voiceId: string, public callbacks: any) { voice.speakers.push(this); }
  },
}));
import { VoiceChat } from '../../src/components/VoiceChat';

class FakeAudioContext { state = FakeAudioContext.initial; resume = vi.fn(() => FakeAudioContext.resumeResult()); close = vi.fn(async () => { this.state = 'closed'; }); static initial = 'running'; static resumeResult = () => Promise.resolve(); }

let host: HTMLDivElement; let root: Root; let voicesResponse: () => any; let props: any;
const msg = (id: string, content: string, isStreaming = false): ChatMessage => ({ id, role: 'assistant', content, voiceMode: true, isStreaming } as any);
const render = async (extra: Record<string, unknown> = {}) => { props = { ...props, ...extra }; await act(async () => { root.render(<VoiceChat {...props} />); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const phase = () => host.querySelector('[role=status]')?.textContent;
const alertText = () => host.querySelector('[role=alert]')?.textContent;
const open = async () => { await render(); await click(button('Voice chat')); };
const startConversation = async (extra: Record<string, unknown> = {}) => { await open(); await render(extra); await click(button('Start conversation')); return voice.captures.at(-1); };
const lastSpeaker = () => voice.speakers.at(-1);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  voice.captures.length = 0; voice.speakers.length = 0; voice.captureError = null; voice.deferred = null;
  FakeAudioContext.initial = 'running'; FakeAudioContext.resumeResult = () => Promise.resolve();
  voicesResponse = () => ({ ok: true, json: async () => ({ voices: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }], default_voice_id: 'v2' }) });
  vi.stubGlobal('fetch', vi.fn(async () => voicesResponse()));
  vi.stubGlobal('AudioContext', FakeAudioContext); (window as any).AudioContext = FakeAudioContext;
  (window as any).AudioWorkletNode = class {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
  localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  props = { messages: [], busy: false, disabled: false, sessionId: 's1', onSend: vi.fn(), onStop: vi.fn(), onActiveChange: vi.fn(), readRequest: null };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); delete (window as any).AudioWorkletNode; });

describe('starting a conversation', () => {
  it('prefers the server default voice and enters listening', async () => {
    await startConversation();
    expect(phase()).toBe('Listening');
    expect(props.onActiveChange).toHaveBeenCalledWith(true);
    expect(host.querySelector('select')!.value).toBe('v2');
    expect(button('End conversation')).toBeTruthy();
  });
  it('falls back to first voice when no default matches', async () => {
    voicesResponse = () => ({ ok: true, json: async () => ({ voices: [{ id: 'v9', name: 'Nine' }] }) });
    await startConversation();
    expect(host.querySelector('select')!.value).toBe('v9');
  });
  it('keeps a stored voice preference', async () => {
    localStorage.setItem('buddy-voice-id', 'v1');
    await startConversation();
    expect(host.querySelector('select')!.value).toBe('v1');
  });
  it.each([
    [() => ({ ok: false, json: async () => ({ detail: 'Bad key' }) }), 'Bad key'],
    [() => ({ ok: false, json: async () => ({}) }), 'Could not load ElevenLabs voices.'],
    [() => ({ ok: true, json: async () => ({}) }), 'No ElevenLabs voices are available for this key.'],
  ])('reports voice loading failure %#', async (response, text) => {
    voicesResponse = response;
    await startConversation();
    expect(alertText()).toBe(text);
    expect(phase()).toBe('Ready');
  });
  it.each([
    [Object.assign(new Error('x'), { name: 'NotAllowedError' }), 'Microphone permission was denied. Allow it in your browser settings.'],
    [new Error('Mic broke'), 'Mic broke'],
  ])('reports microphone failure %#', async (error, text) => {
    voice.captureError = error;
    await startConversation();
    expect(alertText()).toBe(text);
  });
  it('explains unsupported browsers and disables starting', async () => {
    delete (window as any).AudioWorkletNode;
    await open();
    expect(button('Start conversation').disabled).toBe(true);
    expect(host.textContent).toContain('Live microphone audio needs HTTPS');
  });
  it('stops the microphone if the panel closes while starting', async () => {
    let release = () => {}; voice.deferred = new Promise<void>(r => { release = r; });
    await open();
    await click(button('Start conversation'));
    const mic = voice.captures[0];
    expect(phase()).toBe('Connecting');
    await click(host.querySelector('[aria-label="Close voice chat"]')!);
    await act(async () => { release(); await voice.deferred; });
    expect(mic.stop).toHaveBeenCalled();
    expect(props.onActiveChange).not.toHaveBeenCalledWith(true);
  });
  it('asks the user to retry when audio resume is blocked', async () => {
    FakeAudioContext.initial = 'suspended';
    FakeAudioContext.resumeResult = () => Promise.reject(new Error('blocked'));
    await open();
    await click(button('Start conversation'));
    await act(async () => { await Promise.resolve(); });
    expect(alertText()).toBe('Audio playback is blocked. Press Read aloud to retry.');
  });
});

describe('voice preferences', () => {
  it('loads voices on focus and remembers selection', async () => {
    await open();
    const select = host.querySelector('select')!;
    await act(async () => { select.focus(); });
    expect(select.options).toHaveLength(3);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'v1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(localStorage.getItem('buddy-voice-id')).toBe('v1');
    await act(async () => { select.blur(); select.focus(); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('displays a failure from focus-time loading', async () => {
    voicesResponse = () => ({ ok: false, json: async () => ({ detail: 'No key' }) });
    await open();
    await act(async () => { host.querySelector('select')!.focus(); });
    expect(alertText()).toBe('No key');
  });
});

describe('microphone callbacks', () => {
  it('sends completed turns and shows partials', async () => {
    const mic = await startConversation();
    await act(async () => mic.callbacks.partial('hel'));
    expect(host.querySelector('.voice-chat-transcript')?.textContent).toBe('hel');
    await act(async () => mic.callbacks.turn('hello'));
    expect(props.onSend).toHaveBeenCalledWith('hello');
    expect(phase()).toBe('Thinking');
  });
  it('ignores blank turns, and warns when composer is disabled', async () => {
    const mic = await startConversation();
    await act(async () => mic.callbacks.turn('   '));
    expect(props.onSend).not.toHaveBeenCalled();
    await render({ disabled: true });
    await act(async () => mic.callbacks.turn('hello'));
    expect(alertText()).toContain('Finish or remove the pending attachment');
    expect(props.onSend).not.toHaveBeenCalled();
  });
  it('queues turns while busy and flushes when idle', async () => {
    const mic = await startConversation();
    await render({ busy: true });
    await act(async () => { mic.callbacks.turn('first'); mic.callbacks.turn('second'); });
    expect(props.onSend).not.toHaveBeenCalled();
    await render({ busy: false });
    expect(props.onSend).toHaveBeenCalledWith('first second');
  });
  it('interrupts active reply on speech and stops the model', async () => {
    const mic = await startConversation();
    await render({ messages: [msg('a', 'Hello there.', true)], busy: true });
    expect(voice.speakers).toHaveLength(1);
    await act(async () => mic.callbacks.speech());
    expect(lastSpeaker().stop).toHaveBeenCalled();
    expect(props.onStop).toHaveBeenCalled();
    expect(phase()).toBe('Listening');
  });
  it('ignores callbacks while muted, and mute toggles labels and phase', async () => {
    const mic = await startConversation();
    await click(button('Mute'));
    expect(mic.mute).toHaveBeenLastCalledWith(true);
    expect(phase()).toBe('Microphone muted');
    await act(async () => { mic.callbacks.partial('ignored'); mic.callbacks.speech(); mic.callbacks.turn('ignored'); });
    expect(host.querySelector('.voice-chat-transcript')).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled();
    await click(button('Interrupt'));
    expect(phase()).toBe('Microphone muted');
    await render({ messages: [] , busy: false });
    await click(button('Unmute'));
    expect(phase()).toBe('Listening');
  });
  it('shows capture errors and ends conversation', async () => {
    const mic = await startConversation();
    await act(async () => mic.callbacks.error('Socket lost'));
    expect(alertText()).toBe('Socket lost');
    expect(button('Start conversation')).toBeTruthy();
    expect(mic.stop).toHaveBeenCalled();
  });
});

describe('spoken replies', () => {
  it('speaks complete sentences while streaming then finishes the turn', async () => {
    await startConversation();
    await render({ messages: [msg('a', 'One sentence. Partial', true)] });
    const speaker = lastSpeaker();
    expect(phase()).toBe('Preparing voice');
    expect(speaker.append).toHaveBeenCalledWith('One sentence. ');
    await act(async () => speaker.callbacks.speaking());
    expect(phase()).toBe('Speaking');
    expect(host.querySelector('.voice-chat-orb')?.className).toContain('is-speaking');
    await render({ messages: [msg('a', 'One sentence. Partial rest', false)] });
    expect(speaker.append).toHaveBeenLastCalledWith('Partial rest ');
    expect(speaker.finish).toHaveBeenCalled();
    await act(async () => speaker.callbacks.done());
    expect(phase()).toBe('Listening');
  });
  it('flushes long unpunctuated text at a word boundary', async () => {
    await startConversation();
    const long = 'word '.repeat(60).trim();
    await render({ messages: [msg('a', long, true)] });
    const appended = lastSpeaker().append.mock.calls[0][0] as string;
    expect(appended.length).toBeLessThanOrEqual(241);
    expect(appended.trim().endsWith('word')).toBe(true);
  });
  it('waits when short text has no sentence end', async () => {
    await startConversation();
    await render({ messages: [msg('a', 'short fragment', true)] });
    expect(lastSpeaker().append).not.toHaveBeenCalled();
  });
  it('marks empty final replies as seen and returns to listening', async () => {
    await startConversation();
    await render({ messages: [msg('a', '```js\ncode\n```', false)] });
    expect(voice.speakers).toHaveLength(0);
    expect(phase()).toBe('Listening');
    await render({ messages: [msg('b', '', true)], busy: true });
    expect(voice.speakers).toHaveLength(0);
  });
  it('restarts speech when the provider replaces already spoken text', async () => {
    await startConversation();
    await render({ messages: [msg('a', 'First version. ', true)] });
    const first = lastSpeaker();
    await render({ messages: [msg('a', 'Replacement text. ', true)] });
    expect(first.stop).toHaveBeenCalled();
    await render({ messages: [msg('a', 'Replacement final.', false)] });
    expect(lastSpeaker()).not.toBe(first);
    expect(lastSpeaker().append).toHaveBeenCalledWith('Replacement final. ');
    expect(lastSpeaker().finish).toHaveBeenCalled();
  });
  it('restarts cleanly when a final reply replaces spoken text', async () => {
    await startConversation();
    await render({ messages: [msg('a', 'Spoken first. ', true)] });
    const first = lastSpeaker();
    await render({ messages: [msg('a', 'Entirely different.', false)] });
    expect(first.stop).toHaveBeenCalled();
    expect(lastSpeaker()).not.toBe(first);
    expect(lastSpeaker().append).toHaveBeenCalledWith('Entirely different. ');
    expect(lastSpeaker().finish).toHaveBeenCalled();
  });
  it('fails conversation on speaker errors, ignoring stale speakers', async () => {
    await startConversation();
    await render({ messages: [msg('a', 'Hello. ', true)] });
    const first = lastSpeaker();
    await act(async () => first.callbacks.error('Speech failed'));
    expect(alertText()).toBe('Speech failed');
    await act(async () => { first.callbacks.speaking(); first.callbacks.done(); first.callbacks.error('late'); });
    expect(alertText()).toBe('Speech failed');
    expect(phase()).toBe('Ready');
  });
  it('shows thinking state when busy without a reply', async () => {
    await startConversation();
    await render({ busy: true, messages: [{ id: 'u', role: 'user', content: 'hi' } as any] });
    expect(phase()).toBe('Thinking');
  });
  it('does not repeat messages seen before the conversation started', async () => {
    await startConversation({ messages: [msg('old', 'Old reply.')] });
    await render({ messages: [msg('old', 'Old reply.')], busy: false });
    expect(voice.speakers).toHaveLength(0);
  });
});

describe('read aloud', () => {
  it('reads text and stops on request', async () => {
    await render({ readRequest: { text: 'Read me.', nonce: 1 } });
    const speaker = lastSpeaker();
    expect(speaker.append).toHaveBeenCalledWith('Read me. ');
    expect(speaker.finish).toHaveBeenCalled();
    await click(button('Stop audio'));
    expect(speaker.stop).toHaveBeenCalled();
    expect(phase()).toBe('Ready');
  });
  it('reports replies without speakable text', async () => {
    await render({ readRequest: { text: '```\ncode\n```', nonce: 1 } });
    expect(phase()).toBe('No spoken text in this reply');
  });
  it('reports voice failures when reading', async () => {
    voicesResponse = () => ({ ok: false, json: async () => ({ detail: 'Quota' }) });
    await render({ readRequest: { text: 'Hi', nonce: 2 } });
    expect(alertText()).toBe('Quota');
  });
  it('is ignored while voice is disabled', async () => {
    await render({ enabled: false, readRequest: { text: 'Hi', nonce: 3 } });
    expect(host.querySelector('.voice-chat-panel')).toBeNull();
  });
});

describe('ending the mode', () => {
  it('ends when disabled, on session change, and when hidden', async () => {
    await startConversation();
    await render({ sessionId: 's2' });
    expect(button('Start conversation')).toBeTruthy();
    await click(button('Start conversation'));
    await render({ enabled: false });
    expect(button('Start conversation')).toBeTruthy();
    await render({ enabled: true });
    await click(button('Start conversation'));
    expect(button('End conversation')).toBeTruthy();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    expect(button('Start conversation')).toBeTruthy();
  });
  it('closes when another composer tool is used, but not for inner clicks', async () => {
    await startConversation();
    const tool = document.createElement('div'); tool.className = 'composer-context-tools'; document.body.append(tool);
    await act(async () => { host.querySelector('.voice-chat-panel')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(host.querySelector('.voice-chat-panel')).not.toBeNull();
    await act(async () => { tool.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    tool.remove();
    expect(host.querySelector('.voice-chat-panel')).toBeNull();
  });
  it('closes on document Escape and returns focus to the launcher', async () => {
    await open();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(host.querySelector('.voice-chat-panel')).toBeNull();
    expect(document.activeElement).toBe(button('Voice chat'));
  });
  it('closes on panel Escape and via launcher toggle', async () => {
    await open();
    await act(async () => { host.querySelector('.voice-chat-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(host.querySelector('.voice-chat-panel')).toBeNull();
    await click(button('Voice chat'));
    await click(button('Voice chat'));
    expect(button('Voice chat').getAttribute('aria-expanded')).toBe('false');
  });
  it('End conversation stops capture and closes the audio context', async () => {
    const mic = await startConversation();
    await click(button('End conversation'));
    expect(mic.stop).toHaveBeenCalled();
    expect(props.onActiveChange).toHaveBeenLastCalledWith(false);
  });
});
