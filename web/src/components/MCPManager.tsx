import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import type { MCPServer } from '../types';
import { MCPConnectionCard } from './MCPConnectionCard';
import { MCPCatalog } from './MCPCatalog';

export function MCPManager({ servers, onAdd, onRefresh, onDelete, onConfigure, onClose, isAdmin = false }: {
  isAdmin?: boolean;
  onConfigure: (name: string) => void;
  servers: MCPServer[]; onAdd: () => void; onRefresh: () => Promise<void>;
  onDelete: (name: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.focus(); }, []);
  return <div className="feature-overlay"><section ref={dialog} tabIndex={-1} className="feature-dialog mcp-manager buddy-surface" role="dialog" aria-modal="true" aria-labelledby="mcp-manager-title" onKeyDown={event => {
    if (event.key === "Escape") onClose();
    if (event.key === "Tab") {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <WorkspaceSectionHeader title={t("MCP connections")} titleId="mcp-manager-title" eyebrow={t("CONNECTED TOOLS")} compact actions={<button className="feature-close" onClick={onClose}>{t("Close")}</button>} />
    <p>{t(isAdmin ? 'Manage your connected tools and choose which employee teams can use each server.' : 'View and test the MCP connections available to your groups.')}</p>
    <div className="mcp-manager-actions">{isAdmin && <button className="feature-primary" onClick={onAdd}>{t("＋ Define MCP server")}</button>}<button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onRefresh(); } catch { setError('Could not refresh connections. Try again.'); } finally { setBusy(false); } }}>{busy ? t("Refreshing…") : t("Refresh connections")}</button></div>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    <div className="mcp-manager-grid">{servers.map(server => <MCPConnectionCard key={`${server.name}:${server.target}`} server={server} isAdmin={isAdmin} onRefresh={onRefresh} onConfigure={isAdmin ? onConfigure : undefined} onDelete={isAdmin ? onDelete : undefined} />)}</div>
    {!servers.length && <p>{t(isAdmin ? "No MCP connections configured. Define a server to get started." : 'No MCP connections are available for your groups.')}</p>}
    <MCPCatalog isAdmin={isAdmin} onChanged={onRefresh} />
  </section></div>;
}
