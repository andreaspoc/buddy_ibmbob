// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchArtifacts } from '../../src/lib/artifactSocket';
import type { Artifact } from '../../src/components/ArtifactEditor';

class MockSocket {
  url: string;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: ((evt: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    MockSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  static instances: MockSocket[] = [];
}

describe('artifactSocket watchArtifacts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockSocket.instances = [];
    (global as any).WebSocket = MockSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects to websocket, receives artifact events, and deduplicates by sha256', () => {
    const received: Artifact[] = [];
    const controller = new AbortController();

    const stop = watchArtifacts('job-456', controller.signal, (art) => {
      received.push(art);
    });

    expect(MockSocket.instances.length).toBe(1);
    const ws = MockSocket.instances[0];
    expect(ws.url).toContain('/jobs/job-456/artifacts/ws');

    // 1. Dispatch valid artifact event
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'artifact',
        event_id: 1,
        path: 'report.docx',
        content: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA=',
        sha256: 'hash-abc-123',
        kind: 'doc',
      }),
    });

    expect(received.length).toBe(1);
    expect(received[0].path).toBe('report.docx');

    // 2. Dispatch duplicate artifact event with identical sha256 (should be skipped)
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'artifact',
        event_id: 2,
        path: 'report.docx',
        content: 'data:...',
        sha256: 'hash-abc-123',
        kind: 'doc',
      }),
    });
    expect(received.length).toBe(1);

    // 3. Dispatch updated sha256
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'artifact',
        event_id: 3,
        path: 'report.docx',
        content: 'data:...',
        sha256: 'hash-def-456',
        kind: 'doc',
      }),
    });
    expect(received.length).toBe(2);

    // 4. Dispatch terminal done event
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'done',
      }),
    });

    stop();
  });

  it('reconnects with cursor on error, and halts permanently on policy 1008', async () => {
    const controller = new AbortController();
    watchArtifacts('job-789', controller.signal, vi.fn());

    expect(MockSocket.instances.length).toBe(1);
    const ws1 = MockSocket.instances[0];

    // Receive message with cursor
    ws1.onmessage?.({
      data: JSON.stringify({
        type: 'status',
        event_id: 42,
      }),
    });

    // Error triggers reconnect
    ws1.onerror?.();
    expect(ws1.closed).toBe(true);

    // Advance timer for backoff reconnect
    await vi.advanceTimersByTimeAsync(600);

    expect(MockSocket.instances.length).toBe(2);
    const ws2 = MockSocket.instances[1];
    expect(ws2.url).toContain('after_id=42');

    // Code 1008 halts permanently
    ws2.onclose?.({ code: 1008 });
    await vi.advanceTimersByTimeAsync(2000);
    // No further reconnect
    expect(MockSocket.instances.length).toBe(2);
  });

  it('stops cleanly when abort signal is triggered', () => {
    const controller = new AbortController();
    watchArtifacts('job-abort', controller.signal, vi.fn());

    expect(MockSocket.instances.length).toBe(1);
    const ws = MockSocket.instances[0];

    controller.abort();
    expect(ws.closed).toBe(true);
  });
});
