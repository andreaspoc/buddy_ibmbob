/* Buddy dashboard standard: tabs, chart motion and replay, legends, and searchable tables. Contains no data. */
(() => {
  if (window.BobDashboard) return;
  const COLORS = ['#7b00e0', '#1192e8', '#009d9a', '#fdab3d', '#9f1853', '#00c875', '#5a2b85', '#8a3fc8'];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const charts = new Map();
  /* The app's chart motion: web/src/lib/motion.ts chartEnter and chartUpdate. */
  const ENTRANCE_MS = 1400;
  const UPDATE_MS = 700;
  const BAR_STAGGER_MS = 80;
  const EASING = 'cubic-bezier(.2,0,.38,.9)';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /* Carbon's cubic-bezier(.2,0,.38,.9): solve x for the progress, then evaluate y. */
  function carbonEasing(t) {
    const curve = (a, b, u) => 3 * a * (1 - u) * (1 - u) * u + 3 * b * (1 - u) * u * u + u * u * u;
    let low = 0;
    let high = 1;
    for (let step = 0; step < 24; step += 1) {
      const middle = (low + high) / 2;
      if (curve(.2, .38, middle) < t) low = middle; else high = middle;
    }
    return curve(0, .9, (low + high) / 2);
  }

  function configureChartJs() {
    const library = window.Chart;
    if (!library) return false;
    if (library.helpers?.easingEffects) library.helpers.easingEffects.carbon = carbonEasing;
    const defaults = library.defaults;
    defaults.font.family = "'IBM Plex Sans', system-ui, sans-serif";
    defaults.color = '#5a4a72';
    defaults.animation = { duration: reduced.matches ? 0 : ENTRANCE_MS, easing: 'carbon' };
    defaults.transitions = { ...defaults.transitions, active: { animation: { duration: reduced.matches ? 0 : 200 } } };
    if (library.overrides) {
      library.overrides.doughnut = { ...library.overrides.doughnut, animation: { ...library.overrides.doughnut?.animation, animateRotate: true, animateScale: true } };
      library.overrides.bar = { ...library.overrides.bar, animation: { ...library.overrides.bar?.animation, delay: context => (context.type === 'data' && context.mode === 'default' && !reduced.matches ? context.dataIndex * BAR_STAGGER_MS : 0) } };
    }
    Object.assign(defaults.plugins.tooltip, { backgroundColor: '#1a0a2e', titleColor: '#fff', bodyColor: '#e0ccff', borderColor: '#7b00e0', borderWidth: 1, padding: 10, cornerRadius: 8, boxPadding: 4 });
    return true;
  }

  /* A failed library load keeps the page and its source tables usable. */
  function showChartError() {
    if (document.querySelector('.chart-error')) return;
    const notice = document.createElement('p');
    notice.className = 'chart-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Charts could not load because the chart library is unavailable. The tables on this page still show the data.';
    document.querySelector('main')?.prepend(notice);
  }

  function chart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    if (!configureChartJs()) { showChartError(); return null; }
    charts.get(id)?.destroy();
    const created = new window.Chart(canvas, config);
    charts.set(id, created);
    return created;
  }

  function timing(target, duration) {
    target.options.animation = { ...target.options.animation, duration: reduced.matches ? 0 : duration, easing: 'carbon' };
  }

  function replay(id) {
    const target = charts.get(id);
    if (!target) return;
    timing(target, ENTRANCE_MS);
    target.reset();
    target.update();
  }

  /* Call after changing chart data: updates move at the shorter data-update speed. */
  function update(id) {
    const target = charts.get(id);
    if (!target) return;
    timing(target, UPDATE_MS);
    target.update();
  }

  /* Progress bars grow from zero, like the charts beside them. */
  function revealBars(root) {
    if (reduced.matches) return;
    for (const bar of root.querySelectorAll('.prog-bar-fill')) {
      if (bar.getClientRects().length) bar.animate?.([{ width: '0%' }, { width: getComputedStyle(bar).width }], { duration: ENTRANCE_MS, easing: EASING });
    }
  }

  function replayWithin(root) {
    for (const [id, target] of charts) if (root.contains(target.canvas) && target.canvas.getClientRects().length) replay(id);
  }

  function activate(tab, tabs) {
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById('panel-' + item.dataset.panel)?.classList.toggle('active', selected);
    }
    const panel = document.getElementById('panel-' + tab.dataset.panel);
    if (!panel) return;
    for (const target of charts.values()) if (panel.contains(target.canvas)) target.resize();
    replayWithin(panel);
    revealBars(panel);
    document.dispatchEvent(new CustomEvent('bob:chart-activate', { detail: { element: panel } }));
  }

  function setupTabs() {
    const tabs = [...document.querySelectorAll('.nav-tab[data-panel]')];
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab, tabs));
      tab.addEventListener('keydown', event => {
        const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
        if (!(event.key in moves)) return;
        event.preventDefault();
        const next = tabs[(moves[event.key] + tabs.length) % tabs.length];
        next.focus();
        activate(next, tabs);
      });
    });
  }

  function setupReplay() {
    document.addEventListener('click', event => {
      const button = event.target.closest?.('.chart-replay-btn[data-replay]');
      if (button) replay(button.dataset.replay);
    });
  }

  /* Accessible legend that hides and shows the matching doughnut slice or dataset. */
  function legend(elementId, target, values = []) {
    const element = document.getElementById(elementId);
    if (!element || !target) return;
    const sliced = ['doughnut', 'pie'].includes(target.config.type);
    const labels = sliced ? target.data.labels : target.data.datasets.map(item => item.label);
    element.innerHTML = labels.map((label, index) => {
      const dataset = target.data.datasets[sliced ? 0 : index];
      const color = sliced ? [].concat(dataset.backgroundColor)[index] : dataset.borderColor || dataset.backgroundColor;
      const count = values[index] === undefined ? '' : ` <strong>(${escapeHtml(values[index])})</strong>`;
      return `<button type="button" class="legend-item" aria-pressed="true" data-index="${index}"><span class="legend-dot" style="background:${escapeHtml(color)}"></span>${escapeHtml(label)}${count}</button>`;
    }).join('');
    element.addEventListener('click', event => {
      const item = event.target.closest('.legend-item');
      if (!item) return;
      const index = Number(item.dataset.index);
      if (sliced) target.toggleDataVisibility(index);
      else target.setDatasetVisibility(index, !target.isDatasetVisible(index));
      item.setAttribute('aria-pressed', String(item.getAttribute('aria-pressed') !== 'true'));
      timing(target, UPDATE_MS);
      target.update();
    });
  }

  function compare(left, right) {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  /* Render rows with search, filters and sorting. Cell renderers must return escaped HTML. */
  function table({ rows, body, columns, search, filters = [], count, reset, empty = 'No matching records.' }) {
    const tbody = document.getElementById(body);
    if (!tbody) return null;
    const searchBox = search && document.getElementById(search);
    const countBox = count && document.getElementById(count);
    const controls = filters.map(filter => ({ ...filter, element: document.getElementById(filter.id) }));
    const headings = [...(tbody.closest('table')?.querySelectorAll('th[data-sort]') || [])];
    let sortKey = null;
    let direction = 1;

    function render() {
      const query = (searchBox?.value || '').trim().toLowerCase();
      let visible = rows.filter(row => (!query || columns.some(column => String(row[column.key] ?? '').toLowerCase().includes(query)))
        && controls.every(({ element, key }) => !element?.value || String(row[key] ?? '') === element.value));
      if (sortKey) visible = [...visible].sort((a, b) => direction * compare(a[sortKey], b[sortKey]));
      tbody.innerHTML = visible.length
        ? visible.map(row => '<tr>' + columns.map(column => `<td>${column.render ? column.render(row) : escapeHtml(row[column.key])}</td>`).join('') + '</tr>').join('')
        : `<tr><td class="no-results" colspan="${columns.length}">${escapeHtml(empty)}</td></tr>`;
      if (countBox) countBox.textContent = `Showing ${visible.length} of ${rows.length}`;
      for (const heading of headings) {
        if (heading.dataset.sort === sortKey) heading.setAttribute('aria-sort', direction > 0 ? 'ascending' : 'descending');
        else heading.removeAttribute('aria-sort');
      }
    }

    function sortBy(key) {
      direction = sortKey === key ? -direction : 1;
      sortKey = key;
      render();
    }

    searchBox?.addEventListener('input', render);
    controls.forEach(({ element }) => element?.addEventListener('change', render));
    headings.forEach(heading => {
      heading.tabIndex = 0;
      heading.addEventListener('click', () => sortBy(heading.dataset.sort));
      heading.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sortBy(heading.dataset.sort); }
      });
    });
    if (reset) document.getElementById(reset)?.addEventListener('click', () => {
      if (searchBox) searchBox.value = '';
      controls.forEach(({ element }) => { if (element) element.value = ''; });
      sortKey = null;
      direction = 1;
      render();
    });
    render();
    return { render };
  }

  window.BobDashboard = { COLORS, chart, replay, update, legend, table, escapeHtml, carbonEasing };
  setupReplay();
  const start = () => { setupTabs(); revealBars(document); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
