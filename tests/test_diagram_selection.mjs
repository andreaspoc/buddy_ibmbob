import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from '../web/node_modules/typescript/lib/typescript.js'
const compiled = ts.transpileModule(readFileSync(new URL('../web/src/lib/diagramSelection.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { selectDiagramLayout: select } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const base = {id:'test',kind:'flow',title:'Test',direction:'TB',nodes:['A','B','C','D'].map(id=>({id,label:id,shape:'rectangle'})),edges:[['A','B'],['A','C'],['C','D']].map(([source,target],i)=>({id:`e${i}`,source,target}))}
const pick = patch => select({...base,...patch}).layout
assert.equal(pick({}), 'layered')
assert.equal(pick({layout:'auto',purpose:'process'}),'layered')
assert.equal(pick({layout:'auto',purpose:'hierarchy'}),'tree')
assert.equal(pick({layout:'auto',purpose:'concept'}),'radial')
assert.equal(pick({layout:'auto',title:'Organization hierarchy'}),'tree')
assert.equal(pick({layout:'auto',purpose:'inventory',edges:[]}),'rectpacking')
assert.equal(pick({layout:'auto',purpose:'components',edges:base.edges.slice(0,1)}),'disco')
const cyclic=[...base.edges,{id:'back',source:'D',target:'A'}]
assert.equal(pick({layout:'auto',purpose:'relationships',edges:cyclic}),'force')
const dense=[...cyclic,{id:'e4',source:'B',target:'C'},{id:'e5',source:'B',target:'D'}]
assert.equal(pick({layout:'auto',purpose:'relationships',edges:dense}),'stress')
assert.equal(pick({layout:'tree',edges:cyclic}),'layered')
assert.equal(pick({layout:'radial',edges:cyclic}),'layered')
assert.equal(pick({layout:'rectpacking'}),'layered')
assert.equal(pick({layout:'fixed'}),'layered')
const positioned=base.nodes.map((node,i)=>({...node,position:{x:i*200,y:0}}))
assert.equal(pick({layout:'auto',purpose:'spatial',nodes:positioned}),'fixed')
assert.equal(pick({layout:'auto',purpose:'spatial'}),'layered')
assert.equal(pick({layout:'auto',purpose:'process',nodes:positioned}),'layered')
assert.equal(pick({layout:'fixed',nodes:positioned}),'fixed')
for(const layout of ['layered','force','stress','disco']) assert.equal(pick({layout,purpose:'hierarchy'}),layout)
assert.equal(pick({layout:'auto',purpose:'process',lanes:[{id:'owner',label:'Owner'}],nodes:base.nodes.map(node=>({...node,lane:'owner'}))}),'swimlane')
assert.equal(pick({layout:'swimlane'}),'layered')
assert.equal(pick({layout:'auto',purpose:'hierarchy',kind:'sequence'}),'layered')
const before=JSON.stringify(base); select({...base,layout:'auto',purpose:'relationships'}); assert.equal(JSON.stringify(base),before)
console.log('PASS: contextual diagram selection, topology guards, coordinates and legacy defaults')
