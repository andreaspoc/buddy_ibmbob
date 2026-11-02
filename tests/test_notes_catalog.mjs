import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../web/package.json',import.meta.url));
const ts=require('typescript');
const load=(path,deps=()=>({}))=>{const result={};new Function('exports','require',ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(result,deps);return result;};
const {notesCatalog}=load('web/src/lib/notesCatalog.ts');
// Keep shipped Notes UI copy covered as new controls are added.
for (const path of ['web/src/components/StickyNotes.tsx','web/src/components/NoteDetails.tsx','web/src/lib/noteEnrichment.ts']) {
 const source=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 const visit=node=>{
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='t'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){
   const key=node.arguments[0].text;
   for(const language of ['el','hi','mt']) assert.ok(notesCatalog[language][key],`${path}: missing ${language} translation: ${key}`);
  }
  ts.forEachChild(node,visit);
 };
 visit(source);
}
globalThis.document={documentElement:{lang:'en'}};
const i18n=load('web/src/lib/i18n.ts',name=>name==='./notesCatalog'?{notesCatalog}:name==='react'?{useSyncExternalStore:()=>{}}:name==='./greekCatalog'?{greekCatalog:{}}:name==='./hindiCatalog'?{hindiCatalog:{}}:{malteseCatalog:{}});
for(const language of ['el','hi','mt']){
 i18n.setLanguage(language);
 for(const [key,value] of Object.entries(notesCatalog[language])){
  assert.ok(value.trim(),`${language}: ${key}`);
  assert.equal(i18n.t(key),value);
  assert.deepEqual([...value.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),[...key.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),key);
 }
 assert.notEqual(i18n.t('Saved notes'),'Saved notes');
 assert.ok(i18n.t('{0} notes selected',[3]).includes('3'));
 assert.equal(i18n.t('User-authored note content'),'User-authored note content');
}
i18n.setLanguage('en');assert.equal(i18n.t('Saved notes'),'Saved notes');
console.log('Notes catalogs and actual runtime language switching passed');
