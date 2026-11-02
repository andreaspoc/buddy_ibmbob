import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts=require('typescript');
function load(path, dependencies={}) {
  const code=ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};new Function('exports','require',code)(exports,name=>dependencies[name]);return exports;
}
const clarification=load('../web/src/lib/clarification.ts');
const {speechText,speechChunks}=load('../web/src/lib/voice.ts',{'./clarification':clarification});
assert.equal(speechText('<think>Private reasoning</think>\n## Result\n**Hello** [source](https://example.com).\n```bobdeck\n{"slides":[]}\n```'),'Result Hello source.');
assert.equal(speechText('Visible. <thinking>Never speak unfinished reasoning'),'Visible.');
assert.equal(speechText('Discuss the issue.\n```mermaid\nflowchart TD\nA-->B\n```\n```bobquestion\n{"question":"Which next?","options":["One","Two"]}\n```'),'Discuss the issue.');
const text='A sentence with details. Another useful sentence! '.repeat(100).trim();
const chunks=speechChunks(text);assert.ok(chunks.every(chunk=>chunk.length<=900));assert.equal(chunks.join(' '),text);
assert.equal(speechChunks('x'.repeat(3000)).length,4);assert.deepEqual(speechChunks(''),[]);
console.log('PASS: voice prose excludes reasoning, charts, flows, and follow-up forms; bounded speech chunks preserve content.');
