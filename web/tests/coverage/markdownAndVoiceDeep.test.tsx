// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownView } from '../../src/components/MarkdownView';
import { usePeopleVoice } from '../../src/lib/usePeopleVoice';
import { PeopleVoiceCall } from '../../src/components/PeopleVoiceCall';
import { VoiceChat } from '../../src/components/VoiceChat';
import { VoiceInput } from '../../src/components/VoiceInput';
import type { ChatMessage } from '../../src/types';

// Polyfills and mocks for Web Audio, WebRTC, MediaDevices and Speech
class MockMediaStreamTrack {
  kind = 'audio';
  enabled = true;
  stop = vi.fn();
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[];
  constructor(tracks?: MockMediaStreamTrack[]) {
    this.tracks = tracks || [new MockMediaStreamTrack()];
  }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class MockRTCPeerConnection {
  iceServers: any[];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGathererState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: any) => void) | null = null;
  onicecandidateerror: ((event: any) => void) | null = null;
  ontrack: ((event: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(config?: any) {
    this.iceServers = config?.iceServers || [];
    latestMockPeer = this;
  }
  addTrack = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'v=0\r\no=mock 123 1 IN IP4 127.0.0.1\r\ns=mock' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\no=mock 123 2 IN IP4 127.0.0.1\r\ns=mock' });
  setLocalDescription = vi.fn().mockImplementation(async (desc) => {
    this.localDescription = desc;
  });
  setRemoteDescription = vi.fn().mockImplementation(async (desc) => {
    this.remoteDescription = desc;
  });
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
}

let latestMockPeer: MockRTCPeerConnection | null = null;

class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createGain = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
  });
  createOscillator = vi.fn().mockReturnValue({
    frequency: { value: 440 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  });
  createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
  });
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((event: any) => void) | null,
    postMessage: vi.fn(),
  };
  connect = vi.fn();
}

// Mock WebSockets for voice calls and voice listen
const activeCallSockets: MockVoiceWebSocket[] = [];
class MockVoiceWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sentMessages: any[] = [];

  constructor(url: string) {
    this.url = url;
    activeCallSockets.push(this);
    setTimeout(() => {
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    try {
      this.sentMessages.push(JSON.parse(data));
    } catch {
      this.sentMessages.push(data);
    }
  }

  close() {
    this.readyState = 3; // WebSocket.CLOSED
    this.onclose?.();
  }

  async receiveMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
    await new Promise(r => setTimeout(r, 10));
  }
}

// Mock VoiceCapture and VoiceSpeaker for VoiceChat component
export const mockVoiceCaptureInstances: any[] = [];
export const mockVoiceSpeakerInstances: any[] = [];

vi.mock('../../src/lib/realtimeVoice', () => {
  return {
    VoiceCapture: class {
      callbacks: any;
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn();
      mute = vi.fn();
      constructor(callbacks: any) {
        this.callbacks = callbacks;
        mockVoiceCaptureInstances.push(this);
      }
    },
    VoiceSpeaker: class {
      context: any;
      voiceId: any;
      callbacks: any;
      append = vi.fn();
      finish = vi.fn().mockImplementation(() => {
        this.callbacks.done?.();
      });
      stop = vi.fn();
      constructor(context: any, voiceId: any, callbacks: any) {
        this.context = context;
        this.voiceId = voiceId;
        this.callbacks = callbacks;
        mockVoiceSpeakerInstances.push(this);
      }
    },
  };
});

vi.mock('../../src/lib/peopleCallSounds', () => {
  return {
    PeopleCallSounds: class {
      prime = vi.fn().mockResolvedValue(true);
      play = vi.fn().mockReturnValue(true);
      stop = vi.fn();
      dispose = vi.fn();
    },
  };
});

vi.mock('../../src/lib/peopleSocketAudio', () => {
  return {
    PeopleSocketAudio: class {
      context: any;
      stream: any;
      callId: any;
      clientId: any;
      role: any;
      callbacks: any;
      start = vi.fn().mockImplementation(() => {
        this.callbacks.connected?.();
      });
      stop = vi.fn();
      constructor(context: any, stream: any, callId: any, clientId: any, role: any, callbacks: any) {
        this.context = context;
        this.stream = stream;
        this.callId = callId;
        this.clientId = clientId;
        this.role = role;
        this.callbacks = callbacks;
      }
    },
  };
});

describe('MarkdownView Component Deep Interactions & Branch Coverage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders code fence subwindows with language title, collapse toggle, and copy button interactions', async () => {
    const markdown = [
      '```typescript',
      'const networkSegment = "10.200.0.0/16";',
      'console.log("Configuring API peering...");',
      '```',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    const subwindow = host.querySelector('.code-subwindow');
    expect(subwindow).not.toBeNull();

    const title = host.querySelector('.code-subwindow-title');
    expect(title?.textContent).toBe('TYPESCRIPT');

    // Test Collapse / Expand toggle
    const buttons = host.querySelectorAll<HTMLButtonElement>('.code-subwindow-btn');
    const copyBtn = buttons[0];
    const collapseBtn = buttons[1];

    expect(collapseBtn.textContent).toBe('Collapse');
    expect(subwindow?.classList.contains('collapsed')).toBe(false);

    await act(async () => {
      collapseBtn.click();
    });
    expect(subwindow?.classList.contains('collapsed')).toBe(true);
    expect(collapseBtn.textContent).toBe('Expand');

    await act(async () => {
      collapseBtn.click();
    });
    expect(subwindow?.classList.contains('collapsed')).toBe(false);
    expect(collapseBtn.textContent).toBe('Collapse');

    // Test Copy button successful copy
    await act(async () => {
      copyBtn.click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('10.200.0.0/16')
    );
    expect(copyBtn.dataset.copyState).toBe('copied');
    expect(copyBtn.textContent).toContain('Copied');

    // Test Copy button failure handling
    (navigator.clipboard.writeText as any).mockRejectedValueOnce(new Error('Permission denied'));
    await act(async () => {
      copyBtn.click();
    });
    expect(copyBtn.dataset.copyState).toBe('error');
    expect(copyBtn.textContent).toContain('Could not copy');
  });

  it('renders presentation.bobdeck special title in code subwindow', async () => {
    const markdown = [
      '```bobdeck',
      '{"slides": [{"title": "Network Topology Review"}]}',
      '```',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    const title = host.querySelector('.code-subwindow-title');
    expect(title?.textContent).toBe('presentation.bobdeck');
  });

  it('renders Mermaid diagrams replacing pre blocks with mermaid panels', async () => {
    const markdown = [
      '### Topology Diagram',
      '```mermaid',
      'graph TD',
      '  A[Core Switch DC2] --> B[Spine Switch 01]',
      '```',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    const panel = host.querySelector('.mermaid-panel');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('data-mermaid-source')).toContain('Core Switch DC2');
    expect(panel?.getAttribute('data-mermaid-session')).toBe('sess-net-1');
  });

  it('renders tables and transforms them with interactive tables', async () => {
    const markdown = [
      '| Interface | IP Address | Status | Description |',
      '| --- | --- | --- | --- |',
      '| Gi0/0/0 | 10.0.1.1/30 | Up | Transit Link to DC2 |',
      '| Gi0/0/1 | 10.0.2.1/30 | Up | Secondary Peering |',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    const table = host.querySelector('table');
    expect(table).not.toBeNull();
    expect(host.textContent).toContain('Transit Link to DC2');
  });

  it('sanitizes unsafe protocols, formats external links, and attaches knowledge citation markers', async () => {
    const markdown = [
      'Review the following resources:',
      '- [Vendor Advisory](https://external.vendor.com/security/advisory-01)',
      '- [Unsafe Action](javascript:void(0))',
      '- [Network Standard](/sessions/legacy/knowledge/11111111-2222-3333-4444-555555555555/file)',
      '- [Presentation Deck](./artifacts/network-summary.bobdeck)',
      '- [Spreadsheet Table](./reports/ip-plan.xlsx)',
      '- [Configuration File](./backups/router-config.txt)',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    // External link
    const externalLink = host.querySelector<HTMLAnchorElement>('a[href="https://external.vendor.com/security/advisory-01"]');
    expect(externalLink).not.toBeNull();
    expect(externalLink?.target).toBe('_blank');
    expect(externalLink?.rel).toBe('noopener noreferrer');

    // Unsafe link: javascript: protocol href should be removed
    const unsafeLink = Array.from(host.querySelectorAll('a')).find(a => a.textContent?.includes('Unsafe Action'));
    expect(unsafeLink?.hasAttribute('href')).toBe(false);

    // Knowledge citation link
    const citation = host.querySelector<HTMLAnchorElement>('.citation-marker');
    expect(citation).not.toBeNull();
    expect(citation?.textContent).toBe('[1]');
    expect(citation?.getAttribute('aria-label')).toContain('Source 1');
    expect(citation?.dataset.citationPreview).toContain('/knowledge/11111111-2222-3333-4444-555555555555/preview');

    // Sources details section
    const sourcesSummary = host.querySelector('.answer-sources summary');
    expect(sourcesSummary?.textContent).toContain('Sources · 1 document');

    // Presentation badge
    const deckBadge = host.querySelector<HTMLAnchorElement>('.presentation-badge');
    expect(deckBadge).not.toBeNull();
    expect(deckBadge?.textContent).toContain('Download');
    expect(deckBadge?.textContent).toContain('📊');

    // Sheet badge
    const sheetBadge = host.querySelector<HTMLAnchorElement>('.sheet-badge');
    expect(sheetBadge).not.toBeNull();
    expect(sheetBadge?.textContent).toContain('Download');
    expect(sheetBadge?.textContent).toContain('📈');

    // Generic file download
    const configLink = Array.from(host.querySelectorAll('.file-download-badge')).find(l => l.getAttribute('href')?.includes('router-config.txt'));
    expect(configLink).not.toBeNull();
  });

  it('enforces read-only sanitization on private files and workspace links', async () => {
    const markdown = [
      '- [Private Diagram](./diagrams/network-core.png)',
      '- [Workspace Session Link](/sessions/sess-net-1/file?path=secret.json)',
      '![Core Diagram](./diagrams/core.png)',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" readOnly={true} />);
    });

    const links = host.querySelectorAll('a');
    for (const link of links) {
      expect(link.hasAttribute('href')).toBe(false);
      expect(link.getAttribute('aria-disabled')).toBe('true');
    }

    const img = host.querySelector('img');
    expect(img?.hasAttribute('src')).toBe(false);
    expect(img?.alt).toBe('Private image not included in shared conversation');
  });

  it('handles streaming mode tail annotation', async () => {
    const markdown = 'Streaming output in progress...';

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" isStreaming={true} />);
    });

    const tail = host.querySelector('[data-stream-tail]');
    expect(tail).not.toBeNull();
  });

  it('sanitizes script tags while preserving safe HTML', async () => {
    const markdown = '<script>window.pwned = true;</script><div class="network-alert">Alert: API down</div>';

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('.network-alert')?.textContent).toBe('Alert: API down');
  });

  it('renders interactive chart blocks and replaces pre element', async () => {
    const markdown = [
      '```chart',
      '{"type": "bar", "data": {"labels": ["DC1", "DC2"], "datasets": [{"data": [100, 200]}]}}',
      '```',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    const chart = host.querySelector('[data-chart-spec]');
    expect(chart).not.toBeNull();
  });

  it('renders interactive map blocks and replaces pre element', async () => {
    const markdown = [
      '```map',
      '{"type": "geojson", "center": [35.1, 33.3], "zoom": 10}',
      '```',
    ].join('\n');

    await act(async () => {
      root.render(<MarkdownView content={markdown} sessionId="sess-net-1" />);
    });

    const map = host.querySelector('[data-map-spec]');
    expect(map).not.toBeNull();
  });
});

describe('usePeopleVoice Hook & Voice Call State Machine', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    activeCallSockets.length = 0;
    latestMockPeer = null;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', MockVoiceWebSocket);
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
    Object.assign(navigator, {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
      },
    });
    window.isSecureContext = true;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  function VoiceTestComponent({ username }: { username: string }) {
    const voice = usePeopleVoice(username);
    return (
      <div className="voice-test-harness">
        <span data-testid="phase">{voice.call?.phase || 'idle'}</span>
        <span data-testid="caller">{voice.call?.name || ''}</span>
        <span data-testid="muted">{voice.call?.muted ? 'muted' : 'unmuted'}</span>
        <span data-testid="ready">{voice.ready ? 'ready' : 'not-ready'}</span>
        <span data-testid="notice">{voice.notice}</span>
        <button type="button" data-testid="start-btn" onClick={() => void voice.start(10, 'Elena Rostova')}>Start</button>
        <button type="button" data-testid="answer-btn" onClick={() => void voice.answer()}>Answer</button>
        <button type="button" data-testid="decline-btn" onClick={voice.decline}>Decline</button>
        <button type="button" data-testid="mute-btn" onClick={voice.mute}>Mute</button>
        <button type="button" data-testid="hangup-btn" onClick={voice.hangup}>Hangup</button>
        <button type="button" data-testid="dismiss-btn" onClick={voice.dismiss}>Dismiss</button>
        <button type="button" data-testid="enable-sound" onClick={() => void voice.enableSound()}>Sound</button>
        <button type="button" data-testid="resume-audio" onClick={() => void voice.resumeAudio()}>Resume</button>
      </div>
    );
  }

  it('initializes socket, handles call_ready and ping messages', async () => {
    await act(async () => {
      root.render(<VoiceTestComponent username="admin" />);
    });

    expect(activeCallSockets.length).toBe(1);
    const ws = activeCallSockets[0];

    // Ready message from server
    await act(async () => {
      ws.receiveMessage({
        type: 'call_ready',
        ice_servers: [{ urls: 'stun:example.com:3478' }],
        client_id: 'client-admin-1',
        audio_transport: 'webrtc',
      });
    });

    expect(host.querySelector('[data-testid="ready"]')?.textContent).toBe('ready');

    // Ping message from server
    await act(async () => {
      ws.receiveMessage({ type: 'call_ping' });
    });

    expect(ws.sentMessages).toContainEqual({ action: 'ping' });
  });

  it('handles incoming call lifecycle: receive ringing, answer, WebRTC negotiation, mute, and hang up', async () => {
    await act(async () => {
      root.render(<VoiceTestComponent username="admin" />);
    });
    const ws = activeCallSockets[0];

    // Set ready
    await act(async () => {
      ws.receiveMessage({
        type: 'call_ready',
        ice_servers: [{ urls: 'stun:example.com:3478' }],
        client_id: 'client-admin-1',
        audio_transport: 'webrtc',
      });
    });

    // Server announces incoming call from Elena Rostova
    await act(async () => {
      ws.receiveMessage({
        type: 'call_state',
        call: {
          id: 'call-901',
          room_id: 10,
          status: 'ringing',
          role: 'callee',
          caller_name: 'Elena Rostova',
          callee_name: 'Admin User',
          owned: true,
          created_at: '2026-10-29T10:00:00Z',
        },
      });
    });

    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('incoming');
    expect(host.querySelector('[data-testid="caller"]')?.textContent).toBe('Elena Rostova');

    // Callee answers call
    const answerBtn = host.querySelector<HTMLButtonElement>('[data-testid="answer-btn"]')!;
    await act(async () => {
      answerBtn.click();
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(ws.sentMessages).toContainEqual({ action: 'accept', call_id: 'call-901' });

    // Server transitions call to accepted
    await act(async () => {
      ws.receiveMessage({
        type: 'call_state',
        call: {
          id: 'call-901',
          room_id: 10,
          status: 'accepted',
          role: 'callee',
          caller_name: 'Elena Rostova',
          callee_name: 'Admin User',
          owned: true,
          created_at: '2026-10-29T10:00:00Z',
        },
      });
    });

    // Remote offer received via signaling
    await act(async () => {
      ws.receiveMessage({
        type: 'call_signal',
        call_id: 'call-901',
        action: 'offer',
        sdp: 'v=0\r\no=elena 456 1 IN IP4 127.0.0.1\r\ns=remote-offer',
      });
    });

    expect(latestMockPeer?.setRemoteDescription).toHaveBeenCalled();
    expect(latestMockPeer?.createAnswer).toHaveBeenCalled();
    expect(ws.sentMessages).toContainEqual({
      action: 'answer',
      call_id: 'call-901',
      sdp: 'v=0\r\no=mock 123 2 IN IP4 127.0.0.1\r\ns=mock',
    });

    // Remote ICE candidate received
    await act(async () => {
      ws.receiveMessage({
        type: 'call_signal',
        call_id: 'call-901',
        action: 'ice',
        candidate: { candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      });
    });
    expect(latestMockPeer?.addIceCandidate).toHaveBeenCalled();

    // Connection establishes
    await act(async () => {
      if (latestMockPeer) {
        latestMockPeer.connectionState = 'connected';
        latestMockPeer.onconnectionstatechange?.();
      }
    });

    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('connected');
    expect(ws.sentMessages).toContainEqual({ action: 'connected', call_id: 'call-901' });

    // Test mute toggle
    const muteBtn = host.querySelector<HTMLButtonElement>('[data-testid="mute-btn"]')!;
    await act(async () => {
      muteBtn.click();
    });
    expect(host.querySelector('[data-testid="muted"]')?.textContent).toBe('muted');

    await act(async () => {
      muteBtn.click();
    });
    expect(host.querySelector('[data-testid="muted"]')?.textContent).toBe('unmuted');

    // Test hang up
    const hangupBtn = host.querySelector<HTMLButtonElement>('[data-testid="hangup-btn"]')!;
    await act(async () => {
      hangupBtn.click();
    });

    expect(ws.sentMessages).toContainEqual(
      expect.objectContaining({ action: 'end', call_id: 'call-901', reason: 'hangup' })
    );
    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
    expect(host.querySelector('[data-testid="notice"]')?.textContent).toBe('Call ended');

    // Dismiss notice
    const dismissBtn = host.querySelector<HTMLButtonElement>('[data-testid="dismiss-btn"]')!;
    await act(async () => {
      dismissBtn.click();
    });
    expect(host.querySelector('[data-testid="notice"]')?.textContent).toBe('');
  });

  it('handles outgoing call initiation, decline, and missed call notices', async () => {
    await act(async () => {
      root.render(<VoiceTestComponent username="admin" />);
    });
    const ws = activeCallSockets[0];

    // Ready
    await act(async () => {
      ws.receiveMessage({
        type: 'call_ready',
        ice_servers: [],
        client_id: 'client-admin-1',
        audio_transport: 'webrtc',
      });
    });

    // Start outgoing call
    const startBtn = host.querySelector<HTMLButtonElement>('[data-testid="start-btn"]')!;
    await act(async () => {
      startBtn.click();
    });

    expect(ws.sentMessages).toContainEqual({ action: 'start', room_id: 10 });

    // Server acknowledges call and rings
    await act(async () => {
      await ws.receiveMessage({
        type: 'call_state',
        call: {
          id: 'call-902',
          room_id: 10,
          status: 'ringing',
          role: 'caller',
          caller_name: 'Admin User',
          callee_name: 'Elena Rostova',
          owned: true,
          created_at: '2026-10-29T10:00:00Z',
        },
      });
    });

    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('ringing');

    // Callee declines call
    await act(async () => {
      await ws.receiveMessage({
        type: 'call_state',
        call: {
          id: 'call-902',
          room_id: 10,
          status: 'ended',
          role: 'caller',
          reason: 'declined',
          caller_name: 'Admin User',
          callee_name: 'Elena Rostova',
          owned: true,
          created_at: '2026-10-29T10:00:00Z',
        },
      });
    });

    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
    expect(host.querySelector('[data-testid="notice"]')?.textContent).toBe('Call declined');
  });

  it('handles websocket audio transport fallback', async () => {
    await act(async () => {
      root.render(<VoiceTestComponent username="admin" />);
    });
    const ws = activeCallSockets[0];

    await act(async () => {
      ws.receiveMessage({
        type: 'call_ready',
        ice_servers: [],
        client_id: 'client-admin-1',
        audio_transport: 'websocket',
      });
    });

    await act(async () => {
      ws.receiveMessage({
        type: 'call_state',
        call: {
          id: 'call-903',
          room_id: 10,
          status: 'ringing',
          role: 'callee',
          caller_name: 'Marcus Vance',
          callee_name: 'Admin User',
          owned: true,
          created_at: '2026-10-29T10:00:00Z',
          transport: 'websocket',
        },
      });
    });

    const answerBtn = host.querySelector<HTMLButtonElement>('[data-testid="answer-btn"]')!;
    await act(async () => {
      answerBtn.click();
    });

    await act(async () => {
      ws.receiveMessage({
        type: 'call_state',
        call: {
          id: 'call-903',
          room_id: 10,
          status: 'accepted',
          role: 'callee',
          caller_name: 'Marcus Vance',
          callee_name: 'Admin User',
          owned: true,
          created_at: '2026-10-29T10:00:00Z',
          transport: 'websocket',
        },
      });
    });

    expect(ws.sentMessages).toContainEqual({ action: 'connected', call_id: 'call-903' });
  });

  it('handles media error when microphone access is denied', async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError')
    );

    await act(async () => {
      root.render(<VoiceTestComponent username="admin" />);
    });
    const ws = activeCallSockets[0];

    await act(async () => {
      ws.receiveMessage({
        type: 'call_ready',
        ice_servers: [],
        client_id: 'client-admin-1',
        audio_transport: 'webrtc',
      });
    });

    const startBtn = host.querySelector<HTMLButtonElement>('[data-testid="start-btn"]')!;
    await act(async () => {
      startBtn.click();
    });

    expect(host.querySelector('[data-testid="notice"]')?.textContent).toContain(
      'Microphone permission was denied'
    );
  });
});

describe('PeopleVoiceCall Component UI', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('renders incoming call dialog with answer and decline controls', async () => {
    const mockVoice: any = {
      call: { id: 'c-1', roomId: 10, name: 'Elena Rostova', phase: 'incoming', muted: false },
      ready: true,
      notice: '',
      remote: null,
      playbackBlocked: false,
      soundBlocked: false,
      answer: vi.fn(),
      decline: vi.fn(),
      hangup: vi.fn(),
      mute: vi.fn(),
      dismiss: vi.fn(),
    };

    const onOpen = vi.fn();

    await act(async () => {
      root.render(<PeopleVoiceCall voice={mockVoice} onOpen={onOpen} />);
    });

    expect(host.textContent).toContain('Elena Rostova');
    expect(host.textContent).toContain('Incoming voice call');

    const answerBtn = host.querySelector<HTMLButtonElement>('.people-voice-answer');
    expect(answerBtn).not.toBeNull();
    await act(async () => {
      answerBtn?.click();
    });
    expect(mockVoice.answer).toHaveBeenCalled();

    const declineBtn = host.querySelector<HTMLButtonElement>('.people-voice-end');
    expect(declineBtn).not.toBeNull();
    await act(async () => {
      declineBtn?.click();
    });
    expect(mockVoice.decline).toHaveBeenCalled();
  });

  it('renders connected call with mute, hangup, and open conversation actions', async () => {
    const mockVoice: any = {
      call: { id: 'c-1', roomId: 10, name: 'Elena Rostova', phase: 'connected', muted: false },
      ready: true,
      notice: 'Call active',
      remote: null,
      playbackBlocked: false,
      soundBlocked: false,
      answer: vi.fn(),
      decline: vi.fn(),
      hangup: vi.fn(),
      mute: vi.fn(),
      dismiss: vi.fn(),
    };

    const onOpen = vi.fn();

    await act(async () => {
      root.render(<PeopleVoiceCall voice={mockVoice} onOpen={onOpen} />);
    });

    expect(host.textContent).toContain('Voice call connected');

    const muteBtn = host.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
    expect(muteBtn).not.toBeNull();
    await act(async () => {
      muteBtn?.click();
    });
    expect(mockVoice.mute).toHaveBeenCalled();

    const hangupBtn = host.querySelector<HTMLButtonElement>('.people-voice-end');
    await act(async () => {
      hangupBtn?.click();
    });
    expect(mockVoice.hangup).toHaveBeenCalled();

    const openBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Open conversation'));
    await act(async () => {
      openBtn?.click();
    });
    expect(onOpen).toHaveBeenCalledWith(10);
  });
});

describe('VoiceChat & VoiceInput Components', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockVoiceCaptureInstances.length = 0;
    mockVoiceSpeakerInstances.length = 0;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
    Object.assign(navigator, {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/voice/voices')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            voices: [
              { id: 'voice-elena', name: 'Elena' },
              { id: 'voice-marcus', name: 'Marcus' },
            ],
            default_voice_id: 'voice-elena',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }));

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('VoiceChat opens panel, loads voices, toggles conversation and reads aloud', async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onActiveChange = vi.fn();
    const sampleMessages: ChatMessage[] = [
      { id: 'm-1', role: 'user', content: 'Explain API peering status in DC2' },
      { id: 'm-2', role: 'assistant', content: 'API peering with AS65001 is currently established and stable.', voiceMode: true },
    ];

    await act(async () => {
      root.render(
        <VoiceChat
          messages={sampleMessages}
          busy={false}
          disabled={false}
          enabled={true}
          sessionId="sess-1"
          onSend={onSend}
          onStop={onStop}
          onActiveChange={onActiveChange}
          readRequest={null}
        />
      );
    });

    // Panel is initially closed
    expect(host.querySelector('.voice-chat-panel')).toBeNull();

    // Click to open panel
    const launcher = host.querySelector<HTMLButtonElement>('.composer-websearch-btn')!;
    await act(async () => {
      launcher.click();
    });

    expect(host.querySelector('.voice-chat-panel')).not.toBeNull();

    // Select voice focus to trigger voice list fetch
    const select = host.querySelector<HTMLSelectElement>('.voice-chat-controls select')!;
    await act(async () => {
      select.focus();
      select.dispatchEvent(new Event('focus'));
      await new Promise(r => setTimeout(r, 20));
    });

    expect(host.textContent).toContain('Elena');
    expect(host.textContent).toContain('Marcus');

    // Change selected voice
    await act(async () => {
      select.value = 'voice-marcus';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(localStorage.getItem('buddy-voice-id')).toBe('voice-marcus');

    // Start conversation
    const startBtn = host.querySelector<HTMLButtonElement>('.voice-chat-start')!;
    await act(async () => {
      startBtn.click();
    });

    expect(mockVoiceCaptureInstances.length).toBe(1);
    expect(onActiveChange).toHaveBeenCalledWith(true);
    expect(host.textContent).toContain('Listening');

    // Mute / Unmute
    const muteBtn = host.querySelector<HTMLButtonElement>('.voice-chat-controls button')!;
    await act(async () => {
      muteBtn.click();
    });
    expect(muteBtn.textContent).toContain('Unmute');

    await act(async () => {
      muteBtn.click();
    });
    expect(muteBtn.textContent).toContain('Mute');

    // Interrupt
    const interruptBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Interrupt'));
    await act(async () => {
      interruptBtn?.click();
    });

    // End conversation
    const endBtn = host.querySelector<HTMLButtonElement>('.voice-chat-end')!;
    await act(async () => {
      endBtn.click();
    });
    expect(onActiveChange).toHaveBeenCalledWith(false);

    // Read Aloud request
    await act(async () => {
      root.render(
        <VoiceChat
          messages={sampleMessages}
          busy={false}
          disabled={false}
          enabled={true}
          sessionId="sess-1"
          onSend={onSend}
          onStop={onStop}
          onActiveChange={onActiveChange}
          readRequest={{ text: 'Reading out router diagnostics.', nonce: 1 }}
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockVoiceSpeakerInstances.length).toBeGreaterThanOrEqual(1);
  });

  it('VoiceInput handles SpeechRecognition start, result callback and errors', async () => {
    const onTranscript = vi.fn();

    let recognitionInstance: any = null;
    class MockSpeechRecognition {
      lang = 'en-US';
      continuous = true;
      interimResults = false;
      onresult: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn().mockImplementation(() => {
        recognitionInstance = this;
      });
      stop = vi.fn().mockImplementation(() => {
        this.onend?.();
      });
      abort = vi.fn();
    }

    (window as any).SpeechRecognition = MockSpeechRecognition;

    await act(async () => {
      root.render(<VoiceInput onTranscript={onTranscript} disabled={false} />);
    });

    const dictateBtn = host.querySelector<HTMLButtonElement>('.composer-websearch-btn')!;
    expect(dictateBtn.textContent).toContain('Dictate');

    // Start recognition
    await act(async () => {
      dictateBtn.click();
    });

    expect(dictateBtn.textContent).toContain('Stop microphone');
    expect(recognitionInstance).not.toBeNull();

    // Emit result
    await act(async () => {
      recognitionInstance.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            0: { transcript: 'Check DC2 API configuration' },
          },
        ],
      });
    });

    expect(onTranscript).toHaveBeenCalledWith('Check DC2 API configuration');

    // Emit error
    await act(async () => {
      recognitionInstance.onerror?.({ error: 'not-allowed' });
    });

    expect(host.textContent).toContain('Microphone permission was denied');
    expect(dictateBtn.textContent).toContain('Dictate');
  });
});
