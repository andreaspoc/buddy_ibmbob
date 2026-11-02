// Authentication and application APIs share the Buddy origin in every mode.
export const API_BASE = '';
export const DECISIONS_API = '/api/decisions';

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${DECISIONS_API}${path}`, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === 'string' ? detail : detail?.message || `Request failed (HTTP ${response.status}).`);
  }
  return data;
}
