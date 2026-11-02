/** Contextual assistance uses freshly authorized server records, never client snapshots. */
export type PortfolioBobFocus = {
  source: string;
  projectId?: string;
  personId?: string;
  workItemId?: string;
  assignmentId?: string;
  dependencyId?: string;
  scenario?: Record<string, unknown>;
};
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project context returned by the server.');
  return value as RecordValue;
}
function records(portfolio: RecordValue, key: string): RecordValue[] {
  return Array.isArray(portfolio[key]) ? (portfolio[key] as unknown[]).map(object) : [];
}
function find(portfolio: RecordValue, collection: string, id: string): RecordValue {
  const match = records(portfolio, collection).find(item => String(item.id) === String(id));
  if (!match) throw new Error('This record is no longer available in your authorized projects. Refresh Projects and try again.');
  return match;
}
async function request(path: string, signal?: AbortSignal, body?: RecordValue): Promise<RecordValue> {
  const response = await fetch('/api/projects' + path, {
    credentials: 'same-origin', signal,
    ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.detail === 'string' ? detail.detail : 'Could not load your authorized project context.');
  }
  return object(await response.json());
}
export async function loadPortfolioBobContext(focus?: PortfolioBobFocus, signal?: AbortSignal): Promise<string> {
  const context = await request('/context', signal);
  const portfolio = object(context.portfolio);
  const selection: RecordValue = {source: focus?.source?.slice(0, 80) || 'portfolio'};
  if (focus?.projectId) selection.project = find(portfolio, 'projects', focus.projectId);
  if (focus?.personId) selection.person = find(portfolio, 'people', focus.personId);
  for (const [parameter, collection, label] of [
    ['workItemId', 'work_items', 'work_item'], ['assignmentId', 'assignments', 'assignment'], ['dependencyId', 'dependencies', 'dependency'],
  ] as const) {
    const id = focus?.[parameter];
    if (!id) continue;
    const item = find(portfolio, collection, id);
    if (focus?.projectId && label !== 'dependency' && String(item.project_id) !== String(focus.projectId)) throw new Error('The selected item belongs to another project. Refresh Projects and try again.');
    if (focus?.projectId && label === 'dependency' && ![item.source_project_id,item.target_project_id].map(String).includes(String(focus.projectId))) throw new Error('The selected dependency does not belong to this project.');
    selection[label] = item;
  }
  let scenario: RecordValue | undefined;
  if (focus?.scenario) {
    const proposed = focus.scenario;
    const change: RecordValue = {kind: proposed.kind};
    if (proposed.kind === 'person_departure' && typeof proposed.person_id === 'string') {
      find(portfolio, 'people', proposed.person_id);
      change.person_id = proposed.person_id;
      if ('departure_date' in proposed) change.departure_date = proposed.departure_date;
    } else if (proposed.kind === 'project_change' && (typeof proposed.project_id === 'string' || typeof proposed.project_id === 'number')) {
      find(portfolio, 'projects', String(proposed.project_id));
      change.project_id = proposed.project_id;
      if ('due_date' in proposed) change.due_date = proposed.due_date;
      if ('start_date' in proposed) change.start_date = proposed.start_date;
    } else throw new Error('Select a valid change to discuss with Bob.');
    if ('status' in proposed) change.status = proposed.status;
    const impact = await request('/impact/preview', signal, change);
    scenario = {change, impact, applied: false, label: 'Unsaved what-if scenario, rechecked against current authorized records'};
  }
  // Preserve evidence paths and all authorized records rather than silently omitting impacts.
  const serialized = JSON.stringify({portfolio, instructions: context.instructions, focus: selection, scenario, snapshot_captured_at: new Date().toISOString()});
  if (serialized.length > 180000) throw new Error('The authorized portfolio exceeds the assistant context limit. Reduce long record descriptions before retrying.');
  return serialized;
}

/** Only independent reads overlap; callers authorize mutations after this resolves. */
export async function preparePortfolioBobContext<T>(
  focus: PortfolioBobFocus | undefined,
  projects: T[],
  fetchProjects: () => Promise<T[]>,
  signal?: AbortSignal,
): Promise<{serialized: string; projects: T[]}> {
  signal?.throwIfAborted();
  const [serialized, resolvedProjects] = await Promise.all([
    loadPortfolioBobContext(focus, signal),
    projects.length ? Promise.resolve(projects) : fetchProjects().catch(() => projects),
  ]);
  signal?.throwIfAborted();
  return {serialized, projects: resolvedProjects};
}
