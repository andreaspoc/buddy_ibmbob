// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderChartToDOM as renderLegacy } from '../../../frontend/chart.js';
import { renderChartToDOM as renderModern, carbonEase } from '../../src/components/ChartRenderer';

const hover = (el: Element, type: string, x = 50, y = 60) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
const tooltipOf = (card: Element) => card.querySelector<HTMLElement>('.chart-interactive-tooltip')!;

describe('frontend/chart.js', () => {
  const legend = (card: Element) => Array.from(card.querySelectorAll<HTMLButtonElement>('button'));

  it('adopts Chart.js shaped specs including plugin titles and dataset colours', () => {
    const card = renderLegacy({
      type: 'bar',
      data: { labels: ['A', 'B'], datasets: [{ label: 'S', data: [1, 2], backgroundColor: '#123456' }, { data: [3, 4], borderColor: '#654321' }, { label: 'Empty' }] },
      options: { plugins: { title: { text: 'From plugin' }, subtitle: { text: 'Sub plugin' } } },
    });
    expect(card.querySelector('h4')!.textContent).toBe('From plugin');
    expect(card.querySelector('p')!.textContent).toBe('Sub plugin');
    const fills = Array.from(card.querySelectorAll('rect')).map(r => r.getAttribute('fill'));
    expect(fills).toContain('#123456');
    expect(fills).toContain('#654321');
  });
  it('tolerates Chart.js data with no datasets', () => {
    const card = renderLegacy({ data: { labels: [] } });
    expect(card.textContent).toContain('No chart data provided.');
  });
  it('keeps explicit titles over plugin ones and defaults to bar', () => {
    const card = renderLegacy({ title: 'Mine', subtitle: 'Own', labels: ['A'], data: [5], options: { plugins: { title: { text: 'No' }, subtitle: { text: 'No' } } } });
    expect(card.querySelector('h4')!.textContent).toBe('Mine');
    expect(card.querySelector('p')!.textContent).toBe('Own');
    expect(card.textContent).toContain('BAR');
  });
  it.each([
    ['no data at all', {}],
    ['empty datasets with no labels', { datasets: [{ label: 'x', data: [] }] }],
  ])('shows an empty message for %s', (_n, spec) => {
    expect(renderLegacy(spec).textContent).toContain('No chart data provided.');
  });
  it('explains unsupported chart types', () => {
    expect(renderLegacy({ type: 'radar', labels: ['A'], data: [1] }).textContent).toContain('does not support "radar"');
  });
  it.each([
    [2_500_000, '2.5M'], [3_000_000, '3M'], [2500, '2.5k'], [2000, '2k'], [7, '7'], [1.25, '1.3'],
  ])('formats %d as %s in pie legends', (value, expected) => {
    const card = renderLegacy({ type: 'pie', labels: ['A', 'B'], data: [value, 1] });
    expect(legend(card)[0].textContent).toBe(`A (${expected})`);
  });
  it('omits a pie legend value when the data is shorter than the labels', () => {
    const card = renderLegacy({ type: 'pie', labels: ['A', 'B'], data: [4] });
    expect(legend(card)[1].textContent).toBe('B');
  });

  describe('series legend', () => {
    const multi = (type: string, extra = {}) => renderLegacy({
      type, labels: ['Long label beyond fourteen', 'B'],
      datasets: [{ label: 'One', data: [10, 20] }, { data: [5, 2], color: '#abcdef' }], ...extra,
    });
    it.each(['bar', 'line'])('toggles a %s series off and on', type => {
      const card = multi(type);
      const count = () => card.querySelectorAll(type === 'bar' ? 'rect' : 'path').length;
      const before = count();
      expect(legend(card).map(b => b.textContent)).toEqual(['One', 'Series 2']);
      legend(card)[0].click();
      expect(legend(card)[0].style.textDecoration).toBe('line-through');
      if (type === 'line') expect(count()).toBe(before - 1);
      else expect(card.querySelectorAll('rect[height="0"]').length).toBe(2);
      legend(card)[0].click();
      expect(legend(card)[0].style.textDecoration).toBe('none');
      expect(count()).toBe(before);
    });
    it.each(['bar', 'line'])('truncates long %s axis labels', type => {
      expect(multi(type).textContent).toContain('Long label be…');
    });
    it.each(['bar', 'line'])('renders zero-only %s charts on a unit scale', type => {
      const card = renderLegacy({ type, labels: ['A'], datasets: [{ label: 'Zero', data: [0] }] });
      expect(Array.from(card.querySelectorAll('text')).map(t => t.textContent)).toContain('1');
    });
    it('hides every series without failing the scale', () => {
      const card = multi('line');
      legend(card)[0].click();
      legend(card)[1].click();
      expect(card.querySelectorAll('path')).toHaveLength(0);
      expect(card.querySelectorAll('button')).toHaveLength(2);
    });
    it('skips datasets with no points and centres a single label', () => {
      const card = renderLegacy({ type: 'line', labels: ['Only'], datasets: [{ label: 'E', data: [] }, { label: 'F', data: [3] }] });
      expect(card.querySelectorAll('path')).toHaveLength(1);
      expect(card.querySelectorAll('circle')).toHaveLength(1);
    });
  });

  describe('bar hover', () => {
    it('highlights the hovered bar and explains it, then restores', () => {
      const card = renderLegacy({ type: 'bar', labels: ['A', 'B'], datasets: [{ data: [10, 20] }, { label: 'Two', data: [30, 0] }] });
      document.body.appendChild(card);
      const [first, second] = Array.from(card.querySelectorAll<SVGRectElement>('rect'));
      hover(first, 'mouseenter');
      expect(first.style.filter).toContain('brightness');
      expect(second.style.opacity).toBe('0.35');
      expect(tooltipOf(card).style.display).toBe('block');
      expect(tooltipOf(card).textContent).toContain('Series 1:');
      expect(tooltipOf(card).textContent).toContain('10');
      hover(second, 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Two:');
      hover(first, 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Series 1:');
      hover(first, 'mouseleave');
      expect(tooltipOf(card).style.display).toBe('none');
      expect(second.style.opacity).toBe('1');
      card.remove();
    });
    it('hidden bars are inert', () => {
      const card = renderLegacy({ type: 'bar', labels: ['A'], datasets: [{ label: 'X', data: [10] }, { label: 'Y', data: [5] }] });
      card.querySelectorAll('button')[0].click();
      const hiddenBar = card.querySelector<SVGRectElement>('rect')!;
      expect(hiddenBar.style.cursor).toBe('default');
      hover(hiddenBar, 'mouseenter');
      expect(tooltipOf(card).style.display).toBe('none');
    });
  });

  describe('line hover', () => {
    it('grows the point, shows the guide and falls back to generic labels', () => {
      const card = renderLegacy({ type: 'line', labels: ['A'], datasets: [{ data: [1, 2] }] });
      const circles = card.querySelectorAll<SVGCircleElement>('circle');
      hover(circles[0], 'mouseenter');
      expect(circles[0].getAttribute('r')).toBe('6');
      expect(tooltipOf(card).textContent).toContain('Series 1:');
      hover(circles[1], 'mouseenter');
      expect(tooltipOf(card).textContent).toContain('Series 1:2');
      hover(circles[1], 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Series 1:2');
      hover(circles[0], 'mouseleave');
      expect(circles[0].getAttribute('r')).toBe('3.5');
      expect(tooltipOf(card).style.display).toBe('none');
    });
    it('uses the series label on mousemove', () => {
      const card = renderLegacy({ type: 'line', labels: ['A', 'B'], datasets: [{ label: 'Named', data: [1, 2] }] });
      hover(card.querySelector('circle')!, 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Named:');
    });
  });

  describe('pie and doughnut', () => {
    it('summarises the doughnut centre and swaps it on hover', () => {
      const card = renderLegacy({ type: 'doughnut', labels: ['A', 'B'], data: [75, 25] });
      const centre = () => Array.from(card.querySelectorAll('svg > text')).map(t => t.textContent);
      expect(centre()).toEqual(['100', 'Total']);
      const [a, b] = Array.from(card.querySelectorAll<SVGPathElement>('path'));
      expect(a.getAttribute('d')).toMatch(/L .* A /);
      hover(a, 'mouseenter');
      expect(centre()).toEqual(['75', 'A (75.0%)']);
      expect(b.style.opacity).toBe('0.4');
      expect(a.style.transform).toContain('translate');
      hover(a, 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Share:75.0%');
      hover(a, 'mouseleave');
      expect(centre()).toEqual(['100', 'Total']);
      expect(tooltipOf(card).style.display).toBe('none');
    });
    it('pie hover works without centre text and names unlabelled items', () => {
      const card = renderLegacy({ type: 'pie', labels: ['A'], data: [1, 2] });
      const slices = card.querySelectorAll<SVGPathElement>('path');
      hover(slices[1], 'mouseenter');
      expect(tooltipOf(card).textContent).toContain('Item 2');
      hover(slices[1], 'mouseleave');
      expect(slices[1].style.transform).toBe('none');
    });
    it('toggles slices from the legend and draws nothing with no positive total', () => {
      const card = renderLegacy({ type: 'pie', labels: ['A', 'B'], data: [1, 2] });
      legend(card)[0].click();
      expect(card.querySelectorAll('path')).toHaveLength(1);
      legend(card)[0].click();
      expect(card.querySelectorAll('path')).toHaveLength(2);
      const empty = renderLegacy({ type: 'doughnut', labels: ['Z'], data: [0] });
      expect(empty.querySelectorAll('path')).toHaveLength(0);
    });
  });
});

describe('ChartRenderer', () => {
  type Frame = (now: number) => void;
  let frames: Map<number, Frame>;
  let reduced = false;
  const flushFrames = (advance = 10_000) => {
    let guard = 0;
    while (frames.size && guard++ < 50) {
      const batch = Array.from(frames.values());
      frames.clear();
      batch.forEach(f => f(performance.now() + advance));
    }
  };
  const stepFrame = (now: number) => {
    const [id, frame] = Array.from(frames.entries())[0];
    frames.delete(id);
    frame(now);
  };
  const render = (spec: any) => renderModern(spec);
  const legend = (card: Element) => Array.from(card.querySelectorAll<HTMLButtonElement>('.chart-legend-wrapper button'));

  beforeEach(() => {
    reduced = false;
    frames = new Map();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (f: Frame) => { frames.set(++id, f); return id; });
    vi.stubGlobal('cancelAnimationFrame', (i: number) => { frames.delete(i); });
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: reduced, media: query })) as any;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('input normalisation', () => {
    it('adopts Chart.js data with per-slice and series colours and plugin titles', () => {
      const card = render({
        type: 'pie',
        data: { labels: ['A', 'B'], datasets: [{ label: 'S', data: [1, 3], backgroundColor: ['#111111', '#222222'] }] },
        options: { plugins: { title: { text: 'T' }, subtitle: { text: 'ST' } } },
      });
      expect(card.querySelector('h4')!.textContent).toBe('T');
      expect(card.querySelector('p')!.textContent).toBe('ST');
      expect(Array.from(card.querySelectorAll('path')).map(p => p.getAttribute('fill'))).toEqual(['#111111', '#222222']);
    });
    it.each([
      ['background', { backgroundColor: '#aa0000' }, '#aa0000'],
      ['border', { borderColor: '#00bb00' }, '#00bb00'],
    ])('uses the %s colour for a line series', (_n, colour, expected) => {
      const card = render({ type: 'line', data: { labels: ['A', 'B'], datasets: [{ data: [1, 2], ...colour }] } });
      expect(card.querySelector('svg path')!.getAttribute('stroke')).toBe(expected);
    });
    it('tolerates missing datasets and dataset data in Chart.js specs', () => {
      expect(render({ data: { labels: [] } }).textContent).toContain('No chart data provided.');
      expect(render({ type: 'bar', data: { labels: [], datasets: [{ label: 'nothing' }] } }).textContent).toContain('No chart data provided.');
    });
    it('names unlabelled points when data outgrows labels', () => {
      const card = render({ type: 'bar', labels: ['A'], data: [1, 2] });
      expect(legend(card).map(b => b.textContent)).toEqual(['A (1)', 'Item 2 (2)']);
    });
    it('treats non-array dataset data as empty', () => {
      const card = render({ type: 'line', labels: ['A', 'B'], datasets: [{ label: 'x', data: 'nope' }, { label: 'y', data: [1, 2] }] });
      expect(card.querySelectorAll('svg path')).toHaveLength(1);
    });
    it.each([
      ['non-numeric', { type: 'bar', labels: ['A'], datasets: [{ data: ['x'] }] }],
      ['infinite', { type: 'line', labels: ['A'], datasets: [{ data: [Infinity] }] }],
      ['negative pie', { type: 'pie', labels: ['A'], data: [-1] }],
      ['negative doughnut', { type: 'doughnut', labels: ['A'], data: [-1] }],
    ])('refuses %s data with an explanation', (_n, spec) => {
      expect(render(spec).textContent).toContain('Chart data must contain finite numbers');
    });
    it('explains unsupported types', () => {
      const card = render({ type: 'Radar', title: 'R', labels: ['A'], data: [1] });
      expect(card.textContent).toContain('does not support "radar"');
      expect(card.querySelector('svg')).toBeNull();
    });
    it('honours spec colours and series colour mode', () => {
      const custom = render({ type: 'bar', title: 'X', colors: ['#010101'], labels: ['A', 'B'], data: [1, 2] });
      expect(Array.from(custom.querySelectorAll('rect')).map(r => r.getAttribute('fill'))).toEqual(['#010101', '#010101']);
      const series = render({ type: 'bar', title: 'Y', colorMode: 'series', labels: ['A', 'B'], data: [1, 2] });
      const fills = Array.from(series.querySelectorAll('rect')).map(r => r.getAttribute('fill'));
      expect(fills[0]).toBe(fills[1]);
    });
    it('describes the chart for assistive tech, with fallbacks', () => {
      const card = render({ type: 'line', labels: ['A'], datasets: [{ data: [4] }] });
      expect(card.querySelector('svg')!.getAttribute('aria-label')).toBe('line chart. Values: A 4');
    });
    it.each([
      ['negative', [-120, 50], '-200'],
      ['large', [1500, 2_500_000], '3M'],
      ['fractional', [0.25, 0.5], '0.1'],
    ])('scales %s bar values', (_n, data, tick) => {
      const card = render({ type: 'bar', labels: ['A', 'B'], data });
      expect(Array.from(card.querySelectorAll('svg > text')).map(t => t.textContent)).toContain(tick);
    });
    it('wraps long labels with a full-text title', () => {
      const long = 'A very long category label that certainly wraps across several lines indeed';
      const card = render({ type: 'line', labels: [long, ''], data: [1, 2] });
      const label = Array.from(card.querySelectorAll('text')).find(t => t.querySelector('title')?.textContent === long)!;
      expect(label.querySelectorAll('tspan').length).toBeGreaterThan(1);
    });
  });

  describe('maximise dialog', () => {
    function mounted() {
      const card = render({ type: 'bar', labels: ['A'], data: [1] });
      document.body.appendChild(card);
      const dialog = card.querySelector('dialog')!;
      dialog.showModal = () => { dialog.open = true; };
      dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
      dialog.getBoundingClientRect = () => ({ left: 100, right: 200, top: 100, bottom: 200 } as DOMRect);
      card.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
      return { card, dialog };
    }
    const clickAt = (el: Element, clientX: number, clientY: number) => el.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }));
    afterEach(() => { document.body.innerHTML = ''; });
    it('uses generic titles when the chart has none', () => {
      const { dialog } = mounted();
      expect(dialog.getAttribute('aria-label')).toBe('Expanded chart');
      expect(dialog.querySelector('strong')!.textContent).toBe('Chart');
    });
    it.each([[50, 150], [250, 150], [150, 50], [150, 250]])('closes on a backdrop click at %d,%d', (x, y) => {
      const { dialog } = mounted();
      clickAt(dialog, x, y);
      expect(dialog.open).toBe(false);
    });
    it('stays open for clicks inside the dialog', () => {
      const { dialog } = mounted();
      clickAt(dialog, 150, 150);
      clickAt(dialog.querySelector('strong')!, 10, 10);
      expect(dialog.open).toBe(true);
    });
  });

  describe('bars', () => {
    const tooltip = (card: Element) => tooltipOf(card).textContent;
    it('single series hover uses category names and legend hides the category', () => {
      const card = render({ type: 'bar', title: 'Cat', labels: ['A', 'B'], data: [10, 20] });
      document.body.appendChild(card);
      const [a, b] = Array.from(card.querySelectorAll<SVGRectElement>('rect'));
      hover(a, 'mouseenter');
      expect(tooltip(card)).toContain('A: 10');
      expect(b.style.opacity).toBe('0.35');
      hover(a, 'mousemove');
      expect(tooltip(card)).toContain('A: 10');
      hover(a, 'mouseleave');
      expect(b.style.opacity).toBe('1');
      legend(card)[0].click();
      flushFrames();
      expect(a.getAttribute('height')).toBe('0');
      expect(a.style.opacity).toBe('0');
      expect(legend(card)[0].getAttribute('aria-pressed')).toBe('false');
      expect(legend(card)[0].style.textDecoration).toBe('line-through');
      hover(b, 'mouseenter');
      hover(b, 'mouseleave');
      expect(a.style.opacity).toBe('0');
      expect(b.style.opacity).toBe('1');
      legend(card)[0].click();
      flushFrames();
      expect(Number(a.getAttribute('height'))).toBeGreaterThan(0);
      expect(legend(card)[0].getAttribute('aria-pressed')).toBe('true');
      card.remove();
    });
    it('multi series hover names series with fallback and supports toggling', () => {
      const card = render({ type: 'bar', labels: ['A'], datasets: [{ label: 'One', data: [10] }, { data: [20] }] });
      const [one, two] = Array.from(card.querySelectorAll<SVGRectElement>('rect'));
      hover(one, 'mouseenter');
      expect(tooltip(card)).toContain('One: 10');
      hover(two, 'mousemove');
      expect(tooltip(card)).toContain('Series 2: 20');
      expect(legend(card).map(b => b.textContent)).toEqual(['One', 'Series 2']);
      legend(card)[1].click();
      flushFrames();
      expect(two.getAttribute('height')).toBe('0');
      expect(legend(card)[1].getAttribute('aria-pressed')).toBe('false');
      hover(one, 'mouseleave');
      expect(two.style.opacity).toBe('0');
    });
    it('applies hide immediately with reduced motion', () => {
      reduced = true;
      const card = render({ type: 'bar', labels: ['A', 'B'], data: [100, 200] });
      legend(card)[1].click();
      expect(frames.size).toBe(0);
      expect(card.querySelectorAll('rect')[1].getAttribute('height')).toBe('0');
      const valueLabel = Array.from(card.querySelectorAll<SVGTextElement>('svg > text')).find(t => t.textContent === '0' && t.style.opacity === '0');
      expect(valueLabel).toBeDefined();
    });
    it('jumps to the final frame when reduced motion turns on mid-animation', () => {
      const card = render({ type: 'bar', labels: ['A', 'B'], data: [100, 200] });
      legend(card)[0].click();
      reduced = true;
      flushFrames(1);
      expect(card.querySelectorAll('rect')[0].getAttribute('height')).toBe('0');
    });
    it('animates progressively and cancels the running animation when toggled again', () => {
      const start = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const card = render({ type: 'bar', labels: ['A', 'B'], data: [100, 200] });
      const bar = card.querySelectorAll('rect')[0];
      const full = Number(bar.getAttribute('height'));
      legend(card)[0].click();
      flushFrames();
      expect(bar.getAttribute('height')).toBe('0');
      legend(card)[0].click();
      expect(frames.size).toBe(1);
      stepFrame(1020);
      const mid = Number(bar.getAttribute('height'));
      expect(mid).toBeLessThan(full);
      expect(mid).toBeGreaterThan(0);
      legend(card)[0].click();
      expect(frames.size).toBe(1);
      legend(card)[0].click();
      start.mockReturnValue(5000);
      flushFrames();
      expect(Number(bar.getAttribute('height'))).toBeCloseTo(full);
    });
    it('keeps negative value labels below their bars during updates', () => {
      const card = render({ type: 'bar', labels: ['A', 'B'], data: [-500, 500] });
      const negLabel = Array.from(card.querySelectorAll('svg > text')).filter(t => t.textContent === '-500').at(-1)!;
      const bar = card.querySelectorAll('rect')[0];
      const expected = Number(bar.getAttribute('y')) + Number(bar.getAttribute('height')) + 12;
      expect(Number(negLabel.getAttribute('y'))).toBeCloseTo(expected);
      legend(card)[1].click();
      flushFrames();
      expect(Number(negLabel.getAttribute('y'))).toBeCloseTo(expected);
    });
  });

  describe('entrance animation', () => {
    let trigger: (entries: Array<{ isIntersecting: boolean }>) => void;
    const disconnect = vi.fn();
    beforeEach(() => {
      disconnect.mockReset();
      vi.stubGlobal('IntersectionObserver', class { constructor(cb: any) { trigger = cb; } observe() { return undefined; } disconnect = disconnect; });
    });
    it.each([
      ['bar', { type: 'bar', labels: ['A', 'B'], data: [100, 200] }, 'rect', 'height'],
      ['pie', { type: 'pie', labels: ['A', 'B'], data: [100, 200] }, 'path', 'd'],
    ])('reveals a %s once visible, only once', (_n, spec, selector, attribute) => {
      const card = render(spec);
      const before = card.querySelector(selector)!.getAttribute(attribute);
      trigger([{ isIntersecting: false }]);
      expect(card.classList.contains('chart-in-view')).toBe(false);
      trigger([{ isIntersecting: true }]);
      trigger([{ isIntersecting: true }]);
      expect(card.classList.contains('chart-in-view')).toBe(true);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(1);
      flushFrames();
      expect(card.querySelector(selector)!.getAttribute(attribute)).toBe(before);
    });
    it('does nothing extra for line charts or unsupported types', () => {
      const line = render({ type: 'line', labels: ['A', 'B'], data: [1, 2] });
      trigger([{ isIntersecting: true }]);
      expect(line.classList.contains('chart-in-view')).toBe(true);
      expect(frames.size).toBe(0);
      const radar = render({ type: 'radar', labels: ['A'], data: [1] });
      trigger([{ isIntersecting: true }]);
      expect(radar.classList.contains('chart-in-view')).toBe(true);
    });
  });

  describe('lines', () => {
    const twoSeries = { type: 'line', labels: ['A', 'B'], datasets: [{ label: 'One', data: [1, 2] }, { data: [3, -4] }] };
    it('shows and clears the hover guide with series fallback names', () => {
      const card = render(twoSeries);
      const circles = card.querySelectorAll<SVGCircleElement>('circle');
      hover(circles[2], 'mouseenter');
      expect(circles[2].getAttribute('r')).toBe('6');
      expect(tooltipOf(card).textContent).toContain('Series 2: 3');
      hover(circles[0], 'mousemove');
      expect(tooltipOf(card).textContent).toContain('One: 1');
      hover(circles[3], 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Series 2: -4');
      hover(circles[2], 'mouseleave');
      expect(circles[2].getAttribute('r')).toBe('3.5');
      expect(tooltipOf(card).style.display).toBe('none');
    });
    it('fades a series with animation', () => {
      const card = render(twoSeries);
      const group = card.querySelector<SVGGElement>('svg g')!;
      legend(card)[0].click();
      expect(group.style.opacity).toBe('0');
      expect(group.style.pointerEvents).toBe('none');
      expect(group.isConnected || group.parentElement !== null).toBe(true);
      legend(card)[0].click();
      expect(group.style.opacity).toBe('1');
      expect(group.style.transform).toContain('translateY(0)');
    });
    it('hides a line series under reduced motion without throwing', () => {
      reduced = true;
      const svg = render(twoSeries).querySelector('svg') as any;
      expect(() => svg.__updateValues(new Set([0]), true)).not.toThrow();
    });
    it('removes a line series under reduced motion and can restore it', () => {
      reduced = true;
      const card = render(twoSeries);
      const svg = card.querySelector('svg') as any;
      expect(card.querySelectorAll('svg g')).toHaveLength(2);
      svg.__updateValues(new Set([0]), true);
      expect(card.querySelectorAll('svg g')).toHaveLength(1);
      svg.__updateValues(new Set(), true);
      expect(card.querySelectorAll('svg g')).toHaveLength(2);
    });
    it('centres a single point and skips empty series', () => {
      const card = render({ type: 'line', labels: ['Only'], datasets: [{ label: 'none', data: [] }, { label: 'one', data: [0] }] });
      expect(card.querySelectorAll('circle')).toHaveLength(1);
      expect(card.querySelector('circle')!.getAttribute('cx')).toBe(String(50 + (500 - 50 - 30) / 2));
    });
  });

  describe('pie and doughnut', () => {
    const slices = (card: Element) => Array.from(card.querySelectorAll<SVGPathElement>('svg path'));
    it('updates the doughnut centre on hover and restores it', () => {
      const card = render({ type: 'doughnut', labels: ['A', 'B'], data: [75, 25] });
      const centre = () => Array.from(card.querySelectorAll('.chart-center-group text')).map(t => t.textContent);
      expect(centre()).toEqual(['100', 'Total']);
      const [a, b] = slices(card);
      hover(a, 'mouseenter');
      expect(centre()).toEqual(['75', 'A (75.0%)']);
      expect(a.style.filter).toContain('brightness');
      expect(b.style.opacity).toBe('0.4');
      expect(a.style.transform).toContain('translate(');
      hover(b, 'mousemove');
      expect(tooltipOf(card).textContent).toContain('Share: 25.0%');
      hover(a, 'mouseleave');
      expect(centre()).toEqual(['100', 'Total']);
      expect(a.style.transform).toBe('none');
    });
    it('hover works on a plain pie and names unlabelled slices', () => {
      const card = render({ type: 'pie', labels: [''], data: [1, 2] });
      const [, second] = slices(card);
      hover(second, 'mouseenter');
      expect(tooltipOf(card).textContent).toContain('Item 2');
      hover(second, 'mouseleave');
      expect(second.style.opacity).toBe('1');
    });
    it('blanks hidden slices and recalculates shares with reduced motion', () => {
      reduced = true;
      const card = render({ type: 'pie', labels: ['A', 'B'], data: [1, 3] });
      const [a, b] = slices(card);
      legend(card)[0].click();
      expect(a.getAttribute('d')).toBe('');
      expect(a.style.pointerEvents).toBe('none');
      hover(b, 'mouseenter');
      expect(tooltipOf(card).textContent).toContain('Share: 100.0%');
      legend(card)[1].click();
      expect(b.getAttribute('d')).toBe('');
      expect(b.style.opacity).toBe('0');
      legend(card)[0].click();
      expect(a.getAttribute('d')).not.toBe('');
    });
    it('animates to the final shares and cancels overlapping toggles', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(0);
      const card = render({ type: 'doughnut', labels: ['A', 'B'], data: [1, 3] });
      const [a] = slices(card);
      legend(card)[0].click();
      stepFrame(20);
      expect(a.getAttribute('d')).not.toBe('');
      legend(card)[0].click();
      expect(frames.size).toBe(1);
      now.mockReturnValue(1000);
      flushFrames();
      expect(a.getAttribute('d')).toMatch(/^M /);
      expect(card.querySelector('.chart-center-group text')!.textContent).toBe('4');
    });
    it('finishes immediately when reduced motion turns on mid-animation', () => {
      const card = render({ type: 'pie', labels: ['A', 'B'], data: [1, 3] });
      legend(card)[0].click();
      reduced = true;
      flushFrames(0);
      expect(slices(card)[0].getAttribute('d')).toBe('');
    });
    it('draws a single full slice without a degenerate arc', () => {
      const card = render({ type: 'doughnut', labels: ['Only', 'Zero'], data: [5, 0] });
      expect(slices(card)[0].getAttribute('d')).toMatch(/ 0 1 1 /);
      expect(slices(card)[1].getAttribute('d')).toBe('');
    });
    it('shows zero total for all-zero data', () => {
      const card = render({ type: 'doughnut', labels: ['Z'], data: [0] });
      expect(card.querySelector('.chart-center-group text')!.textContent).toBe('0');
      expect(slices(card)[0].style.opacity).toBe('0');
    });
  });

  describe('carbonEase', () => {
    it.each([[-1, 0], [0, 0], [1, 1], [2, 1]])('clamps %d to %d', (input, output) => {
      expect(carbonEase(input)).toBe(output);
    });
    it('is monotonic through the curve', () => {
      expect(carbonEase(0.25)).toBeLessThan(carbonEase(0.75));
    });
  });
});
