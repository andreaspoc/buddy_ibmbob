import { Toolbar } from './Toolbar';
import { Button } from '@carbon/react';
import { Menu, Notification } from '@carbon/icons-react';
import { t, getLanguage, getLocale } from "../lib/i18n";
import React from 'react';
import './Topbar.css';

interface TopbarProps {
  activeModeName: string;
  sessionTokens: number | null;
  sessionCost: number | null;
  usageScope?: 'conversation' | 'task';
  onToggleSidebar: () => void;
  isSidebarOpen?: boolean;
  navigation?: React.ReactNode;
  buddyAction?: React.ReactNode;
  onOpenNotifications?: () => void;
  pinnedReminders?: React.ReactNode;
}

export function formatTokens(count: number): string {
  const locale = getLocale();
  const number = Number.isFinite(count) && count > 0 ? count : 0;
  if (getLanguage() === 'hi') {
    const unit = number >= 10000000 ? [10000000, 'करोड़'] as const
      : number >= 100000 ? [100000, 'लाख'] as const : number >= 1000 ? [1000, 'हज़ार'] as const : null;
    return `${(unit ? number / unit[0] : number).toLocaleString(locale, unit ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : {})}${unit ? ` ${unit[1]}` : ''} ${t('tokens')}`;
  }
  if (number >= 1000000) return `${(number / 1000000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${getLanguage() === 'el' ? ' εκατ.' : 'M'} ${t("tokens")}`;
  if (number >= 1000) return `${(number / 1000).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${getLanguage() === 'el' ? ' χιλ.' : 'k'} ${t("tokens")}`;
  return `${number.toLocaleString(locale)} ${t("tokens")}`;
}

export function formatBobcoins(val: number): string {
  if (!Number.isFinite(val) || val <= 0) return '0 Bobcoins';
  const precision = val < 0.001 ? 4 : 3;
  return `${val.toLocaleString(getLocale(), { minimumFractionDigits: precision, maximumFractionDigits: precision })} Bobcoins`;
}

export const Topbar: React.FC<TopbarProps> = ({
  activeModeName,
  sessionTokens,
  sessionCost,
  usageScope = 'conversation',
  onToggleSidebar,
  isSidebarOpen = false,
  navigation,
  buddyAction,
  onOpenNotifications,
  pinnedReminders,
}) => {
  return (
    <Toolbar as="header" className="topbar">
      {/* Keep the button itself in the flex layout: hasIconOnly adds a tooltip wrapper. */}
      <Button
        className="mobile-menu cds--btn--icon-only"
        kind="ghost"
        size="md"
        renderIcon={Menu}
        iconDescription={t("Toggle navigation")}
        type="button"
        aria-label={t("Toggle navigation")}
        aria-expanded={isSidebarOpen}
        aria-controls="workspace-sidebar"
        onClick={onToggleSidebar}
      />
      {navigation}
      {pinnedReminders && <div className="topbar-pinned-reminders">{pinnedReminders}</div>}
      {onOpenNotifications && <Button kind="ghost" size="md" renderIcon={Notification} iconDescription={t('Notifications')} type="button" className="topbar-notifications cds--btn--icon-only" aria-label={t('Notifications')} title={t('Notifications')} aria-haspopup="dialog" onClick={onOpenNotifications} />}
      {buddyAction && <div className="topbar-buddy-action">{buddyAction}</div>}
      <div className="topbar-actions">
        <div
          className="topbar-token-pill"
          id="token-pill"
          title={t("Total reported tokens across all model calls and Bobcoins for this {0}. Bobcoins vary by model and operation.", [t(usageScope)])}
        >
          <span className="token-icon" aria-hidden="true">🪙</span>
          <span>{sessionTokens === null ? t("Tokens not reported") : formatTokens(sessionTokens)}</span>
          {(usageScope === 'task' || (sessionCost !== null && sessionCost > 0)) && (
            <>
              <span className="token-sep">·</span>
              <span>{sessionCost === null ? t("Bobcoins not reported yet") : formatBobcoins(sessionCost)}</span>
            </>
          )}
        </div>
        <div className="topbar-pill">
          <span>{t(activeModeName)}</span>
        </div>
      </div>
    </Toolbar>
  );
};

