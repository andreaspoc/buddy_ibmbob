// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createInteractiveTable, extractTableData } from '../../src/lib/interactiveTable';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function makeTable() {
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Name</th><th>Amount</th></tr></thead><tbody><tr><td>Beta</td><td>10</td></tr><tr><td>Alpha</td><td>2</td></tr><tr><td>Gamma</td><td>30</td></tr></tbody>';
  const panel = createInteractiveTable(table);
  document.body.append(panel);
  return panel;
}

test('numeric sorting cycles ascending, descending and original order', () => {
  const panel = makeTable();
  const rows = () => Array.from(panel.querySelectorAll('tbody tr')).map(row => row.cells[0].textContent);
  const sort = () => (panel.querySelectorAll('thead th')[1] as HTMLElement).click();
  sort(); expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma']);
  sort(); expect(rows()).toEqual(['Gamma', 'Beta', 'Alpha']);
  sort(); expect(rows()).toEqual(['Beta', 'Alpha', 'Gamma']);
});

test('filter applies to table and chart, including the empty result state', () => {
  const panel = makeTable();
  const search = panel.querySelector('input') as HTMLInputElement;
  search.value = '  ALPHA  ';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(panel.querySelector('.it-count-badge')?.textContent).toContain('1 of 3');
  expect(panel.querySelector('tbody')?.textContent).toContain('Alpha');
  expect(panel.querySelector('tbody')?.textContent).not.toContain('Beta');
  (panel.querySelector('button[title="Visualize as Bar Chart"]') as HTMLButtonElement).click();
  search.value = 'missing'; search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(panel.querySelector('.it-chart-empty')?.textContent).toContain('No rows to visualize');
  (panel.querySelector('button[title="View spreadsheet data table"]') as HTMLButtonElement).click();
  expect(panel.querySelector('.it-empty-cell')?.textContent).toContain('No matching rows');
});

test('copies only filtered rows and gives temporary feedback', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const panel = makeTable();
  const search = panel.querySelector('input') as HTMLInputElement;
  search.value = 'alpha'; search.dispatchEvent(new Event('input', { bubbles: true }));
  const copy = panel.querySelector('button[title="Copy data for Excel"]') as HTMLButtonElement;
  copy.click(); await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith('Name\tAmount\nAlpha\t2');
  expect(copy.textContent).toContain('Copied!');
  vi.advanceTimersByTime(2000);
  expect(copy.textContent).toContain('Copy');
  delete (navigator as any).clipboard;
});

test('extracts simple tables with a header row and detects numeric columns', () => {
  const table = document.createElement('table');
  table.innerHTML = '<tr><td>Item</td><td>Value</td></tr><tr><td>One</td><td>€1,200</td></tr><tr><td>Two</td><td>75%</td></tr>';
  expect(extractTableData(table)).toEqual({ headers: ['Item', 'Value'], rows: [['One', '€1,200'], ['Two', '75%']], numericColumns: [1] });
});
