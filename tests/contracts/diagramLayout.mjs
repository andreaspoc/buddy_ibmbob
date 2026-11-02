import assert from 'node:assert/strict';

export async function runDiagramLayoutChecks(runtime) {
const { layoutDiagram, nodeSize } = runtime;
const chain = { id: 'chain', kind: 'flow', title: 'Synthetic chain', direction: 'LR', nodes: Array.from({ length: 12 }, (_, i) => ({ id: `N${i}`, label: `Synthetic stage ${i + 1}`, shape: 'rounded' })), edges: Array.from({ length: 11 }, (_, i) => ({ id: `E${i}`, source: `N${i}`, target: `N${i + 1}`, label: `Continue ${i + 1}` })) };
function checkRoutes(spec, layout) {
  assert.equal(Object.keys(layout.positions).length, spec.nodes.length);
  assert.equal(Object.keys(layout.edges).length, spec.edges.length);
  assert.ok(layout.width > 0 && layout.height > 0);
  for (const edge of spec.edges) {
    const route = layout.edges[edge.id];
    assert.ok(route.sections.length > 0, `Missing ${edge.id}`);
    const points = route.sections.flatMap(section => section.points);
    assert.ok(points.length >= 2);
    for (const p of points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    for (const section of route.sections) for (let i = 1; i < section.points.length; i++) {
      const a = section.points[i - 1], b = section.points[i];
      assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `Native route must stay orthogonal: ${edge.id} ${JSON.stringify(section.points)}`);
    }
    if (layout.wrapped && route.label) {
      const box = route.label;
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height, 'Caption clipped by bounds');
      for (const node of Object.values(layout.positions)) assert.ok(box.x + box.width <= node.x || node.x + nodeSize.width <= box.x || box.y + box.height <= node.y || node.y + nodeSize.height <= box.y, 'Caption covers a card');
    }
    for (const [point, id] of [[points[0], edge.source], [points.at(-1), edge.target]]) {
      const node = layout.positions[id];
      assert.ok(point.x >= node.x - 1 && point.x <= node.x + nodeSize.width + 1 && point.y >= node.y - 1 && point.y <= node.y + nodeSize.height + 1, `Route endpoint detached: ${edge.id}/${id}`);
    }
    if (edge.label) assert.ok(route.label?.width > 0 && route.label?.height > 0, `Missing label ${edge.id}`);
  }
  const nodes = Object.values(layout.positions);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    assert.ok(a.x + nodeSize.width <= b.x || b.x + nodeSize.width <= a.x || a.y + nodeSize.height <= b.y || b.y + nodeSize.height <= a.y, 'Overlapping nodes');
  }
}
for (const width of [600, 800, 1000, 1440]) {
  const layout = await layoutDiagram(chain, width, 500);
  checkRoutes(chain, layout);
  const rows = new Map();
  for (const p of Object.values(layout.positions)) rows.set(p.y, (rows.get(p.y) || 0) + 1);
  assert.ok(layout.wrapped && rows.size > 1 && Math.max(...rows.values()) >= 2, `No wrapped rows at ${width}`);
  assert.ok(Math.max(...rows.values()) <= 4, `Panoramic row at ${width}`);
  assert.ok(Object.values(layout.edges).some(route => route.sections.some(s => s.points.length >= 6)), 'Row transition must retain native wrap bends');
  console.log(`PASS: ${width}px -> ${Math.max(...rows.values())} columns, ${rows.size} rows, ${layout.width}x${layout.height}`);
}
for (const width of [320, 390]) {
  const layout = await layoutDiagram(chain, width, 330);
  checkRoutes(chain, layout);
  assert.equal(layout.direction, 'TB');
  assert.equal(layout.wrapped, false);
  assert.equal(new Set(Object.values(layout.positions).map(p => p.x)).size, 1);
  console.log(`PASS: ${width}px preserves natural-size single-column cards`);
}
const branching = { ...chain, id: 'branching', nodes: chain.nodes.slice(0, 8), edges: [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4], [4, 5], [5, 6], [5, 7], [7, 1], [6, 6]].map(([a, b], i) => ({ id: `B${i}`, source: `N${a}`, target: `N${b}`, label: `Synthetic route ${i + 1}` })) };
checkRoutes(branching, await layoutDiagram(branching, 900, 500));
const disconnected = { ...chain, id: 'disconnected', edges: chain.edges.filter((_, i) => i !== 5) };
checkRoutes(disconnected, await layoutDiagram(disconnected, 900, 500));
const authoredTBChain = await layoutDiagram({ ...chain, direction: 'TB' }, 1000, 500);
checkRoutes({ ...chain, direction: 'TB' }, authoredTBChain);
assert.equal(authoredTBChain.direction, 'TB');
assert.equal(authoredTBChain.wrapped, false, 'Authored vertical chains stay vertical on wide screens');
assert.equal(new Set(Object.values(authoredTBChain.positions).map(point => point.x)).size, 1);
assert.ok(authoredTBChain.height > 1500, 'Vertical answers grow to contain every step');
const hierarchy = await layoutDiagram({ ...branching, direction: 'TB' }, 1000, 500);
checkRoutes({ ...branching, direction: 'TB' }, hierarchy);
assert.equal(hierarchy.direction, 'TB', 'Keep authored complex hierarchies vertical');
const longLabels = { ...chain, edges: chain.edges.map(edge => ({ ...edge, label: 'Synthetic explanatory caption '.repeat(12) })) };
const captionLayout = await layoutDiagram(longLabels, 1000, 500);
checkRoutes(longLabels, captionLayout);
assert.ok(Object.values(captionLayout.edges).every(edge => !edge.label || edge.label.height <= 66), 'Long captions reserve at most three lines');
console.log('PASS: branches, merges, cycles, self-loops, disconnected components and explicit TB preserve every route');

const star={id:'Strategy',kind:'flow',title:'Synthetic strategy',direction:'TB',nodes:['Goal','PillarA','PillarB','PillarC','PillarD'].map(id=>({id,label:id,shape:'rounded'})),edges:['PillarA','PillarB','PillarC','PillarD'].map((target,i)=>({id:`Spoke${i}`,source:'Goal',target,label:'Supports'}))};
function alternativeIntegrity(spec,layout) {
 assert.equal(Object.keys(layout.positions).length,spec.nodes.length);
 for(const edge of spec.edges) {
  const points=layout.edges[edge.id]?.sections.flatMap(s=>s.points);
  assert.ok(points?.length>=2,`Missing ${edge.id}`);
  assert.ok(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
  for(const [point,id] of [[points[0],edge.source],[points.at(-1),edge.target]]) {
   const n=layout.positions[id];
   assert.ok(point.x>=n.x-1&&point.x<=n.x+184+1&&point.y>=n.y-1&&point.y<=n.y+76+1,`Detached alternative route ${edge.id}/${id}`);
  }
 }
}
for(const algorithm of ['tree','radial','force']) {
 const spec={...star,layout:algorithm};
 const layout=await layoutDiagram(spec,1000,600);
 assert.equal(layout.algorithm,algorithm,`ELK ${algorithm} must run for a valid graph`);
 alternativeIntegrity(spec,layout);
 if(algorithm==='tree')assert.ok(star.nodes.slice(1).every(n=>layout.positions[n.id].y>layout.positions.Goal.y));
 if(algorithm==='radial') {
  const root=layout.positions.Goal;
  assert.ok(star.nodes.some(n=>layout.positions[n.id].x<root.x)&&star.nodes.some(n=>layout.positions[n.id].x>root.x));
  assert.ok(star.nodes.some(n=>layout.positions[n.id].y<root.y)&&star.nodes.some(n=>layout.positions[n.id].y>root.y));
 }
}
const business={id:'Owners',kind:'flow',title:'Synthetic approval',layout:'swimlane',direction:'LR',lanes:[{id:'Requester',label:'Synthetic requester'},{id:'Reviewer',label:'Synthetic reviewer'}],nodes:[{id:'Prepare',label:'Prepare',shape:'rounded',lane:'Requester'},{id:'Approve',label:'Approve?',shape:'diamond',lane:'Reviewer'},{id:'Proceed',label:'Proceed',shape:'ellipse',lane:'Requester'}],edges:[{id:'Submit',source:'Prepare',target:'Approve',label:'Review'},{id:'Yes',source:'Approve',target:'Proceed',label:'Yes'},{id:'Rework',source:'Approve',target:'Prepare',label:'Revise'}]};
for(const width of [390,1000]) {
 const layout=await layoutDiagram(business,width,600);
 assert.equal(layout.algorithm,'swimlane');
 assert.equal(layout.groups.length,2);
 alternativeIntegrity(business,layout);
 for(const node of business.nodes) {
  const p=layout.positions[node.id],g=layout.groups.find(g=>g.id===node.lane);
  assert.ok(p.x>=g.x&&p.y>=g.y+44&&p.x+184<=g.x+g.width&&p.y+76<=g.y+g.height,`${node.id} must be in its owner's group`);
 }
}
const cycle={...star,layout:'tree',edges:[...star.edges,{id:'Back',source:'PillarA',target:'Goal'}]};
const fallback=await layoutDiagram(cycle,1000,600);
assert.equal(fallback.algorithm,'layered');
alternativeIntegrity(cycle,fallback);
console.log('PASS: actual ELK tree/radial/force algorithms, grouped owner handoffs, cross-lane cycles, mobile groups and complete-graph fallback');

// In-chat compact mode folds authored vertical paths without changing their topology.
for (const count of [2, 3, 6, 7, 12]) {
 const spec = { ...chain, direction: 'TB', nodes: chain.nodes.slice(0, count), edges: chain.edges.slice(0, count - 1) };
 for (const width of [600, 800, 1000, 1440]) {
  const layout = await layoutDiagram(spec, width, 500, { pairedRows: true });
  checkRoutes(spec, layout);
  const rows = new Map();
  for (const position of Object.values(layout.positions)) rows.set(position.y, (rows.get(position.y) || 0) + 1);
  assert.equal(rows.size, Math.ceil(count / 2));
  assert.equal(Math.max(...rows.values()), 2);
  assert.equal([...rows.values()].filter(n => n === 1).length, count % 2);
  assert.ok(layout.height < count * 150, 'Compact rows reduce tall inline paths');
 }
}
const six = { ...chain, direction: 'TB', nodes: chain.nodes.slice(0, 6).reverse(), edges: chain.edges.slice(0, 5).reverse() };
const paired = await layoutDiagram(six, 1000, 500, { pairedRows: true });
assert.equal(paired.positions.N0.y, paired.positions.N1.y);
assert.ok(paired.positions.N1.x > paired.positions.N0.x);
assert.equal(paired.positions.N2.x, paired.positions.N1.x);
assert.ok(paired.positions.N2.y > paired.positions.N1.y);
assert.ok(paired.positions.N3.x < paired.positions.N2.x);
for (const width of [320, 390, 540]) {
 const layout = await layoutDiagram(six, width, 500, { pairedRows: true });
 checkRoutes(six, layout);
 assert.equal(new Set(Object.values(layout.positions).map(p => p.x)).size, 1);
}
const compactLongLabels = await layoutDiagram(longLabels, 800, 500, { pairedRows: true });
checkRoutes(longLabels, compactLongLabels);
for (const spec of [branching, disconnected, { ...star, layout: 'radial' }, business]) {
 const original = await layoutDiagram(spec, 1000, 500);
 const compact = await layoutDiagram(spec, 1000, 500, { pairedRows: true });
 assert.deepEqual(compact, original, 'Branches, cycles, disconnected and specialized layouts are unchanged');
}
console.log('PASS: paired inline rows, graph-order traversal, odd final rows, caption bounds, readable mobile and unchanged specialized layouts');
// New layouts exercise the actual installed engine, never mock coordinates.
const packedItems = { ...star, layout: 'rectpacking', edges: [] };
const inventory = await layoutDiagram(packedItems, 1000, 600);
assert.equal(inventory.algorithm, 'rectpacking'); alternativeIntegrity(packedItems, inventory);
const denseRelations = { ...star, layout: 'stress', edges: [...star.edges,
 {id:'CrossA',source:'PillarA',target:'PillarB'}, {id:'CrossB',source:'PillarB',target:'PillarC'}, {id:'CrossC',source:'PillarC',target:'PillarA'}, {id:'CrossD',source:'PillarD',target:'PillarA'}] };
const stressLayout = await layoutDiagram(denseRelations, 1000, 600);
assert.equal(stressLayout.algorithm, 'stress'); alternativeIntegrity(denseRelations, stressLayout);
const componentSpec = { ...disconnected, layout: 'disco' };
const componentsLayout = await layoutDiagram(componentSpec, 1000, 600);
assert.equal(componentsLayout.algorithm, 'disco'); alternativeIntegrity(componentSpec, componentsLayout);
assert.equal(componentsLayout.implementation, 'ELK layered components + rectangle packing');
const fixedSpec = {id:'Fixed',kind:'flow',title:'Supplied positions',direction:'LR',layout:'fixed',nodes:[
 {id:'A',label:'A',shape:'rectangle',position:{x:30,y:30}},
 {id:'B',label:'B',shape:'rectangle',position:{x:400,y:220}},
],edges:[{id:'AB',source:'A',target:'B',label:'Existing connection'}]};
const fixedLayout = await layoutDiagram(fixedSpec, 1000, 600);
assert.equal(fixedLayout.algorithm, 'fixed'); alternativeIntegrity(fixedSpec, fixedLayout);
for (const node of fixedSpec.nodes) assert.deepEqual(fixedLayout.positions[node.id], node.position);
for (const route of Object.values(fixedLayout.edges)) for (const point of route.sections.flatMap(s=>s.points)) assert.ok(point.x <= fixedLayout.width && point.y <= fixedLayout.height, 'Fixed route must fit export bounds');
const invalidPacking = await layoutDiagram({...branching,layout:'rectpacking'},1000,600);
assert.equal(invalidPacking.algorithm,'layered'); assert.match(invalidPacking.reason,/without edges/);
const invalidFixed = await layoutDiagram({...fixedSpec,nodes:fixedSpec.nodes.map(n=>({...n,position:{x:30,y:30}}))},1000,600);
assert.equal(invalidFixed.algorithm,'layered'); assert.match(invalidFixed.reason,/could not preserve/);
for (const [purpose,graph,expected] of [['hierarchy',star,'tree'],['concept',star,'radial'],['inventory',packedItems,'rectpacking'],['relationships',denseRelations,'stress'],['components',componentSpec,'disco'],['spatial',fixedSpec,'fixed']]) {
 const autoSpec={...graph,layout:'auto',purpose}; const actual=await layoutDiagram(autoSpec,1000,600);
 assert.equal(actual.algorithm,expected,`auto ${purpose}`); alternativeIntegrity(autoSpec,actual);
}
console.log('PASS: actual stress/packing/fixed/component layouts, contextual auto, coordinate preservation and explained graph-safe fallbacks');

}
