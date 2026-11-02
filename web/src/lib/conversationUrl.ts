// Private browser links identify a conversation; public access requires a share token.
import { withoutSignInError } from './authUrl.ts';
export function updateConversationUrl(sessionId: string, projectId: string) {
  const url = withoutSignInError(new URL(window.location.href));
  if (url.pathname === '/office' || url.pathname.startsWith('/office/')) return;
  if (parseSharedConversation(url.pathname)) url.pathname = '/';
  if (sessionId) url.searchParams.set('conversation', sessionId);
  else url.searchParams.delete('conversation');
  if (projectId) url.searchParams.set('project', projectId);
  else url.searchParams.delete('project');
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

export type SharedConversationLink = { sessionId?: string; token: string };
export function parseSharedConversation(path: string): SharedConversationLink | null {
  const match = path.match(/^\/shared\/(?:(legacy|[a-f0-9]{32})\/)?([A-Za-z0-9_-]{43})\/?$/);
  return match ? { sessionId: match[1], token: match[2] } : null;
}


export function isNotesPath(path: string): boolean {
  return /^\/notes(?:\/(?:[1-9]\d*|new))?\/?$/.test(path);
}

// Keep conversation/project query parameters while moving between personal notes and chat.
// A shared conversation also retains its token-bearing return path in browser history state.
export function navigateNotes(open: boolean): void {
  const url = withoutSignInError(new URL(window.location.href));
  const inNotes = isNotesPath(url.pathname);
  if (open === inNotes) return;
  const state = { ...window.history.state };
  if (open) {
    state.notesReturnPath = url.pathname;
    url.pathname = '/notes';
  } else {
    const returnPath = state.notesReturnPath;
    url.pathname = typeof returnPath === 'string' && parseSharedConversation(returnPath) ? returnPath : '/';
    delete state.notesReturnPath;
  }
  window.history.pushState(state, '', url);
}

export function isProjectsPath(path: string): boolean {
  return /^\/projects(?:\/(?:view\/[^/]+|tabs\/(?:overview|portfolio|timeline|people|impact|merged)))?\/?$/.test(path);
}

/** The portfolio route is distinct from personal code-workspace API requests. */
export function navigateProjects(open: boolean, replace = false): void {
  const url = withoutSignInError(new URL(window.location.href));
  if (open === isProjectsPath(url.pathname)) return;
  const state = { ...window.history.state };
  if (open) {
    state.projectsReturnPath = url.pathname;
    url.pathname = '/projects';
    if (isProjectsPath(url.searchParams.get('next') || '')) url.searchParams.delete('next');
  } else {
    const previous = state.projectsReturnPath;
    url.pathname = typeof previous === 'string' && (isNotesPath(previous) || parseSharedConversation(previous)) ? previous : '/';
    delete state.projectsReturnPath;
  }
  window.history[replace ? 'replaceState' : 'pushState'](state, '', url);
}
