import { Toolbar } from '../components/Toolbar';
import { WorkspaceSectionHeader } from '../components/WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import React, { useState, useEffect } from 'react';
import { modRegistry, BUILTIN_MODS } from './registry';
import type { BobMod } from './types';
import { HookManager } from '../components/HookManager';

interface ModRegistryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onModToggled?: (modId: string, enabled: boolean) => void;
  initialTab?: 'mods' | 'hooks';
}

export const ModRegistryModal: React.FC<ModRegistryModalProps> = ({
  isOpen,
  onClose,
  onModToggled,
  initialTab = 'mods',
}) => {
  const [activeTab, setActiveTab] = useState<'mods' | 'hooks'>(initialTab);
  const [filter, setFilter] = useState('');
  const [activeStates, setActiveStates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  const refreshStates = () => {
    const states: Record<string, boolean> = {};
    for (const mod of BUILTIN_MODS) {
      states[mod.id] = modRegistry.isEnabled(mod.id);
    }
    setActiveStates(states);
  };

  useEffect(() => {
    refreshStates();
    const unsub = modRegistry.subscribe(refreshStates);
    return unsub;
  }, []);

  if (!isOpen) return null;

  const handleToggle = (modId: string) => {
    const next = !activeStates[modId];
    modRegistry.setEnabled(modId, next);
    setActiveStates(prev => ({ ...prev, [modId]: next }));
    onModToggled?.(modId, next);
  };

  const filteredMods = BUILTIN_MODS.filter((m) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.commands?.some((c) => c.command.toLowerCase().includes(q))
    );
  });

  const activeCount = Object.values(activeStates).filter(Boolean).length;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="mod-modal-title">
      <div className="mod-registry-dialog buddy-surface" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <WorkspaceSectionHeader compact title={t("Buddy Mods Registry")} titleId="mod-modal-title" description={t("Enhance Buddy with custom panels, slash commands, and reactive workspace tools.")} actions={<div className="mod-registry-header-right">
            <span className="mod-active-count-badge">
              {activeCount} {t("of")} {BUILTIN_MODS.length} {t("Active")}</span>
            <button
              type="button"
              className="mod-close-btn"
              onClick={onClose}
              aria-label={t("Close Buddy Mods Registry")}
            >
              ✕
            </button>
          </div>} />

        {/* Navigation Tabs */}
        <Toolbar className="mod-registry-tabs">
          <button
            type="button"
            className={`mod-tab-btn ${activeTab === 'mods' ? 'active' : ''}`}
            onClick={() => setActiveTab('mods')}
          >
            <span>{t("🧩 Buddy Mods")}</span>
            <span className="mod-tab-badge">{activeCount} / {BUILTIN_MODS.length}</span>
          </button>
          <button
            type="button"
            className={`mod-tab-btn ${activeTab === 'hooks' ? 'active' : ''}`}
            onClick={() => setActiveTab('hooks')}
          >
            <span>{t("🪝 Lifecycle Hooks")}</span>
            <span className="mod-tab-badge-accent">{t("Guardrails")}</span>
          </button>
        </Toolbar>

        {activeTab === 'hooks' ? (
          <div className="mod-hooks-container">
            <HookManager />
          </div>
        ) : (
          <>
            {/* Filter / Search Bar */}
            <Toolbar className="mod-registry-toolbar">
              <div className="mod-search-wrap">
                <span className="mod-search-icon" aria-hidden="true">🔍</span>
                <input
                  type="text"
                  className="mod-search-input"
                  placeholder={t("Search mods by name, description, or command…")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  autoFocus
                />
                {filter && (
                  <button
                    type="button"
                    className="mod-search-clear"
                    onClick={() => setFilter('')}
                    title={t("Clear filter")}
                  >
                    ✕
                  </button>
                )}
              </div>
            </Toolbar>

        {/* Mods List */}
        <div className="mod-registry-list">
          {filteredMods.length === 0 ? (
            <div className="mod-empty-search">{t("No mods found matching \"")}{filter}".</div>
          ) : (
            filteredMods.map((mod: BobMod) => {
              const isEnabled = Boolean(activeStates[mod.id]);

              return (
                <div
                  key={mod.id}
                  className={`mod-card ${isEnabled ? 'is-enabled' : 'is-disabled'}`}
                >
                  <div className="mod-card-header">
                    <div className="mod-card-icon-area">
                      <span className="mod-card-icon">{mod.icon}</span>
                    </div>

                    <div className="mod-card-main-info">
                      <div className="mod-card-title-row">
                        <strong className="mod-card-name">{t(mod.name)}</strong>
                        <span className="mod-card-version">v{mod.version}</span>
                        <span className="mod-card-category">{t(mod.category)}</span>
                      </div>
                      <div className="mod-card-author">{t("By")} {mod.author}</div>
                    </div>

                    {/* Enable/Disable Toggle Switch */}
                    <div className="mod-toggle-area">
                      <label className="mod-switch-label" htmlFor={`mod-toggle-${mod.id}`}>
                        <span className={`mod-switch-text ${isEnabled ? 'enabled' : 'disabled'}`}>
                          {isEnabled ? t("Active") : t("Disabled")}
                        </span>
                        <div className="mod-switch-wrapper">
                          <input
                            id={`mod-toggle-${mod.id}`}
                            type="checkbox"
                            role="switch"
                            aria-label={t('Enable {0}', [mod.name])}
                            checked={isEnabled}
                            onChange={() => handleToggle(mod.id)}
                            className="mod-switch-input"
                          />
                          <span className="mod-switch-slider" />
                        </div>
                      </label>
                    </div>
                  </div>

                  <p className="mod-card-description">{t(mod.description)}</p>

                  {/* Commands & Features */}
                  <div className="mod-card-footer">
                    {mod.commands && mod.commands.length > 0 && (
                      <div className="mod-commands-group">
                        <span className="mod-footer-label">{t("Commands:")}</span>
                        {mod.commands.map((cmd) => (
                          <code key={cmd.command} className="mod-cmd-tag" title={t(cmd.description)}>
                            {cmd.command}
                          </code>
                        ))}
                      </div>
                    )}

                    {mod.features && mod.features.length > 0 && (
                      <div className="mod-features-group">
                        {mod.features.slice(0, 2).map((feat, idx) => (
                          <span key={idx} className="mod-feat-pill">
                            ✓ {t(feat)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        </>
        )}

        {/* Modal Footer */}
        <div className="mod-registry-footer">
          <small className="mod-footer-hint">
            {t("Mods are loaded client-side and persist in this browser. To manage or write mods, refer to the Buddy ACP extension guide.")}</small>
          <button type="button" className="mod-done-btn" onClick={onClose}>
            {t("Done")}</button>
        </div>
      </div>
    </div>
  );
};
