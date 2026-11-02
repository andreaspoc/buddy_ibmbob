import type { ApprovalPolicy } from '../types';

export const APPROVAL_ACTIONS = [
  ['commands', 'Run commands', 'Shell commands and scripts'],
  ['files', 'Change files', 'Create, edit, move, or delete files'],
  ['dependencies', 'Install dependencies', 'Packages and development tools'],
  ['messages', 'Send or submit', 'Messages and form submissions'],
  ['external', 'Update external systems', 'Records, settings, and connected services'],
  ['publish', 'Publish or deploy', 'Release content or application changes'],
] as const;
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { mode: 'auto', actions: APPROVAL_ACTIONS.map(([id]) => id) };

