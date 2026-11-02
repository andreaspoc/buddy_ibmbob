// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-expect-error plain JS modules
import { themeFont, resolveDeckLayout, renderSlideToSvg, exportDeckToPptx } from '../../../frontend/bobdeck.js';
// @ts-expect-error plain JS modules
import * as WebBobdeck from '../../src/lib/bobdeck.js';
// @ts-expect-error plain JS modules
import { createBobDeckViewer } from '../../../frontend/renderer.js';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('pptxgenjs', () => {
  return {
    default: class MockPptx {
      defineLayout = vi.fn();
      layout = '16x9';
      addSlide = vi.fn().mockReturnValue({
        background: null,
        addShape: vi.fn(),
        addText: vi.fn(),
        addTable: vi.fn(),
        addChart: vi.fn(),
      });
      writeFile = vi.fn().mockResolvedValue('presentation.pptx');
      write = vi.fn().mockResolvedValue(new Blob(['test'], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
    },
  };
});

describe('frontend/bobdeck.js layout and svg rendering', () => {
  it('themeFont resolves theme fonts and fallbacks', () => {
    expect(themeFont({ fonts: { body: 'Roboto' } })).toBe('Roboto');
    expect(themeFont({ font: 'Arial' })).toBe('Arial');
    expect(themeFont(null)).toBe('Calibri');
    expect(themeFont({})).toBe('Calibri');
  });

  it('resolveDeckLayout clamps element bounds and coordinates', () => {
    const rawDeck = {
      slides: [
        {
          elements: [
            { type: 'rect', x: -5, y: -10, width: 200, height: 100 },
            { type: 'text', x: 2000, y: 1500, w: 50, h: 20, text: 'Overflow' },
          ],
        },
      ],
    };

    const resolved = resolveDeckLayout(rawDeck);
    expect(resolved.slides[0].elements[0].x).toBe(0);
    expect(resolved.slides[0].elements[0].y).toBe(0);
    expect(resolved.slides[0].elements[1].x).toBeLessThan(1400);
  });

  it('renderSlideToSvg renders rects, shapes, multiline text, lines, tables and charts', () => {
    const slide = {
      background: '#FFFFFF',
      elements: [
        { type: 'rect', x: 10, y: 10, w: 50, h: 50, fill: '#FF0000', stroke: '#000000', lineWidth: 2 },
        {
          type: 'text',
          x: 70,
          y: 20,
          w: 200,
          h: 60,
          text: 'Title Line 1\nSubtitle Line 2',
          align: 'center',
          bold: true,
          style: { fontStyle: 'italic', fontFamily: 'Helvetica', lineHeight: 1.4 },
        },
        {
          type: 'text',
          x: 280,
          y: 20,
          w: 100,
          h: 40,
          text: 'Right aligned',
          align: 'right',
        },
        { type: 'line', x: 10, y: 100, w: 200, h: 0, color: '#333333', lineWidth: 3 },
        {
          type: 'table',
          x: 10,
          y: 120,
          w: 300,
          h: 150,
          header: true,
          rows: [
            ['Product', 'Q1', 'Q2'],
            ['Cloud Suite', '100', '150'],
            ['On-Premise', '80', '90'],
          ],
        },
        {
          type: 'chart',
          chartType: 'bar',
          title: 'Quarterly Growth',
          x: 350,
          y: 120,
          w: 250,
          h: 150,
          labels: ['Q1', 'Q2', 'Q3'],
          data: [10, 25, 40],
        },
      ],
    };

    const svg = renderSlideToSvg(slide, { font: 'Arial', accent: '#0f62fe' });
    expect(svg).toBeInstanceOf(SVGElement);
    expect(svg.getAttribute('viewBox')).toBe('0 0 1333 750');

    // Verify elements rendered
    const textNodes = svg.querySelectorAll('text');
    expect(textNodes.length).toBeGreaterThan(0);
    expect(svg.querySelector('line')).not.toBeNull();
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(5);
  });

  it('exportDeckToPptx exports deck data into pptxgen format', async () => {
    const rawDeck = {
      slides: [
        {
          elements: [
            { type: 'text', x: 10, y: 10, w: 100, h: 30, text: 'Sample' },
            { type: 'table', x: 10, y: 50, w: 100, h: 50, rows: [['A', 'B']] },
          ],
        },
      ],
    };

    const result = await exportDeckToPptx(rawDeck, 'test.pptx');
    expect(result).toBe('test.pptx');
  });
});

describe('frontend/renderer.js createBobDeckViewer', () => {
  it('renders presentation deck viewer with slide navigation and thumbnail strip', () => {
    const deckData = {
      title: 'Enterprise Architecture 2026',
      slides: [
        {
          elements: [
            { type: 'text', x: 20, y: 20, w: 300, h: 50, text: 'Slide 1 Overview' },
          ],
        },
        {
          elements: [
            { type: 'text', x: 20, y: 20, w: 300, h: 50, text: 'Slide 2 Deep Dive' },
          ],
        },
      ],
    };

    const viewer = createBobDeckViewer(deckData, JSON.stringify(deckData));
    document.body.appendChild(viewer);

    expect(viewer.classList.contains('bobdeck-viewer')).toBe(true);

    // Check thumbnails
    const thumbs = viewer.querySelectorAll('.bobdeck-thumb');
    expect(thumbs.length).toBe(2);
    (thumbs[1] as HTMLElement).click();

    // Check PPTX download button
    const pptxBtn = viewer.querySelector('.bobdeck-btn-primary') as HTMLButtonElement;
    expect(pptxBtn).not.toBeNull();
    pptxBtn.click();

    // Check keyboard navigation
    viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    viewer.remove();
  });

  it('covers web/src/lib/bobdeck.js resolution, SVG rendering, and PPTX builder blobs', async () => {
    expect(WebBobdeck.themeFont({ fonts: { body: 'IBM Plex Sans' } })).toBe('IBM Plex Sans');
    expect(WebBobdeck.themeFont(null)).toBe('IBM Plex Sans');
    expect(WebBobdeck.resolveDeckLayout(null)).toEqual({ slides: [], theme: {}, title: 'Presentation' });
    expect(WebBobdeck.resolveDeckLayout('invalid')).toEqual({ slides: [], theme: {}, title: 'Presentation' });

    const deck = {
      title: 'Software Q3 Analysis',
      theme: { colors: { primary: '#0f62fe', background: '#ffffff', text: '#161616' } },
      slides: [
        {
          id: 's1',
          background: { color: '#ffffff' },
          elements: [
            { type: 'shape', shape: 'roundedRectangle', x: 1, y: 1, w: 5, h: 3, fill: '#0f62fe', stroke: '#0043ce', lineWidth: 1 },
            { type: 'text', x: 1.5, y: 1.5, w: 4, h: 2, text: 'Network Latency & Core Routing\nKey Findings', fontSize: 24, bold: true, color: '#ffffff' },
            { type: 'line', x: 1, y: 4.5, w: 5, h: 0, color: '#0043ce', lineWidth: 2 },
            { type: 'table', x: 6.5, y: 1, w: 5, h: 3, header: true, rows: [['Region', 'Latency'], ['EMEA', '12ms']] },
            { type: 'chart', chartType: 'bar', x: 6.5, y: 4.5, w: 5, h: 2.5, title: 'Traffic', labels: ['Jan', 'Feb'], data: [100, 150] },
            { type: 'icon', icon: '📡', x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
          ],
        },
      ],
    };

    const resolved = WebBobdeck.resolveDeckLayout(deck);
    expect(resolved.slides.length).toBe(1);

    const svg = WebBobdeck.renderSlideToSvg(resolved.slides[0], deck.theme);
    expect(svg).toBeInstanceOf(SVGElement);
    expect(svg.querySelectorAll('text').length).toBeGreaterThan(0);

    const pptxBlob = await WebBobdeck.buildDeckPptxBlob(deck);
    expect(pptxBlob).toBeDefined();

    const pptxExport = await WebBobdeck.exportDeckToPptx(deck, 'software.pptx');
    expect(pptxExport).toBeDefined();

    const htmlDeckBlob = await WebBobdeck.buildHtmlDeckPptxBlob({
      title: 'Infrastructure Modernization',
      slides: [
        {
          kicker: 'Overview',
          title: 'Hybrid Cloud Network',
          cards: [
            { heading: 'Latency', body: '< 15ms target reached' },
            { heading: 'Throughput', body: '99.999% SLA uptime' },
          ],
        },
        {
          title: 'Next Phase',
          bodyText: 'Migration of peripheral nodes to unified edge architecture.',
        },
      ],
    });
    expect(htmlDeckBlob).toBeDefined();
  });
});
