import { useEffect, useState } from 'react';
// A newly built frontend must not offer references to an older backend that ignores them.
export function useOfficeIntegrationAvailable(enabled: boolean) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(false);
    if (!enabled) return;
    const controller = new AbortController();
    void fetch('/api/office/chat-capabilities', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const capabilities = await response.json();
      if (!controller.signal.aborted) setAvailable(capabilities.version === 1);
    }).catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return enabled && available;
}
