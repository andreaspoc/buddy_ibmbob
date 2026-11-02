import { useCallback, useEffect, useRef, useState } from 'react';
import { redactActivity } from './redaction';

export type MCPCheck = { status: 'working' | 'error'; message: string; tools?: string[]; checked_at?: string };

// Checks never call a provider tool or send a message: initialize + discovery only.
export function useMCPHealth(path: string, enabled: boolean, revision?: unknown) {
  const [result, setResult] = useState<MCPCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const check = useCallback(async () => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setChecking(true);
    try {
      const response = await fetch(path, { method: 'POST', signal: active.signal });
      if (!response.ok) throw new Error('Check failed');
      const value = redactActivity(await response.json());
      if (!active.signal.aborted) setResult(value);
    } catch {
      if (!active.signal.aborted) setResult({ status: 'error', message: 'Could not check this server. Check your connection and try again.' });
    } finally {
      if (!active.signal.aborted) setChecking(false);
    }
  }, [path]);
  useEffect(() => {
    setResult(null);
    setChecking(false);
    if (!enabled) return;
    void check();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 60000);
    return () => { window.clearInterval(timer); controller.current?.abort(); };
  }, [check, enabled, revision]);
  return { result, checking, check };
}
