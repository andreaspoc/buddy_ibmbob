import { renderChartToDOM, type ChartSpec } from '../components/ChartRenderer';
import { createToolbarElement } from '../components/Toolbar';
import { csvCell, tsvCell } from './spreadsheetExport';

interface TableData {
  headers: string[];
  rows: string[][];
  numericColumns: number[];
}

function parseNumber(raw: string): number | null {
  if (!raw) return null;
  // Strip currency symbols, percentages, commas, spaces
  const cleaned = raw.replace(/[$€£¥%,]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function extractTableData(table: HTMLTableElement): TableData | null {
  const headers: string[] = [];
  const rows: string[][] = [];

  // 1. Extract headers
  const thElements = table.querySelectorAll('thead th');
  if (thElements.length > 0) {
    thElements.forEach((th) => headers.push((th.textContent || '').trim()));
  } else {
    // Check first row of tr
    const firstRow = table.querySelector('tr');
    if (firstRow) {
      firstRow.querySelectorAll('th, td').forEach((cell) => {
        headers.push((cell.textContent || '').trim());
      });
    }
  }

  // 2. Extract rows
  const trElements = table.querySelectorAll('tbody tr');
  const targetTrs = trElements.length > 0
    ? Array.from(trElements).filter((tr) => thElements.length > 0 || tr !== table.querySelector('tr'))
    : Array.from(table.querySelectorAll('tr')).slice(1);

  targetTrs.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td, th')).map((td) => (td.textContent || '').trim());
    if (cells.length > 0 && cells.some((c) => c.length > 0)) {
      rows.push(cells);
    }
  });

  if (headers.length < 2 || rows.length < 2) {
    return null;
  }

  // 3. Detect numeric columns (at least 60% of cells in the column are valid numbers)
  const numericColumns: number[] = [];
  headers.forEach((_, colIdx) => {
    let numericCount = 0;
    let populatedCount = 0;
    rows.forEach((row) => {
      const val = row[colIdx];
      if (val !== undefined && val !== '') {
        populatedCount++;
        if (parseNumber(val) !== null) {
          numericCount++;
        }
      }
    });
    if (populatedCount > 0 && numericCount / populatedCount >= 0.6) {
      numericColumns.push(colIdx);
    }
  });

  return { headers, rows, numericColumns };
}

export function createInteractiveTable(table: HTMLTableElement): HTMLElement {
  const data = extractTableData(table);
  if (!data) return table;

  const { headers, rows, numericColumns } = data;
  let activeView: 'table' | 'heatmap' | 'bar' | 'line' | 'pie' = numericColumns.length > 0 ? 'heatmap' : 'table';
  let searchQuery = '';
  let sortCol: number | null = null;
  let sortDir: 'asc' | 'desc' | null = null;

  const panel = document.createElement('div');
  panel.className = 'interactive-table-panel';

  // Toolbar
  const toolbar = createToolbarElement('it-toolbar');

  // Left Info badge
  const leftInfo = document.createElement('div');
  leftInfo.className = 'it-left-info';
  const titlePill = document.createElement('span');
  titlePill.className = 'it-title-pill';
  titlePill.innerHTML = '<span aria-hidden="true">📊</span> Data Grid';
  const countBadge = document.createElement('span');
  countBadge.className = 'it-count-badge';
  countBadge.textContent = `${rows.length} rows · ${headers.length} cols`;
  leftInfo.append(titlePill, countBadge);

  // Right Actions & Controls
  const rightControls = document.createElement('div');
  rightControls.className = 'it-right-controls';

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search rows…';
  searchInput.className = 'it-search-input';
  searchInput.setAttribute('aria-label', 'Filter table rows');

  // View toggle group (Table vs Chart views)
  const viewToggleGroup = document.createElement('div');
  viewToggleGroup.className = 'it-view-group';

  const tableBtn = document.createElement('button');
  tableBtn.type = 'button';
  tableBtn.className = 'it-view-btn is-active';
  tableBtn.innerHTML = '📋 <span>Table</span>';
  tableBtn.title = 'View spreadsheet data table';
  viewToggleGroup.appendChild(tableBtn);

  let heatmapBtn: HTMLButtonElement | null = null;
  let barBtn: HTMLButtonElement | null = null;
  let lineBtn: HTMLButtonElement | null = null;
  let donutBtn: HTMLButtonElement | null = null;

  if (numericColumns.length > 0) {
    heatmapBtn = document.createElement('button');
    heatmapBtn.type = 'button';
    heatmapBtn.className = 'it-view-btn';
    heatmapBtn.innerHTML = '🔥 <span>Heatmap</span>';
    heatmapBtn.title = 'Interactive Color-Scale Heatmap';
    viewToggleGroup.appendChild(heatmapBtn);
  }

  if (numericColumns.length > 0) {
    barBtn = document.createElement('button');
    barBtn.type = 'button';
    barBtn.className = 'it-view-btn';
    barBtn.innerHTML = '📊 <span>Bar</span>';
    barBtn.title = 'Visualize as Bar Chart';

    lineBtn = document.createElement('button');
    lineBtn.type = 'button';
    lineBtn.className = 'it-view-btn';
    lineBtn.innerHTML = '📈 <span>Line</span>';
    lineBtn.title = 'Visualize as Line Chart';

    donutBtn = document.createElement('button');
    donutBtn.type = 'button';
    donutBtn.className = 'it-view-btn';
    donutBtn.innerHTML = '🍩 <span>Donut</span>';
    donutBtn.title = 'Visualize as Donut Chart';

    viewToggleGroup.append(barBtn, lineBtn, donutBtn);
  }

  // Export & Copy Buttons
  const actionGroup = document.createElement('div');
  actionGroup.className = 'it-action-group';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'it-action-btn';
  exportBtn.innerHTML = '📥 <span>CSV</span>';
  exportBtn.title = 'Export data to CSV file';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'it-action-btn';
  copyBtn.innerHTML = '📋 <span>Copy</span>';
  copyBtn.title = 'Copy data for Excel';

  actionGroup.append(copyBtn, exportBtn);

  rightControls.append(searchInput, viewToggleGroup, actionGroup);
  toolbar.append(leftInfo, rightControls);

  // Table Container
  const tableContainer = document.createElement('div');
  tableContainer.className = 'it-table-wrap';

  // Chart Container
  const chartContainer = document.createElement('div');
  chartContainer.className = 'it-chart-wrap';
  chartContainer.hidden = true;

  panel.append(toolbar, tableContainer, chartContainer);

  // Filter & Sort Logic
  function getFilteredAndSortedRows(): string[][] {
    let result = [...rows];

    // Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)));
    }

    // Sort
    if (sortCol !== null && sortDir !== null) {
      const isNum = numericColumns.includes(sortCol);
      result.sort((a, b) => {
        const valA = a[sortCol!] || '';
        const valB = b[sortCol!] || '';
        if (isNum) {
          const numA = parseNumber(valA) ?? -Infinity;
          const numB = parseNumber(valB) ?? -Infinity;
          return sortDir === 'asc' ? numA - numB : numB - numA;
        }
        return sortDir === 'asc'
          ? valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' })
          : valB.localeCompare(valA, undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    return result;
  }

  function renderTableContent() {
    const activeRows = getFilteredAndSortedRows();
    countBadge.textContent = `${activeRows.length} of ${rows.length} rows · ${headers.length} cols`;

    const newTable = document.createElement('table');
    newTable.className = 'it-grid-table';

    // Thead
    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    headers.forEach((h, idx) => {
      const th = document.createElement('th');
      th.className = 'it-header-cell';
      th.tabIndex = 0;
      th.setAttribute('role', 'columnheader');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'it-header-title';
      titleSpan.textContent = h;

      const sortIcon = document.createElement('span');
      sortIcon.className = 'it-sort-indicator';
      if (sortCol === idx) {
        sortIcon.textContent = sortDir === 'asc' ? ' ▲' : ' ▼';
        th.classList.add('is-sorted');
      } else {
        sortIcon.textContent = ' ⇅';
      }

      th.append(titleSpan, sortIcon);

      th.addEventListener('click', () => {
        if (sortCol === idx) {
          if (sortDir === 'asc') sortDir = 'desc';
          else if (sortDir === 'desc') {
            sortCol = null;
            sortDir = null;
          }
        } else {
          sortCol = idx;
          sortDir = 'asc';
        }
        renderTableContent();
        if (activeView !== 'table') renderChartContent();
      });

      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    newTable.appendChild(thead);

    // Calculate min/max for heatmap scaling if heatmap is active
    let minVal = Infinity;
    let maxVal = -Infinity;
    if (activeView === 'heatmap') {
      activeRows.forEach((row) => {
        numericColumns.forEach((cIdx) => {
          const num = parseNumber(row[cIdx]);
          if (num !== null) {
            if (num < minVal) minVal = num;
            if (num > maxVal) maxVal = num;
          }
        });
      });
      if (minVal === Infinity) { minVal = 0; maxVal = 1; }
    }

    // Tbody
    const tbody = document.createElement('tbody');
    if (activeRows.length === 0) {
      const emptyTr = document.createElement('tr');
      const emptyTd = document.createElement('td');
      emptyTd.colSpan = headers.length;
      emptyTd.className = 'it-empty-cell';
      emptyTd.textContent = 'No matching rows found for this search.';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    } else {
      activeRows.forEach((row, rIdx) => {
        const tr = document.createElement('tr');
        tr.className = rIdx % 2 === 0 ? 'it-row-even' : 'it-row-odd';
        row.forEach((cell, cIdx) => {
          const td = document.createElement('td');
          td.className = 'it-body-cell';
          if (numericColumns.includes(cIdx)) {
            td.classList.add('is-numeric');
            if (activeView === 'heatmap') {
              const num = parseNumber(cell);
              if (num !== null) {
                const range = (maxVal - minVal) || 1;
                const ratio = Math.max(0, Math.min(1, (num - minVal) / range));
                const hue = Math.round(15 + ratio * 125);
                td.style.backgroundColor = `hsla(${hue}, 80%, 46%, 0.22)`;
                td.style.color = `hsl(${hue}, 85%, 26%)`;
                td.style.fontWeight = '700';
                td.title = `${headers[cIdx]}: ${cell}`;
              }
            }
          }
          td.textContent = cell;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    newTable.appendChild(tbody);
    tableContainer.replaceChildren(newTable);
  }

  function renderChartContent() {
    if (numericColumns.length === 0) return;

    const activeRows = getFilteredAndSortedRows();
    if (activeRows.length === 0) {
      chartContainer.innerHTML = '<div class="it-chart-empty">No rows to visualize. Clear the search filter to see data.</div>';
      return;
    }

    // Label column: Use the first non-numeric column, or column 0
    let labelCol = 0;
    for (let c = 0; c < headers.length; c++) {
      if (!numericColumns.includes(c)) {
        labelCol = c;
        break;
      }
    }

    const chartLabels = activeRows.map((r) => r[labelCol] || `Row`);

    // Datasets
    const datasets = numericColumns.map((colIdx) => {
      const colLabel = headers[colIdx] || `Series ${colIdx + 1}`;
      const colData = activeRows.map((r) => parseNumber(r[colIdx]) ?? 0);
      return {
        label: colLabel,
        data: colData,
      };
    });

    const chartSpec: ChartSpec = {
      type: activeView === 'pie' ? 'doughnut' : activeView,
      title: `${headers[labelCol]} Overview`,
      subtitle: `Visualizing ${activeRows.length} items across ${datasets.length} metric(s)`,
      labels: chartLabels,
      datasets,
    };

    const chartEl = renderChartToDOM(chartSpec);
    chartContainer.replaceChildren(chartEl);
  }

  function switchView(view: 'table' | 'heatmap' | 'bar' | 'line' | 'pie') {
    activeView = view;
    tableBtn.classList.toggle('is-active', view === 'table');
    if (heatmapBtn) heatmapBtn.classList.toggle('is-active', view === 'heatmap');
    if (barBtn) barBtn.classList.toggle('is-active', view === 'bar');
    if (lineBtn) lineBtn.classList.toggle('is-active', view === 'line');
    if (donutBtn) donutBtn.classList.toggle('is-active', view === 'pie');

    for (const button of [tableBtn, heatmapBtn, barBtn, lineBtn, donutBtn]) {
      if (button) button.setAttribute('aria-pressed', String(button.classList.contains('is-active')));
    }

    if (view === 'table' || view === 'heatmap') {
      tableContainer.hidden = false;
      chartContainer.hidden = true;
      renderTableContent();
    } else {
      tableContainer.hidden = true;
      chartContainer.hidden = false;
      renderChartContent();
    }
  }

  // Events
  searchInput.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    renderTableContent();
    if (activeView !== 'table' && activeView !== 'heatmap') renderChartContent();
  });

  tableBtn.addEventListener('click', () => switchView('table'));
  if (heatmapBtn) heatmapBtn.addEventListener('click', () => switchView('heatmap'));
  if (barBtn) barBtn.addEventListener('click', () => switchView('bar'));
  if (lineBtn) lineBtn.addEventListener('click', () => switchView('line'));
  if (donutBtn) donutBtn.addEventListener('click', () => switchView('pie'));

  exportBtn.addEventListener('click', () => {
    const activeRows = getFilteredAndSortedRows();
    const csvLines = [
      headers.map(csvCell).join(','),
      ...activeRows.map((row) => row.map(csvCell).join(',')),
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `data-export-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  copyBtn.addEventListener('click', async () => {
    const activeRows = getFilteredAndSortedRows();
    const tsvLines = [
      headers.map(tsvCell).join('\t'),
      ...activeRows.map((row) => row.map(tsvCell).join('\t')),
    ];
    try {
      await navigator.clipboard.writeText(tsvLines.join('\n'));
      copyBtn.innerHTML = '✓ <span>Copied!</span>';
      setTimeout(() => {
        copyBtn.innerHTML = '📋 <span>Copy</span>';
      }, 2000);
    } catch {}
  });

  // Initialize the selected view and its accessible toggle state.
  switchView(activeView);

  return panel;
}
