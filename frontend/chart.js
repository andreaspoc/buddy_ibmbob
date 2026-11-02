// Interactive SVG chart renderer for chat responses with clean enterprise styling

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

function formatNumber(num) {
  if (Math.abs(num) >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (Math.abs(num) >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

export function renderChartToDOM(input) {
  const spec = { ...input };
  if (input && input.data && !Array.isArray(input.data) && typeof input.data === 'object') {
    spec.labels = input.data.labels || spec.labels;
    spec.datasets = (input.data.datasets || []).map((d) => ({
      label: d.label, data: d.data || [],
      color: typeof d.backgroundColor === 'string' ? d.backgroundColor : (typeof d.borderColor === 'string' ? d.borderColor : undefined),
    }));
    spec.data = undefined;
  }
  const plugins = input?.options?.plugins;
  if (!spec.title && plugins?.title?.text) spec.title = String(plugins.title.text);
  if (!spec.subtitle && plugins?.subtitle?.text) spec.subtitle = String(plugins.subtitle.text);
  const container = document.createElement('div');
  container.className = 'interactive-chart-card';
  container.style.cssText = `
    position: relative;
    margin: 16px 0;
    padding: 16px 20px 14px;
    background: ${THEME.bg};
    border: 1px solid ${THEME.border};
    border-radius: 0px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    font-family: ${THEME.font};
    color: ${THEME.textPrimary};
    user-select: none;
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
    transform: translate(-50%, -115%);
    transition: opacity 0.1s ease;
  `;
  container.appendChild(tooltip);

  const showTooltip = (clientX, clientY, title, items) => {
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const heading = document.createElement('div');
    heading.style.cssText = 'font-weight:600;margin-bottom:4px;color:#c6c6c6;font-size:11px;';
    heading.textContent = String(title ?? '');
    tooltip.replaceChildren(heading);
    items.forEach((item) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;';
      const swatch = document.createElement('span');
      swatch.style.cssText = 'width:8px;height:8px;display:inline-block;flex-shrink:0;';
      swatch.style.backgroundColor = typeof item.color === 'string' ? item.color : '';
      const label = document.createElement('span');
      label.style.color = '#ffffff';
      label.textContent = `${item.label ?? ''}:`;
      const value = document.createElement('strong');
      value.style.cssText = 'margin-left:auto;padding-left:8px;color:#ffffff;';
      value.textContent = String(item.value ?? '');
      row.append(swatch, label, value);
      tooltip.append(row);
    });
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.max(40, Math.min(rect.width - 40, x))}px`;
    tooltip.style.top = `${y - 8}px`;
  };

  const hideTooltip = () => {
    tooltip.style.display = 'none';
  };

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; gap: 12px;';

  const titleWrap = document.createElement('div');
  if (spec.title) {
    const title = document.createElement('h4');
    title.textContent = spec.title;
    title.style.cssText = `margin: 0; font-size: 14px; font-weight: 600; color: ${THEME.textPrimary}; letter-spacing: 0.16px;`;
    titleWrap.appendChild(title);
  }
  if (spec.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.textContent = spec.subtitle;
    subtitle.style.cssText = `margin: 3px 0 0; font-size: 12px; color: ${THEME.textSecondary};`;
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
    background: ${THEME.tagBg};
    color: ${THEME.tagText};
    border: 1px solid ${THEME.tagBorder};
    border-radius: 2px;
    flex-shrink: 0;
    text-transform: uppercase;
  `;
  header.appendChild(badge);
  container.appendChild(header);

  // Normalize data
  const rawLabels = spec.labels || [];
  let rawDatasets = [];
  if (spec.datasets && spec.datasets.length > 0) {
    rawDatasets = spec.datasets;
  } else if (spec.data && spec.data.length > 0) {
    rawDatasets = [{ label: spec.title || 'Value', data: spec.data }];
  }

  if (rawDatasets.length === 0 || (rawDatasets[0].data.length === 0 && rawLabels.length === 0)) {
    const emptyMsg = document.createElement('div');
    emptyMsg.textContent = 'No chart data provided.';
    emptyMsg.style.cssText = `padding: 20px; text-align: center; color: ${THEME.textSecondary}; font-size: 12px;`;
    container.appendChild(emptyMsg);
    return container;
  }

  // Interactive state
  const hiddenSeries = new Set();
  const chartWrapper = document.createElement('div');
  chartWrapper.style.cssText = 'width: 100%; overflow-x: auto; display: flex; justify-content: center;';
  container.appendChild(chartWrapper);

  const legend = document.createElement('div');
  legend.style.cssText = `display: flex; flex-wrap: wrap; gap: 14px; margin-top: 14px; padding-top: 10px; border-top: 1px solid ${THEME.border}; justify-content: flex-start;`;
  container.appendChild(legend);

  const renderAll = () => {
    hideTooltip();
    chartWrapper.innerHTML = '';
    legend.innerHTML = '';

    const activeDatasets = rawDatasets.map((ds, idx) => ({
      ...ds,
      data: hiddenSeries.has(idx) ? ds.data.map(() => 0) : ds.data,
      hidden: hiddenSeries.has(idx),
    }));

    let svgEl = null;
    if (chartType === 'pie' || chartType === 'doughnut') {
      svgEl = renderInteractivePie(rawLabels, rawDatasets[0].data, chartType === 'doughnut', hiddenSeries, showTooltip, hideTooltip);
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
      chartWrapper.appendChild(svgEl);
    }

    // Build interactive legend
    if (chartType === 'pie' || chartType === 'doughnut') {
      rawLabels.forEach((label, i) => {
        const isHidden = hiddenSeries.has(i);
        const item = document.createElement('button');
        item.type = 'button';
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
          transition: opacity 0.15s ease;
        `;
        const swatch = document.createElement('span');
        swatch.style.cssText = `width: 8px; height: 8px; background: ${isHidden ? '#c6c6c6' : CARBON_PALETTE[i % CARBON_PALETTE.length]}; display: inline-block; flex-shrink: 0;`;
        const text = document.createElement('span');
        const val = rawDatasets[0].data[i] !== undefined ? ` (${formatNumber(rawDatasets[0].data[i])})` : '';
        text.textContent = `${label}${val}`;
        item.append(swatch, text);

        item.addEventListener('click', () => {
          if (hiddenSeries.has(i)) hiddenSeries.delete(i);
          else hiddenSeries.add(i);
          renderAll();
        });
        legend.appendChild(item);
      });
    } else if (rawDatasets.length > 1) {
      rawDatasets.forEach((ds, i) => {
        const isHidden = hiddenSeries.has(i);
        const item = document.createElement('button');
        item.type = 'button';
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
          transition: opacity 0.15s ease;
        `;
        const swatch = document.createElement('span');
        swatch.style.cssText = `width: 8px; height: 8px; background: ${isHidden ? '#c6c6c6' : ds.color || CARBON_PALETTE[i % CARBON_PALETTE.length]}; display: inline-block; flex-shrink: 0;`;
        const text = document.createElement('span');
        text.textContent = ds.label || `Series ${i + 1}`;
        item.append(swatch, text);

        item.addEventListener('click', () => {
          if (hiddenSeries.has(i)) hiddenSeries.delete(i);
          else hiddenSeries.add(i);
          renderAll();
        });
        legend.appendChild(item);
      });
    }
  };

  renderAll();
  return container;
}

function renderInteractiveBar(labels, datasets, rawDatasets, hiddenSeries, showTooltip, hideTooltip) {
  const width = Math.max(500, labels.length * (datasets.length * 36 + 28));
  const height = 260;
  const padding = { top: 25, right: 25, bottom: 42, left: 45 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  let maxVal = 0;
  datasets.forEach((ds, i) => {
    if (hiddenSeries.has(i)) return;
    ds.data.forEach((val) => {
      if (val > maxVal) maxVal = val;
    });
  });
  if (maxVal === 0) maxVal = 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxVal)));
  const yMax = Math.ceil(maxVal / magnitude) * magnitude;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width: ${width}px; height: auto; display: block; font-family: ${THEME.font}; overflow: visible;`);

  for (let i = 0; i <= 4; i++) {
    const yVal = (yMax / 4) * i;
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
  const allBars = [];

  labels.forEach((label, groupIdx) => {
    const groupCenterX = padding.left + groupIdx * groupWidth + groupWidth / 2;
    const totalBarsWidth = datasets.length * barWidth + (datasets.length - 1) * 3;
    const startX = groupCenterX - totalBarsWidth / 2;

    datasets.forEach((ds, dsIdx) => {
      const isHidden = hiddenSeries.has(dsIdx);
      const val = isHidden ? 0 : ds.data[groupIdx] || 0;
      const barH = (val / yMax) * chartH;
      const x = startX + dsIdx * (barWidth + 3);
      const y = padding.top + chartH - barH;
      const color = ds.color || CARBON_PALETTE[dsIdx % CARBON_PALETTE.length];

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(barWidth));
      rect.setAttribute('height', String(Math.max(isHidden ? 0 : 2, barH)));
      rect.setAttribute('rx', '0');
      rect.setAttribute('ry', '0');
      rect.setAttribute('fill', color);
      rect.style.cursor = isHidden ? 'default' : 'pointer';
      rect.style.transition = 'opacity 0.15s ease, filter 0.15s ease';

      if (!isHidden) {
        rect.addEventListener('mouseenter', (e) => {
          allBars.forEach((b) => {
            b.style.opacity = b === rect ? '1' : '0.35';
            b.style.filter = b === rect ? 'brightness(1.15)' : 'none';
          });
          const seriesLabel = rawDatasets[dsIdx]?.label || `Series ${dsIdx + 1}`;
          showTooltip(e.clientX, e.clientY, label, [{ color, label: seriesLabel, value: formatNumber(val) }]);
        });

        rect.addEventListener('mousemove', (e) => {
          const seriesLabel = rawDatasets[dsIdx]?.label || `Series ${dsIdx + 1}`;
          showTooltip(e.clientX, e.clientY, label, [{ color, label: seriesLabel, value: formatNumber(val) }]);
        });

        rect.addEventListener('mouseleave', () => {
          allBars.forEach((b) => {
            b.style.opacity = '1';
            b.style.filter = 'none';
          });
          hideTooltip();
        });
      }

      allBars.push(rect);

      if (barH > 14 && !isHidden) {
        const valText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        valText.setAttribute('x', String(x + barWidth / 2));
        valText.setAttribute('y', String(y - 4));
        valText.setAttribute('text-anchor', 'middle');
        valText.setAttribute('font-size', '10');
        valText.setAttribute('font-weight', '500');
        valText.setAttribute('fill', THEME.textPrimary);
        valText.textContent = formatNumber(val);
        svg.appendChild(valText);
      }

      svg.appendChild(rect);
    });

    const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    xLabel.setAttribute('x', String(groupCenterX));
    xLabel.setAttribute('y', String(height - padding.bottom + 18));
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('font-size', '11');
    xLabel.setAttribute('fill', THEME.textSecondary);
    xLabel.textContent = label.length > 14 ? label.slice(0, 13) + '…' : label;
    svg.appendChild(xLabel);
  });

  return svg;
}

function renderInteractiveLine(labels, datasets, rawDatasets, hiddenSeries, showTooltip, hideTooltip) {
  const width = Math.max(500, labels.length * 55);
  const height = 260;
  const padding = { top: 25, right: 25, bottom: 42, left: 45 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  let maxVal = 0;
  datasets.forEach((ds, i) => {
    if (hiddenSeries.has(i)) return;
    ds.data.forEach((val) => {
      if (val > maxVal) maxVal = val;
    });
  });
  if (maxVal === 0) maxVal = 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxVal)));
  const yMax = Math.ceil(maxVal / magnitude) * magnitude;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width: ${width}px; height: auto; display: block; font-family: ${THEME.font}; overflow: visible;`);

  for (let i = 0; i <= 4; i++) {
    const yVal = (yMax / 4) * i;
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

  datasets.forEach((ds, dsIdx) => {
    if (hiddenSeries.has(dsIdx)) return;
    const color = ds.color || CARBON_PALETTE[dsIdx % CARBON_PALETTE.length];
    const points = [];

    ds.data.forEach((val, i) => {
      const x = padding.left + i * stepX;
      const y = padding.top + chartH - (val / yMax) * chartH;
      points.push([x, y]);
    });

    if (points.length === 0) return;

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);

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

      svg.appendChild(circle);
    });
  });

  labels.forEach((label, i) => {
    const x = padding.left + i * stepX;
    const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    xLabel.setAttribute('x', String(x));
    xLabel.setAttribute('y', String(height - padding.bottom + 18));
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.setAttribute('font-size', '11');
    xLabel.setAttribute('fill', THEME.textSecondary);
    xLabel.textContent = label.length > 14 ? label.slice(0, 13) + '…' : label;
    svg.appendChild(xLabel);
  });

  return svg;
}

function renderInteractivePie(labels, data, isDoughnut, hiddenSeries, showTooltip, hideTooltip) {
  const width = 360;
  const height = 240;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 20;
  const innerRadius = isDoughnut ? radius * 0.65 : 0;

  const total = data.reduce((acc, val, idx) => (hiddenSeries.has(idx) || val <= 0 ? acc : acc + val), 0);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width: ${width}px; height: auto; display: block; font-family: ${THEME.font}; overflow: visible;`);

  if (total <= 0) return svg;

  let currentAngle = -Math.PI / 2;
  const allSlices = [];

  let centerValText = null;
  let centerLabelText = null;
  if (isDoughnut) {
    centerValText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    centerValText.setAttribute('x', String(cx));
    centerValText.setAttribute('y', String(cy - 2));
    centerValText.setAttribute('text-anchor', 'middle');
    centerValText.setAttribute('font-size', '16');
    centerValText.setAttribute('font-weight', '600');
    centerValText.setAttribute('fill', THEME.textPrimary);
    centerValText.textContent = formatNumber(total);

    centerLabelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    centerLabelText.setAttribute('x', String(cx));
    centerLabelText.setAttribute('y', String(cy + 14));
    centerLabelText.setAttribute('text-anchor', 'middle');
    centerLabelText.setAttribute('font-size', '11');
    centerLabelText.setAttribute('fill', THEME.textHelper);
    centerLabelText.textContent = 'Total';
  }

  data.forEach((val, i) => {
    if (hiddenSeries.has(i) || val <= 0) return;
    const sliceAngle = (val / total) * (Math.PI * 2);
    const endAngle = currentAngle + sliceAngle;

    const x1 = cx + radius * Math.cos(currentAngle);
    const y1 = cy + radius * Math.sin(currentAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);

    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    const color = CARBON_PALETTE[i % CARBON_PALETTE.length];

    let pathD = '';
    if (isDoughnut) {
      const ix1 = cx + innerRadius * Math.cos(endAngle);
      const iy1 = cy + innerRadius * Math.sin(endAngle);
      const ix2 = cx + innerRadius * Math.cos(currentAngle);
      const iy2 = cy + innerRadius * Math.sin(currentAngle);
      pathD = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
    } else {
      pathD = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', color);
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.5');
    path.style.cursor = 'pointer';
    path.style.transition = 'opacity 0.15s ease, filter 0.15s ease, transform 0.15s ease';

    const midAngle = currentAngle + sliceAngle / 2;
    const label = labels[i] || `Item ${i + 1}`;
    const pct = ((val / total) * 100).toFixed(1) + '%';

    path.addEventListener('mouseenter', (e) => {
      allSlices.forEach((s) => {
        s.style.opacity = s === path ? '1' : '0.4';
        s.style.filter = s === path ? 'brightness(1.1)' : 'none';
      });
      const dx = Math.cos(midAngle) * 4;
      const dy = Math.sin(midAngle) * 4;
      path.style.transform = `translate(${dx}px, ${dy}px)`;

      if (centerValText && centerLabelText) {
        centerValText.textContent = formatNumber(val);
        centerLabelText.textContent = `${label} (${pct})`;
      }

      showTooltip(e.clientX, e.clientY, label, [
        { color, label: 'Value', value: formatNumber(val) },
        { color, label: 'Share', value: pct },
      ]);
    });

    path.addEventListener('mousemove', (e) => {
      showTooltip(e.clientX, e.clientY, label, [
        { color, label: 'Value', value: formatNumber(val) },
        { color, label: 'Share', value: pct },
      ]);
    });

    path.addEventListener('mouseleave', () => {
      allSlices.forEach((s) => {
        s.style.opacity = '1';
        s.style.filter = 'none';
        s.style.transform = 'none';
      });
      if (centerValText && centerLabelText) {
        centerValText.textContent = formatNumber(total);
        centerLabelText.textContent = 'Total';
      }
      hideTooltip();
    });

    allSlices.push(path);
    svg.appendChild(path);

    currentAngle = endAngle;
  });

  if (centerValText && centerLabelText) {
    svg.appendChild(centerValText);
    svg.appendChild(centerLabelText);
  }

  return svg;
}
