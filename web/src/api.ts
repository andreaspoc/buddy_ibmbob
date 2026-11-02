import { zip } from 'fflate';
import type { SkillDetail } from './types';
import type {
  A2AAgent,
  AuthStatus,
  MCPServer,
  MicrosoftStatus,
  Mode,
  PresentationTemplate,
  Project,
  SessionItem,
  Skill,
  WorkspacePage,
  TaskItem,
  TaskDetail,
} from './types';

export async function fetchTasks(signal?: AbortSignal): Promise<TaskItem[]> {
  const res = await fetch('/tasks', { signal });
  if (!res.ok) throw new Error('Could not load tasks.');
  return res.json();
}

export async function fetchTask(id: string, signal?: AbortSignal): Promise<TaskDetail> {
  const res = await fetch(`/tasks/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(res.status === 404 ? 'Task is no longer available.' : 'Could not load task results.');
  return res.json();
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/auth/status');
  if (!res.ok) throw new Error('Failed to fetch auth status');
  return res.json();
}

export async function login(username: string, password: string):Promise<{ username: string; is_admin: boolean }> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Login failed');
  }
  return res.json();
}

export async function logout(): Promise<void> {
  const response = await fetch('/auth/logout', { method: 'POST' });
  if (!response.ok) throw new Error('Could not end the server session.');
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch('/projects');
  if (!res.ok) return [];
  return res.json();
}

export async function createProjectGit(name: string, url: string, branch?: string, token?: string): Promise<Project> {
  const res = await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, branch: branch || undefined, token: token || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to clone repository');
  }
  return res.json();
}

export async function createEmptyProject(name: string): Promise<Project> {
  const res = await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url: '' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to create project');
  }
  return res.json();
}

export async function uploadProjectZip(name: string, file: File | Blob): Promise<Project> {
  const res = await fetch(`/projects/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to upload and extract ZIP');
  }
  return res.json();
}

export async function fetchSessions(projectId?: string): Promise<SessionItem[]> {
  const url = `/sessions${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

export async function createSession(projectId?: string): Promise<{ id: string }> {
  const url = `/sessions${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Failed to delete conversation');
  }
}

export async function deleteSessionMessage(sessionId: string, messageId: string): Promise<{ cleanup_pending?: boolean }> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not delete this message.');
  }
  return res.json();
}

export async function fetchSessionHistory(sessionId: string): Promise<any[]> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/history`);
  if (!res.ok) throw new Error('Could not load conversation history.');
  return res.json();
}

export async function fetchSkills(): Promise<Skill[]> {
  const res = await fetch('/skills');
  if (!res.ok) return [];
  return res.json();
}

export async function fetchModes(): Promise<Mode[]> {
  const res = await fetch('/modes');
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMcps(): Promise<MCPServer[]> {
  const res = await fetch('/mcps');
  if (!res.ok) return [];
  return res.json();
}

export async function deleteMcp(name: string): Promise<void> {
  const res = await fetch(`/mcps/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Failed to delete MCP server');
  }
}

export async function fetchAgents(): Promise<A2AAgent[]> {
  const res = await fetch('/agents');
  if (!res.ok) return [];
  return res.json();
}

export async function createAgent(data: {
  slug: string;
  card_url: string;
  endpoint_override?: string;
  api_key?: string;
  api_key_header?: string;
  auth_token?: string;
}): Promise<A2AAgent> {
  const res = await fetch('/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to create agent');
  }
  return res.json();
}

export async function updateAgent(
  slug: string,
  data: Partial<A2AAgent>,
): Promise<A2AAgent> {
  const res = await fetch(`/agents/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to update agent');
  }
  return res.json();
}

export async function deleteAgent(slug: string): Promise<void> {
  const res = await fetch(`/agents/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to delete agent');
  }
}

export async function fetchPages(sessionId?: string): Promise<WorkspacePage[]> {
  const url = `/workspace/pages${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchTemplates(): Promise<PresentationTemplate[]> {
  const res = await fetch('/presentation/templates');
  if (!res.ok) return [];
  return res.json();
}

export interface PresentationIntent {
  html_artifact?: boolean;
  html_artifact_path?: string | null;
  presentation: boolean;
  format: 'html' | 'pptx' | null;
  slide_count: number | null;
  templates: PresentationTemplate[];
}

export async function presentationIntent(prompt: string, mode?: string, skill_name?: string): Promise<PresentationIntent> {
  const response = await fetch('/presentation/intent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, mode, skill_name }),
  });
  if (!response.ok) throw new Error('Could not load presentation setup. Please retry.');
  return response.json();
}

export async function fetchLatestDeck(sessionId: string): Promise<any | null> {
  try {
    const res = await fetch(`/presentation/decks?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const decks = await res.json();
    if (decks && decks.length > 0) {
      const deckRes = await fetch(`/presentation/deck?path=${encodeURIComponent(decks[0].path)}&session_id=${encodeURIComponent(sessionId)}`);
      if (deckRes.ok) return await deckRes.json();
    }
  } catch {}
  return null;
}

export async function fetchDeckByPath(path: string, sessionId: string): Promise<any | null> {
  try {
    const res = await fetch(`/presentation/deck?path=${encodeURIComponent(path)}&session_id=${encodeURIComponent(sessionId)}`);
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

export async function fetchMicrosoftStatus(): Promise<MicrosoftStatus> {
  const res = await fetch('/auth/microsoft/status');
  if (!res.ok) return { configured: false, connected: false };
  return res.json();
}

export async function disconnectMicrosoft(): Promise<void> {
  await fetch('/auth/microsoft/disconnect', { method: 'POST' });
}

export interface UploadedFileResponse {
  session_id?: string;
  document?: { path: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'unprepared'; prepared_path?: string | null; error?: string | null } | null;
  filename: string;
  path: string;
  size: number;
  is_spreadsheet: boolean;
  summary?: {
    filename: string;
    format: string;
    total_rows?: number;
    columns?: string[];
    preview_markdown?: string;
    sheets_count?: number;
    sheets?: Array<{ sheet_name: string; total_rows: number; columns: string[] }>;
    error?: string;
  };
}

export async function uploadSessionFile(sessionId: string, file: File): Promise<UploadedFileResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const targetSession = sessionId || 'legacy';
  const res = await fetch(`/sessions/${encodeURIComponent(targetSession)}/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to upload file');
  }
  return res.json();
}

export async function fetchSessionFiles(sessionId: string): Promise<Array<{ name: string; size: number; modified: number; is_spreadsheet: boolean }>> {
  const targetSession = sessionId || 'legacy';
  const res = await fetch(`/sessions/${encodeURIComponent(targetSession)}/files`);
  if (!res.ok) return [];
  return res.json();
}

export async function saveSessionFile(sessionId: string, path: string, content: string): Promise<void> {
  const targetSession = sessionId || 'legacy';
  const res = await fetch(`/sessions/${encodeURIComponent(targetSession)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) {
    // If not found in sessions, try workspace/page
    const pageRes = await fetch(`/workspace/page?session_id=${encodeURIComponent(targetSession)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    if (!pageRes.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to save file');
    }
  }
}


export async function deleteSessionFile(sessionId: string, path: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId || 'legacy')}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Failed to delete file');
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await fetch(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Failed to delete project');
  }
}

export interface BobHook {
  id: string;
  name: string;
  description?: string;
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';
  matcher: string;
  command?: string;
  script_code?: string;
  timeout: number;
  enabled: boolean;
  is_blocking: boolean;
}

export interface BobHookTemplate {
  id: string;
  name: string;
  description: string;
  event: string;
  matcher: string;
  timeout: number;
  is_blocking: boolean;
  script_code: string;
}

export const BUILTIN_HOOK_TEMPLATES_FALLBACK: BobHookTemplate[] = [
  {
    id: 'tpl-guard-destructive-commands',
    name: 'Guard Destructive Commands',
    description: 'Blocks rm -rf, mkfs, drop table/database, and git push --force commands before execution.',
    event: 'PreToolUse',
    matcher: '^(run_command|execute_bash|bash|sh)$',
    timeout: 5000,
    is_blocking: true,
    script_code: `#!/bin/bash
PAYLOAD=$(cat)
CMD=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('tool_input', {}).get('command', '') or data.get('tool_input', {}).get('CommandLine', ''))")

if echo "$CMD" | grep -Ei "(rm\\s+-[a-zA-Z]*r[a-zA-Z]*f|mkfs|drop\\s+database|drop\\s+table|git\\s+push\\s+.*--force)" > /dev/null; then
  echo "BLOCKED: Destructive command detected in tool input: $CMD" >&2
  exit 2
fi
exit 0
`,
  },
  {
    id: 'tpl-protect-sensitive-files',
    name: 'Protect Sensitive & Config Files',
    description: 'Prevents file write/edit actions targeting .env, .git/, id_rsa, and production configs.',
    event: 'PreToolUse',
    matcher: '^(write_file|save_session_file|write_to_file|edit_file)$',
    timeout: 5000,
    is_blocking: true,
    script_code: `#!/bin/bash
PAYLOAD=$(cat)
PATH_ARG=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('tool_input', {}).get('path', '') or data.get('tool_input', {}).get('TargetFile', ''))")

if echo "$PATH_ARG" | grep -Ei "(\\.env|\\.git/|id_rsa|\\.pem|credentials|production\\.json)$" > /dev/null; then
  echo "BLOCKED: Modifying sensitive or secret file '$PATH_ARG' is forbidden by workspace policy." >&2
  exit 2
fi
exit 0
`,
  },
  {
    id: 'tpl-scan-prompt-pii',
    name: 'Prompt Credentials & Secret Scanner',
    description: 'Scans prompts for accidentally pasted OpenAI/AWS keys or passwords before sending to model.',
    event: 'UserPromptSubmit',
    matcher: '.*',
    timeout: 5000,
    is_blocking: true,
    script_code: `#!/bin/bash
PAYLOAD=$(cat)
PROMPT=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('prompt', ''))")

if echo "$PROMPT" | grep -Ei "(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|password\\s*=\\s*['\\\"][^'\\\"]+)" > /dev/null; then
  echo "BLOCKED: Prompt contains potential hardcoded API credentials or secret token. Please remove secrets before submitting." >&2
  exit 2
fi
exit 0
`,
  },
  {
    id: 'tpl-auto-format-python',
    name: 'Auto-Format Python Files',
    description: 'Automatically runs formatting tools after Python file modifications.',
    event: 'PostToolUse',
    matcher: '^(write_file|save_session_file|write_to_file)$',
    timeout: 8000,
    is_blocking: false,
    script_code: `#!/bin/bash
PAYLOAD=$(cat)
FILE=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('tool_input', {}).get('path', '') or data.get('tool_input', {}).get('TargetFile', ''))")

if [[ "$FILE" == *.py ]] && [ -f "$FILE" ]; then
  python3 -m ruff format "$FILE" 2>/dev/null || python3 -m black "$FILE" 2>/dev/null || true
  echo "Formatted Python file: $FILE"
fi
exit 0
`,
  },
  {
    id: 'tpl-git-branch-context',
    name: 'Inject Git Branch & Status Context',
    description: 'Detects Git workspace branch and dirty file status to provide situational context.',
    event: 'SessionStart',
    matcher: '.*',
    timeout: 4000,
    is_blocking: false,
    script_code: `#!/bin/bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  STATUS=$(git status --short 2>/dev/null | head -n 5)
  echo "Active Git Branch: $BRANCH"
  if [ -n "$STATUS" ]; then
    echo "Pending changes:"
    echo "$STATUS"
  fi
fi
exit 0
`,
  },
];

async function callHooksEndpoint(path: string, options?: RequestInit): Promise<Response> {
  // Try /hooks first, fall back to /api/hooks if /hooks returns 404
  const res = await fetch(`/hooks${path}`, options);
  if (res.status === 404) {
    return fetch(`/api/hooks${path}`, options);
  }
  return res;
}

export async function fetchHooks(): Promise<{ hooks: BobHook[]; templates: BobHookTemplate[] }> {
  try {
    const res = await callHooksEndpoint('');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        // Backend might still be starting or restarting
        return { hooks: [], templates: BUILTIN_HOOK_TEMPLATES_FALLBACK };
      }
      throw new Error(data.detail || `Could not load hooks (${res.status}).`);
    }
    const result = await res.json();
    return {
      hooks: result.hooks || [],
      templates: (result.templates && result.templates.length > 0) ? result.templates : BUILTIN_HOOK_TEMPLATES_FALLBACK,
    };
  } catch (err: any) {
    // If network error occurred, return fallback templates so user can still see and draft templates
    if (err.name === 'TypeError' || err.message?.includes('fetch')) {
      return { hooks: [], templates: BUILTIN_HOOK_TEMPLATES_FALLBACK };
    }
    throw err;
  }
}

export async function saveHook(hook: Partial<BobHook>): Promise<BobHook> {
  const res = await callHooksEndpoint('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hook),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Failed to save hook (${res.status}).`);
  }
  return res.json();
}

export async function deleteHook(hookId: string): Promise<void> {
  const res = await callHooksEndpoint(`/${encodeURIComponent(hookId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Failed to delete hook (${res.status}).`);
  }
}

export async function toggleHook(hookId: string, enabled: boolean): Promise<void> {
  const res = await callHooksEndpoint(`/${encodeURIComponent(hookId)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Failed to toggle hook (${res.status}).`);
  }
}

export async function testHook(testData: {
  command?: string;
  script_code?: string;
  event: string;
  payload?: any;
}): Promise<{ exit_code: number; stdout: string; stderr: string; blocked: boolean; allowed: boolean }> {
  const res = await callHooksEndpoint('/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Failed to test hook (${res.status}).`);
  }
  return res.json();
}


export async function sendChatGuidance(jobId: string, instruction: string): Promise<void> {
  const response = await fetch(`/jobs/${encodeURIComponent(jobId)}/guidance`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(typeof failure?.detail === 'string' ? failure.detail : 'Could not send guidance. Please retry.');
  }
}

export async function fetchSkill(name: string, signal?: AbortSignal): Promise<SkillDetail> {
  const response = await fetch(`/skills/${encodeURIComponent(name)}`, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not load skill');
  return result;
}

export async function updateSkill(name: string, updates: Pick<SkillDetail, 'description' | 'instructions'>): Promise<SkillDetail> {
  const response = await fetch(`/skills/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not save skill');
  return result;
}

export async function createSkill(skill: SkillDetail): Promise<Skill> {
  const response = await fetch('/skills', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(skill)});
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not create skill');
  return result;
}

export async function deleteSkill(name: string): Promise<void> {
  const response = await fetch(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not delete skill');
  }
}

export async function uploadProjectFolder(name: string, files: File[]): Promise<Project> {
  const excluded = new Set(['.git', '.bob', '.home', 'node_modules', '.venv', '__pycache__']);
  const selected = files.filter(file => !file.webkitRelativePath.split('/').slice(1).some(part => excluded.has(part)));
  if (!selected.length) throw new Error('Choose a folder containing project files, or create an empty project.');
  if (selected.length > 10000 || selected.reduce((sum, file) => sum + file.size, 0) > 200 * 1024 * 1024)
    throw new Error('Folder exceeds 10,000 files or 200 MB.');
  const entries: Record<string, Uint8Array> = Object.create(null);
  // Keep the selected root folder so extraction preserves nested directory structure.
  for (const file of selected) entries[file.webkitRelativePath] = new Uint8Array(await file.arrayBuffer());
  const archive = await new Promise<Uint8Array>((resolve, reject) => zip(entries, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)));
  if (archive.length > 50 * 1024 * 1024) throw new Error('Compressed folder exceeds 50 MB.');
  return uploadProjectZip(name, new Blob([new Uint8Array(archive)], { type: 'application/zip' }));
}

export async function publishProject(projectId: string, url: string, branch: string, token: string): Promise<{url: string}> {
  const res = await fetch(`/projects/${encodeURIComponent(projectId)}/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({url, branch, token}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'GitHub upload failed');
  return data;
}

async function administrationRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not update user groups.');
  return data as T;
}

export function fetchAdministrationUsers(): Promise<import('./types').AdministrationUsers> {
  return administrationRequest('/admin/users');
}

export function updateManagedUser(username: string, settings: Pick<import('./types').ManagedUser, 'is_admin'>): Promise<import('./types').ManagedUser> {
  return administrationRequest(`/admin/users/${encodeURIComponent(username)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });
}

export function addAdministrator(email: string): Promise<unknown> {
  return administrationRequest('/admin/administrators', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
}

export function updateManagedUsers(usernames: string[], changes: Partial<Pick<import('./types').ManagedUser, 'is_admin'>>): Promise<{ users: import('./types').ManagedUser[]; updated: number }> {
  return administrationRequest('/admin/users/bulk', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames, changes }),
  });
}

export function removePendingAdministrator(email: string): Promise<unknown> {
  return administrationRequest(`/admin/administrators/${encodeURIComponent(email)}`, { method: 'DELETE' });
}
