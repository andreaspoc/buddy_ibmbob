import { themeCssValue } from '../lib/themeColor';
import { Toolbar } from './Toolbar';
import { t, useLanguage } from '../lib/i18n';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReactFlow, ReactFlowProvider, MarkerType, Handle, Position, Background, Controls, BaseEdge, getSmoothStepPath, getViewportForBounds, useReactFlow, applyNodeChanges } from '@xyflow/react';
import type { Node, NodeProps, NodeChange, Edge, EdgeProps } from '@xyflow/react';
import { diagramPalette, nodeTone } from '../lib/diagramTheme';
import type { DiagramTone } from '../lib/structuredDiagram';
import type { CSSProperties } from 'react';
import type { DiagramSpec, DiagramLayoutKind } from '../lib/structuredDiagram';
import type { DiagramLayout, DiagramEdgeLayout, DiagramPoint } from '../lib/diagramLayout';
import { selectDiagramLayout } from '../lib/diagramSelection';
import { diagramWidthFit } from '../lib/diagramSizing';
import { layoutDiagram, nodeSize } from '../lib/diagramLayout';
import { saveSessionFile } from '../api';
import '@xyflow/react/dist/style.css';
import './StructuredDiagram.css';
type Props = { compact?: boolean; spec?: DiagramSpec; source: string; streaming: boolean; error?: string; sessionId?: string };
type DiagramNode = Node<{ label: string; shape: string; direction: string; tone: DiagramTone }>;
const layoutOptions: { value: DiagramLayoutKind; label: string }[] = [
  { value: 'auto', label: 'Auto' }, { value: 'layered', label: 'Layered' }, { value: 'swimlane', label: 'Swimlane' },
  { value: 'tree', label: 'Tree' }, { value: 'radial', label: 'Radial' }, { value: 'force', label: 'Force' },
  { value: 'stress', label: 'Stress' }, { value: 'rectpacking', label: 'Rectangle packing' },
  { value: 'disco', label: 'Component packing' }, { value: 'fixed', label: 'Fixed positions' },
];
const layoutLabel = (value: string) => t(layoutOptions.find(option => option.value === value)?.label || value);
const handlePositions = [['left', Position.Left], ['right', Position.Right], ['top', Position.Top], ['bottom', Position.Bottom]] as const;
function ShapeNode({ data, id }: NodeProps<DiagramNode>) {
  const palette = diagramPalette[data.tone];
  const phase = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7;
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="structured-node-anchor" style={{ '--node-fill': palette.fill, '--node-stroke': palette.stroke, '--node-text': palette.text, '--float-delay': `${-phase * 0.55}s` } as CSSProperties}>
      {handlePositions.map(([side, position]) => <Handle key={`target-${side}`} id={`target-${side}`} type="target" position={position} isConnectable={false} />)}
      <div
        className={`structured-node structured-node-${data.shape}`}
        aria-label={data.label}
        onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setTip(null)}
      >
        <span>{data.label}</span>
      </div>
      {tip && (
        <div
          className="structured-node-tooltip"
          style={{
            position: 'fixed',
            left: `${Math.min(tip.x + 12, typeof window !== 'undefined' ? window.innerWidth - 330 : 0)}px`,
            top: `${tip.y + 16}px`,
            zIndex: 99999,
            pointerEvents: 'none',
            maxWidth: '320px',
            padding: '8px 12px',
            borderRadius: '8px',
            background: '#1a1625',
            color: '#ffffff',
            fontSize: '13px',
            lineHeight: '18px',
            fontWeight: '500',
            border: `1px solid ${themeCssValue('#9469be')}`,
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
            wordBreak: 'break-word',
          }}
        >
          {data.label}
        </div>
      )}
      {handlePositions.map(([side, position]) => <Handle key={`source-${side}`} id={`source-${side}`} type="source" position={position} isConnectable={false} />)}
    </div>
  );
}
function LaneNode({ data }: NodeProps<DiagramNode>) {
  const palette = diagramPalette[data.tone];
  return <div className="structured-lane" style={{ '--lane-fill': palette.fill, '--lane-stroke': palette.stroke, '--lane-text': palette.text } as CSSProperties} aria-label={data.label}><strong>{t(data.label)}</strong></div>;
}
const nodeTypes = { diagram: ShapeNode, lane: LaneNode };
type RoutedData = DiagramEdgeLayout & Record<string, unknown> & { sourceOrigin: DiagramPoint; targetOrigin: DiagramPoint; motion?: boolean };
type RoutedEdge = Edge<RoutedData>;
function portSide(point: DiagramPoint, node: DiagramPoint) {
  return (['left', 'right', 'top', 'bottom'] as const).map(side => ({ side, distance: side === 'left' ? Math.abs(point.x - node.x) : side === 'right' ? Math.abs(point.x - node.x - nodeSize.width) : side === 'top' ? Math.abs(point.y - node.y) : Math.abs(point.y - node.y - nodeSize.height) })).sort((a, b) => a.distance - b.distance)[0].side;
}
function portCenter(side: string, node: DiagramPoint): DiagramPoint {
  return { x: node.x + (side === 'left' ? 0 : side === 'right' ? nodeSize.width : nodeSize.width / 2), y: node.y + (side === 'top' ? 0 : side === 'bottom' ? nodeSize.height : nodeSize.height / 2) };
}
function roundedRoute(points: DiagramPoint[]) {
  if (!points.length) return '';
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1], point = points[i], next = points[i + 1];
    const before = Math.hypot(point.x - previous.x, point.y - previous.y), after = Math.hypot(next.x - point.x, next.y - point.y);
    if (!before || !after) { path += ` L${point.x},${point.y}`; continue; }
    const radius = Math.min(8, before / 2, after / 2);
    const a = { x: point.x + (previous.x - point.x) * radius / before, y: point.y + (previous.y - point.y) * radius / before };
    const b = { x: point.x + (next.x - point.x) * radius / after, y: point.y + (next.y - point.y) * radius / after };
    path += ` L${a.x},${a.y} Q${point.x},${point.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return path + ` L${last.x},${last.y}`;
}
function routeGeometry(data: RoutedData, source: DiagramPoint, target: DiagramPoint) {
  const sourceDelta = { x: source.x - data.sourceOrigin.x, y: source.y - data.sourceOrigin.y };
  const targetDelta = { x: target.x - data.targetOrigin.x, y: target.y - data.targetOrigin.y };
  // Morph the ELK route with moving nodes while keeping both endpoints attached.
  const points = data.sections.flatMap(section => section.points);
  const first = points[0], last = points[points.length - 1];
  const distance = first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0;
  const adjusted = data.sections.map(section => section.points.map((point, i) => {
    const fraction = distance && first ? Math.min(1, Math.hypot(point.x - first.x, point.y - first.y) / distance) : i / Math.max(1, section.points.length - 1);
    return { x: point.x + sourceDelta.x * (1 - fraction) + targetDelta.x * fraction, y: point.y + sourceDelta.y * (1 - fraction) + targetDelta.y * fraction };
  }));
  const label = data.label ? { x: data.label.x + data.label.width / 2 + (sourceDelta.x + targetDelta.x) / 2, y: data.label.y + data.label.height / 2 + (sourceDelta.y + targetDelta.y) / 2 } : first && last ? { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 - 8 } : { x: 0, y: 0 };
  return { path: adjusted.map(roundedRoute).join(' '), label };
}
function FlowEdge(props: EdgeProps<RoutedEdge>) {
  const { data, sourceX, sourceY, targetX, targetY } = props;
  const geometry = data?.sections.length ? routeGeometry(data, { x: sourceX, y: sourceY }, { x: targetX, y: targetY }) : (() => { const [path, x, y] = getSmoothStepPath(props); return { path, label: { x, y } }; })();
  const label = typeof props.label === 'string' ? wrapLabel(props.label, 28).map((line, index) => <tspan key={index} x={0} dy={index ? 16 : 0}>{line}</tspan>) : props.label;
  return <>{typeof props.label === 'string' && <title>{props.label}</title>}<BaseEdge id={props.id} path={geometry.path} markerEnd={props.markerEnd} style={props.style} label={label} labelX={geometry.label.x} labelY={geometry.label.y} labelStyle={props.labelStyle} labelBgStyle={props.labelBgStyle} labelBgPadding={props.labelBgPadding} labelBgBorderRadius={props.labelBgBorderRadius} />{data?.motion && <circle className="diagram-moving-particle" r="3.5" fill={props.style?.stroke || '#64748b'} pointerEvents="none"><animateMotion dur="3s" repeatCount="indefinite" path={geometry.path} /></circle>}</>;
}
const edgeTypes = { routed: FlowEdge };
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const escapeXml = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
function wrapLabel(label: string, limit = 22): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of label.split(/\s+/)) {
    if (line && line.length + word.length + 1 > limit) { lines.push(line); line = ''; }
    if (word.length > limit) {
      if (line) { lines.push(line); line = ''; }
      for (let start = 0; start < word.length; start += limit) lines.push(word.slice(start, start + limit));
    } else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).map((value, i) => i === 2 && lines.length > 3 ? `${value.slice(0, limit - 1)}…` : value);
}
function Sequence({ spec, selected, onSelect }: { spec: DiagramSpec; selected: string; onSelect: (id: string) => void }) {
  const width = Math.max(500, spec.nodes.length * 190); const height = Math.max(230, spec.edges.length * 65 + 130);
  const x = (id: string) => 95 + spec.nodes.findIndex(n => n.id === id) * 190;
  const instanceId = useId();
  const marker = `sequence-arrow-${instanceId.replace(/[^a-zA-Z0-9]/g, '')}`;
  return <svg className="structured-sequence" style={{ width: '100%' }} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={spec.title || t('Sequence diagram')}><defs>{spec.edges.map(edge => <marker key={edge.id} id={`${marker}-${edge.id}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path className="sequence-arrowhead" style={{ fill: diagramPalette[edge.tone || 'slate'].stroke }} d="M0,0 L8,4 L0,8" /></marker>)}</defs>{spec.nodes.map((n, index) => <g key={n.id}><g className="sequence-participant-float" style={{ '--float-delay': `${-index * 0.55}s` } as CSSProperties}><rect style={{ fill: diagramPalette[nodeTone(n)].fill, stroke: diagramPalette[nodeTone(n)].stroke }} x={x(n.id) - 82} y="12" width="164" height="48" rx="8" /><text x={x(n.id)} y={36 - (wrapLabel(n.label).length - 1) * 7} textAnchor="middle">{wrapLabel(n.label).map((line, i) => <tspan key={i} x={x(n.id)} dy={i ? 14 : 0}>{line}</tspan>)}</text></g><line className="sequence-lifeline" x1={x(n.id)} y1="60" x2={x(n.id)} y2={height - 20} /></g>)}{spec.edges.map((e, i) => <g key={e.id} className="sequence-message" role="button" tabIndex={0} aria-label={`${i + 1}. ${spec.nodes.find(node => node.id === e.source)?.label || e.source} → ${spec.nodes.find(node => node.id === e.target)?.label || e.target}: ${e.label || t('Message')}`} aria-pressed={selected === e.id} style={{ opacity: selected && selected !== e.id ? 0.25 : 1, cursor: 'pointer' }} onClick={() => onSelect(selected === e.id ? '' : e.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(selected === e.id ? '' : e.id); } }}><path className={e.animated ? 'diagram-transfer' : undefined} style={{ stroke: diagramPalette[e.tone || 'slate'].stroke }} d={e.source === e.target ? `M${x(e.source)},${100 + i * 65} h50 v26 h-50` : `M${x(e.source)},${100 + i * 65} H${x(e.target)}`} markerEnd={`url(#${marker}-${e.id})`} /><text x={e.source === e.target ? x(e.source) + 55 : (x(e.source) + x(e.target)) / 2} y={90 + i * 65 - (wrapLabel(e.label || '', e.source === e.target ? 22 : Math.max(16, Math.floor(Math.abs(x(e.source) - x(e.target)) / 7))).length - 1) * 14} textAnchor={e.source === e.target ? 'start' : 'middle'}>{wrapLabel(e.label || '', e.source === e.target ? 22 : Math.max(16, Math.floor(Math.abs(x(e.source) - x(e.target)) / 7))).map((line, j) => <tspan key={j} x={e.source === e.target ? x(e.source) + 55 : (x(e.source) + x(e.target)) / 2} dy={j ? 14 : 0}>{line}</tspan>)}</text></g>)}</svg>;
}
function DiagramBody({ spec: incomingSpec, source, streaming, error, sessionId, compact = false, maximized = false, onMaximize, layoutOverride, onLayoutOverride }: Props & { maximized?: boolean; onMaximize: () => void; layoutOverride?: DiagramLayoutKind; onLayoutOverride: (value: DiagramLayoutKind) => void }) {
  useLanguage();
  const lastValidSpec = useRef<DiagramSpec | undefined>(undefined);
  if (incomingSpec) lastValidSpec.current = incomingSpec;
  const sourceSpec = incomingSpec || lastValidSpec.current;
  const spec = sourceSpec && layoutOverride ? { ...sourceSpec, layout: layoutOverride } : sourceSpec;
  const selection = spec && spec.kind !== 'sequence' ? selectDiagramLayout(spec) : undefined;
  const canUseSwimlanes = !!spec?.lanes?.length && spec.nodes.length > 0 && spec.nodes.every(node => spec.lanes?.some(lane => lane.id === node.lane));
  const canUseFixed = !!spec?.nodes.length && spec.nodes.every(node => Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y));
  const [nodes, setNodes] = useState<DiagramNode[]>([]); const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const [layout, setLayout] = useState<DiagramLayout | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [motionOverride, setMotionOverride] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  const usesMotion = spec?.motion !== 'none' && (spec?.motion === 'flow' || !['tree', 'radial', 'force', 'stress', 'rectpacking', 'disco', 'fixed'].includes(layout?.algorithm || selection?.layout || spec?.layout || ''));
  const activeMotion = usesMotion && (!reducedMotion || motionOverride);
  const hasMotion = usesMotion && (spec?.nodes.length ?? 0) > 0;
  const hasFlowMotion = activeMotion && (spec?.edges.some(edge => spec.kind === 'flow' ? edge.animated !== false : edge.animated) ?? false);
  const groupNodes = useMemo<DiagramNode[]>(() => (layout?.groups || []).map(group => ({
    id: `lane:${group.id}`, type: 'lane', position: { x: group.x, y: group.y }, width: group.width, height: group.height,
    data: { label: group.label, shape: 'lane', direction: layout?.direction || 'LR', tone: group.tone || 'slate' },
    draggable: false, selectable: false, connectable: false, focusable: false, zIndex: -1,
  })), [layout]);
  const displayNodes = useMemo(() => [...groupNodes, ...nodes], [groupNodes, nodes]);
  const [selectedMessage, setSelectedMessage] = useState('');
  const activeMessage = spec?.edges.some(edge => edge.id === selectedMessage) ? selectedMessage : '';
  useEffect(() => { setSelectedMessage(''); }, [spec?.id]);
  const [status, setStatus] = useState(''); const [expanded, setExpanded] = useState(false);
  const [positionsReady, setPositionsReady] = useState(false); const version = useRef(0); const frame = useRef(0); const initialFit = useRef(false); const userNavigated = useRef(false);
  const lastFitContext = useRef('');
  const { setViewport } = useReactFlow(); const host = useRef<HTMLDivElement>(null);
  useEffect(() => { initialFit.current = false; userNavigated.current = false; setOverview(maximized); }, [spec?.id, maximized]);
  const [availableWidth, setAvailableWidth] = useState(800);
  const [availableHeight, setAvailableHeight] = useState(500);
  const [overview, setOverview] = useState(maximized);
  const overviewRef = useRef(overview); overviewRef.current = overview;
  const bounds = nodes.length ? { width: Math.max(layout?.width ?? 0, ...nodes.map(n => n.position.x + nodeSize.width)) + 32, height: Math.max(layout?.height ?? 0, ...nodes.map(n => n.position.y + nodeSize.height)) + 32 } : { width: 0, height: 0 };
  const widthFit = diagramWidthFit(bounds.width, bounds.height, availableWidth, 20, compact);
  const panelHeight = maximized ? Math.max(200, availableHeight) : widthFit.height;
  const fitLayout = useCallback((width: number, height: number, minZoom: number, duration: number) => {
    const canvas = host.current?.querySelector<HTMLElement>('.structured-flow-canvas');
    const viewport = getViewportForBounds({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }, canvas?.clientWidth || availableWidth, canvas?.clientHeight || panelHeight, minZoom, 1.2, 0.12);
    return setViewport(viewport, { duration });
  }, [availableWidth, panelHeight, setViewport]);
  const fitLayoutRef = useRef(fitLayout); fitLayoutRef.current = fitLayout;
  const layoutViewportHeight = maximized ? availableHeight : 500;
  const needsScrolling = spec?.kind !== 'sequence' && (bounds.width > availableWidth / 0.85 || bounds.height > panelHeight / 0.85);
  const readingView = maximized && needsScrolling && !overview;
  const showReadable = () => {
    userNavigated.current = false; setOverview(false);
    const viewport = host.current?.querySelector('.structured-flow-scroll');
    viewport?.scrollTo({ left: 0, top: 0 });
    requestAnimationFrame(() => requestAnimationFrame(() => void setViewport({ x: 20, y: 20, zoom: 1 })));
  };
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = element.querySelector<HTMLElement>('.structured-flow-scroll')?.clientWidth || entry.contentRect.width;
      if (width > 0) setAvailableWidth(Math.round(width));
      const height = element.querySelector<HTMLElement>('.structured-flow-scroll')?.clientHeight;
      if (height) setAvailableHeight(Math.round(height));
    });
    observer.observe(element);
    const scroller = element.querySelector('.structured-flow-scroll');
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  }, [spec?.kind]);
  useEffect(() => {
    const current = ++version.current;
    if (!spec || spec.kind === 'sequence') return;
    const timer = setTimeout(() => { void layoutDiagram(spec, availableWidth, 500, { pairedRows: compact }).then(result => {
      const { positions, direction } = result;
      if (version.current !== current) return;
      cancelAnimationFrame(frame.current);
      setLayout(result);
      const previous = new Map(nodesRef.current.map(n => [n.id, n]));
      const targets: DiagramNode[] = spec.nodes.map(n => ({ id: n.id, type: 'diagram', position: positions[n.id] || { x: 0, y: 0 }, data: { label: n.label, shape: n.shape, direction, tone: nodeTone({ ...n, tone: n.tone ?? (n.shape === 'diamond' ? undefined : spec.lanes?.find(lane => lane.id === n.lane)?.tone) }) }, ...nodeSize }));
      const start = performance.now(); const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const fitContext = JSON.stringify([spec.id, availableWidth, layoutViewportHeight, maximized, layoutRevision]);
      const shouldFit = !initialFit.current || lastFitContext.current !== fitContext || !maximized;
      const animate = (now: number) => {
        if (version.current !== current) return;
        const t = reduced || streaming || !initialFit.current ? 1 : Math.min(1, (now - start) / 280); const ease = 1 - (1 - t) ** 3;
        setNodes(targets.map(n => { const p = previous.get(n.id)?.position || n.position; return { ...n, position: { x: p.x + (n.position.x - p.x) * ease, y: p.y + (n.position.y - p.y) * ease } }; }));
        setPositionsReady(true);
        if (t < 1) frame.current = requestAnimationFrame(animate);
        else { initialFit.current = true; lastFitContext.current = fitContext; if (shouldFit && !userNavigated.current) frame.current = requestAnimationFrame(() => { if (version.current === current && !userNavigated.current) {
          const width = Math.max(result.width, ...targets.map(n => n.position.x + nodeSize.width)) + 32;
          const height = Math.max(result.height, ...targets.map(n => n.position.y + nodeSize.height)) + 32;
          const readable = width > availableWidth / 0.85 || height > layoutViewportHeight / 0.85;
          if (!maximized) { const fit = diagramWidthFit(width, height, availableWidth, 20, compact); void setViewport({ x: fit.x, y: fit.y, zoom: fit.zoom }); }
          else if (readable && !overviewRef.current) void setViewport({ x: 20, y: 20, zoom: 1 });
          else void fitLayoutRef.current(width, height, overviewRef.current ? (maximized ? 0.01 : 0.05) : 0.85, reduced || streaming ? 0 : 250);
        } }); }
      }; frame.current = requestAnimationFrame(animate);
    }).catch(() => { if (version.current === current) setStatus('Could not arrange this diagram.'); }); }, 120);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame.current); };
  }, [JSON.stringify(spec), setViewport, availableWidth, layoutViewportHeight, maximized, layoutRevision, streaming, compact]);
  const onChange = useCallback((changes: NodeChange<DiagramNode>[]) => {
    const known = changes.filter(change => 'id' in change && nodesRef.current.some(node => node.id === change.id));
    if (known.some(change => change.type === 'position' && change.dragging)) cancelAnimationFrame(frame.current);
    if (known.length) setNodes(previous => applyNodeChanges(known.map(change => {
      if (change.type !== 'position' || !change.position) return change;
      const lane = spec?.nodes.find(node => node.id === change.id)?.lane;
      const group = layout?.groups?.find(group => group.id === lane);
      if (!group) return change;
      return { ...change, position: {
        x: Math.max(group.x + 24, Math.min(change.position.x, group.x + group.width - nodeSize.width - 24)),
        y: Math.max(group.y + 52, Math.min(change.position.y, group.y + group.height - nodeSize.height - 24)),
      } };
    }), previous));
  }, [spec, layout]);
  const filename = `${(spec?.id || 'diagram').replace(/[^a-zA-Z0-9_-]/g, '_')}.diagram.json`;
  const exportSvg = (format: 'svg' | 'animated-svg' | 'html' = 'svg') => {
    const animated = format !== 'svg';
    const motionStyles = `<style>
      @keyframes export-transfer { to { stroke-dashoffset:-28 } }
      @keyframes export-float { 0%,100% { transform:translateY(0) } 50% { transform:translateY(-3px) } }
      .export-transfer,.diagram-transfer { stroke-dasharray:7 7; animation:export-transfer 1.6s linear infinite }
      .export-float,.sequence-participant-float { animation:export-float 4s ease-in-out infinite }
    </style>`;
    const deliver = (svg: string) => {
      const content = animated ? svg.replace('</svg>', `${motionStyles}</svg>`) : svg;
      if (format === 'html') {
        download(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(spec?.title || 'Diagram')}</title><style>body{margin:0;padding:24px;background:#fff;font-family:sans-serif}svg{display:block;width:100%;height:auto;overflow:visible}</style></head><body>${content}</body></html>`, filename.replace('.diagram.json', '.animated.html'), 'text/html');
      } else download(content, filename.replace('.diagram.json', animated ? '.animated.svg' : '.svg'), 'image/svg+xml');
    };
    if (!spec) return;
    const svg = host.current?.querySelector('.structured-sequence');
    if (svg) { const clone = svg.cloneNode(true) as SVGElement; clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.insertAdjacentHTML('afterbegin', '<style>text{font:14px sans-serif;fill:#242038}rect{fill:#faf7ff;stroke:#6f42c1}line,path{stroke:#6f42c1;fill:none}.sequence-lifeline{stroke-dasharray:5 5}.sequence-arrowhead{fill:#6f42c1}</style>'); clone.querySelectorAll('.sequence-message').forEach(message => { (message as SVGElement).style.opacity = '1'; }); if (!animated) clone.querySelectorAll('.diagram-transfer').forEach(path => path.removeAttribute('class')); deliver(clone.outerHTML); return; }
    const w = Math.max(400, (layout?.width ?? 0) + 32, ...nodes.map(n => n.position.x + 220)), h = Math.max(200, (layout?.height ?? 0) + 32, ...nodes.map(n => n.position.y + 110));
    const edges = spec.edges.map(e => {
      const a = nodes.find(n => n.id === e.source), b = nodes.find(n => n.id === e.target), route = layout?.edges[e.id];
      const first = route?.sections[0]?.points[0], last = route?.sections.at(-1)?.points.at(-1);
      const sourceNode = layout?.positions[e.source], targetNode = layout?.positions[e.target];
      if (!a || !b || !route || !first || !last || !sourceNode || !targetNode) return '';
      const sourceSide = portSide(first, sourceNode), targetSide = portSide(last, targetNode);
      const geometry = routeGeometry({ ...route, sourceOrigin: portCenter(sourceSide, sourceNode), targetOrigin: portCenter(targetSide, targetNode) }, portCenter(sourceSide, a.position), portCenter(targetSide, b.position));
      const lines = wrapLabel(e.label || '', 28);
      const label = lines.length ? `<rect x="${geometry.label.x - (route.label?.width ?? 180) / 2 - 8}" y="${geometry.label.y - lines.length * 8 - 6}" width="${(route.label?.width ?? 180) + 16}" height="${lines.length * 16 + 12}" rx="6" fill="white"/><text x="${geometry.label.x}" y="${geometry.label.y - (lines.length - 1) * 8 + 5}" text-anchor="middle">${lines.map((line, i) => `<tspan x="${geometry.label.x}" dy="${i ? 16 : 0}">${escapeXml(line)}</tspan>`).join('')}</text>` : '';
      return `<path class="${animated && e.animated !== false ? 'export-transfer' : ''}" d="${geometry.path}" fill="none" stroke="${diagramPalette[e.tone || 'slate'].stroke}" stroke-width="2" marker-end="url(#arrow-${escapeXml(e.id)})"/>${animated && e.animated !== false ? `<circle r="3.5" fill="${diagramPalette[e.tone || 'slate'].stroke}"><animateMotion dur="3s" repeatCount="indefinite" path="${geometry.path}"/></circle>` : ''}${label}`;
    }).join('');
    const markers = spec.edges.map(e => `<marker id="arrow-${escapeXml(e.id)}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="${diagramPalette[e.tone || 'slate'].stroke}"/></marker>`).join('');
    const shapes = nodes.map(n => { const { x, y } = n.position; const shape = n.data.shape; const outline = shape === 'database' ? `<path d="M${x},${y + 12} A92,12 0 0,1 ${x + 184},${y + 12} V${y + 64} A92,12 0 0,1 ${x},${y + 64} Z"/><ellipse cx="${x + 92}" cy="${y + 12}" rx="92" ry="12"/>` : shape === 'diamond' ? `<polygon points="${x + 92},${y} ${x + 184},${y + 38} ${x + 92},${y + 76} ${x},${y + 38}"/>` : shape === 'ellipse' ? `<ellipse cx="${x + 92}" cy="${y + 38}" rx="92" ry="38"/>` : `<rect x="${x}" y="${y}" width="184" height="76" rx="${shape === 'rectangle' ? 0 : 12}"/>`; const lines = wrapLabel(n.data.label, shape === 'diamond' ? 14 : 22); const palette = diagramPalette[n.data.tone]; return `<g class="${animated ? 'export-float' : ''}"><g fill="${palette.fill}" stroke="${palette.stroke}">${outline}</g><text fill="${palette.text}" x="${x + 92}" y="${y + 42 - (lines.length - 1) * 8}" text-anchor="middle">${lines.map((line, i) => `<tspan x="${x + 92}" dy="${i ? 16 : 0}">${escapeXml(line)}</tspan>`).join('')}</text></g>`; }).join('');
    const groups = (layout?.groups || []).map(group => { const palette = diagramPalette[group.tone || 'slate']; return `<rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="12" fill="${palette.fill}" stroke="${palette.stroke}"/><text x="${group.x + 16}" y="${group.y + 28}" fill="${palette.text}">${escapeXml(group.label)}</text>`; }).join('');
    deliver(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><style>text{font:14px sans-serif}</style><defs>${markers}</defs>${groups}${edges}${shapes}</svg>`);
  };
  return <section className={`structured-diagram ${maximized ? 'structured-diagram-maximized' : ''} ${activeMotion ? '' : 'diagram-motion-paused'} ${motionOverride ? 'diagram-motion-override' : ''}`} aria-label={spec?.title || t('Diagram')} ref={host}><Toolbar className="structured-diagram-toolbar"><strong>{spec?.title || t('Diagram')}</strong>{streaming && <span className="diagram-stream-status">{t('Drawing…')}</span>}<div className="diagram-actions">{spec?.kind === 'flow' && <select className="sequence-step-picker" aria-label={t('Diagram layout')} value={spec.layout || 'layered'} disabled={streaming} onChange={event => { userNavigated.current = false; setLayout(null); onLayoutOverride(event.target.value as DiagramLayoutKind); }}>{layoutOptions.map(option => <option key={option.value} value={option.value} disabled={(option.value === 'fixed' && !canUseFixed) || (option.value === 'swimlane' && !canUseSwimlanes)}>{layoutLabel(option.value)}</option>)}</select>}{spec?.kind === 'sequence' && spec.edges.length > 0 && <select className="sequence-step-picker" aria-label={t('Explore sequence messages')} value={activeMessage} onChange={event => setSelectedMessage(event.target.value)}><option value="">{t('All messages')}</option>{spec.edges.map((edge, index) => <option key={edge.id} value={edge.id}>{index + 1}. {edge.label || `${edge.source} → ${edge.target}`}</option>)}</select>}<button type="button" disabled={!spec} aria-haspopup={maximized ? undefined : "dialog"} onClick={onMaximize}>{maximized ? t('Return') : t('Maximize')}</button>{hasMotion && reducedMotion && !motionOverride && <button type="button" onClick={() => setMotionOverride(true)}>{t('Enable motion')}</button>}<button type="button" disabled={!positionsReady || spec?.kind === 'sequence'} onClick={() => { userNavigated.current = true; setLayoutRevision(value => value + 1); }}>{t('Arrange')}</button><button type="button" disabled={!positionsReady || spec?.kind === 'sequence'} onClick={() => { userNavigated.current = true; setOverview(true); requestAnimationFrame(() => requestAnimationFrame(() => void fitLayout(bounds.width, bounds.height, 0.01, reducedMotion ? 0 : 300))); }}>{t('Fit')}</button>{maximized && (needsScrolling || overview) && <button type="button" disabled={!positionsReady} aria-pressed={!overview} onClick={showReadable}>{t('Readable view')}</button>}<button type="button" disabled={!spec || (spec.kind !== 'sequence' && !positionsReady)} onClick={() => exportSvg()}>SVG</button><button type="button" disabled={!spec || streaming || (spec.kind !== 'sequence' && !positionsReady)} onClick={() => exportSvg('animated-svg')}>{t('Animated SVG')}</button><button type="button" disabled={!spec || streaming || (spec.kind !== 'sequence' && !positionsReady)} onClick={() => exportSvg('html')}>{t('Animated HTML')}</button>{sessionId && <button type="button" disabled={!spec || streaming} onClick={() => { if (spec) void saveSessionFile(sessionId, filename, JSON.stringify(spec, null, 2)).then(() => setStatus('Diagram saved.')).catch(() => setStatus('Could not save diagram.')); }}>{t('Save')}</button>}<button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t('Source')}</button></div></Toolbar>{spec?.kind === 'sequence' ? <div className="structured-sequence-scroll"><Sequence spec={spec} selected={activeMessage} onSelect={setSelectedMessage} /></div> : <div className="structured-flow-frame"><div className={`structured-flow-scroll ${readingView ? 'diagram-reading-view' : ''}`} style={{ height: panelHeight, overflow: readingView ? 'auto' : 'hidden' }} role="region" aria-label={t('Interactive diagram')} tabIndex={0}><div className="structured-flow-canvas" style={readingView ? { width: Math.max(availableWidth - 2, bounds.width), height: Math.max(panelHeight, bounds.height) } : { height: panelHeight }}>{positionsReady ? <ReactFlow onInit={() => {
            if (!maximized) void setViewport({ x: widthFit.x, y: widthFit.y, zoom: widthFit.zoom });
            else if (readingView) void setViewport({ x: 20, y: 20, zoom: 1 });
            else void fitLayout(bounds.width, bounds.height, 0.01, 0);
          }} nodes={displayNodes} edges={(spec?.edges || []).filter(e => nodes.some(n => n.id === e.source) && nodes.some(n => n.id === e.target)).map(e => { const route = layout?.edges[e.id]; const first = route?.sections[0]?.points[0]; const last = route?.sections.at(-1)?.points.at(-1); const sourceNode = layout?.positions[e.source]; const targetNode = layout?.positions[e.target]; const sourceSide = first && sourceNode ? portSide(first, sourceNode) : layout?.direction === 'TB' ? 'bottom' : 'right'; const targetSide = last && targetNode ? portSide(last, targetNode) : layout?.direction === 'TB' ? 'top' : 'left'; return { ...e, type: 'routed', sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}`, data: route && sourceNode && targetNode ? { ...route, motion: e.animated !== false && activeMotion, sourceOrigin: portCenter(sourceSide, sourceNode), targetOrigin: portCenter(targetSide, targetNode) } : undefined, animated: e.animated !== false && activeMotion, markerEnd: { type: MarkerType.ArrowClosed, color: diagramPalette[e.tone || 'slate'].stroke }, style: { stroke: diagramPalette[e.tone || 'slate'].stroke, strokeWidth: 2 }, labelStyle: { fill: '#334155', fontSize: 12, fontWeight: 500 }, labelBgStyle: { fill: '#ffffff', fillOpacity: 0.96 }, labelBgPadding: [8, 5] as [number, number], labelBgBorderRadius: 6 }; })} nodeTypes={nodeTypes} edgeTypes={edgeTypes} ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': t('Zoom in'), 'controls.zoomOut.ariaLabel': t('Zoom out') }} onNodesChange={onChange} onMoveStart={event => { if (event) userNavigated.current = true; }} onNodeDragStart={() => { userNavigated.current = true; cancelAnimationFrame(frame.current); }} nodesDraggable={maximized} zoomOnScroll={maximized && !readingView} zoomOnPinch={maximized && !readingView} preventScrolling={maximized && !readingView} panOnDrag={maximized && !readingView} minZoom={0.01} maxZoom={2.5} aria-label={t('Interactive diagram')}><Background gap={24} color="#d9e1ed" /></ReactFlow> : <div className="diagram-placeholder" role="status">{error ? t(error) : t('Preparing diagram…')}</div>}</div></div>{positionsReady && <Controls showInteractive={false} showFitView={false} onZoomIn={() => { userNavigated.current = true; }} onZoomOut={() => { userNavigated.current = true; }} />}</div>}{spec?.kind === 'flow' && selection && <p className="diagram-notice" role="status">{t('Layout')}: {layoutLabel(layout?.algorithm || selection.layout)}. {t(layout?.reason || selection.reason)}</p>}{readingView && <p className="diagram-reading-caption">{t('Scroll to follow the flow. Fit shows the whole diagram.')}</p>}{reducedMotion && !motionOverride && <p className="diagram-motion-caption">{t('Your device requests reduced motion. Enable motion to animate this diagram.')}</p>}{hasFlowMotion && <p className="diagram-motion-caption">{t('Moving connectors show flow direction.')}</p>}{error && (positionsReady || spec?.kind === 'sequence') && <p className="diagram-notice">{t(error)}</p>}{status && <p className="diagram-notice" role="status">{t(status)}</p>}{expanded && <pre className="diagram-source">{source}</pre>}</section>;
}
export const StructuredDiagram = memo(function StructuredDiagram(props: Props) {
  useLanguage();
  const [maximized, setMaximized] = useState(false);
  const [layoutOverride, setLayoutOverride] = useState<DiagramLayoutKind | undefined>(undefined);
  useEffect(() => { setLayoutOverride(undefined); }, [props.spec?.id]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const openMaximized = () => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMaximized(true);
  };
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!maximized || !dialog) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (restoreFocus.current?.isConnected) restoreFocus.current.focus({ preventScroll: true });
    };
  }, [maximized]);
  return <>
    <ReactFlowProvider><DiagramBody {...props} layoutOverride={layoutOverride} onLayoutOverride={setLayoutOverride} onMaximize={openMaximized} /></ReactFlowProvider>
    {maximized && createPortal(<dialog ref={dialogRef} className="diagram-maximized-dialog" aria-label={t('Maximized diagram')}
      onCancel={event => { event.preventDefault(); setMaximized(false); }}
      onClick={event => { if (event.target === event.currentTarget) setMaximized(false); }}>
      <ReactFlowProvider><DiagramBody {...props} maximized layoutOverride={layoutOverride} onLayoutOverride={setLayoutOverride} onMaximize={() => setMaximized(false)} /></ReactFlowProvider>
    </dialog>, document.body)}
  </>;
}, (a, b) => a.source === b.source && a.streaming === b.streaming && a.error === b.error && a.sessionId === b.sessionId && JSON.stringify(a.spec) === JSON.stringify(b.spec) && a.compact === b.compact);
