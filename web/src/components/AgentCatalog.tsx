import { useAccessGroups } from '../lib/accessGroups';
import { useEffect, useRef, useState } from 'react';
import { Search, Tag } from '@carbon/react';
import { UserAvatar } from '@carbon/icons-react';
import './AgentUserPicker.scss';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { appConfirm } from './AppDialog';
import './AgentCatalog.css';

interface CatalogAgent {
  id: string; slug: string; name: string; description: string; icon?: string;
  card_url: string; endpoint: string; protocol_version: string; api_key_header?: string;
  capabilities?: Record<string, unknown>; skills?: { id: string; name: string; description: string }[];
  groups: string[]; users: string[]; enabled: boolean; allowed: boolean; activated: boolean;
}
interface Template { id: string; card_url: string; discovery_auth_token: string; discovery_api_key: string; name: string; description: string; icon: string; groups: string[]; users: string[]; enabled: boolean }
const emptyTemplate: Template = { id: '', card_url: '', discovery_auth_token: '', discovery_api_key: '', name: '', description: '', icon: '', groups: [], users: [], enabled: true };

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(typeof error.detail === 'string' ? error.detail : 'Could not complete this action'); }
  return response.status === 204 ? undefined as T : response.json();
}

export function AgentCatalog({ isAdmin = false, onChanged, onClose }: { isAdmin?: boolean; onChanged: () => Promise<void> | void; onClose: () => void }) {
  const groups = useAccessGroups();
  const dialog = useRef<HTMLElement>(null);
  const [agents, setAgents] = useState<CatalogAgent[]>([]);
  const [users, setUsers] = useState<{ username: string; display_name: string }[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [usersLoading, setUsersLoading] = useState(isAdmin);
  const [usersError, setUsersError] = useState('');
  const [template, setTemplate] = useState<Template | null>(null);
  const [editing, setEditing] = useState(false);
  const [activation, setActivation] = useState<CatalogAgent | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [token, setToken] = useState('');
  const [clearCredentials, setClearCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = async () => { setAgents(await request<CatalogAgent[]>('/agent-catalog')); };
  useEffect(() => {
    let active = true;
    dialog.current?.focus();
    request<CatalogAgent[]>('/agent-catalog').then(value => { if (active) setAgents(value); }).catch(cause => { if (active) setError(cause.message); });
    if (isAdmin) request<{ users: { username: string; display_name: string }[] }>('/admin/users').then(value => { if (active) setUsers(value.users); }).catch(cause => { if (active) setUsersError(cause.message); }).finally(() => { if (active) setUsersLoading(false); });
    return () => { active = false; };
  }, [isAdmin]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); await reload(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not complete this action'); }
    finally { setBusy(false); }
  };
  const startActivation = (agent: CatalogAgent) => { setActivation(agent); setApiKey(''); setToken(''); setClearCredentials(false); setTemplate(null); setError(''); };
  const startTemplate = (agent?: CatalogAgent) => {
    setTemplate(agent ? { id: agent.id, card_url: agent.card_url, discovery_auth_token: '', discovery_api_key: '', name: agent.name, description: agent.description, icon: agent.icon || '', groups: agent.groups, users: agent.users, enabled: agent.enabled } : { ...emptyTemplate });
    setUserQuery('');
    setEditing(Boolean(agent)); setActivation(null); setError('');
  };
  const updateTemplate = (values: Partial<Template>) => setTemplate(current => current ? { ...current, ...values } : current);
  const toggleGroup = (id: string) => { if (template) updateTemplate({ groups: template.groups.includes(id) ? template.groups.filter(value => value !== id) : [...template.groups, id] }); };
  return <div className="feature-overlay"><section ref={dialog} tabIndex={-1} className="feature-dialog agent-catalog buddy-surface" role="dialog" aria-modal="true" aria-labelledby="agent-catalog-title" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key === 'Tab') {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <WorkspaceSectionHeader title="A2A agent catalogue" titleId="agent-catalog-title" eyebrow="CONNECTED AGENTS" compact actions={<button className="feature-close" onClick={onClose} disabled={busy}>Close</button>} />
    <p>Activate an agent available to your account. Credentials are optional for agents that allow unauthenticated access. Administrators manage definitions and access separately from MCP connections.</p>
    <div className="agent-catalog-actions">{isAdmin && <button className="feature-primary" disabled={busy} onClick={() => startTemplate()}>＋ Define A2A agent</button>}<button disabled={busy} onClick={() => void run(async () => {})}>Refresh catalogue</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {template && <form className="agent-catalog-form" onSubmit={event => { event.preventDefault(); void run(async () => {
      await request(`/admin/agent-catalog/${encodeURIComponent(template.id)}`, 'PUT', template); setTemplate(null);
    }); }}>
      <h3>{editing ? 'Edit agent definition' : 'Define an agent'}</h3>
      <label>Identifier<input required pattern="[a-z][a-z0-9-]{0,47}" value={template.id} disabled={editing || busy} onChange={event => updateTemplate({ id: event.target.value })} placeholder="research-assistant" /></label>
      <label>Agent Card URL<input required type="url" disabled={busy} value={template.card_url} onChange={event => updateTemplate({ card_url: event.target.value })} placeholder="https://agent.example/.well-known/agent-card.json" /></label>
      <label>API key (optional, x-api-key)<input type="password" autoComplete="new-password" disabled={busy} value={template.discovery_api_key} onChange={event => updateTemplate({ discovery_api_key: event.target.value })} /></label>
      <label>Bearer token (optional)<input type="password" autoComplete="new-password" disabled={busy} value={template.discovery_auth_token} onChange={event => updateTemplate({ discovery_auth_token: event.target.value })} /></label>
      <p className="agent-catalog-hint">Credentials are used to discover the Agent Card and saved privately for your agent requests. They are never shared with other users. Leave blank to preserve existing credentials.</p>
      <p className="agent-catalog-hint">Saving discovers the endpoint, protocol, skills, and capabilities from the real Agent Card. Changing its endpoint or card URL clears existing activations.</p>
      <p className="agent-catalog-hint">Public agent ports follow your deployment settings. Private agents need an administrator-approved host or origin for both the Agent Card and its endpoint.</p>
      <label>Display name override<input disabled={busy} maxLength={200} value={template.name} onChange={event => updateTemplate({ name: event.target.value })} placeholder="Use Agent Card name" /></label>
      <label>Description override<textarea disabled={busy} maxLength={4000} rows={3} value={template.description} onChange={event => updateTemplate({ description: event.target.value })} placeholder="Use Agent Card description" /></label>
      <label>Icon override<input disabled={busy} maxLength={2000} value={template.icon} onChange={event => updateTemplate({ icon: event.target.value })} placeholder="Emoji or HTTPS image URL" /></label>
      <fieldset disabled={busy}><legend>Grant access to groups</legend>{groups.map(group => <label className="agent-catalog-check" key={group.id}><input type="checkbox" checked={template.groups.includes(group.id)} onChange={() => toggleGroup(group.id)} />{group.name}</label>)}</fieldset>
      <fieldset className="agent-user-picker" disabled={busy} aria-describedby="agent-user-picker-help">
        <legend>Grant access to users</legend>
        <p id="agent-user-picker-help">Search by name or username, then select who can activate this agent.</p>
        <Search id="agent-user-search" labelText="Search users" placeholder="Search users…" size="lg" value={userQuery} onChange={event => setUserQuery(event.target.value)} onClear={() => setUserQuery('')} disabled={busy || usersLoading} />
        <div className="agent-user-selection" aria-label="Selected users">
          <span role="status">{template.users.length} selected</span>
          {template.users.map(username => <Tag key={username} type="cool-gray" filter title={`Remove ${users.find(user => user.username === username)?.display_name || username}`} disabled={busy} onClose={() => updateTemplate({ users: template.users.filter(value => value !== username) })}>{users.find(user => user.username === username)?.display_name || username}</Tag>)}
        </div>
        {usersLoading ? <p role="status">Loading users…</p> : usersError ? <p role="alert">{usersError}</p> : <div className="agent-user-list" role="group" aria-label="Available users">
          {users.filter(user => `${user.display_name} ${user.username}`.toLocaleLowerCase().includes(userQuery.trim().toLocaleLowerCase())).map(user => <label className="agent-user-row" key={user.username}>
            <input type="checkbox" checked={template.users.includes(user.username)} onChange={event => updateTemplate({ users: event.target.checked ? [...template.users, user.username] : template.users.filter(value => value !== user.username) })} />
            <span className="agent-user-avatar" aria-hidden="true"><UserAvatar /></span>
            <span className="agent-user-identity"><strong>{user.display_name || user.username}</strong><span>{user.username}</span></span>
          </label>)}
          {!users.some(user => `${user.display_name} ${user.username}`.toLocaleLowerCase().includes(userQuery.trim().toLocaleLowerCase())) && <p role="status">{users.length ? 'No matching users. Try another name or username.' : 'No users are available.'}</p>}
        </div>}
      </fieldset>
      <p className="agent-catalog-hint">Members of any selected group and individually selected users can activate this agent. An empty grant list gives no user access.</p>
      <label className="agent-catalog-check"><input disabled={busy} type="checkbox" checked={template.enabled} onChange={event => updateTemplate({ enabled: event.target.checked })} />Enabled</label>
      <div className="agent-catalog-actions"><button disabled={busy} className="feature-primary" type="submit">{busy ? 'Discovering and saving…' : 'Discover and save'}</button><button disabled={busy} type="button" onClick={() => setTemplate(null)}>Cancel</button></div>
    </form>}
    {activation && <form className="agent-catalog-form" onSubmit={event => { event.preventDefault(); void run(async () => {
      await request(`/agent-catalog/${encodeURIComponent(activation.id)}/activation`, 'PUT', { api_key: apiKey, auth_token: token, clear_credentials: clearCredentials }); setApiKey(''); setToken(''); setActivation(null);
    }); }}>
      <h3>{activation.activated ? 'Update private credentials' : 'Activate'} · {activation.name}</h3>
      <p>Leave both fields empty if this agent does not require authentication. Credentials belong to your account and are sent only to this agent. Existing values are never displayed; blank fields preserve them.</p>
      <label>API key (optional, {activation.api_key_header || 'x-api-key'})<input type="password" autoComplete="new-password" disabled={busy} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
      <label>Bearer token (optional)<input type="password" autoComplete="new-password" disabled={busy} value={token} onChange={event => setToken(event.target.value)} /></label>
      {activation.activated && <label className="agent-catalog-check"><input type="checkbox" disabled={busy} checked={clearCredentials} onChange={event => setClearCredentials(event.target.checked)} />Clear stored credentials before saving</label>}
      <div className="agent-catalog-actions"><button className="feature-primary" disabled={busy} type="submit">{busy ? 'Saving…' : activation.activated ? 'Save credentials' : 'Activate agent'}</button><button disabled={busy} type="button" onClick={() => { setActivation(null); setApiKey(''); setToken(''); }}>Cancel</button></div>
    </form>}
    <div className="agent-catalog-grid">{agents.map(agent => <article className="agent-catalog-card" key={agent.id}>
      <div className="agent-catalog-card-heading"><span className="agent-catalog-icon" aria-hidden="true">{agent.icon?.startsWith('https://') ? <img src={agent.icon} alt="" referrerPolicy="no-referrer" loading="lazy" /> : agent.icon || '↗'}</span><div><h3>{agent.name}</h3><span className="agent-catalog-status">{!agent.enabled ? 'Disabled' : !agent.allowed ? 'No access granted to your account' : agent.activated ? 'Active' : 'Available to activate'}</span></div></div>
      <p>{agent.description || 'No description provided by this agent.'}</p>
      <dl><dt>Protocol</dt><dd>A2A {agent.protocol_version}</dd><dt>Endpoint</dt><dd>{agent.endpoint}</dd></dl>
      {agent.capabilities && Object.keys(agent.capabilities).length > 0 && <div className="agent-catalog-capabilities">{Object.entries(agent.capabilities).filter(([, value]) => value === true).map(([key]) => <span key={key}>{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>)}</div>}
      {Boolean(agent.skills?.length) && <details><summary>Advertised skills ({agent.skills?.length})</summary><ul>{agent.skills?.map((skill, index) => <li key={`${skill.id}:${index}`}><strong>{skill.name || skill.id}</strong>{skill.description && <p>{skill.description}</p>}</li>)}</ul></details>}
      {isAdmin && <p className="agent-catalog-hint">Access: {agent.groups.map(group => groups.find(item => item.id === group)?.name || group).join(', ') || 'No groups'} · {agent.users.length} selected users</p>}
      <div className="agent-catalog-actions">
        {agent.allowed && <button disabled={busy} className={agent.activated ? '' : 'feature-primary'} onClick={() => startActivation(agent)}>{agent.activated ? 'Private credentials' : 'Activate'}</button>}
        {agent.activated && <button disabled={busy} onClick={() => void run(async () => { await request(`/agent-catalog/${encodeURIComponent(agent.id)}/activation`, 'DELETE'); })}>Deactivate</button>}
        {isAdmin && <><button disabled={busy} onClick={() => startTemplate(agent)}>Edit definition & access</button><button disabled={busy} onClick={async () => { if (await appConfirm(`Delete “${agent.name}” and its activations?`)) void run(async () => { await request(`/admin/agent-catalog/${encodeURIComponent(agent.id)}`, 'DELETE'); }); }}>Delete</button></>}
      </div>
    </article>)}</div>
    {!agents.length && <p>{isAdmin ? 'Define an Agent Card to start the shared catalogue.' : 'No A2A agents have been granted to your account.'}</p>}
  </section></div>;
}
