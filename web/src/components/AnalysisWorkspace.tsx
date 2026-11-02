import { Toolbar } from './Toolbar';
import { useEffect, useRef } from 'react';
import type { AnalysisData } from '../lib/analysisData';
import { createInteractiveTable } from '../lib/interactiveTable';
import { normalizeAnalysisData, hasIncompleteAnalysisValues } from '../lib/analysisData';
import { t } from '../lib/i18n';

/** Reuses the existing Carbon-styled grid, charts, filters, heatmap and exports. */
export interface AnalysisWorkspaceProps extends AnalysisData {
  title: string;
  ready?: boolean;
  filters?: string;
  onFiltersChange?: (filters: string) => void;
  onPrompt?: (prompt: string) => void;
}

export function AnalysisWorkspace({ title, headers, rows, source, onPrompt, ready = true, filters, onFiltersChange }: AnalysisWorkspaceProps) {
  const data = { title, headers, rows, source };
  const dialog = useRef<HTMLDialogElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const initialFilters = useRef(filters);
  const reportFilters = useRef(onFiltersChange);
  reportFilters.current = onFiltersChange;
  const normalized = normalizeAnalysisData(data);
  useEffect(() => {
    if (!host.current || !ready) return;
    initialFilters.current = filters;
    const current = normalizeAnalysisData(data);
    if (!current) { host.current.replaceChildren(); return; }
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    current.headers.forEach(header => {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = header; head.append(cell);
    });
    const body = table.createTBody();
    current.rows.forEach(row => {
      const tr = body.insertRow();
      row.forEach(value => { tr.insertCell().textContent = value === null ? '' : String(value); });
    });
    // The legacy chart view converts missing values to zero. Keep incomplete
    // source datasets as a table so an absent measurement is never charted as zero.
    const hasMissing = hasIncompleteAnalysisValues(current);
    host.current.replaceChildren(hasMissing ? table : createInteractiveTable(table));
    const root = host.current;
    // Adapt only this new workspace; the existing table renderer stays unchanged.
    try {
      const saved = JSON.parse(initialFilters.current || '{}');
      const search = root.querySelector<HTMLInputElement>('.it-search-input');
      if (search && typeof saved.q === 'string') { search.value = saved.q; search.dispatchEvent(new Event('input', { bubbles: true })); }
      if (Number.isInteger(saved.sort) && saved.sort >= 0 && saved.sort < current.headers.length) {
        (root.querySelectorAll<HTMLElement>('.it-header-cell')[saved.sort])?.click();
        if (saved.direction === 'desc') (root.querySelectorAll<HTMLElement>('.it-header-cell')[saved.sort])?.click();
      }
      if (Number.isInteger(saved.view) && saved.view >= 0 && saved.view < 5) root.querySelectorAll<HTMLButtonElement>('.it-view-btn')[saved.view]?.click();
    } catch { /* A changed view starts from the existing table defaults. */ }
    const capture = (event: Event) => {
      const target = event.target as Element;
      if (!target.closest('.it-search-input,.it-header-cell,.it-view-btn')) return;
      const cells = Array.from(root.querySelectorAll<HTMLElement>('.it-header-cell'));
      const sorted = cells.findIndex(cell => cell.classList.contains('is-sorted'));
      const selected = Array.from(root.querySelectorAll('.it-view-btn')).findIndex(button => button.classList.contains('is-active'));
      reportFilters.current?.(JSON.stringify({ q: root.querySelector<HTMLInputElement>('.it-search-input')?.value ?? '', view: selected, sort: sorted, direction: sorted >= 0 && cells[sorted].textContent?.includes('▼') ? 'desc' : 'asc' }));
    };
    root.addEventListener('input', capture); root.addEventListener('click', capture);
    return () => { root.removeEventListener('input', capture); root.removeEventListener('click', capture); root.replaceChildren(); };
  }, [title, headers, rows, source, ready]);
  if (!normalized) return <p role="status">{t('Analysis data is unavailable or invalid. Provide column names and complete rows of source data.')}</p>;
  return <section className="analysis-workspace" aria-label={normalized.title || t('Data analysis')}>
    {normalized.title && <h3>{normalized.title}</h3>}
    {normalized.source && <p className="analysis-source">{t('Source')}: {normalized.source}</p>}
    <button ref={expand} type="button" className="chart-maximize-button" aria-haspopup="dialog" onClick={() => {
      if (!dialog.current || !host.current || typeof dialog.current.showModal !== 'function') return;
      dialog.current.append(host.current);
      dialog.current.showModal();
    }}>{t('Expand data workspace')}</button>
    <div ref={dock} className="analysis-live-view"><div ref={host} /></div>
    <table className="analysis-print-source" aria-label={normalized.title}>
      <thead><tr>{normalized.headers.map((header, index) => <th scope="col" key={index}>{header}</th>)}</tr></thead>
      <tbody>{normalized.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell === null ? '' : String(cell)}</td>)}</tr>)}</tbody>
    </table>
    <dialog ref={dialog} className="chart-maximized-dialog" aria-label={normalized.title || t('Data analysis')} onClose={() => {
      if (host.current) dock.current?.append(host.current);
      expand.current?.focus();
    }}>
      <Toolbar className="chart-maximized-header"><strong>{normalized.title}</strong>
        <button type="button" className="chart-maximize-button" onClick={() => dialog.current?.close()}>{t('Close')}</button>
      </Toolbar>
    </dialog>
    {hasIncompleteAnalysisValues(normalized) &&
      <p role="note">{t('Missing or nonnumeric measurements remain unchanged. Charts are unavailable for incomplete datasets.')}</p>}
    {onPrompt && <button type="button" className="analysis-followup" onClick={() => onPrompt(`Analyze the supplied dataset “${normalized.title || 'Data analysis'}”. Explain findings and limitations using only these values: ${JSON.stringify({ headers: normalized.headers, rows: normalized.rows, source: normalized.source })}`)}>{t('Analyze whole dataset')}</button>}
  </section>;
}
