export const WORKSPACE_VIEWS = ['tasks','knowledge','administration'] as const;
export const WORKSPACE_PANELS = ['personalization','sharing','artifacts','documents','research','access','search','comparison','project-memory','productivity','notifications','agent-catalog','mcp-catalog'] as const;
export const WORKSPACE_OVERLAYS = ['connections','workflows','decisions','mods','apps','templates','docmost'] as const;
export function parseWorkspaceUrl(path = window.location.pathname) {
  const match = /^\/app\/([a-z-]+)(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  const name = match[1];
  if (![...WORKSPACE_VIEWS,...WORKSPACE_PANELS,...WORKSPACE_OVERLAYS].some(item => item === name)) return null;
  let taskId = '';
  try { if (name === 'tasks' && match[2]) taskId = decodeURIComponent(match[2]); } catch { return null; }
  return { name, taskId };
}
export function workspacePath(name: string, taskId = '') {
  return `/app/${name}${name === 'tasks' && taskId ? `/${encodeURIComponent(taskId)}` : ''}`;
}
