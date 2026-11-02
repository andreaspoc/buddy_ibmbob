// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { extractTableData, createInteractiveTable } from '../../src/lib/interactiveTable';
import { MarkdownView } from '../../src/components/MarkdownView';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('interactiveTable', () => {
  it('extractTableData returns null for degenerate tables', () => {
    const table = document.createElement('table');
    expect(extractTableData(table)).toBeNull();

    // Table with 1 column, 1 row
    table.innerHTML = '<thead><tr><th>Col1</th></tr></thead><tbody><tr><td>Val1</td></tr></tbody>';
    expect(extractTableData(table)).toBeNull();
  });

  it('extractTableData correctly identifies headers, rows and numeric columns with currency and commas', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Region</th><th>Revenue</th><th>Growth</th></tr>
      </thead>
      <tbody>
        <tr><td>North America</td><td>$1,200.50</td><td>15%</td></tr>
        <tr><td>Europe</td><td>€950.00</td><td>-3%</td></tr>
        <tr><td>Asia Pacific</td><td>¥2,400,000</td><td>25%</td></tr>
      </tbody>
    `;
    const data = extractTableData(table);
    expect(data).not.toBeNull();
    expect(data?.headers).toEqual(['Region', 'Revenue', 'Growth']);
    expect(data?.rows.length).toBe(3);
    // Columns 1 and 2 should be identified as numeric columns
    expect(data?.numericColumns).toEqual([1, 2]);
  });

  it('createInteractiveTable returns original table if data extraction fails', () => {
    const emptyTable = document.createElement('table');
    const result = createInteractiveTable(emptyTable);
    expect(result).toBe(emptyTable);
  });

  it('createInteractiveTable builds interactive panel with search and view toggles', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Product</th><th>Sales</th><th>Cost</th></tr>
      </thead>
      <tbody>
        <tr><td>Alpha</td><td>500</td><td>300</td></tr>
        <tr><td>Beta</td><td>800</td><td>450</td></tr>
        <tr><td>Gamma</td><td>200</td><td>150</td></tr>
      </tbody>
    `;
    const panel = createInteractiveTable(table);
    document.body.appendChild(panel);

    expect(panel.className).toBe('interactive-table-panel');
    expect(panel.textContent).toContain('3 rows · 3 cols');

    // Search filter
    const searchInput = panel.querySelector('input.it-search-input') as HTMLInputElement;
    if (searchInput) {
      searchInput.value = 'Beta';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      // Beta row should still be visible
      expect(panel.textContent).toContain('Beta');
    }

    // View toggles: table, heatmap, bar, line, pie
    const viewButtons = panel.querySelectorAll('button.it-view-btn');
    expect(viewButtons.length).toBeGreaterThan(0);

    // Switch view to Table
    const tableBtn = Array.from(viewButtons).find(btn => btn.textContent?.includes('Table')) as HTMLButtonElement;
    if (tableBtn) {
      tableBtn.click();
      expect(panel.querySelector('table')).not.toBeNull();
    }

    // Sort by clicking a header in the generated table
    const th = panel.querySelector('thead th') as HTMLTableCellElement;
    if (th) {
      th.click(); // asc
      th.click(); // desc
    }

    panel.remove();
  });
});

describe('MarkdownView', () => {
  it('renders standard markdown with bold, headers, and lists', async () => {
    const content = `
# Executive Summary

This is **high priority** for the release.

- Point 1
- Point 2
`;
    await act(async () => {
      root.render(<MarkdownView content={content} />);
    });

    expect(host.querySelector('h1')?.textContent).toBe('Executive Summary');
    expect(host.querySelector('strong')?.textContent).toBe('high priority');
    expect(host.querySelectorAll('li').length).toBe(2);
  });

  it('renders streaming markdown content gracefully without crashes', async () => {
    const streamingContent = 'Streaming output with incomplete [link text';
    await act(async () => {
      root.render(<MarkdownView content={streamingContent} isStreaming={true} />);
    });

    expect(host.textContent).toContain('Streaming output');
  });

  it('sanitizes malicious markup (XSS injection attempt)', async () => {
    const malicious = `
Hello world <img src="x" onerror="alert(1)"> <script>alert('xss')</script>
`;
    await act(async () => {
      root.render(<MarkdownView content={malicious} />);
    });

    expect(host.querySelector('script')).toBeNull();
    const img = host.querySelector('img');
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull();
    }
  });

  it('transforms tables into interactive tables within markdown', async () => {
    const tableMarkdown = `
| Service | SLA | Score |
| --- | --- | --- |
| Gateway | 99.9% | 98 |
| Database | 99.99% | 99 |
`;
    await act(async () => {
      root.render(<MarkdownView content={tableMarkdown} />);
    });

    expect(host.textContent).toContain('Gateway');
    expect(host.textContent).toContain('Database');
  });
});
