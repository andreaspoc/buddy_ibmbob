/** Local call progress tones. Never mixed into the microphone or peer audio. */
export class PeopleCallSounds {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nodes = new Set<OscillatorNode>();
  private mode: 'outgoing' | 'incoming' | null = null;

  private audio() {
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext();
    return this.context;
  }
  async prime(): Promise<boolean> {
    try {
      const audio = this.audio();
      await audio.resume();
      return audio.state === 'running';
    } catch { return false; }
  }
  play(mode: 'outgoing' | 'incoming'): boolean {
    try {
      const audio = this.audio();
      if (audio.state !== 'running') return false;
      if (this.mode === mode && this.timer !== undefined) return true;
      this.stop(); this.mode = mode;
      const ring = () => {
        const now = audio.currentTime;
        const bursts = mode === 'outgoing' ? [[0, 1.1]] : [[0, .28], [.45, .28]];
        for (const [offset, duration] of bursts) {
          const gain = audio.createGain(); gain.connect(audio.destination);
          const start = now + offset, finish = start + duration;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(.035, start + .025);
          gain.gain.setValueAtTime(.035, finish - .03);
          gain.gain.linearRampToValueAtTime(0, finish);
          let remaining = 2;
          for (const frequency of mode === 'outgoing' ? [440, 480] : [660, 880]) {
            const oscillator = audio.createOscillator();
            oscillator.frequency.value = frequency; oscillator.connect(gain); this.nodes.add(oscillator);
            oscillator.onended = () => { this.nodes.delete(oscillator); oscillator.disconnect(); if (--remaining === 0) gain.disconnect(); };
            oscillator.start(start); oscillator.stop(finish + .01);
          }
        }
      };
      ring(); this.timer = setInterval(ring, mode === 'outgoing' ? 4000 : 3000);
      return true;
    } catch { this.stop(); return false; }
  }
  stop() {
    clearInterval(this.timer); this.timer = undefined; this.mode = null;
    for (const node of this.nodes) { try { node.stop(); } catch { /* Already ended. */ } node.disconnect(); }
    this.nodes.clear();
  }
  dispose() { this.stop(); const context = this.context; this.context = null; if (context && context.state !== 'closed') void context.close().catch(() => {}); }
}
