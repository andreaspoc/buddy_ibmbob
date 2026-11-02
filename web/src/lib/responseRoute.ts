/** Model session_id is an ACP context, so only workspace/chat ids route UI events. */
export type ResponseRoute = { workspaceId: string; jobId?: string | null; correlationId?: string; userMessageId?: string; assistantMessageId?: string };
export function matchesResponseRoute(event: unknown, route: ResponseRoute): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const metadata = event as Record<string, unknown>;
  const fields: Array<[string, string | null | undefined]> = [
    ['workspace_id', route.workspaceId], ['chat_id', route.workspaceId],
    ['job_id', route.jobId], ['correlation_id', route.correlationId],
    ['user_message_id', route.userMessageId], ['assistant_message_id', route.assistantMessageId],
  ];
  // Historical events without routing metadata remain readable.
  return fields.every(([key, expected]) => expected == null || metadata[key] == null || metadata[key] === expected);
}

/** Both push and response streams can carry the same persisted artifact event. */
export function acceptArtifactRevision(versions: Map<string, number>, key: string, eventId: unknown): boolean {
  if (typeof eventId !== 'number' || !Number.isSafeInteger(eventId) || eventId <= 0) return !versions.has(key);
  if (eventId <= (versions.get(key) || 0)) return false;
  versions.set(key, eventId);
  return true;
}
