const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');
const catalogs = {};
for (const name of ['greekCatalog','hindiCatalog','malteseCatalog']) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`web/src/lib/${name}.ts`,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {exports});
  catalogs[name] = exports[name];
}
const keys = new Set([
  'My presentation template','My brand','Primary','Secondary','Accent','Background','Text',
  'Heading font','Body font','Title slide','Content slide','Chart slide','Closing slide',
  'Bob is designing…','Ask Bob to design',
]);
for (const file of ['web/src/components/PresentationTemplateStudio.tsx','web/src/components/TemplatePickerModal.tsx','web/src/lib/templateDesign.ts']) {
  const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isCallExpression(node) && ['t','translate','setBusy','setError'].includes(node.expression.getText(source)) && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text) keys.add(node.arguments[0].text);
    if (ts.isNewExpression(node) && node.expression.getText(source)==='Error' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
    if (file.endsWith('PresentationTemplateStudio.tsx')) {
      if (ts.isJsxText(node)) assert.equal(node.text.trim(), '', `Hard-coded studio text: ${node.text}`);
      if (ts.isJsxAttribute(node) && ['aria-label','placeholder'].includes(node.name.text)) assert.ok(!ts.isStringLiteral(node.initializer), `Hard-coded studio attribute: ${node.getText(source)}`);
    }
    if (file.endsWith('templateDesign.ts') && ts.isReturnStatement(node) && node.expression && ts.isStringLiteral(node.expression) && node.expression.text) keys.add(node.expression.text);
    ts.forEachChild(node,visit);
  }
  visit(source);
}
for (const [name,catalog] of Object.entries(catalogs)) {
  for (const key of keys) {
    if (['PowerPoint'].includes(key)) continue;
    assert.ok(Object.hasOwn(catalog,key), `${name} missing studio translation: ${key}`);
    assert.notEqual(catalog[key],key, `${name} falls back to English: ${key}`);
    assert.deepEqual((catalog[key].match(/\{\d+\}/g)||[]).sort(),(key.match(/\{\d+\}/g)||[]).sort(), `Invalid placeholders: ${key}`);
  }
}
console.log(`PASS: ${keys.size} Template Studio/picker/preview keys covered in Hindi, Greek, and Maltese; no raw studio JSX text or labels`);
