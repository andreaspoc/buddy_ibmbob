import { runStreamMarkdownChecks } from './contracts/streamMarkdown.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../web/src/lib/streamMarkdown.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { streamMarkdown } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const { marked } = await import('../web/node_modules/marked/lib/marked.esm.js');
runStreamMarkdownChecks({streamMarkdown, marked});
