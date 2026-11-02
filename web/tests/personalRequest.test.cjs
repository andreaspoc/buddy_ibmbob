const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/lib/personalRequest.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
async function scenario(responses, method = 'PUT') {
  const calls = [];
  const box = {exports: {}, require: () => ({t: text => text}), setTimeout: callback => callback(), fetch: async (url, options) => {
    calls.push({url, ...options});
    const next = responses.shift();
    assert.ok(next, 'Unexpected extra request');
    return {status: next.status, ok: next.status === 200, body: {cancel: async () => {}}, json: async () => {
      if (next.html) throw new SyntaxError("Unexpected token '<'");
      return next.data;
    }};
  }};
  vm.runInNewContext(source, box); // NOSONAR: intentional sandbox for isolated unit testing
  return {request: box.exports.personalRequest('tutorials', method, {disabled: true}), calls};
}
test('personal request retries and error handling', async () => {
  const recovered = await scenario([{status: 502, html: true}, {status: 200, data: {disabled: true}}]);
  assert.equal((await recovered.request).disabled, true);
  assert.equal(recovered.calls.length, 2);
  assert.equal(recovered.calls[1].body, '{"disabled":true}');
  const unavailable = await scenario(Array.from({length: 4}, () => ({status: 502, html: true})));
  await assert.rejects(unavailable.request, /Settings are temporarily unavailable/);
  assert.equal(unavailable.calls.length, 4);
  const unauthorized = await scenario([{status: 401, data: {detail: 'Unauthorized'}}]);
  await assert.rejects(unauthorized.request, /session has expired/);
  assert.equal(unauthorized.calls.length, 1);
  const invalid = await scenario([{status: 200, html: true}]);
  await assert.rejects(invalid.request, /Settings are temporarily unavailable/);
  const post = await scenario([{status: 502, html: true}], 'POST');
  await assert.rejects(post.request, /Settings are temporarily unavailable/);
  assert.equal(post.calls.length, 1);
  console.log('PASS recovery after 502, bounded retries, HTML handling, session expiry, no POST retries');
});
