import { uiMotion } from './src/lib/motion'
import './src/lib/presentationTypography.scss';
/// <reference types="vite/client" />
import {
  SimpleBarChart, GroupedBarChart, StackedBarChart, LineChart, AreaChart,
  StackedAreaChart, PieChart, DonutChart, ScatterChart, BubbleChart,
  HeatmapChart, TreemapChart, AlluvialChart, HistogramChart, BoxplotChart,
  RadarChart, MeterChart, GaugeChart, TreeChart, CirclePackChart, LollipopChart,
  transitions,
} from '@carbon/charts'
import '@carbon/charts/styles.css'
import './carbon-charts.css'

const constructors = {
  bar: SimpleBarChart, simplebar: SimpleBarChart, groupedbar: GroupedBarChart,
  stackedbar: StackedBarChart, line: LineChart, area: AreaChart,
  stackedarea: StackedAreaChart, pie: PieChart, donut: DonutChart,
  scatter: ScatterChart, bubble: BubbleChart, heatmap: HeatmapChart,
  treemap: TreemapChart, sankey: AlluvialChart, alluvial: AlluvialChart,
  histogram: HistogramChart, boxplot: BoxplotChart, radar: RadarChart,
  meter: MeterChart, gauge: GaugeChart, tree: TreeChart,
  circlepack: CirclePackChart, lollipop: LollipopChart,
}
// Match the main chat renderer's Carbon categorical palette. The shared page map
// keeps a group's color stable when charts reorder, filter, or receive new rows.
const palette = ['#0f62fe', '#6929c4', '#1192e8', '#005d5d', '#9f1853', '#fa4d56', '#198038', '#002d9c', '#ee538b', '#b28600', '#009d9a', '#012749', '#8a3ffc', '#570408']
const groupColors = new Map<string, string>()
function colorScale(data: any, options: Record<string, any>) {
  const groupKey = options.data?.groupMapsTo || 'group'
  if (Array.isArray(data)) data.forEach(row => {
    const group = row?.[groupKey]
    if (group !== undefined && group !== null && !groupColors.has(String(group))) {
      groupColors.set(String(group), palette[groupColors.size % palette.length])
    }
  })
  return { ...Object.fromEntries(groupColors), ...options.color?.scale }
}
const duration = uiMotion.chartEnter
const easing = uiMotion.easing
transitions.default.duration = uiMotion.chartUpdate
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const registry = new Map<HTMLElement, ReturnType<typeof create>>()
function visible(element: HTMLElement) {
  return document.visibilityState !== 'hidden' && element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
}

function create(element: HTMLElement, config: { type: string; data: any; options?: Record<string, any> }) {
  if (!(element instanceof HTMLElement)) throw new TypeError('A chart container element is required')
  const key = String(config.type).toLowerCase().replace(/[\s_-]/g, '')
  const Constructor = constructors[key as keyof typeof constructors]
  if (!Constructor) throw new Error(`Unsupported Carbon chart type: ${config.type}`)
  registry.get(element)?.dispose()
  let disposed = false
  let animations: Animation[] = []
  const exitMarks = new Set<SVGGraphicsElement>()
  const clearAnimations = () => {
    animations.forEach(animation => animation.cancel())
    animations = []
    exitMarks.forEach(mark => mark.remove())
    exitMarks.clear()
  }
  let replayFrame = 0
  let wasVisible = visible(element)
  let options: Record<string, any> = { height: '360px', resizable: true, theme: 'white', ...config.options }
  let data = config.data
  const motionOptions = () => ({
    ...options,
    color: { ...options.color, scale: colorScale(data, options) },
    animations: !(window as any).BobPreviewLive && !reducedMotion.matches && options.animations !== false,
  })
  element.classList.add('buddy-carbon-chart')
  element.setAttribute('data-bob-carbon-chart', '')
  // Carbon destroy() removes its holder. Keep the public host owned by the
  // dashboard so disposal/recreation never removes the surrounding screen node.
  const mount = document.createElement('div')
  mount.style.width = '100%'
  element.append(mount)
  const chart = new Constructor(mount, { data: config.data, options: motionOptions() } as any)
  // Carbon owns geometry/data transitions; align its transition service with the UI easing.
  const service = chart.services.transitions
  if (service?.setupTransition) {
    const setup = service.setupTransition.bind(service)
    service.setupTransition = (args: any) => {
      const transition = setup(args)
      // CSS cubic-bezier(.2,0,.38,.9), evaluated for D3's numeric easing API.
      const enabled = !reducedMotion.matches && !(window as any).BobPreviewLive && options.animations !== false && args.animate !== false
      const updateDuration = /hover|mouseover|mouseout/.test(args.name || '') ? uiMotion.fast : uiMotion.chartUpdate
      return transition.duration(enabled ? updateDuration : 0).ease((progress: number) => {
        let lo = 0, hi = 1, t = progress
        for (let i = 0; i < 12; i++) {
          t = (lo + hi) / 2
          const x = 3 * (1-t) ** 2 * t * .2 + 3 * (1-t) * t ** 2 * .38 + t ** 3
          if (x < progress) lo = t; else hi = t
        }
        return 3 * (1-t) * t ** 2 * .9 + t ** 3
      })
    }
  }
  // Carbon removes disabled series immediately. Preserve only the exiting marks
  // long enough to fade them while its native transitions reshape the survivors.
  // Wrapping the model operation covers both pointer and keyboard legend actions.
  const toggleDataLabel = chart.model.toggleDataLabel.bind(chart.model)
  chart.model.toggleDataLabel = (label: string) => {
    cancelAnimationFrame(replayFrame)
    clearAnimations()
    const animate = !reducedMotion.matches && !(window as any).BobPreviewLive && options.animations !== false
    const before = animate ? [...element.querySelectorAll<SVGGraphicsElement>('.bar, path.slice')].map(mark => ({
      mark, parent: mark.parentElement, copy: mark.cloneNode(true) as SVGGraphicsElement,
      opacity: getComputedStyle(mark).opacity,
    })) : []
    toggleDataLabel(label)
    before.forEach(({ mark, parent, copy, opacity }) => {
      if (mark.isConnected || !parent?.isConnected) return
      copy.classList.remove('bar', 'slice')
      copy.setAttribute('aria-hidden', 'true')
      copy.setAttribute('data-buddy-exiting-mark', '')
      copy.style.pointerEvents = 'none'
      parent.append(copy)
      exitMarks.add(copy)
      const animation = copy.animate([{ opacity }, { opacity: 0 }], { duration: uiMotion.chartUpdate, easing })
      animations.push(animation)
      void animation.finished.catch(() => {}).finally(() => { copy.remove(); exitMarks.delete(copy) })
    })
  }
  const syncOptions = () => {
    const selectedGroups = chart.model.getOptions().data?.selectedGroups
    const next = motionOptions()
    chart.model.setOptions({ ...next, data: { ...options.data, ...(selectedGroups ? { selectedGroups: [...selectedGroups] } : {}) } })
  }
  const replay = () => {
    if (disposed || !visible(element)) return
    // Streaming preview starts without native transitions. Final activation restores
    // them for subsequent data changes, retaining the user's legend selection.
    const enabled = !(window as any).BobPreviewLive && !reducedMotion.matches && options.animations !== false
    if (chart.model.getOptions().animations !== enabled) syncOptions()
    if ((window as any).BobPreviewLive) return
    clearAnimations()
    if (reducedMotion.matches || options.animations === false) return
    cancelAnimationFrame(replayFrame)
    replayFrame = requestAnimationFrame(() => {
      if (disposed || !visible(element) || reducedMotion.matches) return
      // Animate actual graph marks without resetting data, filtering, or chart instances.
      const bars = element.querySelectorAll<SVGGraphicsElement>('.bar')
      const horizontal = options.axes?.bottom?.mapsTo === 'value'
      bars.forEach(mark => {
        animations.push(mark.animate([
          { transform: horizontal ? 'scaleX(0)' : 'scaleY(0)', transformOrigin: horizontal ? 'left center' : 'center bottom', transformBox: 'fill-box' },
          { transform: horizontal ? 'scaleX(1)' : 'scaleY(1)', transformOrigin: horizontal ? 'left center' : 'center bottom', transformBox: 'fill-box' },
        ], { duration, easing }))
      })
      element.querySelectorAll<SVGPathElement>('path.line').forEach(mark => {
        const length = mark.getTotalLength()
        if (length > 0) animations.push(mark.animate([
          { strokeDasharray: `${length} ${length}`, strokeDashoffset: String(length) },
          { strokeDasharray: `${length} ${length}`, strokeDashoffset: '0' },
        ], { duration, easing }))
      })
      // Reveal areas, radial slices, and other Carbon graph marks from their own geometry.
      element.querySelectorAll<SVGGraphicsElement>(
        'path.slice, path.area, circle.dot, rect.cell, path.arc, .cds--cc--pie path, .cds--cc--donut path, .cds--cc--treemap rect, .cds--cc--alluvial path'
      ).forEach(mark => {
        animations.push(mark.animate([
          { opacity: 0, transform: 'scale(.92)', transformOrigin: 'center', transformBox: 'fill-box' },
          { opacity: 1, transform: 'scale(1)', transformOrigin: 'center', transformBox: 'fill-box' },
        ], { duration, easing }))
      })
      // The same subtle entrance as other UI panels accompanies graph motion.
      animations.push(element.animate([
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration, easing }))
    })
    element.dispatchEvent(new CustomEvent('buddy:chart-replayed', { bubbles: true }))
  }
  const checkVisibility = () => {
    const next = visible(element)
    if (next && !wasVisible) { chart.update(false); replay() }
    wasVisible = next
  }
  const observer = new MutationObserver(checkVisibility)
  // Watch only ancestors: unrelated chart SVG mutations must not trigger replay.
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] })
  }
  const intersection = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    const entry = entries[0]
    const next = !!entry?.isIntersecting && visible(element)
    if (next && !wasVisible) replay()
    wasVisible = next
  }) : undefined
  intersection?.observe(element)
  const motionChanged = () => { cancelAnimationFrame(replayFrame); clearAnimations(); syncOptions() }
  reducedMotion.addEventListener('change', motionChanged)
  document.addEventListener('visibilitychange', checkVisibility)
  const handle = {
    chart,
    update(next: { data?: any; options?: Record<string, any> }) {
      if (disposed) return
      if (next.options) options = { ...options, ...next.options }
      if (next.data !== undefined) data = next.data
      // Refresh group colors on every data change; existing assignments stay stable.
      syncOptions()
      if (next.data !== undefined) chart.model.setData(data)
    },
    replay,
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(replayFrame)
      clearAnimations()
      observer.disconnect()
      intersection?.disconnect()
      document.removeEventListener('visibilitychange', checkVisibility)
      reducedMotion.removeEventListener('change', motionChanged)
      registry.delete(element)
      chart.destroy()
    },
  }
  registry.set(element, handle)
  replay()
  document.dispatchEvent(new CustomEvent('bob:carbon-ready', { detail: { element } }))
  return handle
}
function replayVisible(scope?: HTMLElement) {
  registry.forEach((handle, element) => {
    if (!element.isConnected) { handle.dispose(); return }
    if (!scope || scope === element || scope.contains(element)) handle.replay()
  })
}
document.addEventListener('bob:chart-activate', (event) => replayVisible((event as CustomEvent).detail?.element))
window.addEventListener('pagehide', event => { if (!event.persisted) registry.forEach(handle => handle.dispose()) })
window.addEventListener('pageshow', event => { if (event.persisted) replayVisible() })
Object.assign(window, { BuddyCarbonCharts: { create, replayVisible, version: '1.27.22' } })
export { create, replayVisible }
