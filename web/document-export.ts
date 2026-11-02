/** Offline, data-only renderer used by server-side Office downloads. */
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { parseDiagramSource, type DiagramSpec } from './src/lib/structuredDiagram'

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const label = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[&<>"#;|\\]/g, character => ({ '&': '#38;', '<': '#60;', '>': '#62;', '"': '#34;', '#': '#35;', ';': '#59;', '|': '#124;', '\\': '#92;' }[character]!))

export function structuredMermaid(spec: DiagramSpec): string {
  const ids = new Map(spec.nodes.map((node, index) => [node.id, `N${index}`]))
  if (spec.kind === 'sequence') {
    return ['sequenceDiagram', ...spec.nodes.map(node => `participant ${ids.get(node.id)} as ${label(node.label)}`),
      ...spec.edges.map(edge => `${ids.get(edge.source)}->>${ids.get(edge.target)}: ${label(edge.label || 'Message')}`)].join('\n')
  }
  const nodeLine = (node: DiagramSpec['nodes'][number]) => {
    const text = `"${label(node.label)}"`, id = ids.get(node.id)
    const shapes = { rectangle: `[${text}]`, rounded: `(${text})`, diamond: `{${text}}`, database: `[(${text})]`, ellipse: `([${text}])` }
    return id + shapes[node.shape]
  }
  const result = [`flowchart ${spec.direction === 'TB' ? 'TD' : 'LR'}`]
  const assigned = new Set<string>()
  for (const [index, lane] of (spec.lanes || []).entries()) {
    result.push(`subgraph L${index} ["${label(lane.label)}"]`)
    for (const node of spec.nodes.filter(node => node.lane === lane.id)) { result.push(nodeLine(node)); assigned.add(node.id) }
    result.push('end')
  }
  for (const node of spec.nodes.filter(node => !assigned.has(node.id))) result.push(nodeLine(node))
  for (const edge of spec.edges) result.push(`${ids.get(edge.source)} -->${edge.label ? `|"${label(edge.label)}"|` : ''} ${ids.get(edge.target)}`)
  return result.join('\n')
}

const renderer = new Renderer()
renderer.html = token => '<pre class="literal-html">' + escape(token.text) + '</pre>'
renderer.image = token => '<span class="export-warning">[External image omitted: ' + escape(token.text || 'image') + ']</span>'
marked.setOptions({ gfm: true, breaks: true, renderer })
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
  maxTextSize: 30000, maxEdges: 250, htmlLabels: false, theme: 'base', themeVariables: { fontFamily: 'Arial, sans-serif', primaryColor: '#f1e4ff', primaryTextColor: '#30104d', primaryBorderColor: '#7b00e0', lineColor: '#6c5680' },
  flowchart: { htmlLabels: false, useMaxWidth: true }, sequence: { useMaxWidth: true } })

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean }
function runs(element: Node, style: Partial<Run> = {}): Run[] {
  if (element.nodeType === Node.TEXT_NODE) return [{ text: element.textContent || '', ...style }]
  if (!(element instanceof Element)) return []
  const tag = element.tagName.toLowerCase()
  if (tag === 'br') return [{ text: '\n', ...style }]
  const next = { ...style, ...(['strong','b'].includes(tag) ? { bold: true } : {}), ...(['em','i'].includes(tag) ? { italic: true } : {}), ...(tag === 'code' ? { code: true } : {}) }
  const result = Array.from(element.childNodes).flatMap(child => runs(child, next))
  if (tag === 'a' && /^https?:\/\//i.test(element.getAttribute('href') || '')) result.push({ text: ' (' + element.getAttribute('href') + ')' })
  return result
}

function documentBlocks(root: Element): object[] {
  const blocks: object[] = []
  function visit(element: Element, depth = 0) {
    const tag = element.tagName.toLowerCase()
    if (element.classList.contains('export-diagram')) { blocks.push({ type: 'image', id: element.id, alt: element.getAttribute('aria-label') || 'Diagram' }); return }
    if (tag === 'table') {
      blocks.push({ type: 'table', rows: Array.from(element.querySelectorAll('tr')).map(row => Array.from(row.children).map(cell => ({ runs: runs(cell), header: cell.tagName === 'TH' }))) }); return
    }
    if (tag === 'ul' || tag === 'ol') {
      Array.from(element.children).forEach((item, index) => {
        const clone = item.cloneNode(true) as Element
        clone.querySelectorAll('ul,ol').forEach(child => child.remove())
        blocks.push({ type: 'paragraph', runs: [{ text: tag === 'ol' ? `${index + 1}. ` : '• ' }, ...runs(clone)], indent: depth })
        Array.from(item.children).filter(child => ['UL','OL'].includes(child.tagName)).forEach(child => visit(child, depth + 1))
      }); return
    }
    if (/^h[1-6]$/.test(tag)) { blocks.push({ type: 'heading', level: Number(tag[1]), runs: runs(element) }); return }
    if (['p','pre','blockquote'].includes(tag)) { blocks.push({ type: tag === 'pre' ? 'code' : 'paragraph', runs: runs(element), quote: tag === 'blockquote' }); return }
    if (tag === 'hr') { blocks.push({ type: 'paragraph', runs: [{ text: '────────────────' }] }); return }
    Array.from(element.children).forEach(child => visit(child, depth))
  }
  Array.from(root.children).forEach(child => visit(child))
  return blocks
}

function splitWideTables(root: Element) {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'))
    const columns = Math.max(0, ...rows.map(row => row.children.length))
    if (columns > 64 || rows.length > 3000) {
      const notice = document.createElement('p'); notice.className = 'export-warning'; notice.textContent = 'Table exceeds the visual export limit (64 columns / 3,000 rows). Its complete readable text follows.'
      const pre = document.createElement('pre'); pre.textContent = rows.map(row => Array.from(row.children).map(cell => cell.textContent).join(' | ')).join('\n')
      table.replaceWith(notice, pre); continue
    }
    if (columns <= 8) continue
    const fragment = document.createDocumentFragment()
    const notice = document.createElement('p')
    notice.className = 'export-warning'
    notice.textContent = `Wide table (${columns} columns) is split into column groups. The first column repeats so rows can be matched.`
    fragment.append(notice)
    for (let start = 1; start < columns; start += 7) {
      const caption = document.createElement('p'); caption.textContent = `Table columns 1 and ${start + 1}–${Math.min(columns, start + 7)}`; fragment.append(caption)
      const copy = document.createElement('table')
      for (const row of rows) {
        const target = document.createElement('tr')
        for (const index of [0, ...Array.from({ length: Math.min(7, columns - start) }, (_, index) => start + index)]) {
          target.append(row.children[index]?.cloneNode(true) || document.createElement('td'))
        }
        let section = copy.querySelector(row.parentElement?.tagName === 'THEAD' ? 'thead' : 'tbody')
        if (!section) { section = document.createElement(row.parentElement?.tagName === 'THEAD' ? 'thead' : 'tbody'); copy.append(section) }
        section.append(target)
      }
      fragment.append(copy)
    }
    table.replaceWith(fragment)
  }
}

function diagramDetails(source: string, caption: string, spec?: DiagramSpec): Element {
  const section = document.createElement('section')
  const heading = document.createElement('h3'); heading.textContent = `Diagram details — ${caption}`
  const notice = document.createElement('p'); notice.textContent = 'The overview is reduced to fit the page. Read the complete labels and connections below for details.'
  section.append(heading, notice)
  const addTable = (headers: string[], rows: string[][]) => {
    const table = document.createElement('table'), head = document.createElement('thead'), headrow = document.createElement('tr'), body = document.createElement('tbody')
    headers.forEach(text => { const cell = document.createElement('th'); cell.textContent = text; headrow.append(cell) }); head.append(headrow)
    rows.forEach(values => { const row = document.createElement('tr'); values.forEach(text => { const cell = document.createElement('td'); cell.textContent = text; row.append(cell) }); body.append(row) })
    table.append(head, body); section.append(table)
  }
  if (spec) {
    const nodes = new Map(spec.nodes.map(node => [node.id, node.label]))
    addTable(['Step / participant', 'Label', 'Lane'], spec.nodes.map(node => [node.id, node.label, spec.lanes?.find(lane => lane.id === node.lane)?.label || '']))
    if (spec.edges.length) addTable(['From', 'To', 'Connection'], spec.edges.map(edge => [nodes.get(edge.source) || edge.source, nodes.get(edge.target) || edge.target, edge.label || '']))
  } else { const pre = document.createElement('pre'); pre.textContent = source; section.append(pre) }
  return section
}

async function prepare(title: string, body: string) {
  document.getElementById('document-title')!.textContent = title
  const root = document.getElementById('document-body')!
  root.innerHTML = DOMPurify.sanitize(await marked.parse(body), { FORBID_TAGS: ['img','svg','style','iframe','object','embed','form','input','button','video','audio'], FORBID_ATTR: ['style','src','srcset','id'] })
  root.querySelectorAll('a').forEach(anchor => { if (!/^https?:\/\//i.test(anchor.getAttribute('href') || '')) anchor.removeAttribute('href') })
  const diagramCodes = Array.from(root.querySelectorAll('pre > code.language-mermaid,pre > code.language-bobdiagram'))
  const warnings: string[] = []
  for (const [index, code] of diagramCodes.entries()) {
    const source = code.textContent || ''
    const fallback = (reason: string) => {
      const notice = document.createElement('p'); notice.className = 'export-warning'; notice.textContent = `Diagram could not be rendered (${reason}). Source follows.`
      code.parentElement!.before(notice); warnings.push(notice.textContent)
    }
    if (index >= 20 || source.length > 30000) { fallback('export diagram limit'); continue }
    let text = source, caption = 'Diagram'
    let structured: DiagramSpec | undefined
    if (code.classList.contains('language-bobdiagram')) {
      const parsed = parseDiagramSource(source, true)
      if (!parsed.spec || parsed.error) { fallback('invalid structured diagram'); continue }
      structured = parsed.spec
      caption = parsed.spec.title || caption
      text = structuredMermaid(parsed.spec)
    }
    const unsupportedDirective = text.split('%%').slice(1).some(part => part.trimStart().startsWith('{')) || text.split(/\r?\n/).some(line => {
      const directive = line.trim();
      return directive === '---' || /^click\s/i.test(directive) || /^(?:accTitle|accDescr)\s*:/i.test(directive);
    });
    if (unsupportedDirective) { fallback('unsupported diagram directives'); continue }
    try {
      const result = await Promise.race([mermaid.render(`exportsvg${index}`, text), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))])
      if (/<foreignObject[\s>]/i.test(result.svg)) throw new Error('unsupported HTML diagram labels')
      const box = document.createElement('figure'); box.className = 'export-diagram'; box.id = `exportdiagram${index}`; box.setAttribute('aria-label', caption)
      box.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject','image','script','a'], FORBID_ATTR: ['href','xlink:href','onload','onclick'] })
      const svg = box.querySelector('svg')
      if (!svg || !svg.querySelector('path,rect,text,circle,line,polygon')) throw new Error('empty')
      const naturalWidth = svg.viewBox.baseVal.width, naturalHeight = svg.viewBox.baseVal.height
      svg.removeAttribute('width'); svg.style.width = '100%'; svg.style.maxWidth = '100%'; svg.style.height = 'auto'; svg.style.maxHeight = '850px'
      const label = document.createElement('figcaption'); label.textContent = caption; box.append(label)
      code.parentElement!.replaceWith(box)
      if (naturalWidth > 1000 || naturalHeight > 1200) box.after(diagramDetails(source, caption, structured))
    } catch { fallback('invalid or unsupported diagram') }
  }
  splitWideTables(root)
  await document.fonts.ready
  return { blocks: documentBlocks(root), warnings }
}
;(window as unknown as { BuddyDocumentExport: object }).BuddyDocumentExport = { prepare, structuredMermaid }
