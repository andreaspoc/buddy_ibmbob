// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../../app/dashboard_standard.js'), 'utf8');
type Row = Record<string, unknown>;
type Dash = {
  update: (id: string) => void;
  COLORS: string[]; chart: (id: string, config: unknown) => FakeChart | null; replay: (id: string) => void;
  legend: (id: string, chart: FakeChart | null, values?: unknown[]) => void; escapeHtml: (value: unknown) => string; carbonEasing: (t: number) => number;
  table: (options: Row) => { render: () => void } | null;
};
type FakeChart = { options: { animation?: Row }; canvas: HTMLCanvasElement; config: { type: string }; data: { labels: string[]; datasets: Row[] }; reset: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; toggleDataVisibility: ReturnType<typeof vi.fn>; setDatasetVisibility: ReturnType<typeof vi.fn>; isDatasetVisible: ReturnType<typeof vi.fn> };

function fakeChartLibrary() {
  class Chart {
    static defaults = { font: {}, plugins: { tooltip: {} }, transitions: {} } as Row;
    static helpers = { easingEffects: {} as Row };
    static overrides = { doughnut: {}, bar: {} } as Record<string, { animation?: { delay?: (context: Row) => number; animateScale?: boolean } }>;
    canvas; config; data; options: Row = {}; reset = vi.fn(); update = vi.fn(); resize = vi.fn(); destroy = vi.fn();
    toggleDataVisibility = vi.fn(); setDatasetVisibility = vi.fn(); isDatasetVisible = vi.fn(() => true);
    constructor(canvas: HTMLCanvasElement, config: { data: FakeChart['data'] }) { this.canvas = canvas; this.config = config; this.data = config.data; }
  }
  return Chart;
}

function load(html: string, withChart = true, reducedMotion = false): Dash {
  document.body.innerHTML = html;
  delete (window as unknown as Row).BobDashboard;
  (window as unknown as Row).Chart = withChart ? fakeChartLibrary() : undefined;
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  new Function(source)();
  return (window as unknown as { BobDashboard: Dash }).BobDashboard;
}

const doughnut = { type: 'doughnut', data: { labels: ['A', '<B>'], datasets: [{ data: [1, 2], backgroundColor: ['#111', '#222'] }] } };
const visible = (chart: FakeChart | null) => { chart!.canvas.getClientRects = () => [{}] as unknown as DOMRectList; };

describe('dashboard standard runtime', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('escapes every HTML character and tolerates empty values', () => {
    const dash = load('');
    expect(dash.escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(dash.escapeHtml(null)).toBe('');
  });

  it('does not install twice', () => {
    const dash = load('');
    new Function(source)();
    expect((window as unknown as { BobDashboard: Dash }).BobDashboard).toBe(dash);
  });

  it('follows the Carbon curve from start to end', () => {
    const { carbonEasing } = load('');
    expect(carbonEasing(0)).toBeCloseTo(0, 3);
    expect(carbonEasing(1)).toBeCloseTo(1, 3);
    expect(carbonEasing(.5)).toBeGreaterThan(.5);
    expect(carbonEasing(.75)).toBeGreaterThan(carbonEasing(.25));
  });

  it('creates charts with the standard motion and replays without destroying them', () => {
    const dash = load('<canvas id="c"></canvas>');
    const chart = dash.chart('c', doughnut)!;
    const library = (window as unknown as { Chart: { defaults: Row; helpers: { easingEffects: Row } } }).Chart;
    expect(library.defaults.animation).toEqual({ duration: 1400, easing: 'carbon' });
    expect(library.helpers.easingEffects.carbon).toBe(dash.carbonEasing);
    document.body.insertAdjacentHTML('beforeend', '<button class="chart-replay-btn" data-replay="c"><span id="inner">Replay</span></button>');
    document.getElementById('inner')!.click();
    expect(chart.reset).toHaveBeenCalledTimes(1);
    expect(chart.update).toHaveBeenCalledTimes(1);
    expect(chart.destroy).not.toHaveBeenCalled();
    dash.replay('unknown');
    expect(chart.reset).toHaveBeenCalledTimes(1);
  });

  it('turns chart animation off for reduced motion and replaces a chart on the same canvas', () => {
    const dash = load('<canvas id="c"></canvas>', true, true);
    const first = dash.chart('c', doughnut)!;
    const library = (window as unknown as { Chart: { defaults: { animation: { duration: number } } } }).Chart;
    expect(library.defaults.animation.duration).toBe(0);
    dash.chart('c', doughnut);
    expect(first.destroy).toHaveBeenCalledTimes(1);
  });

  it('uses 1400ms for entrance and replay, and 700ms for data changes, on the Carbon curve', () => {
    const dash = load('<canvas id="c"></canvas><div id="l"></div>');
    const chart = dash.chart('c', doughnut)!;
    dash.update('c');
    expect(chart.options.animation).toEqual({ duration: 700, easing: 'carbon' });
    expect(chart.reset).not.toHaveBeenCalled();
    expect(chart.update).toHaveBeenCalledTimes(1);
    dash.replay('c');
    expect(chart.options.animation).toEqual({ duration: 1400, easing: 'carbon' });
    dash.legend('l', chart);
    document.querySelector<HTMLElement>('.legend-item')!.click();
    expect(chart.options.animation!.duration).toBe(700);
    dash.update('unknown');
    expect(chart.update).toHaveBeenCalledTimes(3);
  });

  it('disables chart timing for reduced motion', () => {
    const dash = load('<canvas id="c"></canvas>', true, true);
    const chart = dash.chart('c', doughnut)!;
    dash.update('c');
    expect(chart.options.animation!.duration).toBe(0);
  });

  it('staggers bars and scales doughnuts as they enter', () => {
    load('<canvas id="c"></canvas>').chart('c', doughnut);
    const { overrides } = (window as unknown as { Chart: { overrides: Record<string, { animation: { delay: (context: Row) => number; animateScale: boolean; animateRotate: boolean } }> } }).Chart;
    expect(overrides.doughnut.animation).toMatchObject({ animateRotate: true, animateScale: true });
    expect(overrides.bar.animation.delay({ type: 'data', mode: 'default', dataIndex: 2 })).toBe(160);
    expect(overrides.bar.animation.delay({ type: 'data', mode: 'active', dataIndex: 2 })).toBe(0);
    expect(overrides.bar.animation.delay({ type: 'scale' })).toBe(0);
  });

  it('does not stagger bars for reduced motion', () => {
    load('<canvas id="c"></canvas>', true, true).chart('c', doughnut);
    const { overrides } = (window as unknown as { Chart: { overrides: Record<string, { animation: { delay: (context: Row) => number } }> } }).Chart;
    expect(overrides.bar.animation.delay({ type: 'data', mode: 'default', dataIndex: 2 })).toBe(0);
  });

  it('grows visible progress bars on load and when their tab opens', () => {
    const animate = vi.fn();
    const page = '<button class="nav-tab" data-panel="two"></button><section id="panel-two"><div id="seen" class="prog-bar-fill"></div><div id="hidden" class="prog-bar-fill"></div></section>';
    const proto = HTMLElement.prototype as unknown as { animate: typeof animate; getClientRects: () => unknown[] };
    const rects = proto.getClientRects;
    proto.animate = animate;
    proto.getClientRects = function (this: HTMLElement) { return this.id === 'hidden' ? [] : [{}]; };
    load(page);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toEqual({ duration: 1400, easing: 'cubic-bezier(.2,0,.38,.9)' });
    document.querySelector<HTMLElement>('.nav-tab')!.click();
    expect(animate).toHaveBeenCalledTimes(2);
    proto.getClientRects = rects;
  });

  it('leaves progress bars still for reduced motion', () => {
    const animate = vi.fn();
    (HTMLElement.prototype as unknown as { animate: typeof animate }).animate = animate;
    load('<div class="prog-bar-fill"></div>', true, true);
    expect(animate).not.toHaveBeenCalled();
  });

  it('ignores a missing canvas', () => {
    expect(load('').chart('missing', doughnut)).toBeNull();
  });

  it('shows one visible error and keeps the page when the chart library is missing', () => {
    const dash = load('<main><canvas id="c"></canvas><canvas id="d"></canvas></main>', false);
    expect(dash.chart('c', doughnut)).toBeNull();
    expect(dash.chart('d', doughnut)).toBeNull();
    const errors = document.querySelectorAll('.chart-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].getAttribute('role')).toBe('alert');
  });

  describe('tabs', () => {
    const page = `<button class="nav-tab active" data-panel="one"></button><button class="nav-tab" data-panel="two"></button><button class="nav-tab" data-panel="ghost"></button>
      <section id="panel-one" class="panel active"></section><section id="panel-two" class="panel"><canvas id="c"></canvas></section>`;
    const tab = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`)!;
    const press = (element: HTMLElement, key: string) => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    it('switches panel, updates state, replays its charts and announces activation', () => {
      const dash = load(page);
      const chart = dash.chart('c', doughnut)!;
      visible(chart);
      const activated = vi.fn();
      document.addEventListener('bob:chart-activate', activated, { once: true });
      tab('two').click();
      expect(tab('two').getAttribute('aria-selected')).toBe('true');
      expect(tab('one').getAttribute('aria-selected')).toBe('false');
      expect(tab('one').tabIndex).toBe(-1);
      expect(document.getElementById('panel-two')!.classList.contains('active')).toBe(true);
      expect(document.getElementById('panel-one')!.classList.contains('active')).toBe(false);
      expect(chart.resize).toHaveBeenCalled();
      expect(chart.reset).toHaveBeenCalledTimes(1);
      expect(activated).toHaveBeenCalledTimes(1);
    });

    it('does not replay a chart that is not on screen', () => {
      const dash = load(page);
      const chart = dash.chart('c', doughnut)!;
      chart.canvas.getClientRects = () => [] as unknown as DOMRectList;
      tab('two').click();
      expect(chart.reset).not.toHaveBeenCalled();
    });

    it('moves with the arrow, Home and End keys and wraps around', () => {
      load(page);
      press(tab('one'), 'ArrowRight');
      expect(tab('two').classList.contains('active')).toBe(true);
      press(tab('two'), 'Home');
      expect(tab('one').classList.contains('active')).toBe(true);
      press(tab('one'), 'ArrowLeft');
      expect(tab('ghost').classList.contains('active')).toBe(true);
      press(tab('ghost'), 'End');
      expect(tab('ghost').classList.contains('active')).toBe(true);
      press(tab('ghost'), 'x');
      expect(tab('ghost').classList.contains('active')).toBe(true);
    });

    it('sets up tabs after the page finishes loading', () => {
      load('');
      document.body.innerHTML = page;
      Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
      delete (window as unknown as Row).BobDashboard;
      new Function(source)();
      delete (document as unknown as Row).readyState;
      document.dispatchEvent(new Event('DOMContentLoaded'));
      tab('two').click();
      expect(tab('two').classList.contains('active')).toBe(true);
    });
  });

  describe('legends', () => {
    it('toggles a doughnut slice and escapes its label', () => {
      const dash = load('<canvas id="c"></canvas><div id="l"></div>');
      const chart = dash.chart('c', doughnut)!;
      dash.legend('l', chart, [1, 2]);
      const items = document.querySelectorAll<HTMLElement>('.legend-item');
      expect(items[1].textContent).toContain('<B>');
      expect(items[1].querySelector('b')).toBeNull();
      expect(items[1].querySelector('strong')!.textContent).toBe('(2)');
      items[1].click();
      expect(chart.toggleDataVisibility).toHaveBeenCalledWith(1);
      expect(items[1].getAttribute('aria-pressed')).toBe('false');
      items[1].click();
      expect(items[1].getAttribute('aria-pressed')).toBe('true');
    });

    it('toggles a dataset for other chart types and omits missing counts', () => {
      const dash = load('<canvas id="c"></canvas><div id="l"></div>');
      const chart = dash.chart('c', { type: 'line', data: { labels: [], datasets: [{ label: 'Series', borderColor: '#333' }, { label: 'Other', backgroundColor: '#444' }] } })!;
      dash.legend('l', chart);
      const item = document.querySelector<HTMLElement>('.legend-item')!;
      expect(item.querySelector('strong')).toBeNull();
      item.click();
      expect(chart.setDatasetVisibility).toHaveBeenCalledWith(0, false);
      document.getElementById('l')!.click();
      expect(chart.setDatasetVisibility).toHaveBeenCalledTimes(1);
    });

    it('ignores a missing element or chart', () => {
      const dash = load('<div id="l"></div>');
      dash.legend('missing', null);
      dash.legend('l', null);
      expect(document.getElementById('l')!.innerHTML).toBe('');
    });
  });

  describe('tables', () => {
    const page = `<input id="q"><select id="f"><option value=""></option><option value="X">X</option></select><button id="r"></button><span id="n"></span>
      <table><thead><tr><th id="h1" data-sort="name"></th><th id="h2" data-sort="size"></th></tr></thead><tbody id="b"></tbody></table>`;
    const rows = [{ name: 'item 10', size: 2, kind: 'X' }, { name: 'item 2', size: 10, kind: 'Y' }, { name: '<script>', size: 1, kind: 'X' }];
    const options = { rows, body: 'b', search: 'q', count: 'n', reset: 'r', filters: [{ id: 'f', key: 'kind' }, { id: 'absent', key: 'kind' }], columns: [{ key: 'name' }, { key: 'size', render: (row: Row) => `<b>${row.size}</b>` }] };
    const first = () => document.querySelector('#b td')!.textContent;
    const input = (id: string, value: string, event: string) => { const el = document.getElementById(id) as HTMLInputElement; el.value = value; el.dispatchEvent(new Event(event)); };

    it('escapes values by default and uses a custom renderer when given', () => {
      load(page).table(options);
      expect(document.querySelector('#b script')).toBeNull();
      expect(document.querySelector('#b').textContent).toContain('<script>');
      expect(document.querySelector('#b b')!.textContent).toBe('2');
      expect(document.getElementById('n')!.textContent).toBe('Showing 3 of 3');
    });

    it('searches and filters together, explains an empty result and resets', () => {
      load(page).table(options);
      input('q', 'ITEM', 'input');
      expect(document.getElementById('n')!.textContent).toBe('Showing 2 of 3');
      input('f', 'X', 'change');
      expect(document.getElementById('n')!.textContent).toBe('Showing 1 of 3');
      input('q', 'nothing', 'input');
      expect(document.querySelector('.no-results')!.textContent).toBe('No matching records.');
      expect(document.querySelector('.no-results')!.getAttribute('colspan')).toBe('2');
      document.getElementById('r')!.click();
      expect((document.getElementById('q') as HTMLInputElement).value).toBe('');
      expect((document.getElementById('f') as HTMLSelectElement).value).toBe('');
      expect(document.getElementById('n')!.textContent).toBe('Showing 3 of 3');
    });

    it('sorts numbers and natural text, flips direction and supports the keyboard', () => {
      load(page).table(options);
      const name = document.getElementById('h1')!;
      const size = document.getElementById('h2')!;
      size.click();
      expect(first()).toBe('<script>');
      expect(size.getAttribute('aria-sort')).toBe('ascending');
      size.click();
      expect(first()).toBe('item 2');
      expect(size.getAttribute('aria-sort')).toBe('descending');
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      expect(size.hasAttribute('aria-sort')).toBe(false);
      expect(name.getAttribute('aria-sort')).toBe('ascending');
      expect(document.querySelectorAll('#b tr')[1].querySelector('td')!.textContent).toBe('item 2');
      name.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }));
      expect(name.getAttribute('aria-sort')).toBe('descending');
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      expect(name.getAttribute('aria-sort')).toBe('descending');
      document.getElementById('r')!.click();
      expect(name.hasAttribute('aria-sort')).toBe(false);
    });

    it('works with only the required options and returns nothing without a body', () => {
      const dash = load('<table><tbody id="b"></tbody></table>');
      expect(dash.table({ rows: [], body: 'missing', columns: [] })).toBeNull();
      expect(dash.table({ rows: [{ a: null }], body: 'b', columns: [{ key: 'a' }] })).not.toBeNull();
      expect(document.querySelector('#b td')!.textContent).toBe('');
    });
  });
});
