import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { greekCatalog } from '../src/lib/greekCatalog.ts';
import { hindiCatalog } from '../src/lib/hindiCatalog.ts';
import { malteseCatalog } from '../src/lib/malteseCatalog.ts';

import { test } from 'node:test';

test('welcome tutorial translations', () => {

const source = ts.createSourceFile('SkillsGuide.tsx', readFileSync(new URL('../src/components/SkillsGuide.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const strings = new Set<string>(['Summarize this document', 'in five bullet points', 'as a step-by-step plan', 'in a comparison table', 'Replay welcome tutorial']);
function collect(node: ts.Node) {
  if (ts.isStringLiteral(node) && node.text) strings.add(node.text);
  ts.forEachChild(node, collect);
}
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments[0]) collect(node.arguments[0]);
  if (ts.isPropertyAssignment(node) && ['title', 'text', 'label'].includes(node.name.getText(source))) collect(node.initializer);
  ts.forEachChild(node, visit);
}
visit(source);
for (const [language, catalog] of Object.entries({ el: greekCatalog, hi: hindiCatalog, mt: malteseCatalog })) {
  for (const key of strings) {
    if (key !== 'Company A Buddy') assert.ok(catalog[key], `${language}: missing ${key}`);
  }
  console.log(`PASS ${language}: ${strings.size} tutorial and screenshot strings covered`);
}

});
