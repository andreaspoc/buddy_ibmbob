import { useEffect, useRef, useState } from 'react';
import type { PeopleVoice } from '../lib/usePeopleVoice';
import { t } from '../lib/i18n';
import './PeopleVoiceCall.css';

export function PeopleVoiceCall({ voice, onOpen }: { voice: PeopleVoice; onOpen: (roomId: number) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    element.srcObject = voice.remote;
    setNeedsPlay(false);
    if (voice.remote) void element.play().catch(() => setNeedsPlay(true));
    return () => { element.srcObject = null; };
  }, [voice.remote]);
  const call = voice.call;
  const status = call ? ({preparing: 'Waiting for microphone permission…', incoming: 'Incoming voice call', ringing: 'Ringing…', connecting: 'Connecting audio…', connected: 'Voice call connected'}[call.phase]) : '';
  return <div className="people-voice-host">
    <audio ref={audio} autoPlay playsInline aria-label={t('Voice call audio')} />
    {call && <section className="people-voice-call" data-phase={call.phase} role="region" aria-label={t('Voice call')}>
      <div className="people-voice-status" role="status"><strong>{call.name}</strong><span>{t(status)}</span></div>
      <div className="people-voice-controls">
        {call.phase === 'incoming' ? <><button type="button" className="people-voice-answer" onClick={() => void voice.answer()}>{t('Answer')}</button><button type="button" className="people-voice-end" onClick={voice.decline}>{t('Decline')}</button></> : <>
          {call.phase !== 'preparing' && <button type="button" aria-pressed={call.muted} onClick={voice.mute}>{t(call.muted ? 'Unmute microphone' : 'Mute microphone')}</button>}
          <button type="button" className="people-voice-end" onClick={voice.hangup}>{t('Hang up')}</button>
        </>}
        <button type="button" onClick={() => onOpen(call.roomId)}>{t('Open conversation')}</button>
        {voice.soundBlocked && <button type="button" onClick={() => void voice.enableSound()}>{t('Enable ringing sound')}</button>}
        {(needsPlay || voice.playbackBlocked) && <button type="button" onClick={() => voice.playbackBlocked ? void voice.resumeAudio() : void audio.current?.play().then(() => setNeedsPlay(false)).catch(() => setNeedsPlay(true))}>{t('Play call audio')}</button>}
      </div>
    </section>}
    {voice.notice && !/^(Missed voice call from|Call was not answered)/.test(voice.notice) && <div className="people-voice-notice" role="status"><span>{t(voice.notice)}</span><button type="button" onClick={voice.dismiss} aria-label={t('Dismiss call notice')}>×</button></div>}
  </div>;
}
