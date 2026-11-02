type CaptureCallbacks = { partial: (text: string) => void; speech: () => void; turn: (text: string) => void; error: (message: string) => void };
type SpeakerCallbacks = { speaking: () => void; done: () => void; error: (message: string) => void };
function socketURL(path: string) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}
export class VoiceCapture {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stopped = false;
  private speaking = false;
  private muted = false;
  private callbacks: CaptureCallbacks;
  constructor(callbacks: CaptureCallbacks) { this.callbacks = callbacks; }
  async start() {
    try {
      const context = new AudioContext(); this.context = context;
      await context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      await context.audioWorklet.addModule(new URL('./voiceCapture.worklet.js', import.meta.url).href);
      if (this.stopped) return;
      const socket = new WebSocket(socketURL('/voice/listen')); this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Voice connection timed out. Please reconnect.')), 20000);
        socket.onmessage = event => {
          const data = JSON.parse(event.data);
          if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
          if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
        };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error('Could not connect to live voice.')); };
        socket.onclose = () => { clearTimeout(timeout); reject(new Error('Live voice disconnected. Please reconnect.')); };
      });
      if (this.stopped) return;
      socket.onmessage = event => {
        if (this.stopped || this.muted) return;
        const data = JSON.parse(event.data);
        const text = String(data.text || '').trim();
        if (data.type === 'error') { this.callbacks.error(data.message); return; }
        if (data.type === 'partial' && text) {
          if (!this.speaking) { this.speaking = true; this.callbacks.speech(); }
          this.callbacks.partial(text);
        }
        if (data.type === 'transcript' && text) {
          if (!this.speaking) this.callbacks.speech();
          this.speaking = false; this.callbacks.turn(text);
        }
      };
      socket.onclose = () => { if (!this.stopped) this.callbacks.error('Live voice disconnected. Press Start conversation to reconnect.'); };
      socket.onerror = () => { if (!this.stopped) this.callbacks.error('Voice connection failed. Please reconnect.'); };
      this.source = context.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(context, 'buddy-voice-capture');
      this.node.port.onmessage = event => {
        if (!this.stopped && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 128000) socket.send(event.data);
      };
      this.source.connect(this.node);
      // The processor outputs silence; connecting it keeps the capture graph active.
      this.node.connect(context.destination);
    } catch (e) {
      if (!this.stopped) { this.stop(); throw e; }
    }
  }
  mute(muted: boolean) {
    this.muted = muted; this.speaking = false;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }
  stop() {
    this.stopped = true;
    this.socket?.close(); this.socket = null;
    this.node?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}

/** Streams 24 kHz PCM directly into a scheduled Web Audio playback queue. */
export class VoiceSpeaker {
  private socket: WebSocket;
  private pending: object[] = [];
  private ready = false;
  private finished = false;
  private cancelled = false;
  private completed = false;
  private received = false;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private timeout: ReturnType<typeof setTimeout>;
  private context: AudioContext;
  private callbacks: SpeakerCallbacks;
  constructor(context: AudioContext, voiceId: string, callbacks: SpeakerCallbacks) {
    this.context = context; this.callbacks = callbacks;
    this.socket = new WebSocket(socketURL('/voice/speak'));
    this.socket.binaryType = 'arraybuffer';
    this.timeout = setTimeout(() => this.fail('Speech connection timed out. Please retry.'), 20000);
    this.socket.onopen = () => { if (!this.cancelled) this.socket.send(JSON.stringify({voice_id:voiceId})); };
    this.socket.onmessage = event => {
      if (this.cancelled) return;
      if (event.data instanceof ArrayBuffer) { this.play(event.data); return; }
      const data = JSON.parse(event.data);
      if (data.type === 'ready') {
        clearTimeout(this.timeout); this.ready = true;
        for (const item of this.pending) this.socket.send(JSON.stringify(item));
        this.pending = [];
      } else if (data.type === 'done') { this.finished = true; this.complete(); }
      else if (data.type === 'error') this.fail(data.message);
    };
    this.socket.onerror = () => this.fail('Speech connection failed. Please retry.');
    this.socket.onclose = () => { if (!this.cancelled && !this.finished) this.fail('The speech stream disconnected before it finished.'); };
  }
  private send(data: object) {
    if (this.cancelled) return;
    if (this.ready && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data));
    else this.pending.push(data);
  }
  append(text: string) { if (text) this.send({text,flush:true}); }
  finish() { this.send({done:true}); }
  private play(bytes: ArrayBuffer) {
    if (bytes.byteLength % 2) { this.fail('Invalid voice audio received.'); return; }
    this.received = true;
    const buffer = this.context.createBuffer(1, bytes.byteLength / 2, 24000);
    const channel = buffer.getChannelData(0), pcm = new DataView(bytes);
    for (let i=0;i<channel.length;i++) channel[i] = pcm.getInt16(i*2,true)/32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); this.complete(); };
    const start = Math.max(this.context.currentTime + .015, this.nextTime);
    source.start(start); this.nextTime = start + buffer.duration;
    this.callbacks.speaking();
  }
  private complete() {
    if (!this.cancelled && !this.completed && this.finished && !this.sources.size) {
      if (!this.received) { this.fail('ElevenLabs returned no audio. Check the voice and account credits.'); return; }
      this.completed = true; this.callbacks.done();
    }
  }
  private fail(message: string) {
    if (this.cancelled || this.completed) return;
    this.stop(); this.callbacks.error(message);
  }
  stop() {
    this.cancelled = true; clearTimeout(this.timeout);
    this.socket.close(); this.pending = [];
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextTime = 0;
  }
}
