const assert = require('node:assert/strict');
const { test } = require('node:test');

test('note formatting and headings', () => {
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const source = fs.readFileSync(new URL('../src/lib/noteWriting.ts', `file://${__filename}`), 'utf8');
const box = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, box); // NOSONAR: intentional sandbox for isolated unit testing
const {editNoteMarkdown, noteHeadings, localNoteDate} = box.exports;
const plain = value => JSON.parse(JSON.stringify(value));
let result = editNoteMarkdown('before selected after', 7, 15, 'bold', 'Text');
assert.equal(result.body, 'before **selected** after');
assert.equal(result.body.slice(result.start,result.end),'selected');
result = editNoteMarkdown('first\nsecond', 0, 12, 'checklist', 'Text');
assert.equal(result.body, '- [ ] first\n- [ ] second');
result = editNoteMarkdown('prefix suffix', 7, 7, 'heading', 'Text');
assert.equal(result.body, 'prefix \n## Text\nsuffix');
result = editNoteMarkdown('', 0, 0, 'code', 'Text');
assert.equal(result.body, '```\nText\n```');
assert.equal(result.body.slice(result.start,result.end), 'Text');
result = editNoteMarkdown('beforeafter', 6, 6, 'divider', 'Text');
assert.equal(result.body, 'before\n---\nafter');
assert.deepEqual(plain(noteHeadings('# First\n```md\n## Hidden\n```\n## Second ##\n~~~\n# Also hidden\n~~~')), [
  {text:'First',level:1,offset:0},{text:'Second',level:2,offset:28},
]);
// Local calendar fields are intentionally used rather than a UTC conversion.
assert.equal(localNoteDate({getFullYear:()=>2026,getMonth:()=>0,getDate:()=>2}), '2026-01-02');
console.log('PASS: formatting preserves surrounding text and selections, multiline checklists, code, dividers, fenced headings, local daily-note dates');

});
