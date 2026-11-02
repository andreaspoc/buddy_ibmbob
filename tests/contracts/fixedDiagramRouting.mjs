import assert from 'node:assert/strict';

export function runFixedRoutingChecks(runtime) {
const { routeFixedDiagram } = runtime;
const size = { width: 184, height: 76 };
const node = (id, x, y) => ({ id, label: id, shape: 'rectangle', position: { x, y } });
function check(nodes, edges) {
  const result = routeFixedDiagram({ nodes, edges }, size);
  assert.ok(result);
  assert.equal(Object.keys(result.edges).length, edges.length);
  for (const n of nodes) assert.deepEqual(result.positions[n.id], n.position);
  for (const e of edges) {
    const points = result.edges[e.id].sections[0].points;
    assert.ok(points.length >= 2);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      assert.ok(a.x === b.x || a.y === b.y);
      assert.ok(a.x >= 0 && a.y >= 0 && b.x >= 0 && b.y >= 0);
      for (const n of nodes) {
        const r = n.position;
        const crosses = a.x === b.x
          ? a.x > r.x && a.x < r.x + size.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + size.height
          : a.y > r.y && a.y < r.y + size.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + size.width;
        assert.equal(crosses, false, `Route crosses ${n.id}`);
      }
    }
  }
  return result;
}
const edge = { id: 'e', source: 'a', target: 'b' };
check([node('a', 0, 0), node('b', 400, 0)], [edge]);
check([node('a', 0, 0)], [{ id: 'loop', source: 'a', target: 'a' }]);
check([node('a', 0, 100), node('obstacle', 230, 100), node('b', 460, 100)], [edge, { ...edge, id: 'parallel' }]);
assert.equal(routeFixedDiagram({ nodes: [node('a', 0, 0), node('b', 50, 0)], edges: [] }, size), null);
assert.equal(routeFixedDiagram({ nodes: [{ id: 'a' }], edges: [] }, size), null);
assert.equal(routeFixedDiagram({ nodes: [node('a', -1, 0)], edges: [] }, size), null);
console.log('Fixed coordinate routing tests passed');

}
