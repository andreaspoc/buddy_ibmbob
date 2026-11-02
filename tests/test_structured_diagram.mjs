import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from '../web/node_modules/typescript/lib/typescript.js'
const source = readFileSync(new URL('../web/src/lib/structuredDiagram.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { parseDiagramSource: parse, splitDiagramMarkdown: split } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const header = JSON.stringify({ type: 'diagram', id: 'test', kind: 'flow', title: 'Test', direction: 'LR' })
const node = id => JSON.stringify({ type: 'node', id, label: id, shape: 'rounded' })
const edge = JSON.stringify({ type: 'edge', id: 'e', source: 'A', target: 'B', label: 'next' })
const records = [header, node('A'), edge, node('B')].join('\n') + '\n'
assert.equal(parse(header + '\n' + node('A') + '\n').spec.nodes.length, 1)
assert.equal(parse(header + '\n' + node('A')).spec.nodes.length, 1, 'complete final record renders before newline')
assert.equal(parse(header + '\n' + node('A').slice(0, -1)).spec.nodes.length, 0, 'unfinished last record is deferred')
assert.equal(parse([header, node('A'), edge].join('\n') + '\n').spec.edges.length, 0)
assert.equal(parse(records).spec.edges.length, 1, 'forward edges resolve')
const invalid = parse(records + '{bad}\n', true)
assert.equal(invalid.spec.nodes.length, 2)
assert.match(invalid.error, /Invalid JSON/)
assert.equal(parse(records + JSON.stringify({type:'node',id:'unsafe!',label:'Oops'}) + '\n', true).spec.nodes.length, 2)
assert.equal(parse(records + JSON.stringify({type:'node',id:'Huge',label:'x'.repeat(501)}) + '\n', true).spec.nodes.length, 2)
assert.equal(parse(JSON.stringify(parse(records).spec), true).spec.nodes.length, 2)
const parts = split('Intro\n```bobdiagram\n' + records, true)
assert.equal(parts[1].type, 'diagram'); assert.equal(parts[1].complete, false); assert.equal(parts[1].spec.edges.length, 1)
assert.equal(split('```bobdiagram\n' + records + '```\n', true)[0].complete, true)
assert.equal(split('```text\n```bobdiagram\n' + records + '```\n```\n', true).some(p => p.type === 'diagram'), false)
assert.equal(split('> ```bobdiagram\n> {}\n> ```\n', true).some(p => p.type === 'diagram'), false)
assert.equal(split('hello `bobdiagram`', true)[0].text, 'hello `bobdiagram`')
assert.equal(split('hello\n```bobdia', true)[0].text, 'hello\n')
const many = [header, ...Array.from({length: 110}, (_, i) => node('n' + i))].join('\n') + '\n'
assert.equal(parse(many, true).spec.nodes.length, 100)
assert.match(parse(many, true).error, /100 nodes/)
console.log('Structured diagram streaming and validation tests passed')

for (let i = 1; i < '```bobdiagram'.length; i++) {
  assert.equal(split('Intro\n' + '```bobdiagram'.slice(0, i), true).map(p => p.type === 'markdown' ? p.text : '').join(''), 'Intro\n');
}
assert.equal(split('Intro\n```python', true)[0].text, 'Intro\n```python');

const styled = parse(JSON.stringify({id:'Styled',kind:'flow',nodes:[{id:'A',label:'Request',shape:'rounded',tone:'blue'},{id:'B',label:'Store',shape:'database',tone:'teal'}],edges:[{id:'e',source:'A',target:'B',tone:'teal',animated:true}]}),true)
assert.equal(styled.spec.nodes[0].tone,'blue')
assert.equal(styled.spec.edges[0].animated,true)
assert.deepEqual(parse(JSON.stringify(styled.spec),true).spec,styled.spec)
for (const invalid of [{tone:'red; background:url(x)'},{tone:['blue']},{animated:'true'},{animated:1}]) {
  const result = parse(JSON.stringify({...styled.spec,edges:[{id:'e',source:'A',target:'B',...invalid}]}),true)
  assert.equal(result.spec.edges.length,0)
  assert.ok(result.error)
}
assert.equal(parse(JSON.stringify({...styled.spec,nodes:[{id:'A',label:'Unsafe',shape:'rounded',tone:'url(x)'}]}),true).spec.nodes.length,0)

const business = {id:'Business',kind:'flow',layout:'swimlane',motion:'flow',lanes:[{id:'Requester',label:'Synthetic requester',tone:'blue'},{id:'Reviewer',label:'Synthetic reviewer',tone:'teal'}],nodes:[{id:'A',label:'Request',shape:'rounded',lane:'Requester'},{id:'B',label:'Approve?',shape:'diamond',lane:'Reviewer'}],edges:[{id:'E',source:'A',target:'B',animated:true}]};
const parsedBusiness=parse(JSON.stringify(business),true);
assert.equal(parsedBusiness.error,undefined);
assert.deepEqual(parse(JSON.stringify(parsedBusiness.spec),true).spec,parsedBusiness.spec);
const streamBusiness=JSON.stringify({type:'diagram',id:'Business',kind:'flow',layout:'swimlane'})+'\n'+JSON.stringify({type:'node',id:'A',label:'Request',lane:'Requester'})+'\n';
assert.equal(parse(streamBusiness,false).error,undefined,'Owner references are deferred during streaming');
assert.match(parse(streamBusiness,true).error,/defined lane/);
assert.equal(parse(streamBusiness+JSON.stringify({type:'lane',id:'Requester',label:'Requester'})+'\n',true).error,undefined);
for(const layout of ['layered','tree','radial','force']) {
 const parsed=parse(JSON.stringify({...styled.spec,layout,motion:'none'}),true);
 assert.equal(parsed.error,undefined);
 assert.equal(parsed.spec.layout,layout);
 assert.equal(parsed.spec.motion,'none');
}
for(const patch of [{layout:'custom-code'},{layout:['force']},{motion:'javascript'},{motion:['none']}]) {
 assert.equal(parse(JSON.stringify({...styled.spec,...patch}),true).spec,undefined);
}
assert.ok(parse(JSON.stringify({...business,lanes:[{id:'Requester',label:'Test',tone:['blue']}]}),true).error);
console.log('PASS: semantic layout schema, owner lanes, progressive lane resolution, round-trip exports and unsafe option rejection');

for (const layout of ['auto','stress','rectpacking','disco','fixed']) {
 const result=parse(JSON.stringify({...styled.spec,layout,purpose:'relationships'}),true)
 assert.equal(result.error,undefined)
 assert.equal(result.spec.layout,layout)
 assert.equal(result.spec.purpose,'relationships')
}
for (const purpose of ['process','hierarchy','concept','relationships','inventory','components','spatial']) {
 assert.equal(parse(JSON.stringify({...styled.spec,purpose}),true).spec.purpose,purpose)
}
for (const purpose of ['unknown',['process'],null]) assert.ok(parse(JSON.stringify({...styled.spec,purpose}),true).error)
const spatial={...styled.spec,layout:'fixed',purpose:'spatial',nodes:[{id:'A',label:'Known location',position:{x:0,y:100000}}],edges:[]}
assert.deepEqual(parse(JSON.stringify(parse(JSON.stringify(spatial),true).spec),true).spec.nodes[0].position,{x:0,y:100000})
for(const position of [{x:-1,y:0},{x:0,y:100001},{x:'0',y:0},{x:0},[],null]) {
 const result=parse(JSON.stringify({...spatial,nodes:[{id:'A',label:'Unsafe',position}]}),true)
 assert.ok(result.error)
 assert.equal(result.spec.nodes.length,0)
}
assert.ok(parse(JSON.stringify(spatial).replace('100000','1e999'),true).error)
console.log('PASS: extended layout intents and bounded spatial coordinates')
