import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(new URL('../web/src/lib/noteEnrichment.ts', import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
// Exercise the real language helpers: locales deliberately differ from API codes.
const i18n = {};
const i18nCode = ts.transpileModule(fs.readFileSync(new URL('../web/src/lib/i18n.ts', import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
globalThis.document = {documentElement:{lang:'en'}};
new Function('exports','require',i18nCode)(i18n,()=>({greekCatalog:{},hindiCatalog:{},malteseCatalog:{},notesCatalog:{}}));
const exports = {};
let response, request, cancellations = 0;
let workspaceRequests = 0;
globalThis.fetch = async (url, options) => {
 if (url === '/api/notes/workspace') {
  assert.equal(options.method,'POST'); workspaceRequests++;
  return new Response(JSON.stringify({id:'private'}));
 }
 assert.match(url,/^\/jobs\/.+\/cancel$/); cancellations++; return new Response('{}');
};
new Function('exports','require',code)(exports,name => name === './i18n' ? i18n : name === './requestId' ? {createRequestId:()=>webcrypto.randomUUID()} : {submitChatRequest:async options=>{request=JSON.parse(options.body);return response;}});
const {parseNoteRevision,enrichNote}=exports;
assert.deepEqual(parseNoteRevision('```json\n{"title":" Test ","body":"[Source](https://example.org)"}\n```'),{title:'Test',body:'[Source](https://example.org)'});
for(const raw of ['', '{}','[]','{"title":"a","body":"b","extra":1}',JSON.stringify({title:'a',body:'x'.repeat(6001)})]) assert.throws(()=>parseNoteRevision(raw));
const stream=events=>new Response(events.map(e=>JSON.stringify(e)).join('\n'),{headers:{'X-Bob-Job-Id':'job'}});
response=stream([{type:'delta',text:'{"title":"a",'},{type:'delta',text:'"body":"b"}'},{type:'done'}]);
assert.deepEqual(await enrichNote({title:'old',body:'old'},'Shorten',{signal:new AbortController().signal}),{title:'a',body:'b'});
assert.equal(request.workspace_id,'private');
assert.equal(workspaceRequests,1);
assert.equal(request.approval_policy.mode,'selected');
for (const language of ['en','el','hi','mt']) {
 i18n.setLanguage(language);
 response=stream([{type:'done',text:'{"title":"Revision","body":"Revised note"}'}]);
 await enrichNote({title:'Source',body:'Source note'},'Clarify',{signal:new AbortController().signal});
 assert.equal(request.ui_language,language);
 assert.notEqual(request.ui_language,i18n.getLocale());
}

response=stream([{type:'done',text:'{"title":"final","body":"done"}'}]);
assert.equal((await enrichNote({title:'a',body:'b'},'revise',{signal:new AbortController().signal})).title,'final');
for(const events of [[{type:'approval',status:'pending'}],[{type:'error',message:'Failed research'}],[{type:'delta',text:'{}'}]]) {
 response=stream(events);
 await assert.rejects(enrichNote({title:'a',body:'b'},'revise',{signal:new AbortController().signal}));
}
assert.equal(cancellations,3);
const controller=new AbortController();controller.abort();
await assert.rejects(enrichNote({title:'a',body:'b'},'revise',{signal:controller.signal}),{name:'AbortError'});
response=new Response(JSON.stringify({detail:[{loc:['body','ui_language'],msg:'Unsupported language'}]}),{status:422});
await assert.rejects(enrichNote({title:'a',body:'b'},'revise',{signal:new AbortController().signal}),/ui_language: Unsupported language/);
console.log('Note revision parser, four-language request contract, validation errors, stream and cancellation checks passed');
