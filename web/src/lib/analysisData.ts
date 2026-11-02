/** Validate supplied analysis data without inferring or fabricating missing values. */
export interface AnalysisData {
  title?: string;
  source?: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
}

export function normalizeAnalysisData(value: unknown): AnalysisData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.headers) || data.headers.length < 2 || data.headers.length > 50 ||
      !data.headers.every(header => typeof header === 'string' && header.trim().length > 0)) return null;
  if (!Array.isArray(data.rows) || data.rows.length === 0 || data.rows.length > 5000) return null;
  const width = data.headers.length;
  if (!data.rows.every(row => Array.isArray(row) && row.length === width && row.every(cell =>
    cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell))))) return null;
  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    source: typeof data.source === 'string' ? data.source : undefined,
    headers: [...data.headers] as string[],
    rows: data.rows.map(row => [...row]) as AnalysisData['rows'],
  };
}

/** Gate the legacy numeric converter for this opt-in workspace only. */
export function hasIncompleteAnalysisValues(data: AnalysisData): boolean {
  if (data.rows.some(row => row.some(cell => cell === null || (typeof cell === 'string' && !cell.trim())))) return true;
  return data.headers.some((_, index) => {
    const numeric = data.rows.map(row => {
      const value = row[index];
      if (typeof value === 'number') return true;
      const cleaned = String(value).replace(/[$€£¥%,]/g, '').trim();
      return cleaned.length > 0 && Number.isFinite(Number(cleaned));
    });
    const count = numeric.filter(Boolean).length;
    return count / numeric.length >= 0.6 && count !== numeric.length;
  });
}
