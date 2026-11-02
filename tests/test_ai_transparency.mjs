import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marked } from '../web/node_modules/marked/lib/marked.esm.js';
import { transpile } from './frontend_transpile.mjs';
const names = {};
new Function('exports', transpile(readFileSync(new URL('../web/src/lib/toolName.ts', import.meta.url), 'utf8'), true))(names);
const state = {};
new Function('exports', 'require', transpile(readFileSync(new URL('../web/src/lib/taskState.ts', import.meta.url), 'utf8'), true))(state, path => { assert.equal(path, './toolName'); return names; });
const { answerTaskState: status, savedTaskState, latestTaskSummary } = state;
for (const name of [undefined, null, '', '   ', 12, {}]) {
  assert.equal(status({isStreaming:true,content:'',toolsUsed:[{name,status:'running'}]}).detail,'Tool name unavailable');
  assert.equal(names.resolveToolName(name,'call-1',[{id:'call-1',toolName:'office_import'}]),'office_import');
}
assert.equal(names.resolveToolName(undefined,'other',[{id:'call-1',toolName:'office_import'}]),'Tool name unavailable');

for (const terminal of ['completed', 'failed', 'cancelled']) {
  assert.equal(status({ deliveryState: terminal, isStreaming: true, approvals: [{status:'pending'}], toolsUsed:[{name:'search',status:'running'}] }).state, terminal === 'cancelled' ? 'stopped' : terminal);
}
assert.equal(status({deliveryState:'running',isStreaming:true,isStopping:true,approvals:[{status:'pending'}]}).state,'stopping');
assert.equal(status({ deliveryState:'queued', isStreaming:true, content:'' }).state, 'queued');
assert.equal(status({ deliveryState:'running', isStreaming:true, approvals:[{status:'pending'}],content:'' }).state, 'waiting');
assert.equal(status({ deliveryState:'streaming', isStreaming:true, content:'Partial answer',toolsUsed:[{name:'knowledge_search',status:'running'}] }).state, 'tool');
assert.equal(status({ deliveryState:'streaming', isStreaming:true, content:'Partial answer',toolsUsed:[{name:'knowledge_search',status:'completed'}] }).state, 'streaming');
assert.equal(status({content:'Legacy answer'}).state, 'available', 'absence of an event must not invent completion');
assert.equal(status({content:'Legacy answer',approvals:[{status:'pending'}]}).state, 'available', 'historical unresolved approval does not imply active work');
assert.equal(status({content:'Partial saved answer',deliveryState:'streaming'}).state,'available');
assert.equal(savedTaskState({status:'failed',progress:'Finished search'}).state,'failed');
assert.equal(savedTaskState({status:'running',progress:'Reading knowledge sources'}).detail,'Reading knowledge sources');
const queued = {id:'task',status:'queued',updated_at:'2026-10-19T10:00:00Z'};
const stopped = {...queued,status:'stopped'};
assert.equal(latestTaskSummary(queued,stopped).status,'stopped');
assert.equal(latestTaskSummary(stopped,queued).status,'stopped');
assert.equal(latestTaskSummary(queued,{...stopped,id:'other'}).status,'queued');
assert.equal(latestTaskSummary({...stopped,updated_at:'2026-10-19T10:00:01Z'},queued).status,'stopped');
const context = {};
new Function('exports','require',transpile(readFileSync(new URL('../web/src/lib/answerContext.ts', import.meta.url), 'utf8'),true))(context, name => {assert.equal(name,'marked');return {marked};});
const {answerLinks,requestForAnswer} = context;
const origin='https://buddy.example';
const links=answerLinks('[Policy](https://example.com/policy) [Duplicate](https://example.com/policy)\n\n[Reference][ref]\n\n[ref]: /knowledge/source/file\n\n[Unsafe](javascript:alert)\n\n[Credentials](https://user:password@example.com)\n\n[Pending](/knowledge/source/file#stream-pending)\n\n[Relative](report.html)\n\n```md\n[Code sample](https://code.example)\n```',origin);
assert.deepEqual(links,[{href:'https://example.com/policy',label:'Policy'},{href:'https://buddy.example/knowledge/source/file',label:'Reference'}]);
assert.deepEqual(answerLinks('No citations were recorded.',origin),[]);
const messages=[{role:'user',historyTurnIndex:0,noteReferences:[{id:1,title:'Previous turn'}]},{role:'assistant',historyTurnIndex:1,content:'Request deleted'}];
assert.equal(requestForAnswer(messages,1),undefined,'deleted request must not borrow another turn’s context');
messages.splice(1,0,{role:'user',historyTurnIndex:1,noteReferences:[{id:2,title:'Current turn'}]});
assert.equal(requestForAnswer(messages,2).noteReferences[0].id,2);
assert.equal(requestForAnswer([{role:'user',correlationId:'old'},{role:'assistant',correlationId:'new'}],1),undefined);
console.log('PASS event precedence, missing-data states, recorded links, unsafe URL exclusion, deduplication and per-turn context isolation');
