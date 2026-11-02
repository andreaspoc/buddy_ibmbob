import { useAccessGroups } from '../lib/accessGroups';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { buddySkillName } from '../lib/skillNames';
import React, { useEffect, useState } from 'react';

interface CreateItemModalProps {
  mcpName?: string | null;
  kind: 'skill' | 'mode' | 'mcp' | 'agent' | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function parseObjectOrKeyValue(raw: string, fieldName: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        throw new Error(`${fieldName} must be a JSON object of key-value pairs`);
      }
      const res: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        res[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      return res;
    } catch (e: any) {
      throw new Error(`Invalid JSON in ${fieldName}: ${e.message}`);
    }
  }

  const res: Record<string, string> = {};
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eqIdx = line.indexOf('=');
    const colIdx = line.indexOf(':');
    let sepIdx = -1;
    if (eqIdx !== -1 && colIdx !== -1) {
      sepIdx = Math.min(eqIdx, colIdx);
    } else {
      sepIdx = eqIdx !== -1 ? eqIdx : colIdx;
    }
    if (sepIdx === -1) {
      throw new Error(`Invalid line in ${fieldName} (line ${i + 1}): "${line}". Expected KEY=VALUE or a JSON object.`);
    }
    const key = line.slice(0, sepIdx).trim();
    const val = line.slice(sepIdx + 1).trim();
    if (!key) {
      throw new Error(`Empty key in ${fieldName} on line ${i + 1}`);
    }
    res[key] = val;
  }
  return res;
}

function parseArgsInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error('Arguments must be a JSON array of strings');
      }
      return parsed.map((x) => String(x));
    } catch (e: any) {
      throw new Error(`Invalid JSON in arguments: ${e.message}`);
    }
  }
  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

export const CreateItemModal: React.FC<CreateItemModalProps> = ({
  kind,
  mcpName,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [slug, setSlug] = useState('');
  // Skill
  const [skillDesc, setSkillDesc] = useState('');
  const [skillInst, setSkillInst] = useState('');
  // Mode
  const [modeName, setModeName] = useState('');
  const [modeDesc, setModeDesc] = useState('');
  const [roleDef, setRoleDef] = useState('');
  const [modeInst, setModeInst] = useState('');
  // MCP
  const mcpLibrary = 'company';
  const groups = useAccessGroups();
  const [mcpAudience, setMcpAudience] = useState('both');
  const [mcpTransport, setMcpTransport] = useState('http');
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpCmd, setMcpCmd] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [mcpParams, setMcpParams] = useState('');
  const [mcpHeaders, setMcpHeaders] = useState('');
  const [mcpEnv, setMcpEnv] = useState('');
  const [mcpApiKey, setMcpApiKey] = useState('');
  const [mcpApiKeyName, setMcpApiKeyName] = useState('');
  const [mcpApiKeyPrefix, setMcpApiKeyPrefix] = useState('Bearer ');
  // Agent
  const [cardUrl, setCardUrl] = useState('');
  const [endpointOverride, setEndpointOverride] = useState('');
  const [agentApiKey, setAgentApiKey] = useState('');
  const [agentBearerToken, setAgentBearerToken] = useState('');
  const [agentApiKeyHeader, setAgentApiKeyHeader] = useState('x-api-key');
  useEffect(() => { if (!isOpen) setAgentBearerToken(''); }, [isOpen]);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mcpCheck, setMcpCheck] = useState<{ status: string; message: string; tools?: string[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [savedMcp, setSavedMcp] = useState(false);

  const [configLoading, setConfigLoading] = useState(Boolean(mcpName));
  useEffect(() => {
    if (!mcpName) return;
    let active = true;
    setConfigLoading(true);
    fetch(`/mcps/${encodeURIComponent(mcpName)}/config`).then(async response => {
      if (!response.ok) throw new Error('Could not load connection settings. Close and try again.');
      return response.json();
    }).then(config => {
      if (!active) return;
      setSlug(mcpName);
      setMcpAudience(config.audience || 'both');
      setMcpTransport(config.httpURL ? 'http' : config.url ? 'sse' : 'stdio');
      setMcpEnabled(!config.disabled);
      setMcpUrl(config.httpURL || config.url || '');
      setMcpCmd(config.command || '');
      setMcpArgs(JSON.stringify(config.args || []));
      setMcpHeaders(JSON.stringify(config.headers || {}, null, 2));
      if (mcpName === 'monday-platform-local') {
        const { MONDAY_TOKEN = '', ...otherEnv } = config.env || {};
        setMcpApiKey(MONDAY_TOKEN);
        setMcpApiKeyName('MONDAY_TOKEN');
        setMcpEnv(JSON.stringify(otherEnv, null, 2));
      } else {
        setMcpEnv(JSON.stringify(config.env || {}, null, 2));
      }
      setConfigLoading(false);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [mcpName]);

  if (!isOpen || !kind) return null;

  const titles: Record<string, string> = {
    skill: 'Add a skill',
    mode: 'Add a mode',
    mcp: mcpName ? `Configure ${mcpName}` : 'Connect your tools',
    agent: 'Add an A2A agent',
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const testOnly = kind === 'mcp' && (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'test';
    setError('');
    setLoading(true); setTesting(testOnly);

    try {
      const endpoint = {
        skill: '/skills',
        mode: '/modes',
        mcp: '/mcps',
        agent: '/agents',
      }[kind];

      let payload: any = { slug };
      if (kind === 'skill') {
        payload = {
          name: buddySkillName(slug),
          description: skillDesc.trim(),
          instructions: skillInst.trim(),
        };
      } else if (kind === 'mode') {
        payload = {
          slug,
          name: modeName.trim(),
          description: modeDesc.trim(),
          role_definition: roleDef.trim(),
          instructions: modeInst.trim(),
          groups: ['read', 'skill', 'mode'],
        };
      } else if (kind === 'mcp') {
        if (slug === 'monday-platform-local' && !mcpApiKey.trim()) {
          throw new Error('Enter your Monday API token before saving or testing the connection.');
        }
        let finalCommand = mcpCmd.trim();
        let finalArgs = parseArgsInput(mcpArgs);
        if (mcpTransport === 'stdio' && finalArgs.length === 0 && finalCommand.includes(' ')) {
          const parts = parseArgsInput(finalCommand);
          if (parts.length > 0) {
            finalCommand = parts[0];
            finalArgs = parts.slice(1);
          }
        }

        const defaultKeyName = mcpTransport === 'stdio' ? 'API_KEY' : 'Authorization';
        const keyName = mcpApiKeyName.trim() || defaultKeyName;

        payload = {
          name: slug,
          disabled: !mcpEnabled,
          knowledge_base: mcpLibrary,
          audience: mcpAudience,
          transport: mcpTransport,
          url: mcpUrl.trim(),
          command: finalCommand,
          args: finalArgs,
          parameters: parseObjectOrKeyValue(mcpParams, 'URL parameters'),
          headers: parseObjectOrKeyValue(mcpHeaders, 'HTTP headers'),
          env: parseObjectOrKeyValue(mcpEnv, 'Environment variables'),
          api_key: mcpApiKey,
          api_key_name: keyName,
          api_key_prefix: mcpTransport === 'stdio' ? '' : mcpApiKeyPrefix,
        };
      } else if (kind === 'agent') {
        payload = {
          slug,
          card_url: cardUrl.trim(),
          endpoint_override: endpointOverride.trim(),
          api_key: agentApiKey.trim(),
          auth_token: agentBearerToken.trim(),
          api_key_header: agentApiKeyHeader.trim() || 'x-api-key',
        };
      }

      const res = await fetch(testOnly ? '/mcps/check' : kind === 'mcp' && mcpName ? `/mcps/${encodeURIComponent(mcpName)}` : endpoint, {
        method: !testOnly && kind === 'mcp' && mcpName ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to create item');
      }

      if (testOnly) { setMcpCheck(await res.json()); return; }
      onSuccess();
      if (kind === 'mcp') {
        setSavedMcp(true);
        const checked = await fetch(`/mcps/${encodeURIComponent(slug)}/check`, { method: 'POST' });
        if (!checked.ok) throw new Error('Connection saved, but its test could not run. Open MCP connections to test again.');
        setMcpCheck(await checked.json());
        setSavedMcp(true);
      } else onClose();
    } catch (err: any) {
      setError(err.message || 'Creation failed');
    } finally {
      setLoading(false); setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <button type="button" className="agent-edit-backdrop" aria-label={t("Close")} disabled={loading} onClick={onClose} />
      <div
        className="create-dialog buddy-surface agent-edit-dialog"
        style={{ display: 'block', maxWidth: '580px', margin: 'auto' }}
      >
        <form onSubmit={handleSubmit} onChangeCapture={() => setMcpCheck(null)}><fieldset disabled={loading || savedMcp || configLoading} className="mcp-form-fields">
          <WorkspaceSectionHeader compact title={titles[kind]} eyebrow={t("EXTEND BUDDY")} actions={<button
              type="button"
              className="dialog-close"
              onClick={onClose}
              aria-label={t("Close")}
            >
              ×
            </button>} />

          <label>
            {kind === 'skill' ? t("Skill name") : kind === 'mcp' ? t("Connection name") : t("Slug")}
            <input
              readOnly={Boolean(mcpName)}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              pattern={kind === 'mcp' ? '[a-z][a-z0-9_\\-]{0,63}' : '[a-z][a-z0-9\\-]{0,63}'}
              placeholder={kind === 'skill' ? 'my-buddy' : kind === 'mcp' ? 'my-service' : 'my-helper'}
              maxLength={kind === 'skill' ? 58 : 64}
            />
          </label>
          {kind === 'mcp' && <small>{t("Use lowercase letters, numbers, hyphens, or underscores (for example, my-service).")}</small>}

          {kind === 'skill' && (
            <div>
              <p className="dialog-intro">{t("Skill names end with -buddy")}{slug ? ` · ${buddySkillName(slug)}` : ''}.</p>
              <label>
                {t("Description")}<textarea
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                  rows={2}
                  placeholder={t("When should Buddy use this skill?")}
                />
              </label>
              <label>
                {t("Instructions")}<textarea
                  value={skillInst}
                  onChange={(e) => setSkillInst(e.target.value)}
                  rows={6}
                  placeholder={t("Tell Buddy what to do when this skill is activated.")}
                />
              </label>
            </div>
          )}

          {kind === 'mode' && (
            <div>
              <label>
                {t("Display name")}<input
                  value={modeName}
                  onChange={(e) => setModeName(e.target.value)}
                  placeholder={t("My helper mode")}
                />
              </label>
              <label>
                {t("Description")}<textarea
                  value={modeDesc}
                  onChange={(e) => setModeDesc(e.target.value)}
                  rows={2}
                  placeholder={t("What is this mode for?")}
                />
              </label>
              <label>
                {t("Role definition")}<textarea
                  value={roleDef}
                  onChange={(e) => setRoleDef(e.target.value)}
                  rows={4}
                  placeholder={t("You are a specialist in…")}
                />
              </label>
              <label>
                {t("Custom instructions")}<textarea
                  value={modeInst}
                  onChange={(e) => setModeInst(e.target.value)}
                  rows={4}
                  placeholder={t("Follow these guidelines…")}
                />
              </label>
            </div>
          )}

          {kind === 'mcp' && (
            <div className="mcp-setup">
              <label>{t('Available to')}<select value={mcpAudience} onChange={event => setMcpAudience(event.target.value)}><option value="both">{t("Everyone")}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
              <p className="dialog-intro">{t("Define your MCP server and test the handshake and available tools here. Save connects it to Buddy for new tasks; running tasks keep their existing connections.")}</p>
              <div style={{
                background: 'rgba(0, 164, 239, 0.08)',
                border: '1px solid rgba(0, 164, 239, 0.25)',
                borderRadius: '6px',
                padding: '10px 12px',
                marginBottom: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg width="18" height="18" viewBox="0 0 21 21" style={{ flexShrink: 0 }}>
                    <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                  </svg>
                  <div>
                    <strong style={{ fontSize: '12px', color: '#f1f5f9', display: 'block' }}>{t("Microsoft 365 Integration")}</strong>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>{t("Connect Outlook Mail, Calendar, and OneDrive via OAuth.")}</div>
                  </div>
                </div>
                <a href="/auth/microsoft/login" target="_blank" rel="noopener noreferrer" style={{
                  padding: '6px 12px',
                  background: '#00a4ef',
                  color: 'white',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 600,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}>
                  {t("Connect")}</a>
              </div>

              <label><input type="checkbox" checked={mcpEnabled} onChange={event => setMcpEnabled(event.target.checked)} />{t('Enable connection')}</label>
              <label>
                {t("Connection type")}<select
                  value={mcpTransport}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMcpTransport(next);
                    if (next === 'stdio' && (!mcpApiKeyName || mcpApiKeyName === "Authorization")) {
                      setMcpApiKeyName('API_KEY');
                      setMcpApiKeyPrefix('');
                    } else if (next !== 'stdio' && (!mcpApiKeyName || mcpApiKeyName === 'API_KEY')) {
                      setMcpApiKeyName('Authorization');
                      setMcpApiKeyPrefix('Bearer ');
                    }
                  }}
                >
                  <option value="http">{t("Remote URL · HTTP (recommended)")}</option>
                  <option value="sse">{t("Remote URL · SSE (legacy)")}</option>
                  <option value="stdio">{t("Command on the Buddy server (stdio)")}</option>
                </select>
              </label>

              {mcpTransport !== 'stdio' ? (
                <>
                  <label>
                    {t("MCP Server URL")}<input
                      type="url"
                      value={mcpUrl}
                      onChange={(e) => setMcpUrl(e.target.value)}
                      placeholder="https://example.com/mcp or http://host.docker.internal:8000/sse"
                      required
                    />
                    <small style={{ color: '#8890a6', fontSize: '11px', marginTop: '2px' }}>
                      {t("Paste the MCP endpoint from your service. The URL must be reachable from the Buddy server.")}</small>
                  </label>

                  <div className="mcp-config-group">
                    <div className="mcp-config-group-title">{t("Authentication & API Key (optional)")}</div>
                    <div style={{ display: 'grid', gap: '10px', width: '100%' }}>
                      <label>
                        {t("API Key / Bearer Token")}<input
                          type="password"
                          value={mcpApiKey}
                          onChange={(e) => setMcpApiKey(e.target.value)}
                          placeholder={t("Paste API key or token")}
                          autoComplete="off"
                        />
                      </label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <label>
                          {t("Header Name")}<input
                            value={mcpApiKeyName}
                            onChange={(e) => setMcpApiKeyName(e.target.value)}
                            placeholder={t("Authorization")}
                          />
                        </label>
                        <label>
                          {t("Key Prefix")}<input
                            value={mcpApiKeyPrefix}
                            onChange={(e) => setMcpApiKeyPrefix(e.target.value)}
                            placeholder={t("Bearer ")}
                          />
                        </label>
                      </div>
                      <small style={{ color: '#8890a6', fontSize: '11px' }}>
                        {t("Passes")}<code>{mcpApiKeyName || t("Authorization")}: {mcpApiKeyPrefix}{t("&lt;key&gt;")}</code>{t(". Clear prefix for raw tokens.")}</small>
                    </div>
                  </div>
                  <details className="mcp-advanced"><summary>{t("Advanced settings · headers and URL parameters")}</summary>
                  <label>
                    {t("URL / Query Parameters (optional)")}<textarea
                      value={mcpParams}
                      onChange={(e) => setMcpParams(e.target.value)}
                      rows={2}
 placeholder={'{"region": "eu-central", "limit": "50"} or KEY=VALUE'} /><small style={{ color: "#8890a6", fontSize: "11px", marginTop: "2px" }}>
                      {t("JSON object or")}<code>{"KEY=VALUE"}</code> {t("per line. Automatically appended to the URL query string.")}</small>
                  </label>

                  <label>
                    {t("HTTP Headers (optional)")}<textarea
                      value={mcpHeaders}
                      onChange={(e) => setMcpHeaders(e.target.value)}
                      rows={2}
 placeholder={'{"X-Tenant-ID": "example"} or KEY=VALUE'} /><small style={{ color: "#8890a6", fontSize: "11px", marginTop: "2px" }}>
                      {t("JSON object or")}<code>{"KEY=VALUE"}</code> {t("per line.")}</small>
                  </label>

                  </details>
                </>
              ) : (
                <>
                  <label>
                    {t("Server command")}<input
                      value={mcpCmd}
                      onChange={(e) => setMcpCmd(e.target.value)}
                      placeholder={t("npx, python3, node, uvx, or full command")}
                      required
                    />
                    <small style={{ color: '#8890a6', fontSize: '11px', marginTop: '2px' }}>
                      {t("Executable command. Must exist inside the container or on PATH.")}</small>
                  </label>

                  <label>
                    {t("Command Arguments (optional)")}<textarea
                      value={mcpArgs}
                      onChange={(e) => setMcpArgs(e.target.value)}
                      rows={2}
 placeholder={'["-y", "@modelcontextprotocol/server-postgres", "postgresql://..."] or space-separated'} /><small style={{ color: "#8890a6", fontSize: "11px", marginTop: "2px" }}>
                      {t("JSON array of strings or space-separated arguments.")}</small>
                  </label>

                  <label>
                    {t("Environment Variables (optional)")}<textarea
                      value={mcpEnv}
                      onChange={(e) => setMcpEnv(e.target.value)}
                      rows={3}
 placeholder={'{"DATABASE_URL": "postgresql://...", "DEBUG": "true"} or KEY=VALUE'} /><small style={{ color: "#8890a6", fontSize: "11px", marginTop: "2px" }}>
                      {t("JSON object or")}<code>{"KEY=VALUE"}</code> {t("per line.")}</small>
                  </label>

                  <div className="mcp-config-group">
                    <div className="mcp-config-group-title">{t(slug === 'monday-platform-local' ? 'Monday API token (required)' : 'API Key / Secret (optional)')}</div>
                    {slug === 'monday-platform-local' && <p>{t('Paste your Monday API token below, then save to enable the connection.')}</p>}
                    <div style={{ display: 'grid', gap: '10px', width: '100%' }}>
                      <label>
                        {t("Secret / API Key")}<input
                          type="password"
                          value={mcpApiKey}
                          onChange={(e) => setMcpApiKey(e.target.value)}
                          placeholder={t("Paste API key or secret token")}
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        {t("Environment Variable Name")}<input
                          value={mcpApiKeyName}
                          onChange={(e) => setMcpApiKeyName(e.target.value)}
                          placeholder={t("API_KEY")}
                        />
                        <small style={{ color: '#8890a6', fontSize: '11px', marginTop: '2px' }}>
                          e.g. <code>{t("API_KEY")}</code>, <code>{t("OPENAI_API_KEY")}</code>, <code>{t("GITHUB_PERSONAL_ACCESS_TOKEN")}</code>.
                        </small>
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {kind === 'agent' && (
            <div>
              <label>
                {t("Agent Card URL")}<input
                  type="url"
                  value={cardUrl}
                  onChange={(e) => setCardUrl(e.target.value)}
                  required
                  placeholder="https://example.com/.well-known/agent-card.json"
                />
              </label>
              <label>
                {t("Endpoint override (optional)")}<input
                  type="url"
                  value={endpointOverride}
                  onChange={(e) => setEndpointOverride(e.target.value)}
                  placeholder="https://host.docker.internal:9000/a2a"
                />
              </label>
              <label>{t("Bearer token (optional)")}<input type="password" autoComplete="new-password" value={agentBearerToken} onChange={(e) => setAgentBearerToken(e.target.value)} placeholder={t("Paste bearer token if required")} /></label>
              <label>
                {t("API Key (optional)")}<input
                  type="password"
                  value={agentApiKey}
                  onChange={(e) => setAgentApiKey(e.target.value)}
                  placeholder={t("Paste API key if required")}
                />
              </label>
              <label>
                {t("API Key Header Name")}<input
                  value={agentApiKeyHeader}
                  onChange={(e) => setAgentApiKeyHeader(e.target.value)}
                  placeholder="x-api-key"
                />
              </label>
            </div>
          )}

          </fieldset>
          {kind === 'mcp' && mcpCheck && <div className={`mcp-check-result ${mcpCheck.status}`} role="status"><strong>{savedMcp ? t("Connection saved · ") : ''}{mcpCheck.status === 'working' ? t("Handshake passed") : t("Connection needs attention")}</strong><p>{mcpCheck.message}</p>{mcpCheck.tools && <details open><summary>{mcpCheck.tools.length} {t("tools discovered")}</summary><ul>{mcpCheck.tools.map(tool => <li key={tool}>{tool}</li>)}</ul></details>}<p>{t("A successful handshake confirms the server responds. Tool permissions are verified when Buddy uses them.")}</p></div>}
          {error && <div className="form-error" role="alert">{t(error)}</div>}

          <div className="dialog-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={onClose}
              disabled={loading}
            >
              {savedMcp ? t("Done") : t("Cancel")}
            </button>
            {kind === 'mcp' && !savedMcp && <button type="submit" name="action" value="test" className="cancel-button" disabled={loading || configLoading}>{testing ? t("Testing…") : t("Test connection")}</button>}
            {!savedMcp && <button
              type="submit"
              className="save-button"
              disabled={loading || configLoading}
            >
              {loading ? testing ? t("Testing…") : t("Saving & testing…") : kind === 'mcp' ? mcpName ? t("Save changes") : t("Save & connect") : t("Create")}
            </button>}
          </div>
        </form>
      </div>
    </div>
  );
};
