import { withoutSignInError } from './authUrl';

export type OfficeRoute = { fileId?: string; newKind?: 'word' | 'excel' | 'powerpoint' | 'csv' | 'pdf' | 'form' };
export function parseOfficeRoute(path = window.location.pathname): OfficeRoute | null {
  if (/^\/office\/?$/.test(path)) return {};
  const file = /^\/office\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(path);
  if (file) return { fileId: file[1].toLowerCase() };
  const create = /^\/office\/new\/(word|excel|powerpoint|csv|pdf|form)\/?$/.exec(path);
  return create ? { newKind: create[1] as OfficeRoute['newKind'] } : null;
}
export function navigateOffice(path = '/office', replace = false) {
  if (!parseOfficeRoute(path)) throw new Error('Invalid Office path');
  const state = { ...window.history.state };
  if (!parseOfficeRoute()) {
    const url = withoutSignInError(new URL(window.location.href));
    state.officeReturnPath = url.pathname + url.search + url.hash;
  }
  if (window.location.pathname !== path || window.location.search) window.history[replace ? 'replaceState' : 'pushState'](state, '', path);
  window.dispatchEvent(new Event('buddy-office-navigation'));
}
export function closeOfficeRoute() {
  const previous = window.history.state?.officeReturnPath;
  const safe = typeof previous === 'string' && previous.startsWith('/') && !previous.startsWith('//') && !parseOfficeRoute(previous.split('?')[0]);
  const url = withoutSignInError(new URL(safe ? previous : '/', window.location.origin));
  window.history.pushState({}, '', url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event('buddy-office-navigation'));
}
