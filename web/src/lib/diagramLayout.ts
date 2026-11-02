import { selectDiagramLayout } from './diagramSelection';
import { routeFixedDiagram } from './fixedDiagramRouting';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';
import type { DiagramSpec, DiagramLane, DiagramLayoutKind } from './structuredDiagram';
export const nodeSize = { width: 184, height: 76 };
export interface DiagramPoint { x: number; y: number }
export interface DiagramEdgeLayout {
  sections: Array<{ points: DiagramPoint[] }>;
  label?: { x: number; y: number; width: number; height: number };
}
export interface DiagramLayout {
  algorithm?: DiagramLayoutKind;
  requestedAlgorithm?: DiagramLayoutKind;
  reason?: string;
  implementation?: string;
  groups?: Array<DiagramLane & DiagramPoint & { width: number; height: number }>;
  positions: Record<string, DiagramPoint>;
  edges: Record<string, DiagramEdgeLayout>;
  direction: 'LR' | 'TB';
  width: number;
  height: number;
  wrapped: boolean;
}
let engine: Promise<import('elkjs/lib/elk-api').ELK> | undefined;
const elk = {
  async layout(graph: ElkNode): Promise<ElkNode> {
    // Normal chat does not need the diagram-layout engine.
    engine ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK()).catch(error => {
      engine = undefined;
      throw error;
    });
    return (await engine).layout(graph);
  },
};
function inputGraph(spec: DiagramSpec, direction: 'LR' | 'TB', aspectRatio?: number, compactLabels = false): ElkNode {
  return {
    id: '@root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL', 'elk.spacing.nodeNode': '52', 'elk.spacing.edgeNode': '20',
      'elk.layered.spacing.nodeNodeBetweenLayers': direction === 'LR' ? '44' : '68',
      ...(aspectRatio === undefined ? {} : {
        // MULTI_EDGE retains branches and feedback edges across row boundaries.
        // Keep its native routes: reconnecting nodes with ordinary smoothstep edges
        // would draw row transitions straight through the intervening cards.
        'elk.layered.wrapping.strategy': 'MULTI_EDGE',
        'elk.layered.wrapping.additionalEdgeSpacing': spec.edges.some(e => (e.label?.length || 0) > 18) ? '30' : '10',
        'elk.aspectRatio': String(aspectRatio),
      }),
    },
    children: spec.nodes.map(n => ({ id: n.id, ...nodeSize })),
    edges: spec.edges.map(e => ({
      id: e.id, sources: [e.source], targets: [e.target],
      labels: e.label && !compactLabels ? [{ text: e.label, width: Math.min(140, e.label.length * 7 + 16), height: Math.min(66, Math.ceil((e.label.length * 7 + 16) / 140) * 20 + 6) }] : [],
    })),
  };
}
function extent(graph: ElkNode) {
  const children = graph.children || [];
  const rows = new Map<number, number>();
  for (const n of children) { const row = Math.round(n.y || 0); rows.set(row, (rows.get(row) || 0) + 1); }
  return {
    columns: Math.max(0, ...rows.values()), rows: rows.size,
    nodeWidth: Math.max(0, ...children.map(n => (n.x || 0) + (n.width || nodeSize.width))) + 12,
  };
}
function result(graph: ElkNode, direction: 'LR' | 'TB', wrapped: boolean, spec?: DiagramSpec, obstacles: Array<DiagramPoint & { width: number; height: number }> = []): DiagramLayout {
  const output: DiagramLayout = {
    algorithm: 'layered',
    positions: Object.fromEntries((graph.children || []).map(n => [n.id, { x: n.x || 0, y: n.y || 0 }])),
    edges: Object.fromEntries((graph.edges || []).map(e => {
      const label = e.labels?.[0];
      return [e.id, {
        sections: (e.sections || []).map(section => ({ points: [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(p => ({ x: p.x, y: p.y })) })),
        ...(label && label.x !== undefined && label.y !== undefined ? { label: { x: label.x, y: label.y, width: label.width || 0, height: label.height || 0 } } : {}),
      }];
    })),
    direction, width: graph.width || 0, height: graph.height || 0, wrapped,
  };
  // Label dummy layers can double the width of a wrapped flow. Place captions
  // against the native orthogonal routes instead, never on top of a card.
  const used: Array<{ x: number; y: number; width: number; height: number }> = [];
  const boxes = [...(graph.children || []).map(n => ({ x: n.x || 0, y: n.y || 0, width: nodeSize.width, height: nodeSize.height })), ...obstacles];
  const intersects = (a: typeof boxes[number], b: typeof boxes[number]) => a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;
  for (const edge of spec?.edges || []) {
    const route = output.edges[edge.id];
    if (!edge.label || !route || route.label) continue;
    const width = Math.min(140, edge.label.length * 7 + 16);
    const height = Math.min(66, Math.ceil((edge.label.length * 7 + 16) / 140) * 20 + 6);
    const source = output.positions[edge.source];
    const choices: typeof used = [];
    for (const section of route.sections) for (let i = 1; i < section.points.length; i++) {
      const a = section.points[i - 1], b = section.points[i];
      for (const fraction of [0.5, 0.25, 0.75]) {
        const x = a.x + (b.x - a.x) * fraction, y = a.y + (b.y - a.y) * fraction;
        if (a.y === b.y) {
          choices.push({ x: x - width / 2, y: y - height / 2, width, height });
          choices.push({ x: x - width / 2, y: source.y + nodeSize.height + 6, width, height });
        } else {
          choices.push({ x: x + 8, y: y - height / 2, width, height });
          choices.push({ x: x - width - 8, y: y - height / 2, width, height });
        }
      }
    }
    const label = choices.find(box => box.x >= 0 && box.y >= 0 && ![...boxes, ...used].some(other => intersects(box, other)))
      || { x: output.width + 8, y: source.y, width, height };
    route.label = label; used.push(label);
    output.width = Math.max(output.width, label.x + label.width + 12);
    output.height = Math.max(output.height, label.y + label.height + 12);
  }
  return output;
}
/** Fold a true directed path into two-column rows without changing its edges.
 * Branched, cyclic, disconnected and specialized layouts keep the graph engine.
 */
function pairedChain(spec: DiagramSpec, availableWidth: number): DiagramLayout | null {
  if (spec.kind !== 'flow' || (spec.layout && spec.layout !== 'layered') || spec.lanes?.length ||
      availableWidth < 600 || spec.nodes.length < 2 || spec.edges.length !== spec.nodes.length - 1) return null;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, typeof spec.edges[number]>();
  const ids = new Set(spec.nodes.map(node => node.id));
  for (const edge of spec.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target ||
        outgoing.has(edge.source) || incoming.has(edge.target)) return null;
    outgoing.set(edge.source, edge);
    incoming.set(edge.target, 1);
  }
  const roots = spec.nodes.filter(node => !incoming.has(node.id));
  if (roots.length !== 1) return null;
  const ordered: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = roots[0].id;
  while (current && !visited.has(current)) {
    ordered.push(current); visited.add(current);
    current = outgoing.get(current)?.target;
  }
  if (ordered.length !== spec.nodes.length || current) return null;
  const gap = Math.max(160, Math.min(500, availableWidth - 464));
  const rowStride = nodeSize.height + 110;
  const positions = new Map(ordered.map((id, index) => {
    const row = Math.floor(index / 2);
    const column = row % 2 ? 1 - index % 2 : index % 2;
    return [id, { x: 12 + column * (nodeSize.width + gap), y: 12 + row * rowStride }];
  }));
  const children = spec.nodes.map(node => ({ id: node.id, ...positions.get(node.id)!, ...nodeSize }));
  const edges = spec.edges.map(edge => {
    const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
    const horizontal = a.y === b.y;
    const right = b.x > a.x;
    const startPoint = horizontal ? { x: a.x + (right ? nodeSize.width : 0), y: a.y + nodeSize.height / 2 } : { x: a.x + nodeSize.width / 2, y: a.y + nodeSize.height };
    const endPoint = horizontal ? { x: b.x + (right ? 0 : nodeSize.width), y: startPoint.y } : { x: startPoint.x, y: b.y };
    const width = Math.min(140, (edge.label?.length || 0) * 7 + 16);
    const height = Math.min(66, Math.ceil(((edge.label?.length || 0) * 7 + 16) / 140) * 20 + 6);
    return { id: edge.id, sources: [edge.source], targets: [edge.target],
      sections: [{ id: `${edge.id}:route`, startPoint, endPoint }],
      labels: edge.label ? [{ text: edge.label, width, height,
        x: (startPoint.x + endPoint.x - width) / 2,
        y: horizontal ? startPoint.y - height / 2 : (startPoint.y + endPoint.y - height) / 2 }] : [],
    };
  });
  return result({ id: '@root', children, edges,
    width: 24 + nodeSize.width * 2 + gap,
    height: 24 + Math.floor((ordered.length - 1) / 2) * rowStride + nodeSize.height,
  }, 'LR', true, spec);
}
/** Resolve semantics first; every alternative keeps all original nodes and edges. */
export async function layoutDiagram(spec: DiagramSpec, availableWidth = 900, availableHeight = 500, options: { pairedRows?: boolean } = {}): Promise<DiagramLayout> {
  const selected = selectDiagramLayout(spec);
  const output = await layoutConcreteDiagram({ ...spec, layout: selected.layout }, availableWidth, availableHeight, options);
  return { ...output, requestedAlgorithm: spec.layout || 'layered',
    implementation: output.algorithm === 'disco' ? 'ELK layered components + rectangle packing' : 'ELK',
    reason: output.algorithm === selected.layout ? selected.reason : 'The selected layout could not preserve clear nodes and complete connections; Layered is used instead.' };
}

async function layoutConcreteDiagram(spec: DiagramSpec, availableWidth = 900, availableHeight = 500, options: { pairedRows?: boolean } = {}): Promise<DiagramLayout> {
  if (options.pairedRows) {
    const paired = pairedChain(spec, availableWidth);
    if (paired) return paired;
  }
  if (spec.layout && spec.layout !== 'layered') {
    try {
      const alternative = await alternativeLayout(spec, availableWidth, availableHeight);
      if (alternative && validLayout(spec, alternative)) return alternative;
    } catch { /* Preserve the complete graph with the proven layered fallback. */ }
  }
  // Two natural-size cards and their connections do not fit phone widths.
  const direction = availableWidth < 480 ? 'TB' : spec.direction;
  const natural = await elk.layout(inputGraph(spec, direction));
  if (direction !== 'LR' || spec.nodes.length < 3 || (natural.width || 0) <= availableWidth - 24) return result(natural, direction, false);
  const targetWidth = Math.max(440, Math.min(availableWidth - 24, 1150));
  const targetAspect = Math.max(0.5, Math.min(4, targetWidth / Math.max(330, availableHeight)));
  const ratios = [...new Set([targetAspect, 0.5, 0.75, 1, 1.5, 2, 3, 4])];
  const candidates = (await Promise.allSettled(ratios.map(ratio => elk.layout(inputGraph(spec, 'LR', ratio, true)))))
    .flatMap(candidate => candidate.status === 'fulfilled' ? [candidate.value] : [])
    // Some ELK wrapping configurations lose feedback edge routes. Never accept
    // that output; the ordinary layered graph preserves those connections.
    .filter(g => spec.edges.every(e => g.edges?.find(edge => edge.id === e.id)?.sections?.length));
  if (!candidates.length) return result(natural, direction, false);
  const enriched = candidates.map(g => ({ graph: g, layout: result(g, 'LR', true, spec) }));
  const rows = enriched.filter(({ graph }) => { const e = extent(graph); return e.columns >= 2 && e.columns <= 4 && e.rows > 1; });
  const usable = rows.filter(({ layout }) => layout.width <= targetWidth);
  if (!usable.length) {
    const single = enriched.filter(({ layout }) => layout.width <= targetWidth);
    if (!single.length) return result(natural, direction, false);
    single.sort((a, b) => a.layout.height - b.layout.height || a.layout.width - b.layout.width);
    return single[0].layout;
  }
  usable.sort((a, b) => a.layout.height - b.layout.height || a.layout.width - b.layout.width);
  return usable[0].layout;
}

function isTree(spec: DiagramSpec) {
  if (!spec.nodes.length || spec.edges.length !== spec.nodes.length - 1) return false;
  const incoming = new Set<string>();
  for (const edge of spec.edges) {
    if (edge.source === edge.target || incoming.has(edge.target)) return false;
    incoming.add(edge.target);
  }
  const roots = spec.nodes.filter(node => !incoming.has(node.id));
  if (roots.length !== 1) return false;
  const visited = new Set<string>();
  const pending = [roots[0].id];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) return false;
    visited.add(id);
    pending.push(...spec.edges.filter(edge => edge.source === id).map(edge => edge.target));
  }
  return visited.size === spec.nodes.length;
}

function validLayout(spec: DiagramSpec, layout: DiagramLayout) {
  const positions = spec.nodes.map(node => layout.positions[node.id]);
  if (positions.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    const a = positions[i], b = positions[j];
    if (a.x < b.x + nodeSize.width && a.x + nodeSize.width > b.x && a.y < b.y + nodeSize.height && a.y + nodeSize.height > b.y) return false;
  }
  return spec.edges.every(edge => {
    const sections = layout.edges[edge.id]?.sections;
    return sections?.length && sections.every(section => section.points.length >= 2 && section.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  });
}

async function alternativeLayout(spec: DiagramSpec, width: number, height: number): Promise<DiagramLayout | null> {
  const direction = width < 480 ? 'TB' : spec.direction;
  if (spec.layout === 'swimlane') return groupedLayout(spec, direction);
  if (spec.layout === 'disco') return componentLayout(spec, width, height);
  if (spec.layout === 'fixed') return fixedLayout(spec, direction);
  if (spec.layout === 'rectpacking' && spec.edges.length) return null;
  if ((spec.layout === 'tree' || spec.layout === 'radial') && !isTree(spec)) return null;
  const algorithm = spec.layout === 'tree' ? 'mrtree' : spec.layout;
  const graph = inputGraph(spec, direction, undefined, true);
  graph.layoutOptions = {
    'elk.algorithm': algorithm!, 'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN',
    'elk.spacing.nodeNode': '100', 'elk.randomSeed': '1',
    'elk.aspectRatio': String(Math.max(0.5, Math.min(3, width / Math.max(330, height)))),
    ...(algorithm === 'radial' ? { 'elk.radial.centerOnRoot': 'true', 'elk.radial.radius': '240' } : {}),
    ...(algorithm === 'stress' ? { 'elk.stress.desiredEdgeLength': '340', 'elk.stress.iterationLimit': '150' } : {}),
    ...(algorithm === 'force' ? { 'elk.force.iterations': '150', 'elk.spacing.nodeNode': '100' } : {}),
  };
  return { ...result(await elk.layout(graph), direction, false, spec), algorithm: spec.layout };
}

async function groupedLayout(spec: DiagramSpec, direction: 'LR' | 'TB'): Promise<DiagramLayout> {
  const lanes = (spec.lanes || []).filter(lane => spec.nodes.some(node => node.lane === lane.id));
  const unassigned = spec.nodes.filter(node => !lanes.some(lane => lane.id === node.lane));
  const definitions: DiagramLane[] = [...lanes, ...(unassigned.length ? [{ id: '@unassigned', label: 'Owner not specified', tone: 'slate' as const }] : [])];
  const graph = inputGraph(spec, direction, undefined, true);
  graph.layoutOptions = { ...graph.layoutOptions, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.spacing.nodeNode': '48' };
  graph.children = definitions.map(lane => ({
    id: `lane:${lane.id}`,
    layoutOptions: { 'elk.padding': '[top=52,left=24,bottom=24,right=24]' },
    children: (lane.id === '@unassigned' ? unassigned : spec.nodes.filter(node => node.lane === lane.id)).map(node => ({ id: node.id, ...nodeSize })),
  }));
  const laidOut = await elk.layout(graph);
  const offsets = new Map<string, DiagramPoint>([[laidOut.id, { x: 0, y: 0 }]]);
  const children: ElkNode[] = [];
  const allEdges: ElkExtendedEdge[] = [];
  const visit = (node: ElkNode, offset: DiagramPoint) => {
    allEdges.push(...(node.edges || []));
    for (const child of node.children || []) {
      const position = { x: offset.x + (child.x || 0), y: offset.y + (child.y || 0) };
      offsets.set(child.id, position);
      if (child.children) visit(child, position);
      else children.push({ ...child, ...position });
    }
  };
  visit(laidOut, { x: 0, y: 0 });
  const edges = allEdges.map(edge => {
    const offset = offsets.get(edge.container || laidOut.id) || { x: 0, y: 0 };
    const translate = (point: DiagramPoint) => ({ x: point.x + offset.x, y: point.y + offset.y });
    return { ...edge, sections: edge.sections?.map(section => ({ ...section, startPoint: translate(section.startPoint), endPoint: translate(section.endPoint), bendPoints: section.bendPoints?.map(translate) })) };
  });
  const groups = (laidOut.children || []).map(node => ({ ...definitions.find(lane => `lane:${lane.id}` === node.id)!, x: node.x || 0, y: node.y || 0, width: node.width || 0, height: node.height || 0 }));
  const layout = result({ ...laidOut, children, edges }, direction, false, spec, groups.map(group => ({ ...group, height: 44 })));
  return { ...layout, groups, algorithm: 'swimlane' };
}


async function fixedLayout(spec: DiagramSpec, direction: 'LR' | 'TB'): Promise<DiagramLayout | null> {
  const routed = routeFixedDiagram(spec, nodeSize);
  if (!routed) return null;
  const graph = inputGraph(spec, direction, undefined, true);
  graph.layoutOptions = { 'elk.algorithm': 'fixed' };
  graph.children = spec.nodes.map(node => ({ id: node.id, ...node.position!, ...nodeSize }));
  graph.edges = spec.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target],
    sections: routed.edges[edge.id].sections.map((section, index) => ({ id: `${edge.id}:${index}`,
      startPoint: section.points[0], endPoint: section.points.at(-1)!, bendPoints: section.points.slice(1, -1) })) }));
  const placed = await elk.layout(graph);
  return { ...result({ ...placed, width: Math.max(placed.width || 0, routed.width), height: Math.max(placed.height || 0, routed.height) }, direction, false, spec), algorithm: 'fixed' };
}

/** The JS bundle has no native DisCo provider. Compose its component-packing role
 * using supported ELK algorithms without dropping or inventing any connections.
 */
async function componentLayout(spec: DiagramSpec, width: number, height: number): Promise<DiagramLayout | null> {
  const direction = width < 480 ? 'TB' : spec.direction;
  const neighbours = new Map(spec.nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of spec.edges) { neighbours.get(edge.source)?.add(edge.target); neighbours.get(edge.target)?.add(edge.source); }
  const visited = new Set<string>();
  const components: DiagramSpec[] = [];
  for (const node of spec.nodes) {
    if (visited.has(node.id)) continue;
    const members = new Set<string>(), pending = [node.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id); members.add(id);
      for (const next of neighbours.get(id) || []) if (!visited.has(next)) pending.push(next);
    }
    components.push({ ...spec, layout: 'layered', nodes: spec.nodes.filter(n => members.has(n.id)), edges: spec.edges.filter(e => members.has(e.source) && members.has(e.target)) });
  }
  if (!components.length) return null;
  const parts = await Promise.all(components.map(part => elk.layout(inputGraph(part, direction, undefined, true))));
  const packed = await elk.layout({ id: '@components', layoutOptions: {
    'elk.algorithm': 'rectpacking', 'elk.spacing.nodeNode': '80',
    'elk.aspectRatio': String(Math.max(0.5, Math.min(3, width / Math.max(height, 330)))),
  }, children: parts.map((part, index) => ({ id: `@part${index}`, width: part.width || nodeSize.width + 24, height: part.height || nodeSize.height + 24 })) });
  const children: ElkNode[] = [], edges: ElkExtendedEdge[] = [];
  parts.forEach((part, index) => {
    const offset = packed.children?.find(node => node.id === `@part${index}`) || { x: 0, y: 0 };
    const translate = (point: DiagramPoint) => ({ x: point.x + (offset.x || 0), y: point.y + (offset.y || 0) });
    children.push(...(part.children || []).map(node => ({ ...node, ...translate({ x: node.x || 0, y: node.y || 0 }) })));
    edges.push(...(part.edges || []).map(edge => ({ ...edge, sections: edge.sections?.map(section => ({ ...section,
      startPoint: translate(section.startPoint), endPoint: translate(section.endPoint), bendPoints: section.bendPoints?.map(translate),
    })) })));
  });
  return { ...result({ ...packed, children, edges }, direction, false, spec), algorithm: 'disco' };
}
