import type { Artifact } from '../components/ArtifactEditor';

export function watchArtifacts(jobId: string, signal: AbortSignal, receive: (artifact: Artifact) => void) {
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  let delay = 500;
  let cursor = 0;
  const hashes = new Map<string, string>();
  const stop = () => {
    complete = true;
    clearTimeout(retry);
    clearTimeout(watchdog);
    socket?.close();
    signal.removeEventListener('abort', stop);
  };
  const connect = () => {
    if (signal.aborted || complete) return;
    const url = new URL(`/jobs/${encodeURIComponent(jobId)}/artifacts/ws`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (cursor) url.searchParams.set('after_id', String(cursor));
    const current = new WebSocket(url);
    socket = current;
    const scheduleReconnect = () => {
      if (current !== socket || complete || signal.aborted || retry !== undefined) return;
      clearTimeout(watchdog);
      retry = setTimeout(() => { retry = undefined; connect(); }, delay);
      delay = Math.min(delay * 2, 10000);
    };
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        scheduleReconnect();
        current.close();
      }, 45000);
    };
    // Also recover when the handshake never completes.
    armWatchdog();
    current.onmessage = message => {
      if (current !== socket || complete || signal.aborted || retry !== undefined) return;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(message.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        event = parsed as Record<string, unknown>;
      } catch { return; }
      if (typeof event.type !== 'string') return;
      armWatchdog();
      delay = 500;
      const eventId = typeof event.event_id === 'number' && Number.isSafeInteger(event.event_id) && event.event_id > 0 ? event.event_id : undefined;
      if (eventId !== undefined && eventId <= cursor) return;
      if (event.type === 'artifact') {
        if (typeof event.path !== 'string' || !event.path || typeof event.content !== 'string' || typeof event.sha256 !== 'string' || !event.sha256 || typeof event.kind !== 'string') return;
        if (hashes.get(event.path) !== event.sha256) {
          receive(event as Artifact);
          hashes.set(event.path, event.sha256);
        }
      }
      if (eventId !== undefined) cursor = eventId;
      if (['done', 'error', 'complete'].includes(event.type)) stop();
    };
    current.onclose = event => {
      if (current !== socket) return;
      if (event.code === 1008) { stop(); return; }
      scheduleReconnect();
    };
    current.onerror = () => {
      scheduleReconnect();
      current.close();
    };
  };
  signal.addEventListener('abort', stop, { once: true });
  connect();
  return stop;
}
