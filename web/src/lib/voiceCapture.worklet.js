/* Downsample microphone frames to mono 16 kHz signed PCM for realtime STT. */
class BuddyVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Int16Array(2048); this.offset = 0;
    this.phase = 0; this.sum = 0; this.count = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return false;
    for (const sample of samples) {
      this.sum += sample; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.buffer[this.offset++] = value < 0 ? value * 32768 : value * 32767;
        this.sum = 0; this.count = 0;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
          this.buffer = new Int16Array(2048); this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('buddy-voice-capture', BuddyVoiceCapture);
