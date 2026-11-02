import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../web/src/lib/presentationFiles.ts', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../web/src/lib/extractDeck.ts', import.meta.url), 'utf8').replace(/^import[^\n]+presentationFiles[^\n]+\n/m, '');
const compiled = ts.transpileModule(source + '\nexport { deckFence };', { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { extractBobdeck, deckFence } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
if (process.argv.includes('--long')) {
  for (const input of ['{'.repeat(800000), 'a'.repeat(800000), '{'.repeat(400000) + '"slides":[' + '}'.repeat(400000)]) {
    assert.equal(extractBobdeck(input), null);
  }
  for (const tag of ['bobdeck', 'json', 'html']) {
    assert.ok(deckFence(('```' + tag + '\n').repeat(50000), [tag]));
    assert.equal(deckFence('```' + tag + '\n'.repeat(800000), [tag]), null);
  }
  process.exit(0);
}
for (const prefix of ['', 'Before ', '{invalid ', '}{']) {
  for (const suffix of ['', ' After', ' extra}']) {
    for (const body of ['{"slides":[]}', '{"slides":[{"title":"Fixture"}]}', '{"other":[]}', '{broken}']) {
      const input = prefix + body + suffix;
      const previous = input.match(/(\{[\s\S]*"slides"\s*:\s*\[[\s\S]*\})/);
      let expected = null;
      try { if (previous) { const deck = JSON.parse(previous[1]); if (Array.isArray(deck.slides)) expected = deck; } } catch {}
      assert.deepEqual(extractBobdeck(input)?.deck ?? null, expected, input);
    }
  }
}
for (const input of ['before demo.bobdeck after', '/nested/Deck.BOBDECK', 'αfile-name.bobdeck', 'no-file']) {
  const expected = input.match(/([a-zA-Z0-9_-]+\.bobdeck)/i)?.[1];
  assert.equal(extractBobdeck(input)?.filename, expected);
}
// Compare exact block/body boundaries against the replaced patterns.
for (const tag of ['bobdeck', 'json', 'HTML', 'jsonExtra', 'other']) {
  for (const gap of ['', ' ', '\n', '\r\n', '\n\n', '\t\n \n']) {
    for (const body of ['', 'fixture.bobdeck', '{"slides":[]}', '\n', 'x\n```json\n{}']) {
      for (const close of ['', '\n```', '\n``` trailing']) {
        const input = 'before ```' + tag + gap + body + close + ' after';
        for (const [languages, pattern] of [
          [['bobdeck', 'json'], /```(?:bobdeck|json)\s*\n([\s\S]*?)\n```/i],
          [['html'], /```(?:html)\s*\n([\s\S]*?)\n```/i],
        ]) {
          const previous = input.match(pattern);
          assert.deepEqual(deckFence(input, languages), previous ? [previous[0], previous[1]] : null, input);
        }
      }
    }
  }
}
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--long'], { timeout: 10000, encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr || String(child.error));
console.log('PASS: deck span compatibility, filename extraction and bounded long near misses');
