import React from 'react';
import { Header, HeaderMenuButton, HeaderName, HeaderGlobalBar, HeaderGlobalAction, SkipToContent, Tag, Button } from '@carbon/react';
import { Moon, Sun, Compare, CheckmarkOutline, User } from '@carbon/icons-react';

export default function HeaderBar({ theme, toggleTheme, backendConnected, isLiveConnected, currentModel,
  currentUser, onOpenDiff, onPromoteGovernance, isSidebarOpen = true, onToggleSidebar }) {
  const status = currentModel?.status || 'draft';
  const labels = { draft: 'Submit for review', in_review: 'Approve version', approved: 'Publish version', published: 'Start revision' };
  return <Header aria-label="Buddy Decisions" className="decisions-header">
    <SkipToContent href="#decision-main-content" />
    <HeaderMenuButton aria-label={isSidebarOpen ? 'Collapse navigation' : 'Expand navigation'} isCollapsible isActive={isSidebarOpen} onClick={onToggleSidebar} />
    <HeaderName href="#decision-main-content" prefix="Buddy">Decisions</HeaderName>
    <div className="decisions-header-status">
      <Tag type={backendConnected ? 'green' : 'gray'} size="sm">{backendConnected ? 'Service connected' : 'Service unavailable'}</Tag>
      {isLiveConnected && <Tag type="teal" size="sm">● Live Sync</Tag>}
      {currentModel && <Tag type={status === 'published' ? 'green' : 'cool-gray'} size="sm">{currentModel._dirty ? 'Unsaved draft' : status}</Tag>}
    </div>
    <HeaderGlobalBar>
      <Button size="sm" kind="ghost" renderIcon={Compare} hasIconOnly iconDescription="Version history" onClick={onOpenDiff} disabled={!backendConnected || !currentModel?.version}>Version history</Button>
      {backendConnected && currentModel?.version && <Button size="sm" kind="tertiary" renderIcon={CheckmarkOutline} hasIconOnly iconDescription={labels[status] || "Request review"} onClick={onPromoteGovernance} disabled={Boolean(currentModel._dirty)}>{labels[status] || 'Request review'}</Button>}
      <div className="decisions-user" title={currentUser?.username || 'Session unavailable'}><User size={18} /><span>{currentUser?.displayName || currentUser?.username || 'Signed out'}</span>{currentUser?.isAdmin && <Tag type="purple" size="sm">Admin</Tag>}</div>
      <HeaderGlobalAction aria-label={theme === 'white' ? 'Use dark theme' : 'Use light theme'} tooltipAlignment="end" onClick={toggleTheme}>{theme === 'white' ? <Moon size={20} /> : <Sun size={20} />}</HeaderGlobalAction>
    </HeaderGlobalBar>
  </Header>;
}
