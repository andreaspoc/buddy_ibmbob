import { useAccessGroups } from '../lib/accessGroups';
import { brandText } from '../lib/brand';
import { useEffect, useRef, useState } from 'react';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from '../lib/i18n';
import './IntegrationCatalog.css';
import type { MCPServer } from '../types';
import { MCPConnectionCard } from './MCPConnectionCard';
import { useMCPHealth } from '../lib/useMCPHealth';
import { safeHref } from '../lib/safeHref';

type Credential = { key: string; label: string; location: 'env' | 'header'; target: string; prefix: string; required: boolean };
type Template = { id: string; name: string; description: string; icon: string; transport: 'http' | 'sse' | 'stdio'; url: string; command: string; args: string[]; fields: Credential[]; knowledge_base: string; audience: string; access_mode: 'groups' | 'users' | 'grants'; groups: string[]; users: string[]; enabled: boolean; connected?: boolean; allowed?: boolean; ready?: boolean; category?: string; docs_url?: string; setup_instructions?: string; requires_url?: boolean; auth_mode?: 'credentials' | 'oauth' | 'microsoft' | 'keycloak' | 'none'; oauth_client_id?: string; oauth_scopes?: string; oauth_client_secret_env?: string; oauth_token_auth_method?: string };
type Account = { username: string; display_name?: string };
const EVERYONE = { id: 'company', name: 'Everyone' };
const blank = (): Template => ({ id: '', name: '', description: '', icon: 'plug', transport: 'http', url: '', command: '', args: [], fields: [{ key: 'token', label: 'API token', location: 'header', target: 'Authorization', prefix: 'Bearer ', required: true }], knowledge_base: 'company', audience: 'both', access_mode: 'grants', groups: [], users: [], enabled: true, auth_mode: 'credentials', category: 'productivity', docs_url: '', setup_instructions: '', oauth_client_id: '', oauth_scopes: '', oauth_client_secret_env: '', oauth_token_auth_method: 'none' });

function existingGroups(item: Template) {
  if (Array.isArray(item.groups)) return item.groups;
  if (item.access_mode === 'users') return [];
  return [item.audience === 'both' ? 'company' : item.audience];
}

function existingUsers(item: Template) {
  // Legacy group-only mode ignored stored user selections; do not activate them on edit.
  return item.access_mode === 'groups' ? [] : item.users;
}

function AccessFields({ value, accounts, disabled, onChange }: { value: Template; accounts: Account[]; disabled: boolean; onChange: (value: Partial<Template>) => void }) {
  const groups = [EVERYONE, ...useAccessGroups()];
  const [query, setQuery] = useState('');
  return <>
    <fieldset disabled={disabled}><legend>{t('Grant access to groups')}</legend>{groups.map(group => <label className="catalog-check" key={group.id}><input type="checkbox" checked={value.groups.includes(group.id)} onChange={event => onChange({ access_mode: 'grants', groups: event.target.checked ? [...value.groups, group.id] : value.groups.filter(id => id !== group.id) })} />{t(group.name)}</label>)}</fieldset>
    <label>{t('Find users')}<input type="search" disabled={disabled} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <fieldset disabled={disabled} className="catalog-user-list"><legend>{t('Grant access to selected users')}</legend>{accounts.filter(account => `${account.display_name || ''} ${account.username}`.toLowerCase().includes(query.toLowerCase())).map(account => <label className="catalog-check" key={account.username}><input type="checkbox" checked={value.users.includes(account.username)} onChange={event => onChange({ access_mode: 'grants', users: event.target.checked ? [...value.users, account.username] : value.users.filter(username => username !== account.username) })} />{account.display_name || account.username} ({account.username})</label>)}</fieldset>
    <p className="catalog-access-hint">{t('Members of any selected group and individually selected users can connect this server. No selections means no access. MCP grants are independent of A2A agent access.')}</p>
  </>;
}
async function request(path = '', method = 'GET', body?: unknown) {
  const res = await fetch('/mcp-catalog' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const value = await res.json();
  if (!res.ok) throw new Error(typeof value.detail === 'string' ? value.detail : 'Please check the catalog fields and try again.');
  return value;
}
export function CatalogIcon({ kind = 'plug' }: { kind?: string }) {
  const monograms: Record<string, string> = { docmost: 'D', microsoft: 'M', notion: 'N', atlassian: 'A', linear: 'L', gitlab: 'GL', cloudflare: 'CF', context7: 'C7', tavily: 'T', exa: 'E', firecrawl: 'F', brave: 'B', deepwiki: 'DW', keycloak: 'K' };
  if (monograms[kind]) return <span className="catalog-icon catalog-provider-icon" aria-hidden="true">{monograms[kind]}</span>;
  const paths: Record<string, string> = { plug: 'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4m-6-10a6 6 0 0 0 6 6', github: 'M9 19c-4 1-4-2-6-2m12 5v-4c0-1-1-2-1-2 4 0 6-2 6-6 0-2-1-3-2-4 0-1 0-2-1-3-2 0-3 1-4 1a12 12 0 0 0-6 0C6 3 5 3 3 3 2 4 2 5 3 6c-1 1-2 2-2 4 0 4 2 6 6 6-1 1-1 2-1 3v3', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', board: 'M3 3h18v18H3zM8 7v10m4-10v6m4-6v8', database: 'M3 6c0-5 18-5 18 0s-18 5-18 0v12c0 5 18 5 18 0V6M3 12c0 5 18 5 18 0', cloud: 'M6 19a5 5 0 1 1 0-10 7 7 0 0 1 13-1 5 5 0 0 1 0 11H6', chat: 'M3 3h18v14H8l-5 4V3M7 8h10M7 12h7', code: 'M8 6l-6 6 6 6m8-12 6 6-6 6m-3-15-2 18' };
  return <span className="catalog-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind] || paths.plug} /></svg></span>;
}
function CatalogConnectionHealth({ item }: { item: Template }) {
  const { result, checking, check } = useMCPHealth(`/mcp-catalog/${encodeURIComponent(item.id)}/check`, Boolean(item.connected && item.allowed && item.enabled !== false), item);
  return <div className="catalog-connection-health">
    <span role="status" className={`mcp-status ${checking ? 'checking' : result?.status || 'unchecked'}`}>{t(checking ? 'Checking…' : result?.status === 'working' ? 'Online' : result ? 'Offline' : 'Not checked')}</span>
    <button type="button" disabled={checking} onClick={() => void check()}>{t(checking ? 'Testing…' : 'Test again')}</button>
    {result && <details><summary>{t('Connection details')}</summary><p>{t(result.message)}</p>{result.tools && <p>{t('{0} tools', [result.tools.length])}</p>}{result.checked_at && <small>{t('Last checked')} {new Date(result.checked_at).toLocaleTimeString()}</small>}</details>}
  </div>;
}

export function MCPCatalog({ isAdmin, onChanged, standalone = false }: { isAdmin: boolean; onChanged: () => void | Promise<void>; standalone?: boolean }) {
  const groups = [EVERYONE, ...useAccessGroups()];
  const [items, setItems] = useState<Template[]>([]); const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [loginId, setLoginId] = useState('');
  const popup = useRef<Window | null>(null);
  const currentLogin = useRef('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Template | null>(null); const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<Template | null>(null); const [newEntry, setNewEntry] = useState(false);
  const [accessEditor, setAccessEditor] = useState<Template | null>(null);
  const [argsText, setArgsText] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const activeForm = useRef<HTMLFormElement>(null);
  const activeEditorId = editor?.id ?? accessEditor?.id ?? selected?.id;
  useEffect(() => {
    if (activeEditorId === undefined) return;
    activeForm.current?.scrollIntoView({ block: 'start' });
    activeForm.current?.querySelector<HTMLElement>('input:not([readonly]):not(:disabled), select:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
  }, [activeEditorId, Boolean(editor), Boolean(accessEditor), Boolean(selected)]);
  const load = async () => setItems(await request());
  useEffect(() => { let active = true; request().then(data => { if (active) setItems(data); }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, []);
  useEffect(() => { if (!isAdmin) return; let active = true; fetch('/admin/users').then(async response => { if (!response.ok) throw new Error('Could not load accounts for access assignment.'); return response.json(); }).then(data => { if (active) setAccounts(data.users); }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [isAdmin]);
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup.current || event.data?.type !== 'buddy-mcp-oauth' || event.data.template_id !== currentLogin.current) return;
      if (!['success', 'error'].includes(event.data.status)) return;
      popup.current = null; currentLogin.current = ''; setLoginId('');
      if (event.data.status === 'success') {
        setNotice('Account connected. Checking server status automatically.');
        void load().then(onChanged).catch(err => setError(err.message));
      } else setError(typeof event.data.message === 'string' ? event.data.message : 'Could not connect this account. Try again.');
    };
    const timer = window.setInterval(() => { if (popup.current?.closed) { popup.current = null; currentLogin.current = ''; setLoginId(''); void load().then(onChanged).catch(() => {}); } }, 1000);
    window.addEventListener('message', message);
    return () => { window.removeEventListener('message', message); window.clearInterval(timer); };
  }, [onChanged]);
  const signIn = (item: Template) => {
    setError(''); setNotice('');
    const url = item.auth_mode === 'microsoft' ? '/auth/microsoft/login?business=true' : `/mcp-oauth/${encodeURIComponent(item.id)}/start`;
    const opened = window.open(url, 'buddy-mcp-login', 'popup=yes,width=640,height=760');
    if (!opened) { setError(brandText('The sign-in popup was blocked. Allow popups for Buddy and try again.')); return; }
    popup.current = opened; currentLogin.current = item.id; setLoginId(item.id); opened.focus();
  };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await action(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const edit = (value: Partial<Template>) => setEditor(current => current ? { ...current, ...value } : current);
  const createButton = isAdmin && <button type="button" className="feature-primary" disabled={busy} onClick={() => { setEditor(blank()); setArgsText(''); setNewEntry(true); setSelected(null); setAccessEditor(null); }}>{t('Create template')}</button>;
  return <section className="integration-catalog" aria-label={t('MCP catalog')}>
    {standalone ? <><p>{t('Choose a server and connect with your own credentials. Administrators define servers and choose who can access each one.')}</p><div className="catalog-actions">{createButton}<button type="button" disabled={busy} onClick={() => void run(async () => { await load(); await onChanged(); })}>{t('Refresh catalog')}</button></div></> : <WorkspaceSectionHeader compact title={t('MCP catalog')} description={t('Choose a server and connect with your own credentials. Administrators define servers and choose who can access each one.')} actions={createButton} />}
    <label>{t('Search catalog')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <label>{t('Category')}<select value={category} onChange={event => setCategory(event.target.value)}><option value="">{t('All categories')}</option>{Array.from(new Set(items.map(item => item.category || 'productivity'))).sort((a, b) => a.localeCompare(b)).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="catalog-grid">{items.filter(item => (!category || (item.category || 'productivity') === category) && (item.name + ' ' + item.description).toLowerCase().includes(query.toLowerCase())).map(item => <article className="catalog-card" key={item.id}>
      <div className="catalog-heading"><CatalogIcon kind={item.icon} /><div><h3>{item.name}</h3><span>{t(item.enabled === false ? 'Disabled by administrator' : item.ready === false ? 'Administrator setup required' : !item.allowed ? 'Assign access before connecting' : item.connected ? item.auth_mode === 'none' ? 'Connected' : ['oauth', 'microsoft', 'keycloak'].includes(item.auth_mode || '') ? 'Account connected' : 'Connected with your credentials' : 'Available')}</span></div></div>
      {item.connected && item.allowed && item.enabled !== false && <CatalogConnectionHealth item={item} />}
      <p>{item.description}</p>{item.setup_instructions && <details><summary>{t('Setup requirements')}</summary><p>{item.setup_instructions}</p></details>}{item.docs_url && safeHref(item.docs_url) && <a href={safeHref(item.docs_url)} target="_blank" rel="noopener noreferrer">{t('Provider documentation')}</a>}{isAdmin && <p className="catalog-access-hint">{t('Access')}: {existingGroups(item).map(id => groups.find(group => group.id === id)?.name || id).join(', ') || t('No groups')} · {existingUsers(item).length} {t('selected users')}</p>}<div className="catalog-actions">
        {item.auth_mode === 'oauth' || item.auth_mode === 'keycloak' || item.auth_mode === 'microsoft' ? <button type="button" disabled={busy || !item.allowed || item.ready === false || Boolean(loginId)} onClick={() => signIn(item)}>{t(loginId === item.id ? 'Waiting for sign-in…' : item.connected ? 'Reconnect account' : 'Sign in to connect')}</button> : <button type="button" disabled={busy || !item.allowed || item.ready === false} onClick={() => { setSelected(item); setCredentials({}); setEditor(null); setAccessEditor(null); setError(''); }}>{t(item.connected ? item.auth_mode === 'none' ? 'Connected' : 'Update credentials' : 'Connect')}</button>}
        {item.connected && <><button type="button" disabled={busy} onClick={() => void run(async () => { if (item.auth_mode === 'microsoft') { const response = await fetch('/auth/microsoft/disconnect', { method: 'POST' }); if (!response.ok) throw new Error('Could not disconnect Microsoft.'); } else await request(`/${item.id}/connection`, 'DELETE'); await load(); await onChanged(); })}>{t('Disconnect')}</button></>}
        {isAdmin && <><button type="button" disabled={busy} onClick={() => { setAccessEditor({ ...structuredClone(item), access_mode: 'grants', groups: existingGroups(item), users: existingUsers(item) }); setEditor(null); setSelected(null); setError(''); }}>{t('Assign access')}</button><button type="button" disabled={busy} onClick={() => { setEditor({ ...structuredClone(item), access_mode: 'grants', groups: existingGroups(item), users: existingUsers(item) }); setArgsText(item.args.join('\n')); setNewEntry(false); setSelected(null); setAccessEditor(null); }}>{t('Edit template & access')}</button></>}
      </div>
    </article>)}</div>
    {selected && <form ref={activeForm} className="catalog-form" onSubmit={event => { event.preventDefault(); void run(async () => { await request(`/${selected.id}/connect`, 'POST', { credentials }); setCredentials({}); setSelected(null); await load(); await onChanged(); setNotice('Connection saved. Checking server status automatically.'); }); }}>
      <h3>{t('Connect')} {selected.name}</h3><p>{t(selected.auth_mode === 'none' ? 'This public documentation server does not require account sign-in.' : 'Credentials are private to your account. Blank fields preserve saved credentials when updating.')}</p>
      {selected.fields.map(field => <label key={field.key}>{field.label}<input type="password" autoComplete="new-password" maxLength={8192} required={field.required && !selected.connected} value={credentials[field.key] || ''} onChange={event => setCredentials(current => ({ ...current, [field.key]: event.target.value }))} /></label>)}
      <div className="catalog-actions"><button type="submit" disabled={busy}>{t('Save connection')}</button><button type="button" disabled={busy} onClick={() => { setSelected(null); setCredentials({}); }}>{t('Cancel')}</button></div>
    </form>}
    {accessEditor && <form ref={activeForm} className="catalog-form" aria-label={t('Assign MCP server access')} onSubmit={event => { event.preventDefault(); void run(async () => { await request(`/${accessEditor.id}/access`, 'PUT', { groups: accessEditor.groups, users: accessEditor.users, enabled: accessEditor.enabled }); setAccessEditor(null); await load(); await onChanged(); setNotice('MCP server access saved. Updated grants apply to future tool calls.'); }); }}>
      <h3>{t('Assign access')} · {accessEditor.name}</h3>
      <AccessFields value={accessEditor} accounts={accounts} disabled={busy} onChange={values => setAccessEditor(current => current ? { ...current, ...values } : current)} />
      <label><input type="checkbox" checked={accessEditor.enabled} disabled={busy} onChange={event => setAccessEditor(current => current ? { ...current, enabled: event.target.checked } : current)} />{t('Enable catalog entry')}</label>
      <div className="catalog-actions"><button type="submit" disabled={busy}>{t('Save access')}</button><button type="button" disabled={busy} onClick={() => setAccessEditor(null)}>{t('Cancel')}</button></div>
    </form>}
    {editor && <form ref={activeForm} className="catalog-form" onSubmit={event => { event.preventDefault(); void run(async () => { const { connected: _connected, allowed: _allowed, ...definition } = editor; await request(`/${editor.id}`, 'PUT', definition); setEditor(null); await load(); await onChanged(); setNotice('Template and access saved. Changing connection details requires users to reconnect.'); }); }}>
      <h3>{t('Template & access')}</h3><label>{t('Identifier')}<input required pattern="[a-z][a-z0-9_-]{0,47}" readOnly={!newEntry} value={editor.id} onChange={event => edit({ id: event.target.value })} /></label>
      <label>{t('Name')}<input required maxLength={100} value={editor.name} onChange={event => edit({ name: event.target.value })} /></label><label>{t('Description')}<textarea maxLength={2000} rows={3} value={editor.description} onChange={event => edit({ description: event.target.value })} /></label>
      <label>{t('Icon')}<select value={editor.icon} onChange={event => edit({ icon: event.target.value })}>{['plug', 'github', 'search', 'board', 'cloud', 'chat', 'code', 'docmost', 'microsoft', 'notion', 'atlassian', 'linear', 'gitlab', 'cloudflare', 'context7', 'tavily', 'exa', 'firecrawl', 'brave', 'deepwiki', 'keycloak'].map(icon => <option key={icon}>{icon}</option>)}</select></label>
      <label>{t('Transport')}<select disabled={editor.auth_mode === 'microsoft' || editor.auth_mode === 'keycloak'} value={editor.transport} onChange={event => { const transport = event.target.value as Template['transport']; edit({ transport, fields: editor.fields.map(field => ({ ...field, location: transport === 'stdio' ? 'env' : 'header', target: transport === 'stdio' ? 'API_KEY' : 'Authorization', prefix: transport === 'stdio' ? '' : 'Bearer ' })) }); }}><option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">Local process</option></select></label>
      {editor.auth_mode === 'keycloak' && <label>{t('Keycloak realm issuer URL')}<input type="url" value={editor.url} onChange={event => edit({ url: event.target.value })} placeholder="https://your-keycloak-host/realms/your-realm" /></label>}
      {editor.transport === 'stdio' ? <><label>{t('Installed server command')}<input required readOnly={editor.auth_mode === 'microsoft' || editor.auth_mode === 'keycloak'} value={editor.command} onChange={event => edit({ command: event.target.value })} /></label><label>{t('Arguments (one per line)')}<textarea readOnly={editor.auth_mode === 'microsoft' || editor.auth_mode === 'keycloak'} value={argsText} onChange={event => { setArgsText(event.target.value); edit({ args: event.target.value.split('\n').filter(Boolean) }); }} /></label></> : <label>{t('Server URL')}<input required={!editor.requires_url} type="url" value={editor.url} onChange={event => edit({ url: event.target.value })} /></label>}
      {(!editor.auth_mode || editor.auth_mode === 'credentials') && <><h4>{t('Credential fields')}</h4>{editor.fields.map((field, index) => <fieldset key={index}><legend>{field.label || 'Credential'}</legend>{(['key', 'label', 'target', 'prefix'] as const).map(key => <label key={key}>{t(key === 'target' ? editor.transport === 'stdio' ? 'Environment variable' : 'HTTP header' : key === 'prefix' ? 'Prefix (include trailing space for Bearer)' : key)}<input required={key !== 'prefix'} value={field[key]} onChange={event => edit({ fields: editor.fields.map((value, i) => i === index ? { ...value, [key]: event.target.value } : value) })} /></label>)}<label><input type="checkbox" checked={field.required} onChange={event => edit({ fields: editor.fields.map((value, i) => i === index ? { ...value, required: event.target.checked } : value) })} />{t('Required')}</label><button type="button" onClick={() => edit({ fields: editor.fields.filter((_, i) => i !== index) })}>{t('Remove field')}</button></fieldset>)}
      <button type="button" disabled={editor.fields.length >= 12} onClick={() => edit({ fields: [...editor.fields, { key: `token${editor.fields.length + 1}`, label: 'API token', location: editor.transport === 'stdio' ? 'env' : 'header', target: editor.transport === 'stdio' ? 'API_KEY' : 'Authorization', prefix: '', required: true }] })}>{t('Add credential field')}</button></>}
      <label>{t('Category')}<select value={editor.category || 'productivity'} onChange={event => edit({ category: event.target.value })}>{['knowledge', 'productivity', 'development', 'search'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
      <label>{t('Authentication')}<select disabled={editor.auth_mode === 'microsoft' || editor.auth_mode === 'keycloak'} value={editor.auth_mode || 'credentials'} onChange={event => { const auth_mode = event.target.value as Template['auth_mode']; edit({ auth_mode, fields: auth_mode === 'credentials' ? editor.fields.length ? editor.fields : [{ key: 'token', label: 'API token', location: 'header', target: 'Authorization', prefix: 'Bearer ', required: true }] : [], ...(auth_mode === 'oauth' ? { transport: 'http' as const } : {}) }); }}><option value="oauth">{t('Browser sign-in (OAuth)')}</option><option value="credentials">{t('API key / credentials')}</option><option value="none">{t('Public server (no sign-in)')}</option>{editor.auth_mode === 'microsoft' && <option value="microsoft">{t('Microsoft account sign-in')}</option>}{editor.auth_mode === 'keycloak' && <option value="keycloak">{t('Keycloak account sign-in')}</option>}</select></label>
      {(editor.auth_mode === 'oauth' || editor.auth_mode === 'keycloak') && <details><summary>{t('OAuth client registration (if provider requires it)')}</summary><p>{t('Providers supporting automatic registration need no client settings. Other providers require an administrator to register Buddy first.')}</p><label>{t('OAuth client ID')}<input value={editor.oauth_client_id || ''} onChange={event => edit({ oauth_client_id: event.target.value })} /></label><label>{t('Requested scopes (optional)')}<input value={editor.oauth_scopes || ''} onChange={event => edit({ oauth_scopes: event.target.value })} /></label><label>{t('Client authentication')}<select value={editor.oauth_token_auth_method || 'none'} onChange={event => edit({ oauth_token_auth_method: event.target.value })}><option value="none">Public client (PKCE)</option><option value="client_secret_post">Client secret in token request</option><option value="client_secret_basic">Client secret via Basic authentication</option></select></label>{editor.oauth_token_auth_method && editor.oauth_token_auth_method !== 'none' && <label>{t('Server environment variable containing the client secret')}<input pattern="BOB_MCP_OAUTH_[A-Z0-9_]+" placeholder="BOB_MCP_OAUTH_PROVIDER_CLIENT_SECRET" value={editor.oauth_client_secret_env || ''} onChange={event => edit({ oauth_client_secret_env: event.target.value })} /></label>}</details>}
      <label>{t('Provider documentation URL')}<input type="url" value={editor.docs_url || ''} onChange={event => edit({ docs_url: event.target.value })} /></label><label>{t('Setup instructions')}<textarea rows={3} value={editor.setup_instructions || ''} onChange={event => edit({ setup_instructions: event.target.value })} /></label>
      <AccessFields value={editor} accounts={accounts} disabled={busy} onChange={edit} />
      <label><input type="checkbox" checked={editor.enabled} onChange={event => edit({ enabled: event.target.checked })} />{t('Enable catalog entry')}</label><div className="catalog-actions"><button type="submit" disabled={busy}>{t('Save template & access')}</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>{t('Cancel')}</button></div>
    </form>}
    {!items.length && <p>{t('No catalog entries are available for your account.')}</p>}
  </section>;
}

export function MCPServerCatalog({ isAdmin, onChanged, onClose, servers = [], onConfigure }: { onConfigure?: (name: string) => void; servers?: MCPServer[]; isAdmin: boolean; onChanged: () => void | Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  return <div className="feature-overlay"><section ref={dialog} tabIndex={-1} className="feature-dialog mcp-server-catalog buddy-surface" role="dialog" aria-modal="true" aria-labelledby="mcp-catalog-title" onKeyDown={event => {
    if (event.key === 'Escape') onClose();
    if (event.key === 'Tab') {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
  }}><WorkspaceSectionHeader title={t('MCP server catalogue')} titleId="mcp-catalog-title" eyebrow={t('CONNECTED TOOLS')} compact actions={<button type="button" className="feature-close" onClick={onClose}>{t('Close')}</button>} />{servers.length > 0 && <section aria-label={t('Shared MCP connections')}><h3>{t('Shared MCP connections')}</h3><p>{t('These servers are already configured for your workspace. Status is checked automatically.')}</p><div className="mcp-manager-grid">{servers.map(server => <MCPConnectionCard key={server.name} server={server} isAdmin={isAdmin} onRefresh={async () => { await onChanged(); }} onConfigure={onConfigure} />)}</div></section>}<MCPCatalog standalone isAdmin={isAdmin} onChanged={onChanged} /></section></div>;
}
