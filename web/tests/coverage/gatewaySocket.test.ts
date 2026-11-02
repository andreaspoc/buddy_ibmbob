import { afterEach, beforeEach, expect, test, vi } from 'vitest';

class SocketFixture {
  static OPEN = 1;
  static CONNECTING = 0;
  static last: SocketFixture;
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { SocketFixture.last = this; }
  send(text: string) { this.frames.push(JSON.parse(text)); }
  receive(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', SocketFixture);
  vi.stubGlobal('window', { location: { protocol: 'https:', host: 'fixture.test' } });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function readyGateway() {
  const gateway = await import('../../src/lib/gatewaySocket');
  gateway.connectGatewaySocket();
  const socket = SocketFixture.last;
  socket.onopen?.();
  socket.receive({ type: 'gateway_ready' });
  expect(gateway.isGatewayReady()).toBe(true);
  return { gateway, socket };
}

test('generated correlation IDs are transmitted and route acknowledgements and output', async () => {
  const { gateway, socket } = await readyGateway();
  const result = gateway.submitViaGateway({ body: JSON.stringify({ prompt: 'Fixture' }) });
  const id = socket.frames[0].correlation_id;
  expect(id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
  expect(socket.url).toBe('wss://fixture.test/ws/gateway');
  socket.receive({ type: 'accepted', correlation_id: id, job_id: 'fixture-job' });
  const response = await result;
  expect(response.headers.get('X-Correlation-Id')).toBe(id);
  socket.receive({ type: 'done', correlation_id: id });
  expect(await response.text()).toContain('"type":"done"');
});

test('caller-supplied correlation IDs remain intact', async () => {
  const { gateway, socket } = await readyGateway();
  const result = gateway.submitViaGateway({ body: JSON.stringify({ correlation_id: 'fixture-id' }) });
  expect(socket.frames[0].correlation_id).toBe('fixture-id');
  socket.receive({ type: 'accepted', correlation_id: 'fixture-id' });
  expect((await result).status).toBe(200);
  socket.receive({ type: 'done', correlation_id: 'fixture-id' });
});

test('rejects submissions before the gateway is ready', async () => {
  const gateway = await import('../../src/lib/gatewaySocket');
  await expect(gateway.submitViaGateway({ body: '{}' })).rejects.toThrow('not connected');
});

test('reports acknowledgement timeouts', async () => {
  const { gateway } = await readyGateway();
  const result = gateway.submitViaGateway({ body: '{}' });
  const rejected = expect(result).rejects.toThrow('Gateway ACK timeout');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});

test('reports server rejection and caller cancellation', async () => {
  const { gateway, socket } = await readyGateway();
  const rejected = gateway.submitViaGateway({ body: JSON.stringify({ correlation_id: 'rejected' }) });
  socket.receive({ type: 'error', correlation_id: 'rejected', status_code: 403, detail: 'Denied' });
  await expect(rejected).rejects.toThrow('Denied');
  const abort = new AbortController();
  const cancelled = gateway.submitViaGateway({ body: JSON.stringify({ correlation_id: 'cancelled' }), signal: abort.signal });
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  expect(socket.frames.at(-1)).toEqual({ action: 'cancel', correlation_id: 'cancelled' });
});
