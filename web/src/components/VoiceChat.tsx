import { useEffect, useId, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { t } from '../lib/i18n';
import { speechChunks, speechText } from '../lib/voice';
import { VoiceCapture, VoiceSpeaker } from '../lib/realtimeVoice';
import './VoiceChat.css';

type Voice = { id: string; name: string };
type ReadRequest = { text: string; nonce: number };
export function VoiceChat({ messages, busy, disabled, enabled = true, sessionId, onSend, onStop, onActiveChange, readRequest }: {
  messages: ChatMessage[]; busy: boolean; disabled: boolean; enabled?: boolean; sessionId?: string;
  onSend: (text: string) => void; onStop: () => void; onActiveChange: (active: boolean) => void; readRequest: ReadRequest | null;
}) {
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [panel, setPanel] = useState(false);
  const [phase, setPhase] = useState('Ready');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState(() => { try { return localStorage.getItem('buddy-voice-id') || ''; } catch { return ''; } });
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const live = useRef({ busy, disabled, enabled, onSend, onStop, onActiveChange, messages });
  live.current = { busy, disabled, enabled, onSend, onStop, onActiveChange, messages };
  const mode = useRef(false);
  const paused = useRef(false);
  const capture = useRef<VoiceCapture | null>(null);
  const speaker = useRef<VoiceSpeaker | null>(null);
  const context = useRef<AudioContext | null>(null);
  const turn = useRef<{ id: string; sent: string; finished: boolean } | null>(null);
  const generation = useRef(0);
  const pending = useRef('');
  const seen = useRef(new Set<string>());
  const selected = useRef(voice);
  const voiceList = useRef<Voice[]>([]);
  const previousSession = useRef(sessionId);
  const mounted = useRef(true);
  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.AudioContext === 'function' && typeof window.AudioWorkletNode === 'function';

  function stopAudio() {
    speaker.current?.stop(); speaker.current = null; turn.current = null;
    if (mounted.current) setPlaying(false);
  }
  function end() {
    generation.current++; mode.current = false; paused.current = false; pending.current = '';
    capture.current?.stop(); capture.current = null; stopAudio();
    if (context.current && context.current.state !== 'closed') void context.current.close();
    context.current = null;
    if (mounted.current) { setActive(false); setMuted(false); setDraft(''); setPhase('Ready'); }
    live.current.onActiveChange(false);
  }
  function fail(message: string) { if (mounted.current) { end(); setError(message); } }
  function outputContext() {
    if (!context.current || context.current.state === 'closed') context.current = new AudioContext();
    if (context.current.state === 'suspended') void context.current.resume().catch(() => fail('Audio playback is blocked. Press Read aloud to retry.'));
    return context.current;
  }
  function interrupt() {
    for (const message of live.current.messages) seen.current.add(message.id);
    stopAudio();
    if (live.current.busy) live.current.onStop();
    setPhase(paused.current ? 'Microphone muted' : mode.current ? 'Listening' : 'Ready');
  }
  function submit(text: string) {
    if (!mode.current || paused.current || !text.trim()) return;
    if (live.current.disabled) { setError('Finish or remove the pending attachment before starting a voice turn.'); return; }
    setDraft(text);
    if (live.current.busy) { pending.current = [pending.current, text].filter(Boolean).join(' '); return; }
    setPhase('Thinking'); live.current.onSend(text);
  }
  async function loadVoices(): Promise<string> {
    if (selected.current && voiceList.current.length) return selected.current;
    const response = await fetch('/voice/voices');
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Could not load ElevenLabs voices.');
    const list: Voice[] = data.voices || [];
    if (!list.length) throw new Error('No ElevenLabs voices are available for this key.');
    const id = list.some(v => v.id === selected.current) ? selected.current : list.some(v => v.id === data.default_voice_id) ? data.default_voice_id : list[0].id;
    if (!mounted.current) return id;
    voiceList.current = list; setVoices(list); setVoice(id); selected.current = id; return id;
  }
  function makeSpeaker() {
    const instance = new VoiceSpeaker(outputContext(), selected.current, {
      speaking: () => { if (speaker.current === instance && mounted.current) { setPlaying(true); setPhase('Speaking'); } },
      done: () => { if (speaker.current === instance && mounted.current) { speaker.current = null; setPlaying(false); setPhase(paused.current ? 'Microphone muted' : mode.current ? 'Listening' : 'Ready'); } },
      error: message => { if (speaker.current === instance) fail(message); },
    });
    speaker.current = instance; setPlaying(true); setPhase('Preparing voice'); return instance;
  }
  async function readAloud(content: string) {
    stopAudio(); setError('');
    const token = ++generation.current;
    try {
      outputContext(); await loadVoices();
      if (!mounted.current || token !== generation.current) return;
      const text = speechText(content).slice(0,18000);
      if (!text) { setPhase('No spoken text in this reply'); return; }
      const output = makeSpeaker();
      for (const chunk of speechChunks(text)) output.append(chunk + ' ');
      output.finish();
    } catch (e) { if (token === generation.current) fail((e as Error).message); }
  }
  function updateSpeech(message: ChatMessage) {
    const text = speechText(message.content).slice(0,18000);
    if (turn.current?.id !== message.id) {
      if (!text) { if (!message.isStreaming) { seen.current.add(message.id); setPhase('Listening'); } return; }
      stopAudio(); makeSpeaker(); turn.current = { id: message.id, sent: '', finished: false };
    }
    const current = turn.current;
    if (!current || current.finished || !speaker.current) return;
    if (!text.startsWith(current.sent)) {
      // A provider replacement invalidates already spoken text. Stop and wait
      // for the final replacement rather than speaking both versions at once.
      stopAudio();
      if (message.isStreaming) return;
      makeSpeaker(); turn.current = { id: message.id, sent: '', finished: false };
      updateSpeech(message); return;
    }
    const rest = text.slice(current.sent.length);
    let count = rest.length;
    if (message.isStreaming) {
      const sentence = [...rest.matchAll(/[.!?](?:\s|$)/g)].at(-1);
      count = sentence ? sentence.index + 1 : rest.length > 240 ? rest.slice(0,240).lastIndexOf(' ') : 0;
    }
    if (count > 0) {
      const part = rest.slice(0,count);
      for (const chunk of speechChunks(part)) speaker.current.append(chunk + ' ');
      current.sent += part;
    }
    if (!message.isStreaming) { current.finished = true; seen.current.add(message.id); speaker.current.finish(); }
  }
  async function start() {
    setPanel(true); setError(''); setPhase('Connecting');
    const token = ++generation.current;
    try {
      outputContext(); await loadVoices();
      if (!mounted.current || token !== generation.current) return;
      const microphone = new VoiceCapture({
        speech: () => { if (mode.current && !paused.current) interrupt(); },
        partial: text => { if (mode.current && !paused.current) { setDraft(text); setPhase('Listening'); } },
        turn: text => submit(text),
        error: fail,
      });
      capture.current = microphone;
      await microphone.start();
      if (!mounted.current || token !== generation.current) { microphone.stop(); return; }
      seen.current = new Set(live.current.messages.map(m => m.id));
      mode.current = true; setActive(true); setPhase('Listening'); live.current.onActiveChange(true);
    } catch (e) { if (mounted.current && token === generation.current) fail((e as Error).name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser settings.' : (e as Error).message); }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; end(); };
  }, []);
  useEffect(() => { if (!enabled) end(); }, [enabled]);
  useEffect(() => {
    if (previousSession.current && previousSession.current !== sessionId) end();
    previousSession.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    if (!mode.current) return;
    if (!busy && pending.current) { const text = pending.current; pending.current = ''; submit(text); return; }
    const reply = [...messages].reverse().find(m => m.role === 'assistant' && m.voiceMode && !seen.current.has(m.id));
    if (reply) updateSpeech(reply);
    else if (!speaker.current) setPhase(busy ? 'Thinking' : paused.current ? 'Microphone muted' : 'Listening');
  }, [messages, busy, disabled]);
  useEffect(() => { if (readRequest && enabled) { setPanel(true); void readAloud(readRequest.text); } }, [readRequest]);
  useEffect(() => {
    const visibility = () => { if (document.hidden) end(); };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    if (!panel) return;
    const close = () => { end(); setPanel(false); };
    const otherTool = (event: PointerEvent) => {
      if (event.target instanceof Element && !host.current?.contains(event.target) && event.target.closest('.composer-context-tools,.composer-tool-shortcuts')) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', otherTool);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', otherTool); document.removeEventListener('keydown', escape); };
  }, [panel]);
  return <div ref={host} className={`voice-chat ${active ? 'is-active' : ''}`}>

    <button type="button" ref={trigger} className="composer-websearch-btn" aria-controls={panelId} aria-expanded={panel} onClick={() => { if (panel) { end(); setPanel(false); } else setPanel(true); }}>
      <span aria-hidden="true">◉</span> {t('Voice chat')}
    </button>
    {panel && <section id={panelId} className="voice-chat-panel" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(); setPanel(false); trigger.current?.focus(); } }} aria-label={t('Voice conversation')}>
      <div className="voice-chat-heading"><span className={`voice-chat-orb ${phase === 'Speaking' ? 'is-speaking' : ''}`} aria-hidden="true">◉</span><div><strong>{t('Talk with Buddy')}</strong><span role="status">{t(phase)}</span></div><button type="button" aria-label={t('Close voice chat')} onClick={() => { end(); setPanel(false); }}>×</button></div>
      <p className="voice-chat-description">{t('Have a spoken discussion. Buddy gives short natural answers, without charts, diagrams, or follow-up forms. Start speaking to interrupt.')}</p>
      <p className="voice-chat-privacy">{t('Microphone audio and spoken reply text are streamed to ElevenLabs. Echo cancellation is enabled; headphones help when using speakers. Listening ends when you close this mode or leave the chat.')}</p>
      {draft && <p className="voice-chat-transcript">{draft}</p>}
      {error && <p className="voice-chat-error" role="alert">{t(error)}</p>}
      <div className="voice-chat-controls">
        <label>{t('Voice')}<select aria-label={t('Reply voice')} value={voice} disabled={playing} onFocus={() => { void loadVoices().catch(e => setError(e.message)); }} onChange={e => { setVoice(e.target.value); selected.current = e.target.value; try { localStorage.setItem('buddy-voice-id', e.target.value); } catch { /* Optional preference. */ } }}><option value="">{t('Choose a voice')}</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        {!active ? <button type="button" className="voice-chat-start" disabled={busy || disabled || !supported || phase === 'Connecting'} onClick={() => void start()}>{t('Start conversation')}</button> : <>
          <button type="button" aria-pressed={muted} onClick={() => { paused.current = !paused.current; capture.current?.mute(paused.current); setMuted(paused.current); if (!speaker.current) setPhase(paused.current ? 'Microphone muted' : 'Listening'); }}>{t(muted ? 'Unmute' : 'Mute')}</button>
          <button type="button" onClick={interrupt}>{t('Interrupt')}</button>
          <button type="button" className="voice-chat-end" onClick={end}>{t('End conversation')}</button>
        </>}
        {!active && playing && <button type="button" onClick={() => { stopAudio(); setPhase('Ready'); }}>{t('Stop audio')}</button>}
      </div>
      {!supported && <p className="voice-chat-description">{t('Live microphone audio needs HTTPS and a browser with Web Audio support. Read aloud remains available.')}</p>}
    </section>}
  </div>;
}
