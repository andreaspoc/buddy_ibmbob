/** Execute the real state hook with a minimal hook scheduler and mocked HTTP. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
let slots = [], cursor = 0, effects = [], cleanups = [];
globalThis.crypto = webcrypto;
globalThis.__hooks = {
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
  useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  useEffect(effect, deps) {
    const i = cursor++, previous = slots[i];
    if (!previous || deps.some((dep, index) => dep !== previous[index])) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect(); }); }
  },
};
let source = readFileSync(new URL('../web/src/lib/interactiveState.ts', import.meta.url), 'utf8');
source = source.replace(/import .* from 'react';/, 'const {useState,useRef,useEffect} = globalThis.__hooks;');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { useInteractiveState: hook, widgetDigest } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
assert.match(await widgetDigest('source'), /^[a-f0-9]{64}$/);
const calls = [], stored = new Map();
let hold;
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  if (!options) return { ok: true, json: async () => ({ state: stored.get(url.split('?')[0]) ?? null }) };
  if (hold) { const wait = hold; hold = null; await wait; }
  stored.set(url, JSON.parse(options.body).state);
  return { ok: true };
};
function render(args) { cursor = 0; const result = hook(...args); for (const effect of effects.splice(0)) effect(); return result; }
function reset() { cleanups.forEach(cleanup => cleanup?.()); slots = []; effects = []; cleanups = []; }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
const args = ['source', 'message-a:ui0', 'a'.repeat(32), false];
render(args); await flush();
let view = render(args); assert.equal(view.status, 'saved');
let release; hold = new Promise(resolve => { release = resolve; });
view.setState({ selected: 1 });
view.setState({ selected: 2, done: [1] });
await flush();
assert.equal(calls.filter(call => call.options).length, 1, 'writes serialize while first is pending');
release(); await flush();
assert.deepEqual([...stored.values()][0], { selected: 2, done: [1] });
assert.equal(render(args).status, 'saved');
const firstUrl = calls[0].url;
reset(); render(args); await flush();
assert.deepEqual(render(args).state, { selected: 2, done: [1] }, 'restores after remount');
reset(); const other = ['source', 'message-b:ui0', args[2], false]; render(other); await flush();
assert.deepEqual(render(other).state, {});
assert.notEqual(calls.at(-1).url, firstUrl, 'message identities cannot share state');
reset(); const before = calls.length, shared = ['source', 'shared', args[2], true]; render(shared); await flush();
render(shared).setState({ selected: 3 }); await flush(); assert.equal(calls.length, before, 'shared views never read or write owner state');
reset(); globalThis.fetch = async () => { throw new Error('unavailable'); };
render(args); await flush(); view = render(args); assert.equal(view.status, 'error');
view.setState({ selected: 1 }); assert.deepEqual(render(args).state, { selected: 1 }, 'local controls work after failed restore');
console.log('PASS: server restoration, serialized writes, message isolation, shared-view isolation, graceful offline controls');
