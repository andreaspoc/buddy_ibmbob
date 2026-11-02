// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-expect-error frontend plain JS module
import { renderChartToDOM, CARBON_PALETTE } from '../../../frontend/chart.js';
// @ts-expect-error frontend plain JS module
import { createBobDeckViewer } from '../../../frontend/renderer.js';

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
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

describe('frontend/chart.js renderChartToDOM', () => {
  it('CARBON_PALETTE provides standard enterprise colors', () => {
    expect(Array.isArray(CARBON_PALETTE)).toBe(true);
    expect(CARBON_PALETTE.length).toBeGreaterThan(5);
  });

  it('renders a pie chart from direct input spec', () => {
    const el = renderChartToDOM({
      type: 'pie',
      title: 'Traffic Sources',
      labels: ['Direct', 'Search', 'Social'],
      data: [40, 45, 15],
    });
    document.body.appendChild(el);

    expect(el.classList.contains('interactive-chart-card')).toBe(true);
    expect(el.textContent).toContain('Traffic Sources');
    expect(el.querySelector('svg')).not.toBeNull();

    // Toggle legend item
    const legendButtons = el.querySelectorAll('button');
    if (legendButtons.length > 0) {
      legendButtons[0].click();
    }

    el.remove();
  });

  it('adapts Chart.js object format with nested datasets and plugin titles', () => {
    const chartJsInput = {
      type: 'bar',
      data: {
        labels: ['Q1', 'Q2', 'Q3'],
        datasets: [
          {
            label: 'Net Revenue',
            data: [120, 180, 240],
            backgroundColor: '#0f62fe',
          },
        ],
      },
      options: {
        plugins: {
          title: { text: 'Financial Year 2026' },
          subtitle: { text: 'Unaudited figures' },
        },
      },
    };

    const el = renderChartToDOM(chartJsInput);
    document.body.appendChild(el);

    expect(el.textContent).toContain('Financial Year 2026');
    expect(el.textContent).toContain('Unaudited figures');
    expect(el.querySelectorAll('rect').length).toBeGreaterThan(0);

    el.remove();
  });

  it('renders line chart and interacts with points', () => {
    const el = renderChartToDOM({
      type: 'line',
      title: 'CPU Usage',
      labels: ['00:00', '01:00', '02:00'],
      data: [20, 55, 30],
    });
    document.body.appendChild(el);

    expect(el.textContent).toContain('CPU Usage');
    const points = el.querySelectorAll('circle');
    if (points.length > 0) {
      points[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 50, clientY: 50 }));
      points[0].dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }

    el.remove();
  });
});

describe('frontend/renderer.js createBobDeckViewer', () => {
  const sampleDeck = {
    title: 'Strategy 2026',
    metadata: { brand: 'Company A' },
    slides: [
      {
        id: 's1',
        title: 'Mission & Vision',
        bullets: ['Expand fiber connectivity', 'Deliver high reliability'],
      },
      {
        id: 's2',
        title: 'Targets',
        bullets: ['Reach 500k premises', 'Achieve 99.99% core uptime'],
      },
    ],
  };

  it('renders bobdeck viewer with header, brand pill and navigation arrows', () => {
    const viewer = createBobDeckViewer(sampleDeck);
    document.body.appendChild(viewer);

    expect(viewer.classList.contains('bobdeck-viewer')).toBe(true);
    expect(viewer.textContent).toContain('Company A');
    expect(viewer.textContent).toContain('Strategy 2026');

    // Navigation buttons
    const nextBtn = viewer.querySelector('.bobdeck-nav-next') as HTMLButtonElement;
    const prevBtn = viewer.querySelector('.bobdeck-nav-prev') as HTMLButtonElement;
    expect(nextBtn).not.toBeNull();
    expect(prevBtn).not.toBeNull();

    // Click next slide
    nextBtn.click();
    // Click prev slide
    prevBtn.click();

    viewer.remove();
  });

  it('provides json download action', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const viewer = createBobDeckViewer(sampleDeck, JSON.stringify(sampleDeck));
    document.body.appendChild(viewer);

    const jsonBtn = Array.from(viewer.querySelectorAll('button')).find(b => b.textContent?.includes('.bobdeck'));
    expect(jsonBtn).toBeDefined();
    jsonBtn?.click();

    expect(createObjectURL).toHaveBeenCalled();
    viewer.remove();
  });
});
