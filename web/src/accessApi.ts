import type { MCPServer } from './types';
export interface AccessProfile { mcps?: MCPServer[]; user: { username: string; display_name?: string; email?: string | null; groups: { id: string; name: string }[]; is_admin: boolean }; libraries: { id: 'company'; name: string }[]; audiences: string[]; administrator: boolean }
export interface PreviewDocument { id: string; filename: string; knowledge_base: 'company'; audience: string; status: string }
export interface AuditEvent { id: number; actor: string; actor_name?: string; action: string; target: string; target_name?: string; details: Record<string, unknown>; created_at: string }
export async function accessRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not load access information.');
  return data as T;
}
