const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('../node_modules/typescript');

// Compile the repository module and load it through Node's normal module loader.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/redaction.ts'), 'utf8');
const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-redaction-test-'));
let redactActivity;
try {
  const modulePath = path.join(buildDirectory, 'redaction.cjs');
  fs.writeFileSync(modulePath, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { mode: 0o600 });
  ({ redactActivity } = require(modulePath));
} finally {
  fs.rmSync(buildDirectory, { recursive: true, force: true });
}

if (process.argv.includes('--long')) {
  test('long credential inputs finish without backtracking', () => {
  for (const value of ['x'.repeat(800000), 'token' + ' '.repeat(800000), 'https://' + ':'.repeat(800000)]) {
    assert.equal(redactActivity(value), value);
  }
  assert.equal(redactActivity('prefix_token=' + 'x'.repeat(800000)), 'prefix_token=[redacted]');
  });
} else {

test('credential masking and bounded long inputs', () => {
// Expected results express the security contract independently of its implementation.
for (const name of ['api_key', 'my-token-extra', 'password', 'SECRET', 'authorization', 'credential']) {
  for (const separator of [':', '=']) {
    for (const space of ['', ' ', '\t\n']) {
      for (const quote of ['', '"', "'"]) {
        const prefix = `${name}${quote}${space}${separator}${space}${quote}`;
        const suffix = `${quote}, next`;
        assert.equal(redactActivity(prefix + 'fixture' + suffix), prefix + '[redacted]' + suffix);
      }
    }
  }
}
for (const [input, expected] of [
  ['ordinary=fixture, next', 'ordinary=fixture, next'],
  ['ordinary=token=next, next', 'ordinary=token=[redacted], next'],
  ['password=, next', 'password=, next'],
  ['password="", next', 'password="", next'],
  ['password= ', 'password= '],
  ['token fixture', 'token fixture'],
  ['token=one&password=two', 'token=[redacted]&password=[redacted]'],
  ['api-key:fixture}', 'api-key:[redacted]}'],
  ['password="fixture with spaces"', 'password="[redacted] with spaces"'],
  ['Bearer fixture', 'Bearer [redacted]'],
  ['eyJabc.def.ghi', '[redacted]'],
  ['https://a:b@example.test/path', 'https://[redacted]@example.test/path'],
  ['https://:a:b@example.test/path', 'https://[redacted]@example.test/path'],
  ['https://:::@example.test/path', 'https://[redacted]@example.test/path'],
  ['https://user:pass:extra@example.test/path', 'https://[redacted]@example.test/path'],
  ['https://a:@example.test/path', 'https://a:@example.test/path'],
  ['https://:b@example.test/path', 'https://:b@example.test/path'],
  ['https://plain@example.test/path', 'https://plain@example.test/path'],
]) {
  assert.equal(redactActivity(input), expected, input);
}
assert.equal(JSON.stringify(redactActivity({password: 'fixture', items: ['token=fixture']})), '{"password":"[redacted]","items":["token=[redacted]"]}');
const child = spawnSync(process.execPath, [__filename, '--long'], { timeout: 10000, encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr || String(child.error));
console.log('PASS: credential masking contract, nested values and bounded long near misses');

});

}
