import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transpile} from './frontend_transpile.mjs';
const source = readFileSync(new URL('../web/src/lib/presentationEditing.ts', import.meta.url),'utf8');
const {protectPresentationTyping, removablePresentationElement} = await import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString('base64')}`);
let listener; let removed;
const window = {addEventListener(type, handler, capture){assert.equal(type,'keydown');assert.equal(capture,true);listener=handler;},removeEventListener(type,handler,capture){removed=handler;assert.equal(capture,true);}};
const cleanup = protectPresentationTyping(window);
for(const code of ['Space','ArrowRight','ArrowLeft','Backspace','Delete','KeyF']) {
  let stopped=0; let prevented=0;
  listener({code,target:{nodeType:1,isContentEditable:true,closest:()=>null},stopImmediatePropagation(){stopped++;},preventDefault(){prevented++;}});
  assert.equal(stopped,1,`${code} must not invoke deck shortcuts during typing`);assert.equal(prevented,0,'Native text insertion must remain available');
}
for(const tag of ['input','textarea','select','button']) {
  let stopped=false;listener({target:{nodeType:1,closest:selector=>selector.includes(tag)},stopImmediatePropagation(){stopped=true;}});assert.ok(stopped);
}
let stopped=false;listener({target:{nodeType:1,isContentEditable:false,closest:()=>null},stopImmediatePropagation(){stopped=true;}});assert.equal(stopped,false);
cleanup();assert.equal(removed,listener);
const object = (tag,inside=true,slide=false)=>({tagName:tag,closest:()=>inside?{}:null,matches:()=>slide});
for(const tag of ['DIV','IMG','CANVAS','SVG','H2'])assert.ok(removablePresentationElement(object(tag)));
assert.equal(removablePresentationElement(object('SECTION',true,true)),false);
assert.equal(removablePresentationElement(object('DIV',false)),false);
assert.equal(removablePresentationElement(object('SCRIPT')),false);
console.log('Typing shortcuts and removable frame/object boundaries passed.');
