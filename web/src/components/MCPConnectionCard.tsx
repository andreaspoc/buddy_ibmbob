import { useAccessGroups } from '../lib/accessGroups';
import { t, getLocale } from "../lib/i18n";
import { redactActivity } from '../lib/redaction';
import { useEffect, useState } from 'react';
import { accessRequest } from '../accessApi';
import type { MCPServer } from '../types';

import { useMCPHealth } from '../lib/useMCPHealth';

export function MCPConnectionCard({ server, onDelete, onConfigure, isAdmin = false, onRefresh }: { isAdmin?: boolean; onRefresh?: () => Promise<void>; server: MCPServer; onConfigure?: (name: string) => void; onDelete?: (name: string) => void | Promise<void> }) {
  const canManage = isAdmin && server.can_manage !== false;
  const { result, checking, check } = useMCPHealth(`/mcps/${encodeURIComponent(server.name)}/check`, !server.disabled, server);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const library = 'company';
  const groups = useAccessGroups();
  const [audience, setAudience] = useState(server.audience || 'both');
  const [saving, setSaving] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [saved, setSaved] = useState(false);
  const [baseline, setBaseline] = useState({ library: server.knowledge_base || 'company', audience: server.audience || 'both' });
  const dirty = library !== baseline.library || audience !== baseline.audience;
  useEffect(() => { const next = { library: server.knowledge_base || 'company', audience: server.audience || 'both' }; setAudience(next.audience); setBaseline(next); }, [server.knowledge_base, server.audience]);
  return <article className={`mcp-connection-card ${server.disabled ? "is-disabled" : ""}`}>
    <div className="mcp-card-kind">{server.transport === "stdio" ? t("Local process") : t("Remote connection")}{server.managed && <span className="mcp-kind-badge">{t("Built-in")}</span>}</div>
    <div className="mcp-card-heading"><strong>{server.name}</strong>
      <span className={`mcp-status ${checking ? 'checking' : result?.status || 'unchecked'}`} role="status">
        {server.disabled ? t("Disabled") : checking ? t("Checking…") : result?.status === 'working' ? t("Online") : result ? t("Offline") : t("Not checked")}
      </span>
    </div>
    {canManage && <small className="mcp-target" title={redactActivity(server.target)}>{server.transport === 'stdio' ? t("Server command") : server.transport === 'sse' ? t("Remote · SSE") : t("Remote · HTTP")} · {redactActivity(server.target)}</small>}
    {canManage && <form className="mcp-access-editor" onSubmit={async event => {
      event.preventDefault(); setSaving(true); setAccessError(''); setSaved(false);
      try { await accessRequest(`/mcps/${encodeURIComponent(server.name)}/access`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ knowledge_base: library, audience }) }); setBaseline({ library, audience }); setSaved(true); await onRefresh?.(); }
      catch (err) { setAccessError(err instanceof Error ? err.message : 'Could not save connection access.'); } finally { setSaving(false); }
    }}>
      <div className="mcp-access-heading"><span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>{t('Team access')}</span><small>{t(dirty ? 'Unsaved changes' : 'Current access')}</small></div>
      <div className="mcp-access-fields">
        <label>{t('Available to')}<select aria-label={t('Available to')} disabled={saving} value={audience} onChange={event => { setAudience(event.target.value); setSaved(false); setAccessError(''); }}><option value="both">{t("Everyone")}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      </div>
      <div className="mcp-access-footer"><span className="mcp-access-note">{t('Access follows the groups you assign.')}</span><div className="mcp-access-buttons">
        {dirty && <button type="button" className="mcp-access-cancel" disabled={saving} onClick={() => { setAudience(baseline.audience); setAccessError(''); setSaved(false); }}>{t('Cancel')}</button>}
        <button type="submit" className="mcp-access-save" disabled={saving || !dirty}>{t(saving ? 'Saving…' : 'Save access')}</button>
      </div></div>
      {accessError && <p role="alert" className="mcp-access-error">{t(accessError)}</p>}{saved && <p role="status" className="mcp-access-saved"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>{t('Connection access saved.')}</p>}
    </form>}
    {result && <details className="mcp-check-result" aria-live="polite">
      <summary>{t("Connection details")}{result.tools ? t("{0} tools", [result.tools.length]) : ''}</summary>
      <p>{t(result.message)}</p>
      {result.status === 'working' && <>
        <p>{t("Service permissions are checked when tools are used.")}</p>
        {result.tools?.length ? <ul>{result.tools.map(name => <li key={name}>{name}</li>)}</ul> : <p>{t("This server does not expose tools.")}</p>}
      </>}
      {result.checked_at && <small>{t("Last checked")}{new Date(result.checked_at).toLocaleTimeString(getLocale())}</small>}
    </details>}
    {removeError && <p role="alert">{t(removeError)}</p>}
    <div className="mcp-card-actions">
      {canManage && onConfigure && <button type="button" disabled={checking || removing} aria-label={t("Configure {0}", [server.name])} onClick={() => onConfigure(server.name)}>{t("Configure")}</button>}
      <button type="button" disabled={checking || server.disabled} onClick={check}>{checking ? t("Testing…") : result ? t("Test again") : t("Test")}</button>
      {canManage && onDelete && !server.managed && <button type="button" disabled={checking || removing} aria-label={t("Remove {0}", [server.name])} onClick={async () => {
        if (window.confirm(t('Remove MCP connection "{0}"?', [server.name]))) {
          setRemoving(true);
          try { await onDelete(server.name); } catch { setRemoveError('Could not remove this connection. Try again.'); } finally { setRemoving(false); }
        }
      }}>{t("Remove")}</button>}
    </div>
  </article>;
}
