import { brandText } from './brand';
/** Browser-encrypted, audio-only call transport over Buddy's existing WSS origin. */
export class PeopleSocketAudio {
  private socket: WebSocket | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private key: CryptoKey | null = null;
  private stopped = false;
  private captureStarted = false;
  private connected = false;
  private counter = 0;
  private prefix = crypto.getRandomValues(new Uint8Array(8));
  private receivedPrefix: Uint8Array | null = null;
  private receivedCounter = -1;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private sending = Promise.resolve();
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private context: AudioContext;
  private stream: MediaStream;
  private callId: string;
  private clientId: string;
  private role: 'caller' | 'callee';
  private callbacks: { connected: () => void; error: (message: string) => void; blocked: (value: boolean) => void };
  constructor(context: AudioContext, stream: MediaStream, callId: string, clientId: string, role: 'caller' | 'callee', callbacks: { connected: () => void; error: (message: string) => void; blocked: (value: boolean) => void }) {
    this.prefix[0]=(this.prefix[0]&0x7f)|(role==='callee'?0x80:0);
    this.context=context;this.stream=stream;this.callId=callId;this.clientId=clientId;this.role=role;this.callbacks=callbacks;
  }
  async start() {
    try {
      const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveKey']);
      const publicKey = await crypto.subtle.exportKey('jwk',pair.publicKey);
      if (this.stopped) return;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/community/calls/${this.callId}/audio`);
      this.socket = socket; socket.binaryType = 'arraybuffer';
      let receiving = Promise.resolve();
      socket.onopen = () => { if (!this.stopped) socket.send(JSON.stringify({client_id:this.clientId,public_key:{kty:'EC',crv:'P-256',x:publicKey.x,y:publicKey.y}})); };
      socket.onmessage = event => {
        receiving = receiving.then(async () => {
          if (this.stopped) return;
          if (typeof event.data === 'string') {
            const value = JSON.parse(event.data);
            if (value.type === 'audio_peer' && !this.key) {
              const remote = await crypto.subtle.importKey('jwk',value.public_key,{name:'ECDH',namedCurve:'P-256'},false,[]);
              const key = await crypto.subtle.deriveKey({name:'ECDH',public:remote},pair.privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
              if (this.stopped) return;
              this.key = key; await this.capture();
            }
          } else if (event.data instanceof ArrayBuffer) await this.receive(event.data);
        }).catch(() => this.fail('Secure call audio could not be established. Please call again.'));
      };
      socket.onerror = () => this.fail(brandText('Buddy’s audio connection failed. Please call again.'));
      socket.onclose = () => { if (!this.stopped) this.closeTimer=setTimeout(()=>this.fail(brandText('Buddy’s audio connection closed. Please call again.')),200); };
    } catch (error) { if (!this.stopped) this.fail(error instanceof Error ? error.message : 'Could not start secure call audio.'); }
  }
  private async capture() {
    if (this.captureStarted || this.stopped) return;
    this.captureStarted = true;
    this.callbacks.blocked(this.context.state !== 'running');
    void this.context.resume().then(()=>{if(!this.stopped)this.callbacks.blocked(this.context.state !== 'running');}).catch(()=>{if(!this.stopped)this.callbacks.blocked(true);});
    await this.context.audioWorklet.addModule(new URL('./voiceCapture.worklet.js',import.meta.url).href);
    if (this.stopped) return;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context,'buddy-voice-capture');
    this.node.port.onmessage = event => {
      if (this.stopped || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 32000) return;
      const bytes = event.data as ArrayBuffer;
      this.sending = this.sending.then(async () => {
        if (this.stopped || !this.key || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 32000) return;
        if (this.counter >= 0xffffffff) throw new Error('Call encryption limit reached');
        // IV = 8-byte random prefix (set at construction) + 4-byte counter; unique per call.
        const iv = new Uint8Array(12); iv.set(this.prefix); new DataView(iv.buffer).setUint32(8,this.counter++);
        const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`${this.callId}:${this.role}`)},this.key,bytes);
        if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) {
          const packet = new Uint8Array(12+encrypted.byteLength);packet.set(iv);packet.set(new Uint8Array(encrypted),12);this.socket.send(packet.buffer);
        }
      }).catch(() => this.fail('Could not send secure call audio. Please call again.'));
    };
    this.source.connect(this.node);this.node.connect(this.context.destination);
  }
  private async receive(packet: ArrayBuffer) {
    if (!this.key || packet.byteLength !== 4124 || this.stopped) return;
    const iv = new Uint8Array(packet.slice(0,12)), counter = new DataView(iv.buffer).getUint32(8);
    if (counter <= this.receivedCounter || this.receivedPrefix && !this.receivedPrefix.every((value,index) => value===iv[index])) return;
    const other = this.role === 'caller' ? 'callee' : 'caller';
    const bytes = await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`${this.callId}:${other}`)},this.key,packet.slice(12));
    if (this.stopped) return;
    this.receivedPrefix = iv.slice(0,8);this.receivedCounter=counter;
    const buffer = this.context.createBuffer(1,bytes.byteLength/2,16000), samples=buffer.getChannelData(0), pcm=new DataView(bytes);
    for(let i=0;i<samples.length;i++)samples[i]=pcm.getInt16(i*2,true)/32768;
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);this.sources.add(source);
    source.onended=()=>{this.sources.delete(source);source.disconnect();};
    if (this.nextTime > this.context.currentTime+.5) { for (const old of this.sources) if(old!==source){old.stop();old.disconnect();}this.nextTime=0; }
    const start=Math.max(this.context.currentTime+.03,this.nextTime);source.start(start);this.nextTime=start+buffer.duration;
    this.callbacks.blocked(this.context.state !== 'running');
    if(!this.connected){this.connected=true;this.callbacks.connected();}
  }
  private fail(message: string) { if(this.stopped)return;this.stop();this.callbacks.error(message); }
  stop() {
    this.stopped=true;clearTimeout(this.closeTimer);this.socket?.close();this.socket=null;this.node?.disconnect();this.source?.disconnect();
    for(const source of this.sources){source.onended=null;try{source.stop();}catch{}source.disconnect();}this.sources.clear();this.key=null;this.receivedPrefix=null;
  }
}
