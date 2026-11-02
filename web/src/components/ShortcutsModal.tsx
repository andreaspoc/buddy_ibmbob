import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import React from 'react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const cmdKey = isMac ? '⌘' : 'Ctrl';

  const shortcuts = [
    {
      category: 'Chat & Composer',
      items: [
        { keys: ['Enter'], desc: 'Send message' },
        { keys: ['Shift', 'Enter'], desc: 'Add new line in composer' },
        { keys: ['/'], desc: 'Open slash commands, skills & modes' },
        { keys: [cmdKey, 'K'], desc: 'Focus message input' },
        { keys: [cmdKey, '/'], desc: 'Toggle keyboard shortcuts sheet' },
      ],
    },
    {
      category: 'Navigation & Workspace',
      items: [
        { keys: ['Esc'], desc: 'Close modals, dismiss popovers' },
        { keys: ['Drag Border'], desc: 'Resize sidebar width dynamically' },
        { keys: ['Double Click'], desc: 'Reset sidebar to standard 365px' },
      ],
    },
    {
      category: 'Interactive Data Tables & Visuals',
      items: [
        { keys: ['Click Header'], desc: 'Sort table column (Asc / Desc / Reset)' },
        { keys: ['Type in Search'], desc: 'Filter table rows in real time' },
        { keys: ['Bar / Line / Donut'], desc: 'Instant chart visualization toggle' },
        { keys: ['CSV / Copy'], desc: 'Export or copy data for Excel' },
      ],
    },
  ];

  return (
    <div className="shortcuts-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("Keyboard Shortcuts")}>
      <div className="shortcuts-modal-card buddy-surface" onClick={(e) => e.stopPropagation()}>
        <WorkspaceSectionHeader compact title={t("Keyboard Shortcuts & Navigation")} actions={<button type="button" className="shortcuts-close-btn" onClick={onClose} aria-label={t("Close shortcuts")}>
            ✕
          </button>} />

        <div className="shortcuts-modal-body">
          {shortcuts.map((group, gIdx) => (
            <div key={gIdx} className="shortcuts-group">
              <h4 className="shortcuts-group-title">{t(group.category)}</h4>
              <div className="shortcuts-list">
                {group.items.map((item, idx) => (
                  <div key={idx} className="shortcuts-item">
                    <span className="shortcuts-desc">{t(item.desc)}</span>
                    <div className="shortcuts-keys">
                      {item.keys.map((k, kIdx) => (
                        <kbd key={kIdx} className="shortcuts-kbd">
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="shortcuts-modal-footer">
          <span className="shortcuts-footer-hint">{t("Press")}<kbd className="shortcuts-kbd">{t("Esc")}</kbd> {t("or click outside to dismiss")}</span>
          <button type="button" className="shortcuts-done-btn" onClick={onClose}>
            {t("Got it")}</button>
        </div>
      </div>
    </div>
  );
};
