/** Share invalidations, never private note or document content, between tabs. */
export function startWorkspaceUpdates() {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('buddy-workspace-updates');
  let receiving = false;
  const names = ['buddy-notes-changed', 'buddy-office-changed'] as const;
  const forward = (event: Event) => { if (!receiving) channel?.postMessage(event.type); };
  for (const name of names) window.addEventListener(name, forward);
  if (channel) channel.onmessage = event => {
    if (!names.includes(event.data)) return;
    receiving = true;
    try { window.dispatchEvent(new Event(event.data)); } finally { receiving = false; }
  };
  return () => { for (const name of names) window.removeEventListener(name, forward); channel?.close(); };
}
