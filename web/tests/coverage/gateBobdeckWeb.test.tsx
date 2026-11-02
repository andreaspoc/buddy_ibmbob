// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pptx = vi.hoisted(() => {
  const slides: any[] = [];
  class Fake {
    layout = ''; title = ''; author = '';
    ShapeType = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', diamond: 'diamond', chevron: 'chevron', hexagon: 'hexagon', pentagon: 'pentagon', line: 'line' };
    ChartType = { bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut' };
    static last: Fake;
    constructor() { Fake.last = this; slides.length = 0; }
    addSlide() { const slide = { background: null, texts: [] as any[], shapes: [] as any[], images: [] as any[], charts: [] as any[], tables: [] as any[], addText(t: string, o: any) { this.texts.push({ t, o }); }, addShape(k: string, o: any) { this.shapes.push({ k, o }); }, addImage(o: any) { this.images.push(o); }, addChart(k: string, s: any, o: any) { this.charts.push({ k, s, o }); }, addTable(r: any, o: any) { this.tables.push({ r, o }); } }; slides.push(slide); return slide; }
    write = vi.fn(async (o: unknown) => ({ blob: o }));
    writeFile = vi.fn(async (o: { fileName: string }) => o.fileName);
  }
  return { slides, Fake };
});
vi.mock('pptxgenjs', () => ({ default: pptx.Fake }));

import { buildDeckPptxBlob, buildHtmlDeckPptxBlob, exportDeckToPptx, renderSlideToSvg, resolveDeckLayout, themeFont } from '../../src/lib/bobdeck.js';

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ font: '', measureText: (text: string) => ({ width: text.length * 10 }), clearRect() {}, fillText() {} })) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,AA');
});
afterEach(() => { vi.restoreAllMocks(); });

const deck = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ slides: [{ elements }], ...extra });
const firstSlide = () => pptx.slides[0];

describe('themeFont', () => {
  it.each([
    [{ fonts: { body: 'Serif A' }, font: 'B' }, 'Serif A'],
    [{ font: 'B' }, 'B'],
    [undefined, 'IBM Plex Sans'],
  ])('resolves the deck font (%#)', (theme, expected) => {
    expect(themeFont(theme)).toBe(expected);
  });
});

describe('resolveDeckLayout', () => {
  it.each([[null], ['text'], [42]])('returns an empty deck for %j', input => {
    expect(resolveDeckLayout(input)).toEqual({ slides: [], theme: {}, title: 'Presentation' });
  });

  it('returns an empty deck for uncloneable input', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(resolveDeckLayout(cycle).slides).toEqual([]);
  });

  it('adds missing slides and elements, skipping junk entries', () => {
    expect(resolveDeckLayout({ title: 'T' }).slides).toEqual([]);
    const { slides } = resolveDeckLayout({ slides: [null, { id: 's' }, { elements: ['junk', null] }] });
    expect(slides[0]).toBeNull();
    expect(slides[1].elements).toEqual([]);
    expect(slides[2].elements).toEqual(['junk', null]);
  });

  it('clamps geometry into the slide using the alias the element already uses', () => {
    const { slides } = resolveDeckLayout(deck([{ x: 99, y: -1, w: 50, h: 0 }, { x: 1, y: 1, width: 2, height: 3 }]));
    const [clamped, aliased] = slides[0].elements;
    expect(clamped.w).toBeCloseTo(13.333, 2);
    expect(clamped.h).toBe(0.01);
    expect(clamped.y).toBe(0);
    expect(clamped.x).toBeCloseTo(0, 2);
    expect(aliased).toMatchObject({ width: 2, height: 3 });
    expect(aliased.w).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = deck([{ x: 99 }]);
    resolveDeckLayout(input);
    expect((input.slides[0].elements[0] as { x: number }).x).toBe(99);
  });
});

describe('renderSlideToSvg', () => {
  const svgOf = (elements: unknown[], theme?: Record<string, unknown>) => renderSlideToSvg({ elements }, theme) as SVGSVGElement;
  const texts = (root: Element) => [...root.querySelectorAll('tspan')].map(item => item.textContent);

  it('draws only a background for a missing slide, using a white default', () => {
    const svg = renderSlideToSvg(undefined) as SVGSVGElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 1333 750');
    expect(svg.children).toHaveLength(1);
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#FFFFFF');
  });

  it('ignores junk elements and unknown types', () => {
    expect(svgOf([null, 'x', { type: 'video' }]).children).toHaveLength(1);
  });

  it('keeps rendering after one element throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = Object.defineProperty({ type: 'text' }, 'x', { get() { throw new Error('boom'); }, enumerable: true });
    const svg = svgOf([bad, { type: 'line', x: 1, y: 1, w: 1, h: 0 }]);
    expect(warn).toHaveBeenCalledOnce();
    expect(svg.querySelector('line')).not.toBeNull();
  });

  describe('text', () => {
    const box = (over: Record<string, unknown>) => svgOf([{ type: 'text', id: 'tb', x: 1, y: 1, w: 5, h: 2, text: 'Hello', fontSize: 72, ...over }]);
    const textNode = (svg: Element) => svg.querySelector('text')!;

    it.each([
      ['center', 'middle', '350'],
      ['right', 'end', '600'],
      ['left', 'start', '100'],
    ])('aligns %s', (align, anchor, x) => {
      const svg = box({ align });
      expect(textNode(svg).getAttribute('text-anchor')).toBe(anchor);
      expect(textNode(svg).getAttribute('x')).toBe(x);
    });

    it.each([
      ['top', 100],
      ['bottom', 200],
      ['mid', 150],
    ])('positions vertically with valign %s', (valign, top) => {
      const svg = box({ style: { valign }, fontSize: 72, h: 2 });
      expect(Number(textNode(svg).getAttribute('y'))).toBeCloseTo(top + 80, 0);
    });

    it('applies italic, weight and family from style', () => {
      const svg = box({ bold: true, style: { fontStyle: 'ITALIC', fontFamily: 'Mono', lineHeight: 2 } });
      const node = textNode(svg);
      expect(node.getAttribute('font-style')).toBe('italic');
      expect(node.getAttribute('font-weight')).toBe('700');
      expect(node.getAttribute('font-family')).toBe('Mono');
    });

    it('defaults to the theme font and normal style', () => {
      const svg = box({});
      expect(textNode(svg).getAttribute('font-family')).toBe('IBM Plex Sans');
      expect(textNode(svg).getAttribute('font-style')).toBe('normal');
      expect(svg.querySelector('g')?.getAttribute('data-element-index')).toBe('0');
    });

    it('wraps words to the box width and keeps paragraphs apart', () => {
      const svg = box({ w: 0.4, text: 'aa bb cc\nnext' });
      expect(texts(svg)).toEqual(['aa', 'bb', 'cc', 'next']);
    });

    it('breaks a long unbroken token across lines', () => {
      const svg = box({ w: 0.3, text: 'abcdefgh' });
      expect(texts(svg).join('')).toBe('abcdefgh');
      expect(texts(svg).length).toBeGreaterThan(1);
    });

    it('uses a unique clip per text box', () => {
      const svg = svgOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
      const ids = [...svg.querySelectorAll('clipPath')].map(item => item.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  it('renders rect shapes and themed lines', () => {
    const svg = svgOf([{ type: 'rect', x: 1, y: 1, w: 1, h: 1, fill: '#112233' }, { type: 'shape', shape: 'ellipse', x: 2, y: 2, w: 1, h: 1 }, { type: 'line', x: 1, y: 2, w: 3, h: 4 }], { accent: '#ABCDEF' });
    expect(svg.querySelector('line')?.getAttribute('stroke')).toBe('#ABCDEF');
    expect(svg.querySelector('line')?.getAttribute('x2')).toBe('400');
    expect(svg.querySelector('ellipse')).not.toBeNull();
  });

  describe('tables', () => {
    it('draws cells with a highlighted header', () => {
      const svg = svgOf([{ type: 'table', x: 1, y: 1, w: 4, h: 2, header: true, rows: [['H1', 'H2'], ['a', null]], border: { color: '#010203' } }], { accent: '#ABCDEF', colors: { text: '#111111' } });
      const cells = [...svg.querySelectorAll('g > rect')];
      expect(cells).toHaveLength(4);
      expect(cells[0].getAttribute('fill')).toBe('#ABCDEF');
      expect(cells[3].getAttribute('fill')).toBe('#FFFFFF');
      expect(cells[0].getAttribute('stroke')).toBe('#010203');
      expect(texts(svg)).toEqual(['H1', 'H2', 'a', '']);
      expect(svg.querySelectorAll('text')[0].getAttribute('fill')).toBe('#FFFFFF');
      expect(svg.querySelectorAll('text')[2].getAttribute('fill')).toBe('#111111');
    });

    it('tolerates missing and malformed rows', () => {
      expect(svgOf([{ type: 'table' }]).querySelectorAll('g > rect')).toHaveLength(0);
      expect(texts(svgOf([{ type: 'table', x: 0, y: 0, w: 4, h: 2, rows: ['junk', ['ok']] }]))).toEqual(['ok']);
    });
  });

  describe('charts', () => {
    const chart = (over: Record<string, unknown>, theme?: Record<string, unknown>) => svgOf([{ type: 'chart', x: 1, y: 1, w: 5, h: 3, data: [{ label: 'A', value: 3 }, { label: 'B', value: 1 }], ...over }], theme);

    it('renders a pie with titled wedges and palette colours', () => {
      const svg = chart({ chartType: 'pie', title: 'Share', titleColor: '#222222' }, { chartPalette: ['#111111', '#222222'] });
      const wedges = [...svg.querySelectorAll('path')];
      expect(wedges.map(item => item.getAttribute('fill'))).toEqual(['#111111', '#222222']);
      expect(wedges[0].querySelector('title')?.textContent).toBe('A: 3');
      expect(wedges[0].getAttribute('d')).toContain(' 1 1 '); // the 75% wedge uses the large arc
      expect(wedges[1].getAttribute('d')).toContain(' 0 1 ');
      expect(svg.querySelector('text')?.textContent).toBe('Share');
    });

    it('adds a hole to a doughnut using the chart background', () => {
      const svg = chart({ chartType: 'doughnut', background: '#EEEEEE' });
      expect(svg.querySelector('circle')?.getAttribute('fill')).toBe('#EEEEEE');
    });

    it('treats negative pie values as zero-sized wedges without dividing by zero', () => {
      const svg = chart({ chartType: 'pie', data: [{ label: 'A', value: -1 }] });
      expect(svg.querySelector('path')?.getAttribute('d')).not.toContain('NaN');
    });

    it('names unlabelled wedges by position', () => {
      const svg = chart({ chartType: 'pie', series: [{ values: [1, 1] }] });
      expect(svg.querySelectorAll('path')).toHaveLength(2);
      expect(svg.querySelector('path title')?.textContent).toBe('Category 1: 1');
    });

    it('delegates bar charts to the shared cartesian renderer with a card', () => {
      const svg = chart({ border: { color: '#ABABAB' } });
      const card = svg.querySelectorAll('rect')[1];
      expect(card.getAttribute('stroke')).toBe('#ABABAB');
      expect(svg.querySelectorAll('rect').length).toBeGreaterThan(2);
    });

    it('uses the nested theme palette', () => {
      const svg = chart({ chartType: 'pie' }, { colors: { chartPalette: ['#0A0A0A'] } });
      expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#0A0A0A');
    });
  });
});

describe('PPTX export', () => {
  it.each([
    [null, 'No presentation data provided to export.'],
    [{ slides: [] }, 'Presentation contains no slides to export.'],
  ])('rejects unusable decks (%#)', async (input, message) => {
    await expect(buildDeckPptxBlob(input)).rejects.toThrow(message);
  });

  it('takes metadata over the title and uses a default author otherwise', async () => {
    await buildDeckPptxBlob(deck([], { metadata: { title: 'Meta', author: 'Me' }, title: 'Ignored' }));
    expect(pptx.Fake.last).toMatchObject({ layout: 'LAYOUT_WIDE', title: 'Meta', author: 'Me' });
    await buildDeckPptxBlob(deck([], { title: 'Plain' }));
    expect(pptx.Fake.last).toMatchObject({ title: 'Plain', author: 'Buddy Presentation Studio' });
    await buildDeckPptxBlob(deck([]));
    expect(pptx.Fake.last.title).toBe('Presentation');
  });

  it('returns the written blob as a blob output', async () => {
    await expect(buildDeckPptxBlob(deck([]))).resolves.toEqual({ blob: { outputType: 'blob' } });
  });

  it.each([
    ['report', 'report.pptx'],
    ['report.pptx', 'report.pptx'],
  ])('exports %s with the pptx extension', async (name, expected) => {
    await expect(exportDeckToPptx(deck([]), name)).resolves.toBe(expected);
  });

  it('defaults the export file name', async () => {
    await expect(exportDeckToPptx(deck([]))).resolves.toBe('presentation.pptx');
  });

  it('skips junk slides and elements, and survives element failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await buildDeckPptxBlob({ slides: [null, { elements: [null, { type: 'text', text: 'ok' }] }] });
    expect(pptx.slides).toHaveLength(1);
    expect(firstSlide().texts[0].t).toBe('ok');
    const addText = vi.spyOn(pptx.Fake.prototype, 'addSlide');
    addText.mockImplementationOnce(() => ({ background: null, addText() { throw new Error('bad'); }, addShape() {} }) as never);
    await buildDeckPptxBlob(deck([{ type: 'text', text: 'x' }]));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('maps text styles and theme defaults', async () => {
    await buildDeckPptxBlob(deck([
      { type: 'text', text: 'Styled', x: 1, y: 1, w: 2, h: 1, bold: true, align: 'center', fontSize: 30, color: '#123456', style: { fontStyle: 'italic', fontFamily: 'Mono', valign: 'top' } },
      { type: 'text', text: 'Plain', x: 1, y: 2, w: 2, h: 1 },
    ], { theme: { font: 'ThemeFont', colors: { text: '#ABCDEF', background: '#000000' } } }));
    const [styled, plain] = firstSlide().texts;
    expect(styled.o).toMatchObject({ fontFace: 'Mono', fontSize: 30, bold: true, italic: true, color: '123456', align: 'center', valign: 'top' });
    expect(plain.o).toMatchObject({ fontFace: 'ThemeFont', italic: false, color: 'ABCDEF', valign: 'mid' });
  });

  it('rasterises icon badges centred in their box', async () => {
    await buildDeckPptxBlob(deck([{ type: 'text', text: '🚀', x: 1, y: 1, w: 4, h: 2 }]));
    const [image] = firstSlide().images;
    expect(firstSlide().texts).toHaveLength(0);
    expect(image).toMatchObject({ x: 2, y: 1, w: 2, h: 2 });
    expect(image.data).toContain('data:image');
  });

  it('falls back to text when an icon cannot be rasterised', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    await buildDeckPptxBlob(deck([{ type: 'text', text: '🚀', x: 1, y: 1, w: 4, h: 2 }]));
    expect(firstSlide().images).toHaveLength(0);
    expect(firstSlide().texts[0].t).toBe('🚀');
  });

  it.each([
    ['rectangle', 'rect'], ['roundedRectangle', 'roundRect'], ['circle', 'ellipse'], ['triangle', 'triangle'],
    ['diamond', 'diamond'], ['chevron', 'chevron'], ['hexagon', 'hexagon'], ['pentagon', 'pentagon'], ['blob', 'rect'],
  ])('maps the %s shape', async (shape, expected) => {
    await buildDeckPptxBlob(deck([{ type: 'shape', shape, x: 1, y: 1, w: 1, h: 1, fill: '#112233', stroke: '#445566', transparency: 30 }]));
    expect(firstSlide().shapes[0].k).toBe(expected);
    expect(firstSlide().shapes[0].o.fill).toEqual({ color: '112233', transparency: 30 });
    expect(firstSlide().shapes[0].o.line.color).toBe('445566');
  });

  it('uses the fill as the outline of a plain rect', async () => {
    await buildDeckPptxBlob(deck([{ type: 'rect', x: 1, y: 1, w: 1, h: 1, fill: '#112233' }]));
    expect(firstSlide().shapes[0].o.line.color).toBe('112233');
    expect(firstSlide().shapes[0].o.fill.transparency).toBe(0);
  });

  it('keeps arrowheads on lines', async () => {
    await buildDeckPptxBlob(deck([{ type: 'line', x: 1, y: 1, w: 2, h: 0, color: '#123456', beginArrowType: 'oval', endArrowType: 'triangle' }]));
    expect(firstSlide().shapes[0].k).toBe('line');
    expect(firstSlide().shapes[0].o.line).toMatchObject({ color: '123456', beginArrowType: 'oval', endArrowType: 'triangle' });
  });

  describe('charts', () => {
    const chartOptions = async (over: Record<string, unknown>, theme: Record<string, unknown> = {}) => {
      await buildDeckPptxBlob(deck([{ type: 'chart', x: 1, y: 1, w: 3, h: 3, data: [{ label: 'A', value: 1 }], ...over }], { theme }));
      return firstSlide().charts[0];
    };

    it.each([
      ['bar', 'bar'], ['column', 'bar'], ['line', 'line'], ['pie', 'pie'], ['doughnut', 'doughnut'], ['mystery', 'bar'],
    ])('maps the %s chart type', async (chartType, expected) => {
      expect((await chartOptions({ chartType })).k).toBe(expected);
    });

    it('shows a legend and percentages for categorical charts, using the palette', async () => {
      const { o } = await chartOptions({ chartType: 'pie', title: 'Split', showValues: true, axisColor: '#333333' }, { chartPalette: ['#010101', '#020202'] });
      expect(o).toMatchObject({ showLegend: true, showPercent: true, showTitle: true, title: 'Split', showValue: true, chartColors: ['010101', '020202'], catAxisLabelColor: '333333', valAxisLabelColor: '333333', legendPos: 'b' });
    });

    it('hides the legend for one series and honours explicit settings', async () => {
      expect((await chartOptions({ chartType: 'bar' })).o).toMatchObject({ showLegend: false, showPercent: false, showTitle: false, showValue: false, title: '' });
      expect((await chartOptions({ chartType: 'bar', showLegend: true, legendPosition: 'r' })).o).toMatchObject({ showLegend: true, legendPos: 'r' });
    });

    it('uses a legend and per-series colours for multiple series', async () => {
      const series = [{ name: 'One', labels: ['A'], values: [1], color: '#0A0A0A' }, { labels: ['A'], values: [2] }];
      const chart = await chartOptions({ chartType: 'bar', series, data: undefined }, { colors: { chartPalette: ['#111111', '#222222'] } });
      expect(chart.s.map((item: { name: string }) => item.name)).toEqual(['One', 'Series 2']);
      expect(chart.o.showLegend).toBe(true);
      expect(chart.o.chartColors).toEqual(['0A0A0A', '222222']);
    });

    it('still adds a chart with an empty default series when no data exists', async () => {
      await buildDeckPptxBlob(deck([{ type: 'chart', series: [] }]));
      expect(firstSlide().charts[0].s).toEqual([expect.objectContaining({ name: 'Series', labels: [], values: [] })]);
    });
  });

  describe('tables', () => {
    it('stringifies cells and applies styling', async () => {
      await buildDeckPptxBlob(deck([{ type: 'table', x: 1, y: 1, w: 3, h: 3, rows: [['a', null, 3], 'solo', null], color: '#123456', fill: '#ABCDEF', border: { color: '#010203', width: 2 } }]));
      const { r, o } = firstSlide().tables[0];
      expect(r).toEqual([['a', '', '3'], ['solo'], ['']]);
      expect(o).toMatchObject({ color: '123456', fill: { color: 'ABCDEF' }, border: { color: '010203', pt: 2 } });
    });

    it('applies table defaults and skips empty tables', async () => {
      await buildDeckPptxBlob(deck([{ type: 'table', rows: [['x']] }, { type: 'table', rows: [] }, { type: 'table' }], { theme: { font: 'ThemeFont' } }));
      expect(firstSlide().tables).toHaveLength(1);
      expect(firstSlide().tables[0].o).toMatchObject({ fontFace: 'ThemeFont', fill: { color: 'FFFFFF' }, border: { color: 'E9D5FF', pt: 1 } });
    });
  });

  it('uses a default palette built from the theme accent', async () => {
    await buildDeckPptxBlob(deck([{ type: 'chart', chartType: 'pie', data: [{ label: 'A', value: 1 }] }], { theme: { accent: '#ABCDEF' } }));
    expect(firstSlide().charts[0].o.chartColors).toEqual(['ABCDEF', '8B2FC9', '6B21A8', 'C084FC']);
  });
});

describe('buildHtmlDeckPptxBlob', () => {
  it('builds a default empty deck with one error when no slides exist', async () => {
    await expect(buildHtmlDeckPptxBlob()).rejects.toThrow('Presentation contains no slides to export.');
  });

  it('builds a titled first slide with kicker and body text', async () => {
    await buildHtmlDeckPptxBlob({ title: 'Html', slides: [{ kicker: 'intro', title: 'Welcome', bodyText: 'Body words' }], colors: { bg: '#010101', surface: '#020202', brandPrimary: '#030303', brandSecondary: '#040404', text: '#050505' } });
    const slide = firstSlide();
    expect(pptx.Fake.last.title).toBe('Html');
    expect(slide.background).toEqual({ color: '010101' });
    expect(slide.texts.map((item: { t: string }) => item.t)).toEqual(['INTRO', 'Welcome', 'Body words']);
    expect(slide.texts[0].o.color).toBe('040404');
    expect(slide.texts[1].o).toMatchObject({ fontSize: 34, y: 1 });
    expect(slide.texts[2].o.color).toBe('050505');
    expect(slide.shapes).toHaveLength(2);
    expect(slide.shapes[0].o.fill.color).toBe('030303');
  });

  it('numbers untitled later slides at the smaller size', async () => {
    await buildHtmlDeckPptxBlob({ slides: [{ title: 'First' }, {}] });
    const second = pptx.slides[1];
    expect(second.texts[0].t).toBe('Slide 2');
    expect(second.texts[0].o).toMatchObject({ fontSize: 28, y: 0.7 });
    expect(second.shapes).toHaveLength(1);
  });

  it('lays out one row of tall cards and two rows of short ones, capped at six', async () => {
    const cards = Array.from({ length: 8 }, (_, index) => ({ heading: `H${index}`, body: `B${index}` }));
    await buildHtmlDeckPptxBlob({ slides: [{ title: 'Few', cards: cards.slice(0, 2), bodyText: 'ignored' }, { title: 'Many', cards }] });
    const [few, many] = pptx.slides;
    expect(few.shapes.slice(1).map((item: any) => item.o.h)).toEqual([4.2, 4.2]);
    expect(few.texts.map((item: { t: string }) => item.t)).not.toContain('ignored');
    expect(many.shapes.slice(1)).toHaveLength(6);
    expect(many.shapes[1].o.h).toBe(2.2);
    expect(many.shapes[4].o.y).toBeGreaterThan(many.shapes[1].o.y);
  });

  it('positions card text by which parts are present', async () => {
    await buildHtmlDeckPptxBlob({ slides: [{ title: 'Cards', cards: [{ heading: 'Only head' }, { body: 'Only body' }, {}] }] });
    const texts = firstSlide().texts;
    expect(texts.map((item: { t: string }) => item.t)).toEqual(['Cards', 'Only head', 'Only body']);
    expect(texts[1].o.fontSize).toBe(18);
    expect(texts[2].o.y).toBeCloseTo(2.15 + 0.25);
    expect(firstSlide().shapes).toHaveLength(4);
  });

  it('falls back to default brand colours for invalid values', async () => {
    await buildHtmlDeckPptxBlob({ slides: [{ title: 'T', bodyText: 'b' }], colors: { bg: 'not-a-colour' } });
    expect(firstSlide().background).toEqual({ color: '0D0818' });
    expect(firstSlide().shapes[0].o.fill.color).toBe('A63BFF');
  });
});
