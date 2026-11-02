import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpile } from './frontend_transpile.mjs';
const code = transpile(readFileSync(new URL('../web/src/lib/artifactSocket.ts', import.meta.url), 'utf8'), true);
let now = 0, next = 0;
const timers = new Map(), sockets = [];
const setTimer = (fn, delay) => { timers.set(++next, { fn, at: now + delay }); return next; };
const advance = ms => {
  const end = now + ms;
  for (;;) {
    const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry || entry[1].at > end) break;
    timers.delete(entry[0]); now = entry[1].at; entry[1].fn();
  }
  now = end;
};
class Socket {
  constructor(url) { this.url = new URL(url); sockets.push(this); }
  close() { this.closed = true; this.onclose?.({ code: 1000 }); }
  message(data) { this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}
const exports = {};
new Function('exports', 'WebSocket', 'location', 'setTimeout', 'clearTimeout', code)(exports, Socket,
  { href: 'https://example.test/chat', protocol: 'https:' }, setTimer, id => timers.delete(id));
const received = [], controller = new AbortController();
exports.watchArtifacts('job /1', controller.signal, a => received.push(a));
let socket = sockets.at(-1);
assert.equal(socket.url.protocol, 'wss:');
assert.ok(socket.url.pathname.includes('job%20%2F1'));
for (const bad of ['broken json', 'null', '[]', '{}', { type: 'artifact', event_id: 999, path: 'a.html' }]) socket.message(bad);
const artifact = (event_id, content, sha256 = content) => ({ type: 'artifact', event_id, path: 'a.html', kind: 'html', content, sha256 });
socket.message(artifact(1, 'first'));
socket.message(artifact(2, 'first'));
assert.equal(received.length, 1);
socket.close(); advance(500);
assert.equal(sockets.length, 2);
socket = sockets.at(-1);
assert.equal(socket.url.searchParams.get('after_id'), '2');
socket.message(artifact(1, 'obsolete'));
socket.message(artifact(3, 'second'));
assert.deepEqual(received.map(a => a.content), ['first', 'second']);
advance(30000); socket.message({ type: 'heartbeat' }); advance(30000);
assert.equal(sockets.length, 2);
advance(15000); advance(500);
assert.equal(sockets.length, 3);
assert.equal(sockets.at(-1).url.searchParams.get('after_id'), '3');
socket.message(artifact(4, 'stale socket'));
assert.equal(received.length, 2);
sockets.at(-1).message({ type: 'complete' });
advance(100000);
assert.equal(sockets.length, 3);
assert.equal(timers.size, 0);
const abort = new AbortController();
exports.watchArtifacts('abort', abort.signal, () => assert.fail('Aborted stream delivered'));
abort.abort(); advance(100000);
assert.equal(sockets.length, 4); assert.equal(timers.size, 0);
const denied = new AbortController();
exports.watchArtifacts('denied', denied.signal, () => {});
sockets.at(-1).onclose({ code: 1008 }); advance(100000);
assert.equal(sockets.length, 5); assert.equal(timers.size, 0);
console.log('PASS artifact websocket validation, resume, deduplication, heartbeat recovery, completion and cleanup');
