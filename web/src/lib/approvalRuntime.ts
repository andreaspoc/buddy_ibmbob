import type { ApprovalPolicy } from '../types';
import { APPROVAL_ACTIONS } from './approvalPolicy';

export interface ApprovalRuntime {
  policy: ApprovalPolicy;
  revision: number;
  mutable: boolean;
  reason: string | null;
}
export async function fetchApprovalRuntime(jobId: string, policy?: ApprovalPolicy, signal?: AbortSignal): Promise<ApprovalRuntime> {
  const response = await fetch(`/jobs/${encodeURIComponent(jobId)}/approval-policy`, {
    method: policy ? 'PUT' : 'GET', signal,
    ...(policy ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Could not update task approval settings.');
  if (!data?.policy || !['auto', 'selected'].includes(data.policy.mode) || !Array.isArray(data.policy.actions)
    || !data.policy.actions.every((action: string) => APPROVAL_ACTIONS.some(([id]) => id === action))
    || !Number.isInteger(data.revision) || typeof data.mutable !== 'boolean') throw new Error('Invalid approval settings response.');
  return data;
}
