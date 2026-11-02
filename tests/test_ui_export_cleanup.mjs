import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpile } from './frontend_transpile.mjs';
async function load(path) {
  return import(`data:text/javascript;base64,${Buffer.from(transpile(readFileSync(new URL(path, import.meta.url), 'utf8'))).toString('base64')}`);
}
const { csvCell, tsvCell } = await load('../web/src/lib/spreadsheetExport.ts');
for (const input of ['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '\t=1', '\r=1', '\n=1', '\0=1']) {
  assert.ok(csvCell(input).replace(/^"/, '').startsWith("'"), JSON.stringify(input));
  assert.ok(tsvCell(input).startsWith("'"));
}
assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
assert.equal(csvCell(null), '');
assert.equal(csvCell('ordinary text'), 'ordinary text');
assert.equal(tsvCell('a\tb\nc'), 'a b c');
const { clearPrivateClientData } = await load('../web/src/lib/clientData.ts');
function storage(entries) {
  const values = new Map(Object.entries(entries));
  return { get length() { return values.size; }, key(index) { return [...values.keys()][index] ?? null; }, removeItem(key) { values.delete(key); }, getItem(key) { return values.get(key); } };
}
globalThis.window = {
  localStorage: storage({ 'buddy-quiz:s:q': 'answers', 'buddy-recent-documents:alice': 'paths', 'onlyoffice_ai_chat_state': 'private', 'buddy-ui-theme': 'carbon', 'bob-ui-language': 'en' }),
  sessionStorage: storage({ 'buddy.people.draft.v1:alice:1:0': 'private draft', 'buddy-active-session:alice': 'id' }),
};
clearPrivateClientData();
assert.equal(window.localStorage.getItem('buddy-quiz:s:q'), undefined);
assert.equal(window.localStorage.getItem('buddy-recent-documents:alice'), undefined);
assert.equal(window.localStorage.getItem('onlyoffice_ai_chat_state'), undefined);
assert.equal(window.sessionStorage.length, 0);
assert.equal(window.localStorage.getItem('buddy-ui-theme'), 'carbon');
assert.equal(window.localStorage.getItem('bob-ui-language'), 'en');
Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage unavailable'); } });
assert.doesNotThrow(clearPrivateClientData);
delete globalThis.window;
console.log('PASS: CSV/TSV formula neutralization, CSV quoting, private storage cleanup and restricted storage');
