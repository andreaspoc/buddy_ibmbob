import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../web/src/lib/presentationChatText.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { presentationChatText: clean } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
for (const language of ['json', 'bobdeck', 'html', '']) {
 const block = '```' + language + '\n' + (language === 'html' ? '<html><body>slides</body></html>' : '{"slides":[{"content":"brace } and \\\" quote"}]}') + '\n```';
 for (let i = 1; i <= block.length; i++) assert.equal(clean('Preparing your deck.\n' + block.slice(0, i), true), 'Preparing your deck.', block.slice(0, i));
 assert.equal(clean('Intro\n' + block + '\nReady.', true), 'Intro\n\nReady.');
}
const json = '{"slides":[{"text":"a } b"}]}';
for (let i = 1; i <= json.length; i++) assert.equal(clean('Intro\n' + json.slice(0,i), true), 'Intro');
assert.equal(clean('Intro\n' + json + '\nReady.', true), 'Intro\n\nReady.');
assert.equal(clean('```json\n{"answer":42}\n```', false), '```json\n{"answer":42}\n```');
assert.equal(clean('```bobdeck\n' + json + '\n```', false), '');
assert.equal(clean('```python\nprint(42)\n```', true), '```python\nprint(42)\n```');
console.log('Presentation chat source filtering checks passed');
