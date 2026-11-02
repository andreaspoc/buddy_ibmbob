const assert = require('node:assert/strict');
const { test } = require('node:test');

test('module load failure recovery', () => {
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const React = require('../node_modules/react');
const {renderToStaticMarkup} = require('../node_modules/react-dom/server');
const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/ErrorBoundary.tsx'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
let reloads = 0;
const box = {exports: {}, window: {location: {reload: () => reloads++}}, require: name => name.includes('i18n') ? {t: s => s} : require('../node_modules/'+name)};
vm.runInNewContext(code,box); // NOSONAR: intentional sandbox for testing ErrorBoundary in isolation
for (const message of ['Failed to fetch dynamically imported module: https://example.test/assets/OfficeSuite-old.js', 'Importing a module script failed.', 'error loading dynamically imported module']) {
 const boundary = new box.exports.ErrorBoundary({name: 'Application'});
 boundary.state = {hasError: true, error: new Error(message)};
 const tree = boundary.render();
 const html = renderToStaticMarkup(tree);
 assert.match(html, /Refresh application/);
 assert.doesNotMatch(html, /OfficeSuite-old/);
 const button = tree.props.children[0].props.children[1];
 button.props.onClick();
}
assert.equal(reloads,3);
const ordinary = new box.exports.ErrorBoundary({name: 'Application'});
ordinary.state = {hasError: true, error: new Error('Ordinary error')};
const html = renderToStaticMarkup(ordinary.render());
assert.match(html,/Retry/);
assert.match(html,/Ordinary error/);
console.log('PASS browser module failures refresh the app; ordinary errors retain Retry');

});
