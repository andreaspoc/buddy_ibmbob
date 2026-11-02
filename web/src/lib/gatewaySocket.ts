/**
 * Zero-Polling WebSocket Gateway Client for Buddy.
 * Maintains a persistent duplex connection to /ws/gateway.
 * Multiplexes prompt submissions, status updates, tool events, and artifacts
 * over the existing open WebSocket with instant fallback to HTTP.
 */

interface PendingStream {
  correlationId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal;
  onAccepted: (meta: { jobId: string; correlationId: string; userMessageId?: string; assistantMessageId?: string; replayed?: boolean }) => void;
  onError: (error: Error) => void;
}

let socket: WebSocket | null = null;
let isReady = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
const activeStreams = new Map<string, PendingStream>();

export function isGatewayReady(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN && isReady;
}

export function connectGatewaySocket(): void {
  if (typeof window === 'undefined') return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws/gateway`;

  try {
    socket = new WebSocket(url);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'ping' }));
      }
    }, 25000);
  };

  socket.onmessage = (event) => {
    try {
      const text = typeof event.data === 'string' ? event.data : '';
      if (!text.trim()) return;
      const data = JSON.parse(text);

      if (data.type === 'gateway_ready') {
        isReady = true;
        return;
      }

      if (data.type === 'pong') return;

      const corrId = data.correlation_id;
      if (!corrId) return;

      const stream = activeStreams.get(corrId);
      if (!stream) return;

      if (data.type === 'accepted') {
        stream.onAccepted({
          jobId: data.job_id,
          correlationId: data.correlation_id,
          userMessageId: data.user_message_id,
          assistantMessageId: data.assistant_message_id,
          replayed: data.replayed,
        });
        return;
      }

      if (data.type === 'error' && !data.event_id && data.status_code) {
        const errorMsg = typeof data.detail === 'string' ? data.detail : (data.message || `HTTP ${data.status_code}`);
        stream.onError(new Error(errorMsg));
        activeStreams.delete(corrId);
        return;
      }

      // Enqueue the JSON line for App.tsx's reader
      const encoder = new TextEncoder();
      stream.controller.enqueue(encoder.encode(text + '\n'));

      if (data.type === 'done' || data.type === 'error') {
        try {
          stream.controller.close();
        } catch { /* stream might already be closed */ }
        activeStreams.delete(corrId);
      }
    } catch {
      // Ignored malformed lines
    }
  };

  socket.onclose = () => {
    isReady = false;
    socket = null;
    if (pingInterval) clearInterval(pingInterval);
    scheduleReconnect();
  };

  socket.onerror = () => {
    isReady = false;
  };
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectGatewaySocket();
  }, 3000);
}

export async function submitViaGateway(options: RequestInit): Promise<Response> {
  if (!isGatewayReady() || !socket) {
    throw new Error('Gateway socket not connected');
  }

  const payload = JSON.parse(options.body as string);
  const correlationId = payload.correlation_id || crypto.randomUUID();

  return new Promise<Response>((resolve, reject) => {
    const timeout = setTimeout(() => {
      activeStreams.delete(correlationId);
      reject(new Error('Gateway ACK timeout'));
    }, 5000);

    const abortHandler = () => {
      clearTimeout(timeout);
      if (socket && socket.readyState === WebSocket.OPEN && activeStreams.has(correlationId)) {
        socket.send(JSON.stringify({ action: 'cancel', correlation_id: correlationId }));
      }
      activeStreams.delete(correlationId);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        activeStreams.set(correlationId, {
          correlationId,
          controller,
          signal: options.signal || undefined,
          onAccepted: (meta) => {
            clearTimeout(timeout);
            const headers = new Headers();
            headers.set('Content-Type', 'application/x-ndjson');
            if (meta.jobId) headers.set('X-Bob-Job-Id', meta.jobId);
            if (meta.correlationId) headers.set('X-Correlation-Id', meta.correlationId);
            if (meta.userMessageId) headers.set('X-User-Message-Id', meta.userMessageId);
            if (meta.assistantMessageId) headers.set('X-Assistant-Message-Id', meta.assistantMessageId);
            if (meta.replayed !== undefined) headers.set('X-Idempotency-Replayed', String(meta.replayed));

            resolve(new Response(readable, {
              status: 200,
              statusText: 'OK',
              headers,
            }));
          },
          onError: (err) => {
            clearTimeout(timeout);
            activeStreams.delete(correlationId);
            reject(err);
          },
        });

        // Send prompt submission frame over WebSocket
        socket!.send(JSON.stringify({
          action: 'prompt',
          ...payload,
          correlation_id: correlationId,
        }));
      },
      cancel() {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: 'cancel', correlation_id: correlationId }));
        }
        activeStreams.delete(correlationId);
      },
    });
  });
}
