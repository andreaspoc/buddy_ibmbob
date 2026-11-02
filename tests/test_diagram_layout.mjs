import { runDiagramLayoutChecks } from './contracts/diagramLayout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('../web/node_modules/typescript');
const ELK = require('../web/node_modules/elkjs/lib/elk.bundled.js');
// Exercise the real TS module and actual ELK runtime without a browser bundle.
let source = ts.transpileModule(fs.readFileSync(new URL('../web/src/lib/diagramLayout.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
const dependencies = {};
for (const name of ['diagramSelection', 'fixedDiagramRouting']) {
 const compiled = ts.transpileModule(fs.readFileSync(new URL(`../web/src/lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 const exports = {}; new Function('exports', compiled)(exports); dependencies[`./${name}`] = exports;
}
new Function('require', 'exports', 'module', source)(id => { if (dependencies[id]) return dependencies[id]; assert.equal(id, 'elkjs/lib/elk.bundled.js'); return ELK; }, module.exports, module);
await runDiagramLayoutChecks(module.exports);
