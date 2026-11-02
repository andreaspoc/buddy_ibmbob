import { useEffect, useRef, useState } from 'react';

export type InteractiveState = {
  selected?: number; done?: number[];
  values?: { total?: string; people?: string; tip?: string };
  filters?: string;
};
export async function widgetDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Server-owned state; no shared-browser localStorage and no replay of actions. */
export function useInteractiveState(source: string, identity: string, sessionId?: string, readOnly = false) {
  const [state, update] = useState<InteractiveState>({});
  const [status, setStatus] = useState<'loading' | 'saved' | 'saving' | 'error' | 'local'>('loading');
  const target = useRef<{ url: string; source_hash: string } | null>(null);
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    target.current = null;
    update({});
    if (!sessionId || readOnly) { setStatus('local'); return; }
    setStatus('loading');
    void (async () => {
      try {
        const source_hash = await widgetDigest(source);
        const key = await widgetDigest(identity + ':' + source_hash);
        const url = `/api/interactive/${encodeURIComponent(sessionId)}/${key}`;
        const response = await fetch(`${url}?source_hash=${source_hash}`);
        if (!response.ok) throw new Error('State unavailable');
        const data = await response.json();
        if (cancelled) return;
        target.current = { url, source_hash };
        update(data.state ?? {}); setStatus('saved');
      } catch { if (!cancelled) setStatus('error'); }
    })();
    return () => { cancelled = true; alive.current = false; };
  }, [source, identity, sessionId, readOnly]);
  function setState(next: InteractiveState) {
    update(next);
    const destination = target.current;
    if (!destination || readOnly) return;
    const writeRevision = ++revision.current;
    setStatus('saving');
    // Serialize writes so a slower old request cannot replace the latest selection.
    queue.current = queue.current.catch(() => {}).then(async () => {
      try {
        const response = await fetch(destination.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_hash: destination.source_hash, state: next }) });
        if (!response.ok) throw new Error('State unavailable');
        if (alive.current && target.current === destination && revision.current === writeRevision) setStatus('saved');
      } catch { if (alive.current && target.current === destination && revision.current === writeRevision) setStatus('error'); }
    });
  }
  return { state, setState, status };
}
