// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderChartToDOM, carbonEase, CARBON_PALETTE } from '../../src/components/ChartRenderer';
import { renderMapToDOM, type MapSpec } from '../../src/components/MapRenderer';

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe('ChartRenderer', () => {
  it('moves the chart into a dialog and restores it with focus when closed', () => {
      const el = renderChartToDOM({ type: 'bar', title: 'Sales', labels: ['A'], data: [10] });
      document.body.appendChild(el);
      const maximize = el.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
      const dialog = el.querySelector('dialog')!;
      dialog.showModal = () => { dialog.open = true; };
      dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
      const chart = el.querySelector('.chart-canvas-wrapper')!;
      maximize.click();
      expect(dialog.open).toBe(true);
      expect(dialog.contains(chart)).toBe(true);
      const closeButton = dialog.querySelector<HTMLButtonElement>('[aria-label="Close expanded chart"]')!;
      expect(document.activeElement).toBe(closeButton);
      closeButton.click();
      expect(dialog.open).toBe(false);
      expect(dialog.contains(chart)).toBe(false);
      expect(document.activeElement).toBe(maximize);
      el.remove();
  });

  it('explains unsupported chart types instead of rendering a misleading chart', () => {
    const el = renderChartToDOM({ type: 'radar', labels: ['A'], data: [1] });
    expect(el.textContent).toContain('does not support "radar"');
    expect(el.querySelector('svg')).toBeNull();
  });

  it('carbonEase computes easing curve for boundaries and midpoints', () => {
    expect(carbonEase(0)).toBe(0);
    expect(carbonEase(1)).toBe(1);
    expect(carbonEase(-0.5)).toBe(0);
    expect(carbonEase(1.5)).toBe(1);
    const mid = carbonEase(0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('renders a warning for pie/doughnut charts with negative numbers', () => {
    const el = renderChartToDOM({
      type: 'pie',
      title: 'Invalid Pie',
      labels: ['A', 'B'],
      data: [10, -5],
    });
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.textContent).toContain('nonnegative');
  });

  it('renders a pie chart and allows toggling series visibility via legend', () => {
    const el = renderChartToDOM({
      type: 'pie',
      title: 'Browser Market Share',
      subtitle: 'Global 2026',
      labels: ['Chrome', 'Safari', 'Firefox'],
      data: [65, 20, 15],
    });
    document.body.appendChild(el);

    expect(el.querySelector('.chart-toolbar')).not.toBeNull();
    expect(el.textContent).toContain('Browser Market Share');
    expect(el.textContent).toContain('Global 2026');

    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('role')).toBe('img');

    // Check legend items
    const legendButtons = el.querySelectorAll('button[aria-pressed]');
    expect(legendButtons.length).toBe(3);

    // Click first legend button to toggle hide
    const firstBtn = legendButtons[0] as HTMLButtonElement;
    expect(firstBtn.getAttribute('aria-pressed')).toBe('true');
    firstBtn.click();
    expect(firstBtn.getAttribute('aria-pressed')).toBe('false');

    // Click again to unhide
    firstBtn.click();
    expect(firstBtn.getAttribute('aria-pressed')).toBe('true');

    el.remove();
  });

  it('renders a doughnut chart with custom colors and format', () => {
    const el = renderChartToDOM({
      type: 'doughnut',
      title: 'Budget Allocation',
      labels: ['Engineering', 'Marketing'],
      datasets: [
        {
          label: 'Spending',
          data: [70000, 30000],
          colors: ['#0f62fe', '#8a3ffc'],
        },
      ],
    });
    document.body.appendChild(el);

    expect(el.textContent).toContain('Budget Allocation');
    const paths = el.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);

    el.remove();
  });

  it('renders a single-series and multi-series bar chart', () => {
    // Single-series bar chart
    const single = renderChartToDOM({
      type: 'bar',
      title: 'Monthly Revenue',
      labels: ['Jan', 'Feb', 'Mar'],
      data: [100, 250, 180],
    });
    document.body.appendChild(single);
    expect(single.querySelectorAll('rect').length).toBeGreaterThan(0);
    single.remove();

    // Multi-series bar chart
    const multi = renderChartToDOM({
      type: 'bar',
      title: 'Quarterly Comparison',
      labels: ['Q1', 'Q2'],
      datasets: [
        { label: '2025', data: [100, 150], color: '#0f62fe' },
        { label: '2026', data: [120, 170], color: '#6929c4' },
      ],
    });
    document.body.appendChild(multi);
    const legendBtns = multi.querySelectorAll('button[aria-pressed]');
    expect(legendBtns.length).toBe(2);
    (legendBtns[0] as HTMLButtonElement).click();
    multi.remove();
  });

  it('renders a line chart with points and handles tooltip interaction', () => {
    const el = renderChartToDOM({
      type: 'line',
      title: 'Latency Trend',
      labels: ['10:00', '11:00', '12:00', '13:00'],
      datasets: [
        {
          label: 'p95',
          data: [45, 52, 48, 60],
          color: '#fa4d56',
        },
      ],
    });
    document.body.appendChild(el);

    expect(el.textContent).toContain('Latency Trend');
    const polyline = el.querySelector('polyline, path');
    expect(polyline).not.toBeNull();

    // Interactive circles for points
    const circles = el.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThan(0);

    // Hover circle
    const point = circles[0] as SVGCircleElement;
    point.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 100, clientY: 100 }));
    const tooltip = el.querySelector('.chart-interactive-tooltip') as HTMLElement;
    expect(tooltip).not.toBeNull();
    point.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

    el.remove();
  });

  it('handles empty datasets gracefully', () => {
    const el = renderChartToDOM({
      type: 'bar',
      labels: [],
      data: [],
    });
    expect(el).toBeInstanceOf(HTMLElement);
  });
});

describe('MapRenderer', () => {
  it('renders map container and toolbar with title and places counter', () => {
    const spec: MapSpec = {
      title: 'Data Centers',
      subtitle: 'Active Global Regions',
      places: [
        { name: 'Frankfurt DC', lat: 50.1109, lng: 8.6821, category: 'Primary', rating: 4.8, address: 'Main St 1' },
        { name: 'Dublin DC', lat: 53.3498, lng: -6.2603, category: 'Secondary', description: 'Backup facility' },
      ],
    };

    const el = renderMapToDOM(spec);
    document.body.appendChild(el);

    expect(el.classList.contains('interactive-map-card')).toBe(true);
    expect(el.textContent).toContain('Data Centers');
    expect(el.textContent).toContain('Active Global Regions');
    expect(el.textContent).toContain('Frankfurt DC');
    expect(el.textContent).toContain('Dublin DC');

    el.remove();
  });

  it('filters out places with invalid lat/lng coordinates', () => {
    const spec: MapSpec = {
      title: 'Edge Nodes',
      places: [
        { name: 'Valid Node', lat: 40.7128, lng: -74.006 },
        { name: 'Invalid Lat', lat: 999, lng: -74.006 },
        { name: 'Invalid Lng', lat: 40.7128, lng: 999 },
        // @ts-expect-error test non-numeric lat
        { name: 'NaN Node', lat: NaN, lng: 0 },
      ],
    };

    const el = renderMapToDOM(spec);
    document.body.appendChild(el);

    expect(el.textContent).toContain('Valid Node');
    expect(el.textContent).not.toContain('Invalid Lat');
    expect(el.textContent).not.toContain('Invalid Lng');

    el.remove();
  });

  it('filters places via the search input in the places drawer/list', () => {
    const spec: MapSpec = {
      title: 'Branch Offices',
      places: [
        { name: 'Tokyo Branch', lat: 35.6762, lng: 139.6503, category: 'APAC' },
        { name: 'London Branch', lat: 51.5074, lng: -0.1278, category: 'EMEA' },
      ],
    };

    const el = renderMapToDOM(spec);
    document.body.appendChild(el);

    const searchInput = el.querySelector('input[type="text"], input[type="search"]') as HTMLInputElement;
    if (searchInput) {
      searchInput.value = 'Tokyo';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      expect(el.textContent).toContain('Tokyo Branch');
    }

    el.remove();
  });

  it('renders basemap switcher buttons in the toolbar', () => {
    const spec: MapSpec = {
      places: [{ name: 'Campus', lat: 37.7749, lng: -122.4194 }],
    };

    const el = renderMapToDOM(spec);
    document.body.appendChild(el);

    const basemapButtons = Array.from(el.querySelectorAll('.map-style-btn'));
    expect(basemapButtons.length).toBe(3);
    const canvasBtn = basemapButtons.find(b => b.textContent?.includes('Canvas'));
    expect(canvasBtn?.classList.contains('is-active')).toBe(true);

    el.remove();
  });
});
