import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const queueSource = readFileSync(new URL('../web/src/lib/streamText.ts', import.meta.url),'utf8');
const queueCode = ts.transpileModule(queueSource.replace('export function','function'), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const source = readFileSync(new URL('../web/src/App.tsx',import.meta.url),'utf8');
const start = source.indexOf('    const textStream = createTextStream');
const end = source.indexOf('\n    try {\n      const res = await submitChatRequest', start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
let messages=[{id:'assistant',content:'',isStreaming:true,statusText:'Working…'}];
const frames=new Map(); let id=0, clock=0;
const queue=new Function('requestAnimationFrame','cancelAnimationFrame','updateRequestMessages','assistantMsgId','document','matchMedia','performance',queueCode+code+'return textStream;')(
 cb=>{frames.set(++id,cb);return id;}, id=>frames.delete(id), fn=>{messages=fn(messages);}, 'assistant', {hidden:false},()=>({matches:false}),{now:()=>clock});
const text='First paragraph.\n\n1. One\n2. Two\n\n'+'Long response 🟣 '.repeat(1000);
queue.push(text);
const finished=queue.drain();
for(let i=0;i<15;i++){clock+=16;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn());assert.ok(text.startsWith(messages[0].content));}
await finished;
assert.equal(messages[0].content,text);
assert.equal(frames.size,0);
queue.push(' tail');messages[0].isStreaming=false;messages[0].statusText='Stopped by you';queue.flush();
assert.equal(messages[0].content,text+' tail');assert.equal(messages[0].statusText,'Stopped by you');
queue.push('obsolete');
// The first character paints immediately; clear cancels only the queued tail.
const paintedBeforeClear=messages[0].content;
queue.clear();assert.equal(frames.size,0);
assert.equal(messages[0].content,paintedBeforeClear);
assert.ok('obsolete'.startsWith(paintedBeforeClear.slice((text+' tail').length)));
console.log('App streaming integration checks passed');
