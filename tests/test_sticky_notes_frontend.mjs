import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(new URL('../web/src/lib/stickyNotes.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('exports', code)(exports);
const { parseStickyNotes } = exports;
const note = {title:' Finding ',body:'See [Source](https://example.org/path).',color:'butter'};
const block = value => '```bobnotes\n' + JSON.stringify(value) + '\n```';
const valid = block({notes:[note]});
assert.deepEqual(parseStickyNotes('Before\n'+valid+'\nAfter'), {text:'Before\nAfter',notes:[{...note,title:'Finding'}]});
assert.equal(parseStickyNotes('````text\n'+valid+'\n````').notes.length, 0);
assert.equal(parseStickyNotes('~~~text\n'+valid+'\n~~~').notes.length, 0);
for (let i = 1; i < '```bobnotes'.length; i++) assert.equal(parseStickyNotes('Hello\n'+'```bobnotes'.slice(0,i), true).text,'Hello');
for (let i = '```bobnotes'.length; i < valid.length; i++) assert.equal(parseStickyNotes('Hello\n'+valid.slice(0,i), true).text,'Hello');
assert.equal(parseStickyNotes(valid, true).notes.length,1);
assert.equal(parseStickyNotes(valid.replaceAll('\n','\r\n')).notes.length,1);
for (const value of [null, [], {}, {notes:[]}, {notes:Array(13).fill(note)}, {notes:[{...note,color:'red'}]}, {notes:[{...note,title:' '}]}, {notes:[{...note,body:'x'.repeat(6001)}]}, {notes:[{...note,title:'x'.repeat(161)}]}, {notes:[{...note,extra:1}]}, {notes:[note,null]}, {notes:[note],extra:1}]) {
  const invalid = block(value);
  assert.deepEqual(parseStickyNotes(invalid),{text:invalid,notes:[]});
}
assert.equal(parseStickyNotes('```bobnotes\n{bad}\n```').notes.length,0);
assert.equal(parseStickyNotes('```bobnotes\n{').text,'```bobnotes\n{');
assert.equal(parseStickyNotes(block({notes:Array(12).fill(note)})+'\n'+valid).notes.length,12);
console.log('Sticky notes parser validation and streaming checks passed');
