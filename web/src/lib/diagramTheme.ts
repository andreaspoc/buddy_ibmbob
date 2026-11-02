import type { DiagramNode, DiagramTone } from './structuredDiagram';

// A fixed palette keeps streamed JSON data-only and exported SVGs consistent.
export const diagramPalette = {
  violet: { fill: '#f3edff', stroke: '#7952bd', text: '#43236d' },
  blue: { fill: '#eaf3ff', stroke: '#3974bc', text: '#204a7b' },
  teal: { fill: '#e7f7f3', stroke: '#228574', text: '#155e52' },
  amber: { fill: '#fff5dd', stroke: '#ac791d', text: '#775315' },
  rose: { fill: '#ffedf2', stroke: '#bc557a', text: '#812e50' },
  slate: { fill: '#eff3f8', stroke: '#64748b', text: '#334155' },
} satisfies Record<DiagramTone, { fill: string; stroke: string; text: string }>;

export function nodeTone(node: Pick<DiagramNode, 'shape' | 'tone'>): DiagramTone {
  return node.tone ?? (node.shape === 'diamond' ? 'amber' : node.shape === 'database' ? 'blue' : node.shape === 'ellipse' ? 'teal' : 'violet');
}
