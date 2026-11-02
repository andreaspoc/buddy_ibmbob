import { t } from './i18n';

export async function personalRequest(path: string, method = 'GET', body?: unknown) {
  const retryable = method === 'GET' || method === 'PUT';
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('/personalization/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ([502, 503, 504].includes(response.status) && retryable && attempt < 3) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    const unavailable = 'Settings are temporarily unavailable. Please try again.';
    const data = await response.json().catch(() => { throw new Error(t(unavailable)); });
    if (!response.ok) {
      throw new Error(t(response.status === 401 ? 'Your session has expired. Please sign in again.'
        : [502, 503, 504].includes(response.status) ? unavailable
        : typeof data?.detail === 'string' ? data.detail : 'Could not save settings'));
    }
    return data;
  }
}
