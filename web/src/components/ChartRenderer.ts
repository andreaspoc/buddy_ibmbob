import { uiMotion } from '../lib/motion';
// Interactive SVG chart renderer for chat responses with clean enterprise styling

function createToolbarElement(className: string, as: 'div' | 'header' | 'nav' | 'section' = 'div'): HTMLElement {
  const element = document.createElement(as);
  element.className = `buddy-toolbar ${className}`.trim();
  return element;
}

export interface ChartDataset {
  label?: string;
  data: number[];
  color?: string;
  colors?: string[];
}

export interface ChartSpec {
  type?: 'bar' | 'line' | 'pie' | 'doughnut' | string;
  title?: string;
  subtitle?: string;
  labels?: string[];
  data?: number[];
  datasets?: ChartDataset[];
  colors?: string[];
  colorMode?: 'categorical' | 'series';
}

// Enterprise categorical 14-color palette
export const CARBON_PALETTE = [
  '#0f62fe', // Blue 60 (Primary)
  '#6929c4', // Purple 70
  '#1192e8', // Cyan 50
  '#005d5d', // Teal 70
  '#9f1853', // Magenta 70
  '#fa4d56', // Red 50
  '#198038', // Green 60
  '#002d9c', // Blue 80
  '#ee538b', // Magenta 50
  '#b28600', // Yellow 50
  '#009d9a', // Teal 50
  '#012749', // Cyan 90
  '#8a3ffc', // Purple 60
  '#570408', // Red 90
];

// Carbon Design System motion specifications
export const CARBON_CHART_MOTION = {
  duration: uiMotion.chartEnter,
  updateDuration: uiMotion.chartUpdate,
  exitDuration: uiMotion.standard,
  easing: uiMotion.easing,
  entrance: uiMotion.entrance,
  exit: uiMotion.exit,
};

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const currentX = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
      if (Math.abs(currentX - x) < 1e-5) break;
      const dxdt = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
      if (Math.abs(dxdt) < 1e-6) break;
      t = Math.max(0, Math.min(1, t - (currentX - x) / dxdt));
    }
    return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  };
}

export const carbonEase = cubicBezier(0.2, 0, 0.38, 0.9);

function detachChild(child: any): void {
  if (!child) return;
  const parent = child.parentElement;
  if (typeof child.remove === 'function') {
    child.remove();
  } else if (parent) {
    if (typeof parent.removeChild === 'function') {
      parent.removeChild(child);
    } else if (Array.isArray(parent.children)) {
      parent.children = parent.children.filter((c: any) => c !== child);
    }
  }
  // Real DOM nodes clear this themselves, and it is read-only on them.
  if (typeof child.remove !== 'function') child.parentElement = null;
}

function computeSlicePath(cx: number, cy: number, radius: number, innerRadius: number, startAngle: number, endAngle: number, isDoughnut: boolean): string {
  const sliceAngle = Math.max(0, endAngle - startAngle);
  if (sliceAngle <= 0.0001) return '';
  const effectiveEnd = startAngle + Math.min(sliceAngle, Math.PI * 2 - 0.000001);
  const x1 = cx + radius * Math.cos(startAngle);
  const y1 = cy + radius * Math.sin(startAngle);
  const x2 = cx + radius * Math.cos(effectiveEnd);
  const y2 = cy + radius * Math.sin(effectiveEnd);
  const largeArc = sliceAngle > Math.PI ? 1 : 0;
  if (isDoughnut) {
    const ix1 = cx + innerRadius * Math.cos(effectiveEnd);
    const iy1 = cy + innerRadius * Math.sin(effectiveEnd);
    const ix2 = cx + innerRadius * Math.cos(startAngle);
    const iy2 = cy + innerRadius * Math.sin(startAngle);
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
  }
  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

const THEME = {
  font: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  bg: '#ffffff',
  border: '#e0e0e0',
  textPrimary: '#161616',
  textSecondary: '#525252',
  textHelper: '#6f6f6f',
  gridLine: '#e0e0e0',
  axisBaseline: '#8d8d8d',
  tagBg: '#edf5ff',
  tagText: '#0043ce',
  tagBorder: '#d0e2ff',
};

function formatNumber(num: number): string {
  if (Math.abs(num) >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (Math.abs(num) >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

export function renderChartToDOM(input: ChartSpec): HTMLElement {
  const anyIn = input as any;
  const spec: ChartSpec = { ...input };
  if (anyIn && anyIn.data && !Array.isArray(anyIn.data) && typeof anyIn.data === 'object') {
    spec.labels = anyIn.data.labels || spec.labels;
    spec.datasets = (anyIn.data.datasets || []).map((d: any) => ({
      label: d.label, data: d.data || [],
      colors: Array.isArray(d.backgroundColor) ? d.backgroundColor : undefined,
      color: typeof d.backgroundColor === 'string' ? d.backgroundColor : (typeof d.borderColor === 'string' ? d.borderColor : undefined),
    }));
    spec.data = undefined;
  }
  const plugins = anyIn?.options?.plugins;
  if (!spec.title && plugins?.title?.text) spec.title = String(plugins.title.text);
  if (!spec.subtitle && plugins?.subtitle?.text) spec.subtitle = String(plugins.subtitle.text);
  // Stable per-chart variation: rerenders and legend toggles retain their colors.
  const seed = Array.from(spec.title || (spec.labels || []).join('|')).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0);
  const palette = spec.colors?.length ? spec.colors : CARBON_PALETTE.map((_, i) => CARBON_PALETTE[(i + seed % CARBON_PALETTE.length) % CARBON_PALETTE.length]);
  const container = document.createElement('div');
  container.className = 'interactive-chart-card';
  container.dataset.chartSpec = JSON.stringify(input);
  container.style.cssText = `
    position: relative;
    margin: 24px auto;
    width: 100%;
    max-width: 100%;
    min-height: 440px;
    box-sizing: border-box;
    padding: 20px 24px 18px;
    background: ${THEME.bg};
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    font-family: ${THEME.font};
    color: ${THEME.textPrimary};
    user-select: none;
    display: flex;
    flex-direction: column;
    align-items: stretch;
  `;

  // Tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-interactive-tooltip';
  tooltip.style.cssText = `
    position: absolute;
    display: none;
    pointer-events: none;
    background: #161616;
    color: #ffffff;
    font-family: ${THEME.font};
    font-size: 11.5px;
    padding: 7px 10px;
    border-radius: 2px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
    z-index: 999;
    white-space: nowrap;
    line-height: 1.4;
    max-width: calc(100% - 16px);
    box-sizing: border-box;
    white-space: normal;
    overflow-wrap: anywhere;
    transition: opacity 0.1s ease;
  `;
  container.appendChild(tooltip);

  const showTooltip = (clientX: number, clientY: number, title: string, items: Array<{ color: string; label: string; value: string | number }>) => {
    const rect = (tooltip.parentElement || container).getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    tooltip.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = title;
    tooltip.appendChild(heading);
    items.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
      const swatch = document.createElement('span');
      swatch.style.cssText = 'width:8px;height:8px;display:inline-block;flex-shrink:0;';
      swatch.style.backgroundColor = item.color;
      const text = document.createElement('span');
      text.textContent = `${item.label}: ${item.value}`;
      row.append(swatch, text);
      tooltip.appendChild(row);
    });
    tooltip.style.display = 'block';
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.width - bounds.width - 8, x - bounds.width / 2))}px`;
    tooltip.style.top = `${Math.max(8, y - bounds.height - 8)}px`;
  };

  const hideTooltip = () => {
    tooltip.style.display = 'none';
  };

  // Header
  const header = createToolbarElement('chart-toolbar');

  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'min-width:0;flex:1 1 120px;overflow-wrap:anywhere;';
  if (spec.title) {
    const title = document.createElement('h4');
    title.textContent = spec.title;
    title.style.cssText = 'margin: 0; font-size: 14px; font-weight: 600; color: inherit; letter-spacing: 0.16px;';
    titleWrap.appendChild(title);
  }
  if (spec.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.textContent = spec.subtitle;
    subtitle.style.cssText = 'margin: 3px 0 0; font-size: 12px; color: inherit;';
    titleWrap.appendChild(subtitle);
  }
  header.appendChild(titleWrap);

  const chartType = (spec.type || 'bar').toLowerCase();
  const badge = document.createElement('span');
  badge.textContent = chartType.toUpperCase();
  badge.style.cssText = `
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.32px;
    padding: 2px 7px;
    background: var(--toolbar-control);
    color: inherit;
    border: 1px solid var(--toolbar-border);
    border-radius: 2px;
    flex-shrink: 0;
    text-transform: uppercase;
  `;
  header.appendChild(badge);
  container.appendChild(header);

  // Normalize data
  const rawLabels = Array.isArray(spec.labels) ? spec.labels.map(String) : [];
  let rawDatasets: ChartDataset[] = [];
  if (spec.datasets && spec.datasets.length > 0) {
    rawDatasets = spec.datasets;
  } else if (spec.data && spec.data.length > 0) {
    rawDatasets = [{ label: spec.title || 'Value', data: spec.data }];
  }
  rawDatasets = rawDatasets.map(ds => ({ ...ds, data: Array.isArray(ds.data) ? ds.data : [] }));
  const pointCount = Math.max(rawLabels.length, ...rawDatasets.map(ds => ds.data.length), 0);
  while (rawLabels.length < pointCount) rawLabels.push(`Item ${rawLabels.length + 1}`);
  if (rawDatasets.some(ds => ds.data.some(value => typeof value !== 'number' || !Number.isFinite(value))) ||
      ((chartType === 'pie' || chartType === 'doughnut') && rawDatasets.some(ds => ds.data.some(value => value < 0)))) {
    const message = document.createElement('p');
    message.textContent = 'Chart data must contain finite numbers; pie and doughnut values must also be nonnegative.';
    container.appendChild(message);
    return container;
  }
  const sliceColors = rawDatasets[0]?.colors?.length ? rawDatasets[0].colors : palette;
  rawDatasets = rawDatasets.map((ds, i) => ({
    ...ds,
    colors: ds.colors?.length ? ds.colors : (chartType === 'bar' && rawDatasets.length === 1 && spec.colorMode !== 'series' && !ds.color ? palette : undefined),
    color: ds.color || palette[i % palette.length],
  }));

  if (rawDatasets.length === 0 || (rawDatasets[0].data.length === 0 && rawLabels.length === 0)) {
    const emptyMsg = document.createElement('div');
    emptyMsg.textContent = 'No chart data provided.';
    emptyMsg.style.cssText = `padding: 20px; text-align: center; color: ${THEME.textSecondary}; font-size: 12px;`;
    container.appendChild(emptyMsg);
    return container;
  }

  // Interactive state
  const hiddenSeries = new Set<number>();
  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'chart-canvas-wrapper';
  chartWrapper.style.cssText = 'width: 100%; min-height: 360px; overflow-x: auto; display: flex; justify-content: center; align-items: center; min-width: 0; margin: 12px 0 6px;';
  container.appendChild(chartWrapper);

  const legend = document.createElement('div');
  legend.className = 'chart-legend-wrapper';
  legend.style.cssText = `display: flex; flex-wrap: wrap; gap: 14px; margin-top: 14px; padding-top: 10px; border-top: 1px solid ${THEME.border}; justify-content: center; align-items: center;`;
  container.appendChild(legend);

  const maximize = document.createElement('button');
  maximize.type = 'button';
  maximize.className = 'chart-maximize-button';
  maximize.textContent = '⛶ Maximize';
  maximize.setAttribute('aria-label', `Maximize chart: ${spec.title || 'Chart'}`);
  maximize.setAttribute('aria-haspopup', 'dialog');
  header.appendChild(maximize);

  // Keep the same chart nodes so legend selections and event handlers survive.
  // Nest the native dialog in the card so removing a message also removes its modal.
  const dialog = document.createElement('dialog');
  dialog.className = 'chart-maximized-dialog';
  dialog.setAttribute('aria-label', spec.title || 'Expanded chart');
  const modalHeader = createToolbarElement('chart-maximized-header');
  const modalTitle = document.createElement('strong');
  modalTitle.textContent = spec.title || 'Chart';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'chart-maximize-button';
  close.textContent = '✕ Close';
  close.setAttribute('aria-label', 'Close expanded chart');
  modalHeader.append(modalTitle, close);
  dialog.appendChild(modalHeader);
  container.appendChild(dialog);
  maximize.addEventListener('click', () => {
    hideTooltip();
    dialog.append(tooltip, chartWrapper, legend);
    dialog.showModal();
    close.focus();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    hideTooltip();
    container.append(tooltip, chartWrapper, legend);
    maximize.focus();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  let currentSvg: SVGElement | null = null;

  // Render chart SVG & update legend
  const renderAll = () => {
    hideTooltip();
    chartWrapper.innerHTML = '';
    legend.innerHTML = '';

    const isSingleBar = chartType === 'bar' && rawDatasets.length === 1;
    const activeDatasets = rawDatasets.map((ds, idx) => ({
      ...ds,
      data: isSingleBar
        ? ds.data.map((val, catIdx) => hiddenSeries.has(catIdx) ? 0 : val)
        : (hiddenSeries.has(idx) ? ds.data.map(() => 0) : ds.data),
      hidden: isSingleBar ? false : hiddenSeries.has(idx),
    }));

    let svgEl: SVGElement | null = null;
    if (chartType === 'pie' || chartType === 'doughnut') {
      svgEl = renderInteractivePie(rawLabels, rawDatasets[0].data, chartType === 'doughnut', hiddenSeries, showTooltip, hideTooltip, sliceColors);
    } else if (chartType === 'line') {
      svgEl = renderInteractiveLine(rawLabels, activeDatasets, rawDatasets, hiddenSeries, showTooltip, hideTooltip);
    } else if (chartType === 'bar') {
      svgEl = renderInteractiveBar(rawLabels, activeDatasets, rawDatasets, hiddenSeries, showTooltip, hideTooltip);
    } else {
      const message = document.createElement('p');
      message.style.cssText = `font-size: 12px; color: ${THEME.textSecondary}; margin: 8px 0;`;
      message.textContent = `The chart renderer does not support "${chartType}". Generate this chart as a plot image or HTML visualization.`;
      chartWrapper.appendChild(message);
      return;
    }

    if (svgEl) {
      svgEl.setAttribute('role', 'img');
      svgEl.setAttribute('aria-label', `${spec.title || chartType + ' chart'}. ${rawDatasets.map(ds => `${ds.label || 'Values'}: ${ds.data.map((value, i) => `${rawLabels[i]} ${value}`).join(', ')}`).join('. ')}`);
      currentSvg = svgEl;
      chartWrapper.appendChild(svgEl);
    }

    const updateLegendUI = () => {
      Array.from(legend.children || []).forEach((child: any, idx: number) => {
        const btn = child;
        const isHidden = hiddenSeries.has(idx);
        btn.setAttribute('aria-pressed', String(!isHidden));
        btn.style.color = isHidden ? THEME.textHelper : THEME.textPrimary;
        btn.style.opacity = isHidden ? '0.45' : '1';
        btn.style.textDecoration = isHidden ? 'line-through' : 'none';
        const isCategorical = chartType === 'pie' || chartType === 'doughnut' || isSingleBar;
        const swatch = btn.children?.[0];
        if (swatch) {
          const color = isCategorical
            ? (rawDatasets[0]?.colors?.[idx] || sliceColors[idx % sliceColors.length])
            : (rawDatasets[idx]?.color || CARBON_PALETTE[idx % CARBON_PALETTE.length]);
          swatch.style.background = isHidden ? '#c6c6c6' : color;
          swatch.style.cssText = `width: 8px; height: 8px; background: ${isHidden ? '#c6c6c6' : color}; display: inline-block; flex-shrink: 0; transition: background-color 0.2s ease, opacity 0.2s ease;`;
        }
      });
    };

    // Build interactive legend
    const isCategorical = chartType === 'pie' || chartType === 'doughnut' || isSingleBar;

    if (isCategorical) {
      rawLabels.forEach((label, i) => {
        const isHidden = hiddenSeries.has(i);
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('aria-pressed', String(!isHidden));
        item.style.cssText = `
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: ${isHidden ? THEME.textHelper : THEME.textPrimary};
          background: transparent;
          border: none;
          padding: 2px 4px;
          cursor: pointer;
          opacity: ${isHidden ? '0.45' : '1'};
          text-decoration: ${isHidden ? 'line-through' : 'none'};
          border-radius: 2px;
          transition: opacity 0.2s cubic-bezier(0.2, 0, 0.38, 0.9), color 0.2s ease;
        `;
        const itemColor = isSingleBar
          ? (rawDatasets[0]?.colors?.[i] || sliceColors[i % sliceColors.length])
          : sliceColors[i % sliceColors.length];
        const swatch = document.createElement('span');
        swatch.style.cssText = `width: 8px; height: 8px; background: ${isHidden ? '#c6c6c6' : itemColor}; display: inline-block; flex-shrink: 0; transition: background-color 0.2s ease, opacity 0.2s ease;`;
        const text = document.createElement('span');
        const val = rawDatasets[0]?.data?.[i] !== undefined ? ` (${formatNumber(rawDatasets[0].data[i])})` : '';
        text.textContent = `${label}${val}`;
        item.append(swatch, text);

        item.addEventListener('click', () => {
          if (hiddenSeries.has(i)) hiddenSeries.delete(i);
          else hiddenSeries.add(i);

          if (currentSvg && typeof (currentSvg as any).__updateValues === 'function') {
            (currentSvg as any).__updateValues(hiddenSeries, true);
            updateLegendUI();
          } else {
            renderAll();
          }
          item.focus();
        });
        legend.appendChild(item);
      });
    } else if (rawDatasets.length > 1) {
      rawDatasets.forEach((ds, i) => {
        const isHidden = hiddenSeries.has(i);
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('aria-pressed', String(!isHidden));
        item.style.cssText = `
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: ${isHidden ? THEME.textHelper : THEME.textPrimary};
          background: transparent;
          border: none;
          padding: 2px 4px;
          cursor: pointer;
          opacity: ${isHidden ? '0.45' : '1'};
          text-decoration: ${isHidden ? 'line-through' : 'none'};
          border-radius: 2px;
          transition: opacity 0.2s cubic-bezier(0.2, 0, 0.38, 0.9), color 0.2s ease;
        `;
        const swatch = document.createElement('span');
        swatch.style.cssText = `width: 8px; height: 8px; background: ${isHidden ? '#c6c6c6' : ds.color || CARBON_PALETTE[i % CARBON_PALETTE.length]}; display: inline-block; flex-shrink: 0; transition: background-color 0.2s ease, opacity 0.2s ease;`;
        const text = document.createElement('span');
        text.textContent = ds.label || `Series ${i + 1}`;
        item.append(swatch, text);

        item.addEventListener('click', () => {
          if (hiddenSeries.has(i)) hiddenSeries.delete(i);
          else hiddenSeries.add(i);

          if (currentSvg && typeof (currentSvg as any).__updateValues === 'function') {
            (currentSvg as any).__updateValues(hiddenSeries, true);
            updateLegendUI();
          } else {
            renderAll();
          }
          item.focus();
        });
        legend.appendChild(item);
      });
    }
  };

  renderAll();

  // Scroll entrance animation when scrolling to charts
  if (typeof IntersectionObserver !== 'undefined' && typeof window !== 'undefined') {
    let triggered = false;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !triggered) {
          triggered = true;
          observer.disconnect();
          container.classList.add('chart-in-view');
          if (currentSvg && typeof (currentSvg as any).__animateEntrance === 'function') {
            (currentSvg as any).__animateEntrance();
          }
        }
      });
    }, { threshold: 0.1 });
    observer.observe(container);
  }

  return container;
}

function wrapChartLabel(label: string, maxCharacters: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of label.split(/\s+/)) {
    const pieces = word.match(new RegExp(`.{1,${maxCharacters}}`, 'g')) || [''];
    for (const piece of pieces) {
      if (line && line.length + piece.length + 1 > maxCharacters) { lines.push(line); line = ''; }
      line = line ? `${line} ${piece}` : piece;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function addWrappedLabel(label: SVGTextElement, original: string, lines: string[]) {
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = original; label.appendChild(title);
  for (const [index, line] of lines.entries()) {
    const span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    span.setAttribute('x', label.getAttribute('x') || '0');
    span.setAttribute('dy', index === 0 ? '0' : '14'); span.textContent = line;
    label.appendChild(span);
  }
}

function renderInteractiveBar(
  labels: string[],
  datasets: ChartDataset[],
  rawDatasets: ChartDataset[],
  hiddenSeries: Set<number>,
  showTooltip: (x: number, y: number, title: string, items: Array<{ color: string; label: string; value: string | number }>) => void,
  hideTooltip: () => void,
): SVGElement {
  const width = Math.max(500, labels.length * Math.max(96, datasets.length * 36 + 28) + 70);
  const labelCharacters = Math.max(8, Math.floor(((width - 70) / Math.max(1, labels.length) - 12) / 6.5));
  const wrappedLabels = labels.map(label => wrapChartLabel(label, labelCharacters));
  const labelLines = Math.max(1, ...wrappedLabels.map(lines => lines.length));
  const bottom = 28 + labelLines * 14;
  const height = 340 + bottom;
  const padding = { top: 28, right: 30, bottom, left: 50 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const isSingleDataset = rawDatasets.length === 1;
  let minVal = 0;
  let maxVal = 0;
  if (isSingleDataset) {
    (rawDatasets[0]?.data || []).forEach((val, i) => {
      if (hiddenSeries.has(i)) return;
      minVal = Math.min(minVal, val);
      maxVal = Math.max(maxVal, val);
    });
  } else {
    datasets.forEach((ds, i) => {
      if (hiddenSeries.has(i)) return;
      ds.data.forEach(val => { minVal = Math.min(minVal, val); maxVal = Math.max(maxVal, val); });
    });
  }
  if (minVal === maxVal) maxVal = 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(minVal), maxVal))));
  const yMin = Math.floor(minVal / magnitude) * magnitude;
  const yMax = Math.ceil(maxVal / magnitude) * magnitude;
  const yPosition = (value: number) => padding.top + chartH - ((value - yMin) / (yMax - yMin)) * chartH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width: ${width}px; min-width: ${width > 500 ? `${width}px` : '0'}; flex-shrink: 0; height: auto; display: block; margin: 0 auto; font-family: ${THEME.font}; overflow: visible;`);

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const yVal = yMin + ((yMax - yMin) / 4) * i;
    const yPos = padding.top + chartH - (i / 4) * chartH;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(padding.left));
    line.setAttribute('y1', String(yPos));
    line.setAttribute('x2', String(width - padding.right));
    line.setAttribute('y2', String(yPos));
    line.setAttribute('stroke', i === 0 ? THEME.axisBaseline : THEME.gridLine);
    line.setAttribute('stroke-width', '1');
    if (i > 0) line.setAttribute('stroke-dasharray', '2 2');
    svg.appendChild(line);

    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tick.setAttribute('x', String(padding.left - 8));
    tick.setAttribute('y', String(yPos + 4));
    tick.setAttribute('text-anchor', 'end');
    tick.setAttribute('font-size', '11');
    tick.setAttribute('fill', THEME.textSecondary);
    tick.textContent = formatNumber(yVal);
    svg.appendChild(tick);
  }

  const numGroups = labels.length;
  const groupWidth = chartW / numGroups;
  const barWidth = Math.min(32, Math.max(12, (groupWidth - 14) / datasets.length));
  const allBars: SVGRectElement[] = [];
  interface BarEntry {
    rect: SVGRectElement;
    valText?: SVGTextElement;
    dsIdx: number;
    groupIdx: number;
    originalVal: number;
    x: number;
    barWidth: number;
    color: string;
  }
  const barEntries: BarEntry[] = [];
  const currentBarVals = new Map<BarEntry, number>();

  labels.forEach((label, groupIdx) => {
    const groupCenterX = padding.left + groupIdx * groupWidth + groupWidth / 2;
    const totalBarsWidth = datasets.length * barWidth + (datasets.length - 1) * 3;
    const startX = groupCenterX - totalBarsWidth / 2;

    datasets.forEach((ds, dsIdx) => {
      const isHidden = isSingleDataset ? hiddenSeries.has(groupIdx) : hiddenSeries.has(dsIdx);
      const originalVal = isSingleDataset ? (rawDatasets[0]?.data?.[groupIdx] || 0) : (ds.data[groupIdx] || 0);
      const val = isHidden ? 0 : originalVal;
      const barH = Math.abs(yPosition(val) - yPosition(0));
      const x = startX + dsIdx * (barWidth + 3);
      const y = Math.min(yPosition(val), yPosition(0));
      const color = ds.colors?.length ? ds.colors[groupIdx % ds.colors.length] : ds.color || CARBON_PALETTE[dsIdx % CARBON_PALETTE.length];

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(barWidth));
      rect.setAttribute('height', String(isHidden ? 0 : barH));
      rect.setAttribute('rx', '0');
      rect.setAttribute('ry', '0');
      rect.setAttribute('fill', color);
      rect.style.cursor = isHidden ? 'default' : 'pointer';
      rect.style.opacity = isHidden ? '0' : '1';
      rect.style.pointerEvents = isHidden ? 'none' : 'auto';
      rect.style.transition = 'filter 0.15s ease';

      const entry: BarEntry = { rect, dsIdx, groupIdx, originalVal, x, barWidth, color };

      rect.addEventListener('mouseenter', (e) => {
        allBars.forEach((b) => {
          b.style.opacity = b === rect ? '1' : '0.35';
          b.style.filter = b === rect ? 'brightness(1.15)' : 'none';
        });
        const currentV = currentBarVals.get(entry) ?? (isHidden ? 0 : originalVal);
        const seriesLabel = isSingleDataset ? (labels[groupIdx] || `Item ${groupIdx + 1}`) : (rawDatasets[dsIdx]?.label || `Series ${dsIdx + 1}`);
        showTooltip(e.clientX, e.clientY, label, [{ color, label: seriesLabel, value: formatNumber(currentV) }]);
      });

      rect.addEventListener('mousemove', (e) => {
        const currentV = currentBarVals.get(entry) ?? (isHidden ? 0 : originalVal);
        const seriesLabel = isSingleDataset ? (labels[groupIdx] || `Item ${groupIdx + 1}`) : (rawDatasets[dsIdx]?.label || `Series ${dsIdx + 1}`);
        showTooltip(e.clientX, e.clientY, label, [{ color, label: seriesLabel, value: formatNumber(currentV) }]);
      });

      rect.addEventListener('mouseleave', () => {
        allBars.forEach((b) => {
          const bEntry = barEntries.find(be => be.rect === b);
          const isTargetZero = bEntry ? (isSingleDataset ? hiddenSeries.has(bEntry.groupIdx) : hiddenSeries.has(bEntry.dsIdx)) : false;
          b.style.opacity = isTargetZero ? '0' : '1';
          b.style.filter = 'none';
        });
        hideTooltip();
      });

      allBars.push(rect);

      let valText: SVGTextElement | undefined;
      // Value label on top
      if (barH > 14 && !isHidden) {
        valText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        valText.setAttribute('x', String(x + barWidth / 2));
        valText.setAttribute('y', String(val < 0 ? y + barH + 12 : y - 4));
        valText.setAttribute('text-anchor', 'middle');
        valText.setAttribute('font-size', '10');
        valText.setAttribute('font-weight', '500');
        valText.setAttribute('fill', THEME.textPrimary);
        valText.textContent = formatNumber(val);
        svg.appendChild(valText);
      }

      entry.valText = valText;
      barEntries.push(entry);
      svg.appendChild(rect);
    });

    // X-axis label
    const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    xLabel.setAttribute('x', String(groupCenterX));
    xLabel.setAttribute('y', String(height - padding.bottom + 18));
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('font-size', '11');
    xLabel.setAttribute('fill', THEME.textSecondary);
    addWrappedLabel(xLabel, label, wrappedLabels[groupIdx]);
    svg.appendChild(xLabel);
  });

  let animId = 0;
  (svg as any).__updateValues = (newHiddenSeries: Set<number>, animate = true, entrance = false) => {
    const canAnimate = animate && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';

    if (animId && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animId);
      animId = 0;
    }

    const isHiddenForBar = (b: BarEntry) =>
      isSingleDataset ? newHiddenSeries.has(b.groupIdx) : newHiddenSeries.has(b.dsIdx);

    const startVals = barEntries.map(b => currentBarVals.get(b) ?? (isHiddenForBar(b) ? 0 : b.originalVal));
    const targetVals = barEntries.map(b => isHiddenForBar(b) ? 0 : b.originalVal);

    const applyVals = (vals: number[]) => {
      vals.forEach((v, idx) => {
        const b = barEntries[idx];
        currentBarVals.set(b, v);
        const y = Math.min(yPosition(v), yPosition(0));
        const barH = Math.abs(yPosition(v) - yPosition(0));
        b.rect.setAttribute('y', String(y));
        b.rect.setAttribute('height', String(barH));
        const isTargetZero = targetVals[idx] === 0;
        b.rect.style.opacity = isTargetZero && Math.abs(v) < 0.05 ? '0' : '1';
        b.rect.style.pointerEvents = isTargetZero && Math.abs(v) < 0.05 ? 'none' : 'auto';
        if (b.valText) {
          b.valText.setAttribute('y', String(v < 0 ? y + barH + 12 : y - 4));
          b.valText.textContent = formatNumber(Math.round(v));
          b.valText.style.opacity = isTargetZero && Math.abs(v) < 0.05 ? '0' : (barH > 14 ? '1' : '0');
        }
      });
    };

    if (!canAnimate) {
      applyVals(targetVals);
      return;
    }

    const startTime = performance.now();
    const duration = entrance ? CARBON_CHART_MOTION.duration : CARBON_CHART_MOTION.updateDuration; // Carbon productive duration

    const frame = (now: number) => {
      const elapsed = now - startTime;
      const progress = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : Math.min(1, elapsed / duration);
      const ease = carbonEase(progress);

      const frameVals = startVals.map((sv, idx) => sv + (targetVals[idx] - sv) * ease);
      applyVals(frameVals);

      if (progress < 1) {
        animId = window.requestAnimationFrame(frame);
      } else {
        animId = 0;
        applyVals(targetVals);
      }
    };

    animId = window.requestAnimationFrame(frame);
  };

  (svg as any).__animateEntrance = () => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      barEntries.forEach(b => {
        currentBarVals.set(b, 0);
        const y0 = yPosition(0);
        b.rect.setAttribute('y', String(y0));
        b.rect.setAttribute('height', '0');
        b.rect.style.opacity = '0';
        if (b.valText) b.valText.style.opacity = '0';
      });
      (svg as any).__updateValues(hiddenSeries, true, true);
    }
  };

  return svg;
}

function renderInteractiveLine(
  labels: string[],
  datasets: ChartDataset[],
  rawDatasets: ChartDataset[],
  hiddenSeries: Set<number>,
  showTooltip: (x: number, y: number, title: string, items: Array<{ color: string; label: string; value: string | number }>) => void,
  hideTooltip: () => void,
): SVGElement {
  const width = Math.max(500, labels.length * 55);
  const wrappedLabels = labels.map(label => wrapChartLabel(label, Math.max(7, Math.floor(((width - 70) / Math.max(1, labels.length)) / 6.5))));
  const labelLines = Math.max(1, ...wrappedLabels.map(lines => lines.length));
  const bottom = 28 + labelLines * 14;
  const height = 340 + bottom;
  const padding = { top: 28, right: 30, bottom, left: 50 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  let minVal = 0;
  let maxVal = 0;
  datasets.forEach((ds, i) => {
    if (hiddenSeries.has(i)) return;
    ds.data.forEach(val => { minVal = Math.min(minVal, val); maxVal = Math.max(maxVal, val); });
  });
  if (minVal === maxVal) maxVal = 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(minVal), maxVal))));
  const yMin = Math.floor(minVal / magnitude) * magnitude;
  const yMax = Math.ceil(maxVal / magnitude) * magnitude;
  const yPosition = (value: number) => padding.top + chartH - ((value - yMin) / (yMax - yMin)) * chartH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width: ${width}px; min-width: ${width > 500 ? `${width}px` : '0'}; flex-shrink: 0; height: auto; display: block; margin: 0 auto; font-family: ${THEME.font}; overflow: visible;`);

  // Grid
  for (let i = 0; i <= 4; i++) {
    const yVal = yMin + ((yMax - yMin) / 4) * i;
    const yPos = padding.top + chartH - (i / 4) * chartH;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(padding.left));
    line.setAttribute('y1', String(yPos));
    line.setAttribute('x2', String(width - padding.right));
    line.setAttribute('y2', String(yPos));
    line.setAttribute('stroke', i === 0 ? THEME.axisBaseline : THEME.gridLine);
    line.setAttribute('stroke-width', '1');
    if (i > 0) line.setAttribute('stroke-dasharray', '2 2');
    svg.appendChild(line);

    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tick.setAttribute('x', String(padding.left - 8));
    tick.setAttribute('y', String(yPos + 4));
    tick.setAttribute('text-anchor', 'end');
    tick.setAttribute('font-size', '11');
    tick.setAttribute('fill', THEME.textSecondary);
    tick.textContent = formatNumber(yVal);
    svg.appendChild(tick);
  }

  // Hover guide line
  const guideLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  guideLine.setAttribute('y1', String(padding.top));
  guideLine.setAttribute('y2', String(padding.top + chartH));
  guideLine.setAttribute('stroke', '#8d8d8d');
  guideLine.setAttribute('stroke-width', '1');
  guideLine.setAttribute('stroke-dasharray', '2 2');
  guideLine.style.display = 'none';
  guideLine.style.pointerEvents = 'none';
  svg.appendChild(guideLine);

  const stepX = labels.length > 1 ? chartW / (labels.length - 1) : chartW / 2;

  const seriesGroups: SVGGElement[] = [];

  datasets.forEach((ds, dsIdx) => {
    const isHidden = hiddenSeries.has(dsIdx);
    const color = ds.color || CARBON_PALETTE[dsIdx % CARBON_PALETTE.length];
    const points: Array<[number, number]> = [];

    ds.data.forEach((val, i) => {
      const x = padding.left + (labels.length === 1 ? chartW / 2 : i * stepX);
      const y = yPosition(val);
      points.push([x, y]);
    });

    if (points.length === 0) return;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.style.transition = `opacity ${CARBON_CHART_MOTION.updateDuration}ms ${CARBON_CHART_MOTION.easing}, transform ${CARBON_CHART_MOTION.updateDuration}ms ${CARBON_CHART_MOTION.easing}`;
    g.style.opacity = isHidden ? '0' : '1';
    g.style.transform = isHidden ? 'translateY(12px) scale(0.99)' : 'translateY(0) scale(1)';
    g.style.pointerEvents = isHidden ? 'none' : 'auto';
    seriesGroups[dsIdx] = g;

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    g.appendChild(path);

    points.forEach(([x, y], idx) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '3.5');
      circle.setAttribute('fill', '#ffffff');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '2');
      circle.style.cursor = 'pointer';
      circle.style.transition = 'r 0.15s ease, stroke-width 0.15s ease';

      circle.addEventListener('mouseenter', (e) => {
        circle.setAttribute('r', '6');
        circle.setAttribute('stroke-width', '3');
        guideLine.setAttribute('x1', String(x));
        guideLine.setAttribute('x2', String(x));
        guideLine.style.display = 'block';

        const seriesLabel = rawDatasets[dsIdx]?.label || `Series ${dsIdx + 1}`;
        const val = ds.data[idx];
        showTooltip(e.clientX, e.clientY, labels[idx] || '', [{ color, label: seriesLabel, value: formatNumber(val) }]);
      });

      circle.addEventListener('mousemove', (e) => {
        const seriesLabel = rawDatasets[dsIdx]?.label || `Series ${dsIdx + 1}`;
        const val = ds.data[idx];
        showTooltip(e.clientX, e.clientY, labels[idx] || '', [{ color, label: seriesLabel, value: formatNumber(val) }]);
      });

      circle.addEventListener('mouseleave', () => {
        circle.setAttribute('r', '3.5');
        circle.setAttribute('stroke-width', '2');
        guideLine.style.display = 'none';
        hideTooltip();
      });

      g.appendChild(circle);
    });

    if (!isHidden) {
      svg.appendChild(g);
    }
  });

  (svg as any).__updateValues = (newHiddenSeries: Set<number>, animate = true) => {
    const canAnimate = animate && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
    seriesGroups.forEach((g, dsIdx) => {
      if (!g) return;
      const isHidden = newHiddenSeries.has(dsIdx);
      if (canAnimate) {
        if (!g.parentElement) svg.appendChild(g);
        g.style.opacity = isHidden ? '0' : '1';
        g.style.transform = isHidden ? 'translateY(12px) scale(0.99)' : 'translateY(0) scale(1)';
        g.style.pointerEvents = isHidden ? 'none' : 'auto';
      } else {
        if (isHidden) {
          detachChild(g);
        } else if (!g.parentElement) {
          svg.appendChild(g);
        }
      }
    });
  };

  // X labels
  labels.forEach((label, i) => {
    const x = padding.left + (labels.length === 1 ? chartW / 2 : i * stepX);
    const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    xLabel.setAttribute('x', String(x));
    xLabel.setAttribute('y', String(height - padding.bottom + 18));
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('font-size', '11');
    xLabel.setAttribute('fill', THEME.textSecondary);
    addWrappedLabel(xLabel, label, wrappedLabels[i]);
    svg.appendChild(xLabel);
  });

  return svg;
}

function renderInteractivePie(
  labels: string[],
  data: number[],
  isDoughnut: boolean,
  hiddenSeries: Set<number>,
  showTooltip: (x: number, y: number, title: string, items: Array<{ color: string; label: string; value: string | number }>) => void,
  hideTooltip: () => void,
  colors: string[],
): SVGElement {
  const width = 480;
  const height = 360;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 26;
  const innerRadius = isDoughnut ? radius * 0.62 : 0;
  const isBrowser = typeof window !== 'undefined';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width: ${width}px; flex-shrink: 0; height: auto; display: block; margin: 0 auto; font-family: ${THEME.font}; overflow: visible;`);

  // Dedicated group for slices to keep them beneath center text
  const slicesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  slicesGroup.setAttribute('class', 'chart-slices-group');
  svg.appendChild(slicesGroup);

  const centerGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  centerGroup.setAttribute('class', 'chart-center-group');
  centerGroup.style.pointerEvents = 'none';
  svg.appendChild(centerGroup);

  // Center KPI Text (for doughnut)
  let centerValText: SVGTextElement | null = null;
  let centerLabelText: SVGTextElement | null = null;
  if (isDoughnut) {
    centerValText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    centerValText.setAttribute('x', String(cx));
    centerValText.setAttribute('y', String(cy - 4));
    centerValText.setAttribute('text-anchor', 'middle');
    centerValText.setAttribute('font-size', '24');
    centerValText.setAttribute('font-weight', '600');
    centerValText.setAttribute('fill', THEME.textPrimary);
    centerGroup.appendChild(centerValText);

    centerLabelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    centerLabelText.setAttribute('x', String(cx));
    centerLabelText.setAttribute('y', String(cy + 18));
    centerLabelText.setAttribute('text-anchor', 'middle');
    centerLabelText.setAttribute('font-size', '13');
    centerLabelText.setAttribute('fill', THEME.textHelper);
    centerLabelText.textContent = 'Total';
    centerGroup.appendChild(centerLabelText);
  }

  const sliceElements = data.map((_, i) => {
    const color = colors[i % colors.length];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', color);
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.5');
    path.style.cursor = 'pointer';
    path.style.transition = 'filter 0.15s ease, transform 0.15s ease';
    slicesGroup.appendChild(path);
    return path;
  });

  let currentVals = data.map((v, i) => hiddenSeries.has(i) || v <= 0 ? 0 : v);

  const applyGeometry = (vals: number[], isFinal: boolean) => {
    const currentTotal = vals.reduce((sum, v) => sum + Math.max(0, v), 0);
    if (centerValText) {
      centerValText.textContent = formatNumber(Math.round(currentTotal));
    }
    if (currentTotal <= 0) {
      sliceElements.forEach(p => {
        if (!isBrowser) {
          detachChild(p);
        } else {
          p.setAttribute('d', '');
          p.style.opacity = '0';
          p.style.pointerEvents = 'none';
        }
      });
      return;
    }

    let angle = -Math.PI / 2;
    vals.forEach((v, i) => {
      const path = sliceElements[i];
      const sliceVal = Math.max(0, v);
      if (sliceVal <= 0.0001) {
        if (!isBrowser && isFinal) {
          detachChild(path);
        } else {
          path.setAttribute('d', '');
          path.style.opacity = '0';
          path.style.pointerEvents = 'none';
        }
        return;
      }

      if (!path.parentElement) {
        let nextSibling: any = null;
        for (let j = i + 1; j < sliceElements.length; j++) {
          if ((sliceElements[j].parentElement as any) === slicesGroup) {
            nextSibling = sliceElements[j];
            break;
          }
        }
        if (nextSibling && typeof (slicesGroup as any).insertBefore === 'function') {
          (slicesGroup as any).insertBefore(path, nextSibling);
        } else {
          slicesGroup.appendChild(path);
          if (Array.isArray((slicesGroup as any).children)) {
            (slicesGroup as any).children.sort((a: any, b: any) => sliceElements.indexOf(a) - sliceElements.indexOf(b));
          }
        }
      }
      path.style.opacity = '1';
      path.style.pointerEvents = 'auto';

      const sliceAngle = (sliceVal / currentTotal) * (Math.PI * 2);
      const endAngle = angle + sliceAngle;
      const pathD = computeSlicePath(cx, cy, radius, innerRadius, angle, endAngle, isDoughnut);
      path.setAttribute('d', pathD);

      const midAngle = angle + sliceAngle / 2;
      const label = labels[i] || `Item ${i + 1}`;
      const pct = ((sliceVal / currentTotal) * 100).toFixed(1) + '%';
      const color = colors[i % colors.length];

      path.onmouseenter = (e: any) => {
        sliceElements.forEach(s => {
          s.style.opacity = s === path ? '1' : '0.4';
          s.style.filter = s === path ? 'brightness(1.1)' : 'none';
        });
        const dx = Math.cos(midAngle) * 4;
        const dy = Math.sin(midAngle) * 4;
        path.style.transform = `translate(${dx}px, ${dy}px)`;
        if (centerValText && centerLabelText) {
          centerValText.textContent = formatNumber(sliceVal);
          centerLabelText.textContent = `${label} (${pct})`;
        }
        showTooltip(e.clientX, e.clientY, label, [
          { color, label: 'Value', value: formatNumber(sliceVal) },
          { color, label: 'Share', value: pct },
        ]);
      };

      path.onmousemove = (e: any) => {
        showTooltip(e.clientX, e.clientY, label, [
          { color, label: 'Value', value: formatNumber(sliceVal) },
          { color, label: 'Share', value: pct },
        ]);
      };

      path.onmouseleave = () => {
        sliceElements.forEach(s => {
          s.style.opacity = '1';
          s.style.filter = 'none';
          s.style.transform = 'none';
        });
        if (centerValText && centerLabelText) {
          centerValText.textContent = formatNumber(currentTotal);
          centerLabelText.textContent = 'Total';
        }
        hideTooltip();
      };

      angle = endAngle;
    });
  };

  // Initial draw
  applyGeometry(currentVals, true);

  let animId = 0;
  (svg as any).__updateValues = (newHiddenSeries: Set<number>, animate = true, entrance = false) => {
    const targetValues = data.map((v, i) => newHiddenSeries.has(i) || v <= 0 ? 0 : v);
    const startValues = [...currentVals];
    const canAnimate = animate && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) && isBrowser && typeof window.requestAnimationFrame === 'function';

    if (animId && isBrowser) {
      window.cancelAnimationFrame(animId);
      animId = 0;
    }

    if (!canAnimate) {
      currentVals = targetValues;
      applyGeometry(targetValues, true);
      return;
    }

    // Ensure all target slices are attached to slicesGroup in order
    targetValues.forEach((tv, i) => {
      const path = sliceElements[i];
      if (tv > 0 && !path.parentElement) {
        let nextSibling: any = null;
        for (let j = i + 1; j < sliceElements.length; j++) {
          if ((sliceElements[j].parentElement as any) === slicesGroup) {
            nextSibling = sliceElements[j];
            break;
          }
        }
        if (nextSibling && typeof (slicesGroup as any).insertBefore === 'function') {
          (slicesGroup as any).insertBefore(path, nextSibling);
        } else {
          slicesGroup.appendChild(path);
          if (Array.isArray((slicesGroup as any).children)) {
            (slicesGroup as any).children.sort((a: any, b: any) => sliceElements.indexOf(a) - sliceElements.indexOf(b));
          }
        }
      }
    });

    const startTime = performance.now();
    const duration = entrance ? CARBON_CHART_MOTION.duration : CARBON_CHART_MOTION.updateDuration; // Carbon productive duration

    const frame = (now: number) => {
      const elapsed = now - startTime;
      const progress = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : Math.min(1, elapsed / duration);
      const ease = carbonEase(progress);

      const frameValues = startValues.map((sv, i) => sv + (targetValues[i] - sv) * ease);
      currentVals = [...frameValues];
      applyGeometry(frameValues, progress === 1);

      if (progress < 1) {
        animId = window.requestAnimationFrame(frame);
      } else {
        animId = 0;
        currentVals = targetValues;
        applyGeometry(targetValues, true);
      }
    };

    animId = window.requestAnimationFrame(frame);
  };

  (svg as any).__animateEntrance = () => {
    if (isBrowser && typeof window.requestAnimationFrame === 'function') {
      currentVals = data.map(() => 0);
      applyGeometry(currentVals, false);
      (svg as any).__updateValues(hiddenSeries, true, true);
    }
  };

  return svg;
}
