const assert = require('node:assert/strict');
const { test } = require('node:test');

test('interface translations and placeholders', () => {
// Audit all statically declared t() strings, including conditional labels.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const root = path.resolve(__dirname, '../src');
const catalogs = {el: {}, hi: {}, mt: {}};
for (const [file, language] of [['greekCatalog','el'],['hindiCatalog','hi'],['malteseCatalog','mt'],['workspaceGreekCatalog','el'],['workspaceHindiCatalog','hi'],['workspaceMalteseCatalog','mt'],['officeCatalog'],['officeFoldersCatalog'],['notesCatalog'],['appsCatalog'],['interactiveCatalog'],['diagramLayoutCatalog'],['securityCatalog'],['aiTransparencyCatalog']]) {
  const parsed = ts.createSourceFile(file, fs.readFileSync(`${root}/lib/${file}.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, `Invalid catalog syntax: ${file}`);
  const box = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${root}/lib/${file}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, box); // NOSONAR: intentional sandbox for isolated unit testing
  const data = Object.values(box.exports)[0];
  for (const lang of ['el','hi','mt']) Object.assign(catalogs[lang], language ? language === lang ? data : {} : data[lang]);
}
const keys = new Set();
function scan(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (/\.tsx?$/.test(file) && !file.includes('Catalog')) {
      const source = ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
      const strings = node => { if(ts.isStringLiteral(node)) keys.add(node.text); else if(ts.isConditionalExpression(node)){strings(node.whenTrue);strings(node.whenFalse);} };
      const visit = node => { if(ts.isCallExpression(node) && node.expression.getText(source)==='t' && node.arguments[0]) strings(node.arguments[0]); ts.forEachChild(node,visit); };
      visit(source);
    }
  }
}
scan(root);
for (const language of ['el','hi','mt']) for (const key of keys) {
  assert.ok(catalogs[language][key], `${language}: missing ${key}`);
  assert.deepEqual((catalogs[language][key].match(/\{\d+\}/g)||[]).sort(),(key.match(/\{\d+\}/g)||[]).sort(),`${language}: placeholders in ${key}`);
}
console.log(`PASS: ${keys.size} static interface strings covered in Greek, Hindi and Maltese; placeholders preserved`);

});
