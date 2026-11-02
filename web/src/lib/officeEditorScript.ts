/** Only load the configured OnlyOffice API script over a trusted transport. */
export function officeEditorScriptUrl(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (!((url.protocol === 'https:') || (url.protocol === 'http:' && url.origin === origin)) ||
      url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/web-apps/apps/api/documents/api.js')) {
    throw new Error('The Office editor script URL is invalid.');
  }
  return url.href;
}
