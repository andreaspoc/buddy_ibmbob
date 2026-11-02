const assert = require('node:assert/strict');
const { test } = require('node:test');

test('draft isolation and storage failures', () => {
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const data = new Map();
let blocked = false;
let slots = [], cursor = 0;
const react = {
  useRef(initial) { const index=cursor++; return slots[index] ?? (slots[index]={current:initial}); },
  useState(initial) { const index=cursor++; if (!slots[index]) slots[index]={value:initial}; return [slots[index].value, update=>{slots[index].value=typeof update==='function'?update(slots[index].value):update;}]; },
  useCallback(callback,deps) { const index=cursor++; const previous=slots[index]; if (previous && deps.every((value,i)=>Object.is(value,previous.deps[i]))) return previous.callback; slots[index]={callback,deps}; return callback; },
};
const box = {exports:{}, require:name=>react, sessionStorage:{
  getItem:key=>{if(blocked)throw Error('restricted');return data.get(key)||null;},
  setItem:(key,value)=>{if(blocked)throw Error('restricted');data.set(key,value);},
  removeItem:key=>{if(blocked)throw Error('restricted');data.delete(key);},
}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/lib/peopleDrafts.ts',`file://${__filename}`),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,box); // NOSONAR: intentional sandbox for isolated unit testing
const {peopleDraftKey:key,readPeopleDraft:read,writePeopleDraft:write,messageDayKey:day} = box.exports;
const plain=value=>JSON.parse(JSON.stringify(value));
const root=key('fixture-a',1,null), thread=key('fixture-a',1,42), other=key('fixture-a',2,null), account=key('fixture-b',1,null);
assert.equal(new Set([root,thread,other,account]).size,4);
assert.equal(key('fixture-a',null,null),'');
write(root,{body:'Fixture main draft',mentioned:[{username:'fixture-peer',display_name:'Fixture Peer'}]});
write(thread,{body:'Fixture thread draft',mentioned:[]});
assert.equal(read(root).body,'Fixture main draft');
assert.equal(read(thread).body,'Fixture thread draft');
assert.equal(read(other).body,''); assert.equal(read(account).body,'');
assert.equal(read(root).mentioned[0].username,'fixture-peer');
write(thread,{body:'',mentioned:[]});
assert.equal(read(thread).body,''); assert.equal(read(root).body,'Fixture main draft');
data.set(root,JSON.stringify({body:'x'.repeat(21000),mentioned:[null,{username:3},{username:'valid',display_name:'Valid'}]}));
assert.equal(read(root).body.length,20000); assert.equal(read(root).mentioned.length,1);
data.set(root,'broken json');assert.deepEqual(plain(read(root)),{body:'',mentioned:[]});
blocked=true;assert.doesNotThrow(()=>write(root,{body:'fixture',mentioned:[]}));assert.equal(read(root).body,'');
assert.equal(day('invalid date'),'');
assert.equal(day(new Date(2026,0,1,10).toISOString()),'2026-0-1');
assert.notEqual(day(new Date(2026,0,1,23).toISOString()),day(new Date(2026,0,2,0).toISOString()));
blocked=false; data.clear();
function render(username,room,thread) { cursor=0; return box.exports.usePeopleDraft(username,room,thread); }
let state=render('fixture-a',1,null); state.setBody('Main draft');
const completeOldSend=state.setBody;
state=render('fixture-a',1,42); state.setBody('Thread draft');
completeOldSend('');
assert.equal(render('fixture-a',1,42).body,'Thread draft','An old send must not clear the active thread draft');
assert.equal(render('fixture-a',1,null).body,'');
state=render('fixture-a',1,42); state.setMentioned([{username:'fixture-peer',display_name:'Fixture Peer'}]);
assert.equal(render('fixture-a',1,42).mentioned[0].username,'fixture-peer');
assert.equal(render('fixture-b',1,42).body,'','Account changes must not reuse another account draft');
blocked=true; state=render('fixture-a',2,null); state.setBody('Memory-only fixture');
render('fixture-a',3,null);
assert.equal(render('fixture-a',2,null).body,'Memory-only fixture');
console.log('PASS: account/room/thread draft isolation, mention metadata, clearing one draft, bounds, corrupt/restricted storage, invalid dates, keyed hook switching, late send completion and in-memory fallback');

});
