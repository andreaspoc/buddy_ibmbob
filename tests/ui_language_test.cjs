const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');
const catalogs = {};
for (const name of ['greekCatalog','hindiCatalog','malteseCatalog','officeCatalog','officeFoldersCatalog','notesCatalog','workspaceGreekCatalog','workspaceHindiCatalog','workspaceMalteseCatalog']) {
  const module = {exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`web/src/lib/${name}.ts`, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {exports:module.exports});
  catalogs[`./${name}`] = module.exports;
}
const {greekCatalog} = catalogs['./greekCatalog'];
const {malteseCatalog} = catalogs['./malteseCatalog'];
const {hindiCatalog} = catalogs['./hindiCatalog'];
for (const key of Object.keys(greekCatalog)) {
  assert.ok(Object.hasOwn(hindiCatalog,key), `Missing Hindi translation: ${key}`);
}
for (const [key,value] of Object.entries(hindiCatalog)) {
  assert.deepEqual((value.match(/\{\d+\}/g)||[]).sort(),(key.match(/\{\d+\}/g)||[]).sort(), `Hindi placeholders: ${key}`);
}
for (const key of new Set([...Object.keys(greekCatalog), ...Object.keys(hindiCatalog)])) {
  assert.ok(Object.hasOwn(malteseCatalog, key), `Missing Maltese translation: ${key}`);
}
for (const [key, value] of Object.entries(malteseCatalog)) {
  assert.ok(value.trim(), `Empty Maltese translation: ${key}`);
  assert.deepEqual((value.match(/\{\d+\}/g)||[]).sort(), (key.match(/\{\d+\}/g)||[]).sort(), `Maltese placeholders: ${key}`);
}
function load(restricted = false, initialLanguage = null) {
  const values = new Map([['bob-ui-language', initialLanguage]]), handlers = new Map(), document = {documentElement: {lang: ''}};
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/src/lib/i18n.ts','utf8'), {compilerOptions: {module:ts.ModuleKind.CommonJS}}).outputText, {
    exports, document, window: {addEventListener: (type, callback) => handlers.set(type, callback)},
    localStorage: {getItem: key => {if(restricted) throw Error('restricted'); return values.get(key);}, setItem: (key,value) => {if(restricted) throw Error('restricted'); values.set(key,value);}},
    require: name => name === 'react' ? {useSyncExternalStore: (_subscribe, snapshot) => snapshot()} : catalogs[name],
  });
  return {exports,document,handlers,values};
}
for (const restricted of [false,true]) {
  const {exports: locale, document} = load(restricted);
  assert.equal(locale.getLanguage(),'en');
  locale.setLanguage('el');
  assert.equal(locale.getLanguage(),'el');
  assert.equal(document.documentElement.lang,'el');
  assert.equal(locale.t('Completed in 4.0s'), 'Ολοκληρώθηκε σε 4,0 δευτ.');
  assert.equal(locale.t('Completed in Done'), 'Ολοκληρώθηκε');
  assert.equal(locale.t('Using skill research-buddy…'), 'Χρήση δεξιότητας research-buddy…');
  assert.equal(locale.t('Using knowledge search…'), 'Χρήση εργαλείου knowledge search…');
  assert.equal(locale.t('Error: Request failed'), 'Σφάλμα: Το αίτημα απέτυχε');
  assert.notEqual(locale.t('Language'),'Language');
  assert.equal(locale.t('Untranslated user content'), 'Untranslated user content');
  assert.equal(locale.t('User: {0}', ['Δημήτρης']), 'User: Δημήτρης');
  locale.setLanguage('hi');
  assert.equal(locale.getLanguage(),'hi');
  assert.equal(document.documentElement.lang,'hi');
  assert.equal(locale.getLocale(),'hi-IN');
  assert.equal(locale.t('Language'),'भाषा');
  assert.equal(locale.t('Assistant'),'सहायक');
  assert.equal(locale.t('Completed in 4.0s'),'4.0 सेकंड में पूरा हुआ');
  assert.equal(locale.t('Completed in Done'),'पूरा हुआ');
  assert.equal(locale.t('Using skill research-buddy…'),'research-buddy कौशल का उपयोग हो रहा है…');
  assert.equal(locale.t('Configure {0}', ['My MCP α']), 'My MCP α कॉन्फ़िगर करें');
  assert.equal(locale.t('Untranslated user content'), 'Untranslated user content');
  locale.setLanguage('mt');
  assert.equal(locale.getLocale(), 'mt-MT');
  assert.equal(document.documentElement.lang, 'mt');
  assert.equal(locale.t('Language'), 'Lingwa');
  assert.equal(locale.t('Configure {0}', ['Test']), 'Ikkonfigura Test');
  assert.equal(locale.t('Completed in Done'), 'Tlesta');
  assert.equal(locale.t('Using skill research-buddy…'), 'Qed tintuża l-ħila research-buddy…');
  assert.equal(locale.t('Untranslated user content'), 'Untranslated user content');
  locale.setLanguage('en');
  assert.equal(locale.t('Language'),'Language');
}
const {exports: locale,handlers,document} = load();
handlers.get('storage')({key:'bob-ui-language',newValue:'el'});
assert.equal(locale.getLanguage(),'el');
assert.equal(document.documentElement.lang,'el');
handlers.get('storage')({key:'bob-ui-language',newValue:'hi'});
assert.equal(locale.getLanguage(),'hi');
assert.equal(document.documentElement.lang,'hi');
assert.equal(load(false,'mt').exports.getLanguage(),'mt');
assert.equal(load(false,'hi').exports.getLanguage(),'hi');
assert.equal(load(false,'unsupported').exports.getLanguage(),'en');
console.log('UI language switching, restricted storage, cross-tab updates, and content preservation passed.');
