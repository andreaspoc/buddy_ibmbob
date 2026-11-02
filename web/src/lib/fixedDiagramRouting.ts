import type { DiagramSpec } from './structuredDiagram'

type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }
export interface FixedDiagramRouting {
  positions: Record<string, Point>
  edges: Record<string, { sections: Array<{ points: Point[] }> }>
  width: number
  height: number
}

/** Preserve explicit coordinates; return null rather than draw a route through a node. */
export function routeFixedDiagram(spec: DiagramSpec, nodeSize: { width: number; height: number }): FixedDiagramRouting | null {
  if (![nodeSize.width, nodeSize.height].every(v => Number.isFinite(v) && v > 0)) return null
  const positions: Record<string, Point> = Object.create(null)
  const boxes: Record<string, Rect> = Object.create(null)
  for (const node of spec.nodes) {
    const p = node.position
    if (!p || ![p.x, p.y].every(v => Number.isFinite(v) && v >= 0) || boxes[node.id]) return null
    positions[node.id] = { ...p }
    boxes[node.id] = { ...p, ...nodeSize }
  }
  const obstacles = Object.values(boxes)
  for (let i = 0; i < obstacles.length; i++) for (let j = i + 1; j < obstacles.length; j++) {
    const a = obstacles[i], b = obstacles[j]
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return null
  }
  const maxX = Math.max(0, ...obstacles.map(r => r.x + r.width))
  const maxY = Math.max(0, ...obstacles.map(r => r.y + r.height))
  let routingWork = 0;
  const clear = (points: Point[]) => points.every(p => p.x >= 0 && p.y >= 0 && Number.isFinite(p.x) && Number.isFinite(p.y)) && points.slice(1).every((b, i) => {
    const a = points[i]
    if (a.x !== b.x && a.y !== b.y) return false
    return obstacles.every(r => (++routingWork <= 1000000) && (a.x === b.x
      ? !(a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height)
      : !(a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width)))
  })
  const ports = (r: Rect, fraction: number) => [
    [{ x: r.x + r.width, y: r.y + r.height * fraction }, { x: r.x + r.width + 20, y: r.y + r.height * fraction }],
    [{ x: r.x + r.width * fraction, y: r.y + r.height }, { x: r.x + r.width * fraction, y: r.y + r.height + 20 }],
    [{ x: r.x, y: r.y + r.height * fraction }, { x: r.x - 20, y: r.y + r.height * fraction }],
    [{ x: r.x + r.width * fraction, y: r.y }, { x: r.x + r.width * fraction, y: r.y - 20 }],
  ]
  const edges: FixedDiagramRouting['edges'] = Object.create(null)
  let width = maxX, height = maxY
  for (const [index, edge] of spec.edges.entries()) {
    const source = boxes[edge.source], target = boxes[edge.target]
    if (!source || !target || edges[edge.id]) return null
    const fraction = 0.25 + ((index * 0.1732050807) % 0.5)
    const xs = [maxX + 20 + index * 8, 0, ...obstacles.flatMap(r => [r.x - 20, r.x + r.width + 20])].filter(v => v >= 0)
    const ys = [maxY + 20 + index * 8, 0, ...obstacles.flatMap(r => [r.y - 20, r.y + r.height + 20])].filter(v => v >= 0)
    let best: Point[] | undefined
    let bestLength = Infinity
    for (const [sp, a] of ports(source, fraction)) for (const [tp, b] of ports(target, 1 - fraction)) {
      const candidates = [
        [a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b],
        ...xs.map(x => [a, { x, y: a.y }, { x, y: b.y }, b]),
        ...ys.map(y => [a, { x: a.x, y }, { x: b.x, y }, b]),
      ]
      for (const middle of candidates) {
        const path = [sp, ...middle, tp].filter((p, i, all) => !i || p.x !== all[i - 1].x || p.y !== all[i - 1].y)
        const length = path.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - path[i].x) + Math.abs(p.y - path[i].y), 0)
        if (routingWork > 1000000) return null
        if (length < bestLength && clear(path)) { best = path; bestLength = length }
      }
    }
    if (!best) return null
    edges[edge.id] = { sections: [{ points: best }] }
    width = Math.max(width, ...best.map(p => p.x))
    height = Math.max(height, ...best.map(p => p.y))
  }
  return { positions, edges, width: width + 20, height: height + 20 }
}
