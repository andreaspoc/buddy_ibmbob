/** Data-only diagrams. Each complete JSON line can be painted during streaming. */
export type DiagramShape = 'rectangle' | 'rounded' | 'diamond' | 'database' | 'ellipse'
export type DiagramTone = 'violet' | 'blue' | 'teal' | 'amber' | 'rose' | 'slate'
export type DiagramLayoutKind = 'layered' | 'swimlane' | 'tree' | 'radial' | 'force' | 'auto' | 'stress' | 'rectpacking' | 'disco' | 'fixed'
export type DiagramPurpose = 'process' | 'hierarchy' | 'concept' | 'relationships' | 'inventory' | 'components' | 'spatial'
export interface DiagramLane { id: string; label: string; tone?: DiagramTone }
export interface DiagramNode { id: string; label: string; shape: DiagramShape; tone?: DiagramTone; lane?: string; position?: { x: number; y: number } }
export interface DiagramEdge { id: string; source: string; target: string; label?: string; tone?: DiagramTone; animated?: boolean }
export interface DiagramSpec { id: string; kind: 'flow' | 'sequence'; title: string; direction: 'LR' | 'TB'; layout?: DiagramLayoutKind; purpose?: DiagramPurpose; motion?: 'flow' | 'none'; lanes?: DiagramLane[]; nodes: DiagramNode[]; edges: DiagramEdge[] }
export type DiagramPart = { type: 'markdown'; key: string; text: string } | { type: 'diagram'; key: string; source: string; complete: boolean; spec?: DiagramSpec; error?: string }
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
const label = (v: unknown): v is string => typeof v === 'string' && v.length <= 500
const shapes = new Set(['rectangle', 'rounded', 'diamond', 'database', 'ellipse'])
const tones = new Set(['violet', 'blue', 'teal', 'amber', 'rose', 'slate'])
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseDiagramSource(source: string, complete = false): { spec?: DiagramSpec; error?: string } {
  let spec: DiagramSpec | undefined
  const errors: string[] = []
  const pending: DiagramEdge[] = []
  const fail = (message: string) => { if (!errors.includes(message)) errors.push(message) }
  const header = (v: Record<string, unknown>) => {
    if (!validId(v.id) || !['flow', 'sequence'].includes(String(v.kind)) || !label(v.title ?? '') || !['LR', 'TB'].includes(String(v.direction ?? 'LR'))) { fail('Invalid diagram header.'); return }
    if (v.layout !== undefined && (typeof v.layout !== 'string' || !['layered', 'swimlane', 'tree', 'radial', 'force', 'auto', 'stress', 'rectpacking', 'disco', 'fixed'].includes(v.layout))) { fail('Invalid diagram layout.'); return }
    if (v.purpose !== undefined && (typeof v.purpose !== 'string' || !['process', 'hierarchy', 'concept', 'relationships', 'inventory', 'components', 'spatial'].includes(v.purpose))) { fail('Invalid diagram purpose.'); return }
    if (v.motion !== undefined && (typeof v.motion !== 'string' || !['flow', 'none'].includes(v.motion))) { fail('Invalid diagram motion.'); return }
    spec = { id: v.id, kind: v.kind as DiagramSpec['kind'], title: (v.title ?? '') as string, direction: (v.direction ?? 'LR') as DiagramSpec['direction'], nodes: [], edges: [],
      ...(v.layout !== undefined ? { layout: v.layout as DiagramLayoutKind } : {}), ...(v.purpose !== undefined ? { purpose: v.purpose as DiagramPurpose } : {}), ...(v.motion !== undefined ? { motion: v.motion as DiagramSpec['motion'] } : {}),
      ...(v.layout === 'swimlane' || Array.isArray(v.lanes) ? { lanes: [] } : {}) }
    pending.length = 0
  }
  const lane = (v: Record<string, unknown>) => {
    if (!spec) { fail('Diagram header must precede lanes.'); return }
    if (!validId(v.id) || !label(v.label) || (v.tone !== undefined && (typeof v.tone !== 'string' || !tones.has(v.tone)))) { fail('Invalid lane: use an ID, plain text label and supported tone.'); return }
    spec.lanes ??= []
    const item: DiagramLane = { id: v.id, label: v.label, ...(v.tone !== undefined ? { tone: v.tone as DiagramTone } : {}) }
    const index = spec.lanes.findIndex(l => l.id === item.id)
    if (index >= 0) spec.lanes[index] = item
    else if (spec.lanes.length < 12) spec.lanes.push(item)
    else fail('Diagram limit is 12 lanes.')
  }
  const node = (v: Record<string, unknown>) => {
    if (!spec) { fail('Diagram header must precede nodes.'); return }
    if (!validId(v.id) || !label(v.label) || !shapes.has(String(v.shape ?? 'rectangle'))) { fail('Invalid node: use an ID, plain text label and supported shape.'); return }
    if (v.tone !== undefined && (typeof v.tone !== 'string' || !tones.has(v.tone))) { fail('Invalid node tone.'); return }
    if (v.lane !== undefined && !validId(v.lane)) { fail('Invalid node lane.'); return }
    if (v.position !== undefined && (!object(v.position) || !['x', 'y'].every(key => { const value = (v.position as Record<string, unknown>)[key]; return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000 }))) { fail('Invalid node position: use finite x/y coordinates between 0 and 100000.'); return }
    const item: DiagramNode = { id: v.id, label: v.label, shape: (v.shape ?? 'rectangle') as DiagramShape, ...(v.tone !== undefined ? { tone: v.tone as DiagramTone } : {}), ...(v.lane !== undefined ? { lane: v.lane } : {}), ...(v.position !== undefined ? { position: v.position as DiagramNode['position'] } : {}) }
    const index = spec.nodes.findIndex(n => n.id === item.id)
    if (index >= 0) spec.nodes[index] = item
    else if (spec.nodes.length < 100) spec.nodes.push(item)
    else fail('Diagram limit is 100 nodes.')
  }
  const edge = (v: Record<string, unknown>) => {
    if (!spec) { fail('Diagram header must precede edges.'); return }
    if (!validId(v.id) || !validId(v.source) || !validId(v.target) || (v.label !== undefined && !label(v.label))) { fail('Invalid edge: use valid endpoint IDs and a plain text label.'); return }
    if (v.tone !== undefined && (typeof v.tone !== 'string' || !tones.has(v.tone))) { fail('Invalid edge tone.'); return }
    if (v.animated !== undefined && typeof v.animated !== 'boolean') { fail('Edge animated must be a boolean.'); return }
    const item: DiagramEdge = { id: v.id, source: v.source, target: v.target, ...(v.label !== undefined ? { label: v.label as string } : {}), ...(v.tone !== undefined ? { tone: v.tone as DiagramTone } : {}), ...(v.animated !== undefined ? { animated: v.animated } : {}) }
    const index = pending.findIndex(e => e.id === item.id)
    if (index >= 0) pending[index] = item
    else if (pending.length < 200) pending.push(item)
    else fail('Diagram limit is 200 edges.')
  }
  const record = (v: unknown) => {
    if (!object(v)) { fail('Diagram records must be JSON objects.'); return }
    if (Array.isArray(v.nodes) && Array.isArray(v.edges)) {
      header(v); if (Array.isArray(v.lanes)) for (const l of v.lanes) object(l) ? lane(l) : fail('Invalid lane.'); for (const n of v.nodes) object(n) ? node(n) : fail('Invalid node.'); for (const e of v.edges) object(e) ? edge(e) : fail('Invalid edge.'); return
    }
    if (v.type === 'diagram') header(v)
    else if (v.type === 'lane') lane(v)
    else if (v.type === 'node') node(v)
    else if (v.type === 'edge') edge(v)
    else fail('Unknown diagram record type.')
  }
  // A whole JSON object supports editing/import, including pretty-printed JSON.
  try { const whole: unknown = JSON.parse(source); if (object(whole)) record(whole); else fail('Diagram must be a JSON object.') }
  catch {
    const lines = source.split('\n')
    if (!complete && !source.endsWith('\n')) {
      // A closing brace is sufficient to expose a complete record immediately.
      try { JSON.parse(lines[lines.length - 1]) } catch { lines.pop() }
    }
    for (const line of lines) {
      if (!line.trim()) continue
      try { record(JSON.parse(line)) } catch { fail('Invalid JSON record. Earlier valid diagram content is preserved.') }
    }
  }
  if (spec) {
    if (complete && spec.layout === 'swimlane' && (!spec.lanes?.length || spec.nodes.some(n => !spec!.lanes?.some(l => l.id === n.lane)))) fail('Assign each business process step to a defined lane.')
    const ids = new Set(spec.nodes.map(n => n.id))
    spec.edges = pending.filter(e => ids.has(e.source) && ids.has(e.target))
    if (complete && spec.edges.length !== pending.length) fail('Some connections reference missing nodes.')
  } else if (complete && !errors.length) fail('Diagram header is missing.')
  return { ...(spec ? { spec } : {}), ...(errors.length ? { error: errors.join(' ') } : {}) }
}

export function splitDiagramMarkdown(content: string, streaming = false): DiagramPart[] {
  const parts: DiagramPart[] = []
  const lines = content.split(/(?<=\n)/)
  let markdown = '', source: string | undefined, fenceChar = '', fenceSize = 0, ordinaryFence = ''
  let ordinarySize = 0
  const pushMarkdown = () => { if (markdown) { parts.push({ type: 'markdown', key: `markdown-${parts.length}`, text: markdown }); markdown = '' } }
  const pushDiagram = (complete: boolean) => { const text = source ?? ''; parts.push({ type: 'diagram', key: `diagram-${parts.length}`, source: text, complete, ...parseDiagramSource(text, complete) }); source = undefined }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (streaming && source === undefined && !ordinaryFence && i === lines.length - 1 && !line.endsWith('\n')) {
      const tail = line.replace(/^ {0,3}/, '');
      if (tail && ('```bobdiagram'.startsWith(tail) || '~~~bobdiagram'.startsWith(tail))) continue;
    }
    const opening = /^ {0,3}(?=(`{3,}|~{3,}))\1([^\n]*)\n?$/.exec(line)
    if (source !== undefined) {
      if (new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${fenceSize},}\\s*$`).test(line)) pushDiagram(true)
      else source += line
      continue
    }
    if (ordinaryFence) {
      markdown += line
      if (new RegExp(`^ {0,3}${ordinaryFence}{${ordinarySize},}\\s*$`).test(line)) ordinaryFence = ''
      continue
    }
    if (opening) {
      const info = opening[2].trim()
      if (info === 'bobdiagram') { pushMarkdown(); source = ''; fenceChar = opening[1][0]; fenceSize = opening[1].length; continue }
      // Hide only a final standalone partial protocol opener while it arrives.
      if (streaming && i === lines.length - 1 && !line.endsWith('\n') && info && 'bobdiagram'.startsWith(info)) continue
      ordinaryFence = opening[1][0]; ordinarySize = opening[1].length
    }
    markdown += line
  }
  if (source !== undefined) pushDiagram(!streaming)
  pushMarkdown()
  return parts
}
