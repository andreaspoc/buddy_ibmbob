const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../web/node_modules/typescript');
const vm = require('node:vm');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/src/lib/malteseCatalog.ts', 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {exports: exportsObject});
const catalog = exportsObject.malteseCatalog;
let checked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.tsx?$/.test(file) || file.includes('Catalog')) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function check(node) {
      if (ts.isStringLiteral(node)) {
        assert.ok(Object.hasOwn(catalog, node.text), `${file}: Missing Maltese translation: ${node.text}`);
        checked++;
      } else if (ts.isConditionalExpression(node)) { check(node.whenTrue); check(node.whenFalse); }
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ['t', 'translate'].includes(node.expression.getText(source)) && node.arguments[0]) check(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
walk('web/src');
console.log(`PASS: ${checked} static interface translation calls have Maltese entries.`);
