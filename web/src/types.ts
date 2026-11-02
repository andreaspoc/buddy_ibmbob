import type { RequestDelivery } from './lib/requestDelivery';
export interface User {
  display_name?: string;
  email?: string | null;
  groups?: { id: string; name: string }[];
  username: string;
  is_admin: boolean;
}

export interface ManagedUser extends User {
  groups: { id: string; name: string }[];
}

export interface AdministrationUsers {
  users: ManagedUser[];
  pending_admins: string[];
}

export interface AuthStatus {
  keycloak_configured: boolean;
  local_login_enabled: boolean;
  setup_required: boolean;
  user: User | null;
}

export interface Project {
  id: string;
  name: string;
  is_active: boolean;
}

export interface SessionItem {
  id: string;
  title: string;
  updated_at: number;
  project_id?: string;
  deletion_pending?: boolean;
}

export interface Skill {
  name: string;
  description: string;
}

export interface Mode {
  slug: string;
  name: string;
  description: string;
  kind?: string;
}

export interface A2AAgent {
  slug: string;
  name: string;
  description?: string;
  card_url?: string;
  endpoint: string;
  protocol_version?: string;
  api_key?: string;
  api_key_header?: string;
}

export interface MCPServer {
  knowledge_base?: 'company';
  audience?: string;
  can_manage?: boolean;
  allowed?: boolean;
  disabled?: boolean;
  managed?: boolean;
  name: string;
  transport: string;
  target: string;
}

export interface MicrosoftStatus {
  configured: boolean;
  connected: boolean;
  account?: string | null;
  name?: string | null;
  signed_in?: boolean;
  scopes?: string[];
  missing_scopes?: string[];
}

export interface TaskItem {
  cost?: number | null;
  tokens?: number | null;
  guidance_supported?: boolean;
  kind: 'chat' | 'research' | 'workflow';
  id: string;
  session_id: string;
  title: string;
  mode: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  progress: string;
  created_at: string;
  updated_at: string;
  duration_ms?: number;
  terminal_event_id?: number | null;
}

export interface TaskDetail extends TaskItem {
  result: string;
  steps: Array<{ id: number; type: string; message: string; timestamp: string }>;
}

export interface WorkspacePage {
  is_presentation?: boolean;
  name: string;
  path: string;
  size: number;
}

export interface PresentationTemplate {
  titleSlideColors?: { background: string; text: string };
  custom?: boolean;
  id: string;
  title: string;
  brand: string;
  themeId: string;
  fonts: { heading: string; body: string };
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    chartPalette: string[];
  };
  slidesCount: number;
  slidePreviews: Array<{ id: string; layout: string; title: string }>;
}

export interface WorkStep {
  collaboration?: unknown;
  toolName?: string;
  id?: string;
  text: string;
  state?: 'started' | 'running' | 'success' | 'completed' | 'error' | 'failed' | string;
  input?: any;
  output?: any;
  timestamp: number;
}

export interface ChatMessage extends RequestDelivery {
  historyTurnIndex?: number;
  noteReferences?: Array<{ id: number; title: string; updated_at?: string; truncated?: boolean }>;
  officeReferences?: Array<{ id: string; name: string; revision?: number; truncated?: boolean }>;
  voiceMode?: boolean;
  correlationId?: string;
  jobId?: string;
  workspaceId?: string;
  editArtifactPath?: string;
  isPresentation?: boolean;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  displayPrompt?: string;
  presentationFormat?: 'pptx' | 'html';
  mode?: string;
  skillName?: string;
  agentName?: string;
  agentSlugs?: string[];
  templateId?: string;
  approvals?: ActionApproval[];
  guidance?: Array<{ id: string; text: string; status: string }>;
  workLog?: WorkStep[];
  isStreaming?: boolean;
  isStopping?: boolean;
  statusText?: string;
  skillsUsed?: string[];
  toolsUsed?: Array<{ name: string; status: string }>;
  deckJson?: any;
  presentationDeleted?: boolean;
  htmlFilename?: string;
  tokens?: number;
  cost?: number;
  durationMs?: number;
}

export interface ApprovalPolicy {
  mode: 'auto' | 'selected';
  actions: string[];
}

export interface ActionApproval {
  approval_id: string;
  job_id: string;
  title: string;
  detail?: unknown;
  status: 'pending' | 'approved' | 'rejected';
  scope?: 'action' | 'task';
  personal_data?: string[];
}

export interface SkillDetail extends Skill {
  instructions: string;
}
