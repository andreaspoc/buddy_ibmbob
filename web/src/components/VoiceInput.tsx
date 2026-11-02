import { getLanguage, getLocale } from "../lib/i18n";
import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';

// The browser API is prefixed in some engines and absent in others.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

export function VoiceInput({ onTranscript, disabled }: {
  onTranscript: (text: string) => void; disabled: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const callback = useRef(onTranscript);
  useEffect(() => { callback.current = onTranscript; }, [onTranscript]);
  const win = window as SpeechWindow;
  const Constructor = win.SpeechRecognition || win.webkitSpeechRecognition;
  useEffect(() => () => {
    if (recognition.current) {
      recognition.current.onresult = null;
      recognition.current.onerror = null;
      recognition.current.onend = null;
      recognition.current.abort();
      recognition.current = null;
    }
  }, []);
  useEffect(() => {
    if (disabled) recognition.current?.stop();
  }, [disabled]);

  function toggle() {
    if (listening) { recognition.current?.stop(); return; }
    if (!Constructor) return;
    const instance = new Constructor();
    recognition.current = instance;
    instance.lang = getLanguage() === 'en' ? navigator.language || 'en-US' : getLocale();
    instance.continuous = true;
    instance.interimResults = false;
    instance.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) callback.current(event.results[i][0].transcript);
      }
    };
    instance.onerror = event => {
      setError(event.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice input failed: ${event.error}`);
      setListening(false);
    };
    instance.onend = () => { setListening(false); recognition.current = null; };
    try { setError(''); instance.start(); setListening(true); }
    catch { setError('Could not start voice input.'); setListening(false); recognition.current = null; }
  }
  return <>
    <button type="button" className={`composer-websearch-btn ${listening ? 'active' : ''}`}
      disabled={disabled || !Constructor} onClick={toggle} aria-pressed={listening}
      title={Constructor ? t("Dictate editable text. Your browser may use its provider’s speech service. Review before sending.") : t("Voice input is unavailable in this browser.")}>
      {listening ? t("⏹ Stop microphone") : t("🎙 Dictate")}
    </button>
    {error && <span role="alert" className="voice-error">{t(error)}</span>}
  </>;
}
