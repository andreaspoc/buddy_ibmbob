/** Keep untrusted text from becoming a spreadsheet formula on import/paste. */
export function spreadsheetText(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r\n\0]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: unknown): string {
  const text = spreadsheetText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function tsvCell(value: unknown): string {
  return spreadsheetText(value).replace(/[\t\r\n]/g, ' ');
}
