import { afterEach, expect, test, vi } from 'vitest';
import * as model from '../../../frontend/bobdeck-common.js';
import { renderSlideToSvg as modernSlide } from '../../src/lib/bobdeck.js';
import { renderSlideToSvg as legacySlide } from '../../../frontend/bobdeck.js';

class SvgFixture {
  attrs: Record<string, string> = {};
  children: SvgFixture[] = [];
  textContent = '';
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  append(...nodes: SvgFixture[]) { this.children.push(...nodes); }
}
function svgDocument() {
  vi.stubGlobal('document', { createElementNS: (_namespace: string, tag: string) => new SvgFixture(tag) });
}
afterEach(() => vi.unstubAllGlobals());

test('normalizes supported colors and rejects markup-like input', () => {
  expect(model.normalizeHex('#abc')).toBe('AABBCC');
  expect(model.normalizeHex({ color: '#abcdef80' })).toBe('ABCDEF');
  expect(model.normalizeHex('rgb(255, 0, 18)')).toBe('FF0012');
  expect(model.normalizeHex('<img>', '#123456')).toBe('123456');
  expect(model.normalizeHex(null, '#123456')).toBe('123456');
  expect(model.toCssColor('#abc')).toBe('#AABBCC');
});

test('reads element aliases, numeric defaults and themed model values', () => {
  const element = { width: 3, height: 2, content: 'Fixture', style: { fontSize: 18, fontWeight: 'bold', align: 'center', color: '#abc', fill: '#fff', stroke: '#123', lineWidth: 2 } };
  expect([model.xOf(element), model.yOf(element), model.wOf(element), model.hOf(element)]).toEqual([0, 0, 3, 2]);
  expect(model.textOf(element)).toBe('Fixture');
  expect(model.fontSizeOf(element)).toBe(18);
  expect(model.boldOf(element)).toBe(true);
  expect(model.alignOf(element)).toBe('center');
  expect(model.colorOf(element)).toBe('#abc');
  expect(model.fillOf(element)).toBe('#fff');
  expect(model.strokeOf(element)).toBe('#123');
  expect(model.lineWidthOf(element)).toBe(2);
  expect(model.num('bad', 7)).toBe(7);
  expect(model.clamp(-3, 0, 1)).toBe(0);
  expect(model.slideBackground({}, {})).toBe('FFFFFF');
  expect(model.themeForeground({ colors: { text: '#123456' } })).toBe('#123456');
  expect(model.themeAccent({ accent: '#abc' })).toBe('#abc');
});

test('normalizes series, categories, missing numeric values and single-series data', () => {
  expect(model.chartSeries({ categories: [1, 2], series: [{ values: [3, 'bad'] }] }))
    .toEqual([{ name: 'Series 1', labels: ['1', '2'], values: [3, 0], color: undefined }]);
  expect(model.chartSeries({ data: [{ label: 'A', value: '4' }] })[0].values).toEqual([4]);
  expect(model.chartSeries({})[0].values).toEqual([]);
});

test('renders every shared shape using SVG attributes', () => {
  svgDocument();
  for (const shape of ['rectangle', 'roundedRectangle', 'roundRect', 'circle', 'ellipse', 'triangle', 'diamond', 'chevron', 'hexagon']) {
    const result = model.renderShapeSvg({ shape, x: 1, y: 1, w: 2, h: 3, fill: '#abc' }) as SvgFixture;
    expect(['rect', 'ellipse', 'polygon']).toContain(result.tag);
    expect(result.attrs.fill).toBe('#AABBCC');
  }
  expect(model.isEmojiOrIconBadge('📊')).toBe(true);
  expect(model.isEmojiOrIconBadge('ordinary long title')).toBe(false);
  expect(model.isEmojiOrIconBadge('')).toBe(false);
});

test('both UIs retain SVG chart structures and labels across chart types', () => {
  svgDocument();
  for (const render of [modernSlide, legacySlide]) {
    for (const chartType of ['bar', 'line', 'pie', 'doughnut']) {
      const result = render({ elements: [{ type: 'chart', chartType, x: 1, y: 1, w: 6, h: 4, title: 'Fixture', data: [{ label: 'A', value: 3 }, { label: 'B', value: 2 }] }] }) as SvgFixture;
      const chart = result.children.find(child => child.tag === 'g');
      expect(chart).toBeDefined();
      expect(chart?.children.some(child => child.textContent === 'Fixture')).toBe(true);
      expect(chart?.children.some(child => child.tag === (chartType === 'line' ? 'polyline' : chartType === 'bar' ? 'rect' : 'path'))).toBe(true);
    }
  }
});
