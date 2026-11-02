import type { DiagramLayoutKind, DiagramSpec } from './structuredDiagram'

export type DiagramLayoutSelection = { layout: Exclude<DiagramLayoutKind, 'auto'>; reason: string }

/** Choose only from diagram semantics and supplied topology; never fabricate edges or coordinates. */
export function selectDiagramLayout(spec: DiagramSpec): DiagramLayoutSelection {
  const choose = (layout: DiagramLayoutSelection['layout'], reason: string): DiagramLayoutSelection => ({ layout, reason })
  const ids = new Set(spec.nodes.map(node => node.id))
  const edges = spec.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  const parents = new Map(spec.nodes.map(node => [node.id, 0]))
  const neighbours = new Map(spec.nodes.map(node => [node.id, new Set<string>()]))
  for (const edge of edges) {
    parents.set(edge.target, (parents.get(edge.target) ?? 0) + 1)
    neighbours.get(edge.source)?.add(edge.target)
    neighbours.get(edge.target)?.add(edge.source)
  }
  const visited = new Set<string>()
  let components = 0
  for (const id of ids) {
    if (visited.has(id)) continue
    components++
    const stack = [id]
    while (stack.length) {
      const next = stack.pop()!
      if (visited.has(next)) continue
      visited.add(next)
      for (const neighbour of neighbours.get(next) ?? []) if (!visited.has(neighbour)) stack.push(neighbour)
    }
  }
  const roots = [...parents].filter(([, count]) => count === 0).map(([id]) => id)
  const tree = ids.size > 0 && components === 1 && edges.length === ids.size - 1 && roots.length === 1 && [...parents.values()].every(count => count <= 1)
  const positioned = spec.nodes.length > 0 && spec.nodes.every(node => node.position && [node.position.x, node.position.y].every(value => Number.isFinite(value) && value >= 0 && value <= 100000))
  const lanes = !!spec.lanes?.length && spec.nodes.length > 0 && spec.nodes.every(node => spec.lanes!.some(lane => lane.id === node.lane))
  if (spec.kind === 'sequence') return choose('layered', 'Participant messages retain sequence order.')
  if (spec.layout && spec.layout !== 'auto') {
    if (spec.layout === 'rectpacking' && edges.length) return choose('layered', 'Rectangle packing requires independent items without edges.')
    if (spec.layout === 'fixed' && !positioned) return choose('layered', 'Fixed layout requires explicit coordinates for every node.')
    if (spec.layout === 'swimlane' && !lanes) return choose('layered', 'Owner lanes require a defined owner for every node.')
    if ((spec.layout === 'tree' || spec.layout === 'radial') && !tree) return choose('layered', 'Hierarchy layouts require a connected rooted tree without joins or cycles.')
    return choose(spec.layout, 'Explicit layout selection.')
  }
  if (!spec.layout && !spec.purpose) return choose('layered', 'Preserve the default layout for existing diagrams.')
  const context = spec.title.toLowerCase()
  const purpose = spec.purpose ?? (/\b(organi[sz]ation|hierarchy|taxonomy)\b/.test(context) ? 'hierarchy' : /\b(concept|pillars|mind map)\b/.test(context) ? 'concept' : /\b(inventory|catalog|catalogue)\b/.test(context) ? 'inventory' : /\b(relationships?|ecosystem|stakeholders?)\b/.test(context) ? 'relationships' : /\b(components|clusters|disconnected)\b/.test(context) ? 'components' : 'process')
  if (purpose === 'spatial' && positioned) return choose('fixed', 'Preserve explicitly supplied spatial coordinates.')
  if (lanes) return choose('swimlane', 'Defined owners and assignments support responsibility handoffs.')
  if (!edges.length && ids.size > 1 && purpose === 'inventory') return choose('rectpacking', 'Independent inventory items need compact packing without invented connections.')
  if (components > 1 && ids.size > 1) return choose('disco', 'Arrange disconnected groups while retaining their independence.')
  if (purpose === 'process' || purpose === 'spatial') return choose('layered', 'Ordered steps and dependencies use directional layers.')
  if (tree && purpose === 'hierarchy') return choose('tree', 'A rooted parent-child hierarchy fits a tree.')
  if (tree && purpose === 'concept') return choose('radial', 'A central concept and its branches fit a radial tree.')
  if (purpose === 'relationships' || purpose === 'concept' || purpose === 'components') {
    if (!tree && edges.length >= ids.size * 1.5) return choose('stress', 'Dense interconnected relationships benefit from stress minimization.')
    return choose('force', 'Cross-linked relationships have no required process order.')
  }
  return choose('layered', 'Directional layers preserve the supplied dependencies.')
}
