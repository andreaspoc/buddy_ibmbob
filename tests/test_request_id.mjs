import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { transpile } from './frontend_transpile.mjs';
const source=transpile(readFileSync(new URL('../web/src/lib/requestId.ts',import.meta.url),'utf8'),true);
function load(crypto){const exports={};new Function('exports','crypto',source)(exports,crypto);return exports.createRequestId;}
assert.equal(load({randomUUID:()=> 'native-request-id'})(),'native-request-id');
const fallback=load({getRandomValues: bytes=>webcrypto.getRandomValues(bytes)});
const values=new Set(Array.from({length:100},()=>fallback()));
assert.equal(values.size,100);
for(const id of values)assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
console.log('PASS request IDs use native UUIDs or cryptographic UUID fallback on HTTP');
