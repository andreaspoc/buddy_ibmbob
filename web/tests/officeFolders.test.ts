import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { officeFoldersCatalog } from '../src/lib/officeFoldersCatalog.ts';

import { test } from 'node:test';

test('folder hierarchy and translations', () => {
const text = readFileSync(new URL('../src/components/OfficeFolderBrowser.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('folders.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['folderPath', 'folderDestinations'].includes(node.name?.text ?? '')).map(node => node.getText(source)).join('\n');
const compiled = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const box: { exports: Record<string, (...args: unknown[]) => unknown> } = { exports: {} };
runInNewContext(compiled, box); // NOSONAR: intentional sandbox for isolated unit testing
const folders = [{ id: 'a', name: 'Projects', parent_id: null }, { id: 'b', name: 'Reports', parent_id: 'a' }, { id: 'c', name: '2026', parent_id: 'b' }, { id: 'd', name: 'Archive', parent_id: null }];
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(box.exports.folderPath(folders, 'c')).map((item: {id: string}) => item.id), ['a', 'b', 'c']);
assert.deepEqual(plain(box.exports.folderPath(folders, null)), []);
assert.deepEqual(plain(box.exports.folderPath(folders, 'missing')), []);
assert.deepEqual(plain(box.exports.folderDestinations(folders, 'a')).map((item: {id: string}) => item.id), ['d']);
assert.equal(plain(box.exports.folderPath([{ id: 'a', name: 'A', parent_id: 'b' }, { id: 'b', name: 'B', parent_id: 'a' }], 'a')).length, 2);
const keys = new Set<string>();
function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text); ts.forEachChild(node, visit); }
visit(source);
for (const language of ['el', 'hi', 'mt']) for (const key of keys) assert.ok(officeFoldersCatalog[language][key], `${language}: missing ${key}`);
console.log('PASS folder ancestors, root/missing paths, descendant exclusion, cycle bounds and translations');

});
