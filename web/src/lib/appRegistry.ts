import { useCallback, useEffect, useState } from 'react';
export interface WorkspaceApp {
  id: string; name: string; description: string; kind: 'core' | 'installed'; desktop_only: boolean; disabled?: boolean;
  launch: { kind: string; url?: string; embed?: boolean; target?: '_self' | '_blank' };
}
interface Snapshot { owner: string | boolean; apps: WorkspaceApp[]; loaded: boolean; error: boolean }
export function useAppRegistry(account?: string | boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ owner: false, apps: [], loaded: false, error: false });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const response = await fetch('/api/apps', { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('registry');
        const data = await response.json();
        if (!Array.isArray(data.apps)) throw new Error('registry');
        if (!controller.signal.aborted) setSnapshot({ owner: account, apps: data.apps, loaded: true, error: false });
      } catch {
        if (!controller.signal.aborted) setSnapshot(previous => ({ owner: account, apps: previous.owner === account ? previous.apps : [], loaded: true, error: true }));
      } finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [account, revision]);
  return { ...(snapshot.owner === account && account ? snapshot : { apps: [], loaded: false, error: false }), refresh };
}

/** Purpose-based directory groups; availability still comes from the server registry. */
export const workspaceAppGroups = [
  { id: 'projects', label: 'Projects & delivery' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'create', label: 'Presentations' },
  { id: 'knowledge', label: 'Knowledge & research' },
  { id: 'automation', label: 'Automation' },
  { id: 'tools', label: 'Search saved work' },
  { id: 'installed', label: 'Installed apps' },
] as const;
export type WorkspaceAppGroup = typeof workspaceAppGroups[number]['id'];
export function workspaceAppGroup(app: WorkspaceApp): WorkspaceAppGroup {
  if (['projects', 'tasks', 'productivity'].includes(app.id)) return 'projects';
  if (['chat', 'notes', 'office', 'people'].includes(app.id)) return 'workspace';
  if (app.id === 'presentations') return 'create';
  if (['knowledge', 'research', 'docmost'].includes(app.id)) return 'knowledge';
  if (['workflows', 'decisions', 'zen'].includes(app.id)) return 'automation';
  if (['search', 'connections'].includes(app.id)) return 'tools';
  return 'installed';
}
