const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');
const source = fs.readFileSync('web/src/lib/htmlDeckReadiness.ts', 'utf8');
const compiledExports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: compiledExports });
const { shouldWaitForHtmlDeck, isCompleteHtmlDeck } = compiledExports;

// Valid user uploads need not resemble Bob's generated slide template.
for (const html of [
  '<html><body><h1>My presentation</h1></body></html>',
  '<!doctype html><div class="reveal"><div class="slides">Uploaded deck</div></div>',
  '<html><body><main data-slide="1">A short presentation</main>',
]) {
  assert.equal(shouldWaitForHtmlDeck(html, false, 'saved-office-file'), false);
  assert.equal(shouldWaitForHtmlDeck(html, false), true);
}

const complete = '<html><body><section class="slide">' + 'Slide content '.repeat(25) + '</section></body></html>';
assert.equal(isCompleteHtmlDeck(complete), true);
assert.equal(shouldWaitForHtmlDeck(complete, false), false);
assert.equal(shouldWaitForHtmlDeck('<html><body>Partial generation', false), true);
assert.equal(shouldWaitForHtmlDeck('<html><body>Streaming generation', true), false);
assert.equal(shouldWaitForHtmlDeck('', false), false);
console.log('HTML upload readiness and generated-deck regression tests passed');
