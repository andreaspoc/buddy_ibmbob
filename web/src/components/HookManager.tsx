import { themeCssValue } from '../lib/themeColor';
import { Toolbar } from './Toolbar';
import { t } from "../lib/i18n";
import React, { useState, useEffect } from 'react';
import {
  fetchHooks,
  saveHook,
  deleteHook,
  toggleHook,
  type BobHook,
  type BobHookTemplate,
} from '../api';

export const HookManager: React.FC = () => {
  const [hooks, setHooks] = useState<BobHook[]>([]);
  const [templates, setTemplates] = useState<BobHookTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [filter, setFilter] = useState('');

  // Form state
  const [formId, setFormId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formEvent, setFormEvent] = useState<'PreToolUse' | 'UserPromptSubmit' | 'PostToolUse' | 'SessionStart' | 'Stop'>('PreToolUse');
  const [formMatcher, setFormMatcher] = useState('^(run_command|bash)$');
  const [formScript, setFormScript] = useState('');
  const [formTimeout, setFormTimeout] = useState(5000);
  const [formBlocking, setFormBlocking] = useState(true);

  const loadHooks = async () => {
    try {
      setIsLoading(true);
      setError('');
      const data = await fetchHooks();
      setHooks(data.hooks || []);
      setTemplates(data.templates || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load hooks.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadHooks();
  }, []);

  const resetForm = () => {
    setFormId(null);
    setFormName('');
    setFormDesc('');
    setFormEvent('PreToolUse');
    setFormMatcher('^(run_command|bash)$');
    setFormScript(`#!/bin/bash
PAYLOAD=$(cat)
# Parse tool_input or prompt from payload
echo "Hook executed successfully"
exit 0
`);
    setFormTimeout(5000);
    setFormBlocking(true);
    setIsEditing(false);
  };

  const startNewHook = () => {
    resetForm();
    setIsEditing(true);
  };

  const startEditHook = (h: BobHook) => {
    setFormId(h.id);
    setFormName(h.name);
    setFormDesc(h.description || '');
    setFormEvent(h.event);
    setFormMatcher(h.matcher || '.*');
    setFormScript(h.script_code || '');
    setFormTimeout(h.timeout || 5000);
    setFormBlocking(Boolean(h.is_blocking));
    setIsEditing(true);
  };

  const applyTemplate = (tpl: BobHookTemplate) => {
    setFormName(tpl.name);
    setFormDesc(tpl.description);
    setFormEvent(tpl.event as any);
    setFormMatcher(tpl.matcher);
    setFormScript(tpl.script_code);
    setFormTimeout(tpl.timeout || 5000);
    setFormBlocking(tpl.is_blocking);
  };

  const handleSaveHook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setError('Please provide a name for this hook.');
      return;
    }
    if (!formScript.trim()) {
      setError('Please provide script code for this hook.');
      return;
    }

    try {
      setError('');
      await saveHook({
        id: formId || undefined,
        name: formName.trim(),
        description: formDesc.trim(),
        event: formEvent,
        matcher: formMatcher.trim() || '.*',
        script_code: formScript,
        timeout: Number(formTimeout) || 5000,
        is_blocking: formBlocking,
        enabled: true,
      });

      setSuccessMsg(`Hook '${formName}' saved to .bob/settings.json`);
      setTimeout(() => setSuccessMsg(''), 3000);
      setIsEditing(false);
      resetForm();
      await loadHooks();
    } catch (err: any) {
      setError(err.message || 'Failed to save hook.');
    }
  };

  const handleDeleteHook = async (id: string, name: string) => {
    if (!window.confirm(`Delete hook '${name}'? This will remove it from .bob/settings.json.`)) return;
    try {
      await deleteHook(id);
      await loadHooks();
    } catch (err: any) {
      setError(err.message || 'Failed to delete hook.');
    }
  };

  const handleToggleHook = async (id: string, current: boolean) => {
    try {
      await toggleHook(id, !current);
      setHooks(prev => prev.map(h => (h.id === id ? { ...h, enabled: !current } : h)));
    } catch (err: any) {
      setError(err.message || 'Failed to toggle hook.');
    }
  };

  const loadRecommendedSecurityPack = async () => {
    try {
      setError('');
      for (const tpl of templates.slice(0, 2)) {
        await saveHook({
          name: tpl.name,
          description: tpl.description,
          event: tpl.event as any,
          matcher: tpl.matcher,
          script_code: tpl.script_code,
          timeout: tpl.timeout,
          is_blocking: tpl.is_blocking,
          enabled: true,
        });
      }
      setSuccessMsg('Installed recommended security guardrail hooks!');
      setTimeout(() => setSuccessMsg(''), 4000);
      await loadHooks();
    } catch (err: any) {
      setError(err.message || 'Failed to install recommended hooks.');
    }
  };

  const filteredHooks = hooks.filter(h => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      h.name.toLowerCase().includes(q) ||
      h.event.toLowerCase().includes(q) ||
      h.matcher.toLowerCase().includes(q) ||
      (h.description && h.description.toLowerCase().includes(q))
    );
  });

  const getEventBadgeClass = (event: string) => {
    switch (event) {
      case 'PreToolUse':
        return 'hook-badge-pretool';
      case 'UserPromptSubmit':
        return 'hook-badge-prompt';
      case 'PostToolUse':
        return 'hook-badge-posttool';
      case 'SessionStart':
        return 'hook-badge-session';
      default:
        return 'hook-badge-default';
    }
  };

  return (
    <div className="hooks-manager-content">
      {/* Messages */}
      {error && (
        <div className="hook-alert hook-alert-error" role="alert">
          <span>⚠️ {t(error)}</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="hook-retry-btn"
              onClick={() => void loadHooks()}
              style={{ background: 'transparent', border: '1px solid currentColor', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '0.85rem' }}
            >
              {t("🔄 Retry")}</button>
            <button type="button" onClick={() => setError('')}>✕</button>
          </div>
        </div>
      )}
      {successMsg && (
        <div className="hook-alert hook-alert-success" role="status">
          <span>✓ {successMsg}</span>
          <button type="button" onClick={() => setSuccessMsg('')}>✕</button>
        </div>
      )}

      {/* If Form is Open */}
      {isEditing ? (
        <form className="hook-edit-form" onSubmit={handleSaveHook}>
          <div className="hook-form-header">
            <h3>{formId ? t("Edit Lifecycle Hook") : t("Create New Lifecycle Hook")}</h3>
            <span className="hook-form-hint">
              {t("Saved into")}<code>{t(".bob/settings.json")}</code> {t("&amp;")}<code>{t(".bob/hooks/")}</code>
            </span>
          </div>

          {/* Quick template dropdown */}
          {templates.length > 0 && (
            <div className="hook-form-group">
              <label>{t("Preset Guardrail Templates (1-Click Fill):")}</label>
              <select
                className="hook-select"
                onChange={(e) => {
                  const tpl = templates.find(t => t.id === e.target.value);
                  if (tpl) applyTemplate(tpl);
                }}
                defaultValue=""
              >
                <option value="" disabled>{t("Select a pre-built template…")}</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.event})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="hook-form-row">
            <div className="hook-form-group" style={{ flex: 2 }}>
              <label>{t("Hook Name *")}</label>
              <input
                type="text"
                className="hook-input"
                placeholder={t("e.g. Guard Dangerous Shell Commands")}
                value={formName}
                onChange={e => setFormName(e.target.value)}
                required
              />
            </div>
            <div className="hook-form-group" style={{ flex: 1.5 }}>
              <label>{t("Lifecycle Event *")}</label>
              <select
                className="hook-select"
                value={formEvent}
                onChange={e => setFormEvent(e.target.value as any)}
              >
                <option value="PreToolUse">{t("PreToolUse (Gate before tool)")}</option>
                <option value="UserPromptSubmit">{t("UserPromptSubmit (Prompt filter)")}</option>
                <option value="PostToolUse">{t("PostToolUse (After tool)")}</option>
                <option value="SessionStart">{t("SessionStart (Session init)")}</option>
                <option value="Stop">{t("Stop (Session stop)")}</option>
              </select>
            </div>
          </div>

          <div className="hook-form-row">
            <div className="hook-form-group" style={{ flex: 2 }}>
              <label>
                {t("Tool Matcher (Regex)")}<small style={{ color: themeCssValue('#8b5cf6'), marginLeft: '6px' }}>{t("e.g. ^(run_command|bash)$")}</small>
              </label>
              <input
                type="text"
                className="hook-input"
                placeholder=".*"
                value={formMatcher}
                onChange={e => setFormMatcher(e.target.value)}
              />
            </div>
            <div className="hook-form-group" style={{ flex: 1 }}>
              <label>{t("Timeout (ms)")}</label>
              <input
                type="number"
                className="hook-input"
                value={formTimeout}
                onChange={e => setFormTimeout(Number(e.target.value))}
                min={1000}
                max={30000}
              />
            </div>
            <div className="hook-form-group" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '16px' }}>
                <input
                  type="checkbox"
                  checked={formBlocking}
                  onChange={e => setFormBlocking(e.target.checked)}
                />
                <span>{t("Block on Exit 2")}</span>
              </label>
            </div>
          </div>

          <div className="hook-form-group">
            <label>{t("Description")}</label>
            <input
              type="text"
              className="hook-input"
              placeholder={t("Explain why this hook is used and what actions it permits or halts")}
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
            />
          </div>

          <div className="hook-form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label style={{ margin: 0 }}>{t("Script Code (Bash / Python) *")}</label>
              <span style={{ fontSize: '11px', color: themeCssValue('#a78bfa') }}>
                {t("Receives JSON payload on")}<code>{t("stdin")}</code> {t("· Exit")}<code>2</code> {t("blocks · Exit")}<code>0</code> {t("allows")}</span>
            </div>
            <textarea
              className="hook-script-editor"
              rows={9}
              value={formScript}
              onChange={e => setFormScript(e.target.value)}
              spellCheck={false}
              required
            />
          </div>

          <p role="note">{t('Validate trusted hook scripts in an isolated administrative environment.')}</p>

          <div className="hook-form-actions">
            <button
              type="button"
              className="hook-btn-secondary"
              disabled
            >
              {t('Hook testing is disabled')}
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="hook-btn-cancel"
                onClick={resetForm}
              >
                {t("Cancel")}</button>
              <button
                type="submit"
                className="hook-btn-primary"
              >
                {t("Save Hook")}</button>
            </div>
          </div>
        </form>
      ) : (
        /* Hook List View */
        <div>
          <Toolbar className="hook-toolbar">
            <div className="hook-search-wrap">
              <span aria-hidden="true">🔍</span>
              <input
                type="text"
                className="hook-search-input"
                placeholder={t("Filter hooks by name, event, matcher…")}
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
              {filter && (
                <button type="button" className="hook-clear-btn" onClick={() => setFilter('')}>✕</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {hooks.length === 0 && (
                <button
                  type="button"
                  className="hook-btn-secondary"
                  onClick={loadRecommendedSecurityPack}
                >
                  {t("🛡️ Load Security Pack")}</button>
              )}
              <button
                type="button"
                className="hook-btn-primary"
                onClick={startNewHook}
              >
                {t("+ New Hook")}</button>
            </div>
          </Toolbar>

          {isLoading ? (
            <div className="hook-loading-state">
              <span className="bobdeck-spinner" aria-hidden="true">🪝</span>
              <p>{t("Loading lifecycle hooks from .bob/settings.json…")}</p>
            </div>
          ) : filteredHooks.length === 0 ? (
            <div className="hook-empty-state">
              <span className="hook-empty-icon" aria-hidden="true">🪝</span>
              <h3>{t("No Lifecycle Hooks Configured")}</h3>
              <p>
                {t("Hooks execute deterministic shell guardrails and validators at critical points during Buddy turns.")}</p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="hook-btn-primary"
                  onClick={loadRecommendedSecurityPack}
                >
                  {t("🛡️ Install Recommended Security Guardrails")}</button>
                <button
                  type="button"
                  className="hook-btn-secondary"
                  onClick={startNewHook}
                >
                  {t("Create Custom Hook")}</button>
              </div>
            </div>
          ) : (
            <div className="hook-card-list">
              {filteredHooks.map(h => (
                <div key={h.id} className={`hook-card ${!h.enabled ? 'is-disabled' : ''}`}>
                  <div className="hook-card-main">
                    <div className="hook-card-title-row">
                      <strong className="hook-card-title">{h.name}</strong>
                      <span className={`hook-event-badge ${getEventBadgeClass(h.event)}`}>
                        {h.event}
                      </span>
                      {h.is_blocking && (
                        <span className="hook-blocking-badge" title={t("Exit code 2 halts turn immediately")}>
                          {t("🚫 Blocking")}</span>
                      )}
                      {!h.enabled && (
                        <span className="hook-disabled-badge">{t("Disabled")}</span>
                      )}
                    </div>
                    {h.description && (
                      <p className="hook-card-desc">{t(h.description)}</p>
                    )}
                    <div className="hook-card-meta">
                      <span><strong>{t("Matcher:")}</strong> <code>{h.matcher}</code></span>
                      <span><strong>{t("Timeout:")}</strong> {h.timeout}{t("ms")}</span>
                      {h.command && (
                        <span><strong>{t("Script:")}</strong> <code>{h.command}</code></span>
                      )}
                    </div>
                  </div>

                  <div className="hook-card-actions">
                    <button
                      type="button"
                      className="hook-action-btn"
                      onClick={() => startEditHook(h)}
                      title={t("Edit hook definition")}
                    >
                      {t("✏️ Edit")}</button>
                    <button
                      type="button"
                      className="hook-action-btn hook-delete-btn"
                      onClick={() => handleDeleteHook(h.id, h.name)}
                      title={t("Delete hook")}
                    >
                      🗑️
                    </button>
                    <label className="mod-switch" title={h.enabled ? t("Disable hook") : t("Enable hook")}>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={t('Enable {0}', [h.name])}
                        checked={h.enabled}
                        onChange={() => handleToggleHook(h.id, h.enabled)}
                      />
                      <span className="mod-slider" />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
