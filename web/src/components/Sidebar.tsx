import { brandLogoUrl, brandName, brandText } from '../lib/brand';
import { themeCssValue } from '../lib/themeColor';
import { skillDisplayName } from '../lib/skillNames';
import { t } from "../lib/i18n";
import { ProjectPublishModal } from './ProjectPublishModal';
import React, { useState, useEffect } from 'react';
import type {
  A2AAgent,
  MicrosoftStatus,
  Mode,
  Project,
  SessionItem,
  Skill,
  User,
  WorkspacePage,
} from '../types';

interface SidebarProps {
  isOpen: boolean;
  user: User | null;
  projects: Project[];
  selectedProjectId: string;
  sessions: SessionItem[];
  selectedSessionId: string;
  skills: Skill[];
  modes: Mode[];
  selectedMode: string;
  agents: A2AAgent[];
  selectedAgent: string;
  msStatus?: MicrosoftStatus;
  onDisconnectMicrosoft?: () => void;
  pages: WorkspacePage[];
  files: Array<{ name: string; size: number }>;
  onDeleteFile: (path: string) => void;
  onDeleteProject: () => void;
  onSelectProject: (id: string) => void;
  onOpenProjectModal?: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (session: SessionItem) => void;
  onNewChat: () => void;
  onSelectMode: (slug: string) => void;
  onSelectAgent: (slug: string) => void;
  onEditAgent: (agent: A2AAgent) => void;
  onEditSkill: (name: string) => void;
  onDeleteSkill: (name: string) => void;
  onOpenCreate: (kind: 'skill' | 'mode' | 'mcp' | 'agent') => void;
  onRefreshPages: () => void;
  onOpenPage?: (page: WorkspacePage) => void;
  onOpenFile?: (path: string) => void;
  onSignOut: () => void;
  activeView: 'chat' | 'tasks' | 'knowledge' | 'administration' | 'notes';
  onOpenNotes: () => void;
  onOpenKnowledge: () => void;
  taskCount: number;
  onOpenTasks: () => void;
  onOpenWorkflows: () => void;
  onOpenMods?: () => void;
  onOpenTemplateStudio?: () => void;
  activeModCount?: number;
}

type SidebarCategory = 'all' | 'chats' | 'pages' | 'skills' | 'modes';

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  user,
  projects,
  selectedProjectId,
  sessions,
  selectedSessionId,
  skills,
  modes,
  selectedMode,
  agents,
  selectedAgent,
  msStatus,
  onDisconnectMicrosoft,
  pages,
  files,
  onDeleteFile,
  onDeleteProject,
  onSelectProject,
  onOpenProjectModal,
  onSelectSession,
  onDeleteSession,
  onNewChat,
  onSelectMode,
  onSelectAgent,
  onEditAgent,
  onEditSkill,
  onDeleteSkill,
  onOpenCreate,
  onRefreshPages,
  onOpenPage,
  onOpenFile,
  onSignOut,
  activeView,
  taskCount,
  onOpenKnowledge,
  onOpenTasks,
  onOpenNotes,
  onOpenWorkflows,
  onOpenMods,
  onOpenTemplateStudio,
  activeModCount,
}) => {
  const [publishProjectId, setPublishProjectId] = useState('');
  const [activeTab, setActiveTab] = useState<SidebarCategory>('all');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('bob_sidebar_collapsed');
      // Keep recent conversations visible; secondary libraries open on demand.
      return saved ? JSON.parse(saved) : { projects: true, pages: true, modes: true, skills: true, microsoft: true, agents: true };
    } catch {
      return { projects: true, pages: true, modes: true, skills: true, microsoft: true, agents: true };
    }
  });

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('bob_sidebar_width');
      if (saved) {
        const val = Number(saved);
        if (val >= 260 && val <= 850) return val;
      }
    } catch {}
    return 300;
  });
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const setSidebarWidthAndPersist = (newWidth: number) => {
    setSidebarWidth(newWidth);
    try {
      localStorage.setItem('bob_sidebar_width', String(newWidth));
    } catch {}
  };

  const handleResetWidth = () => {
    setSidebarWidthAndPersist(300);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const minWidth = 260;
      const maxWidth = Math.min(850, window.innerWidth * 0.65);
      const newWidth = Math.max(minWidth, Math.min(maxWidth, e.clientX));
      setSidebarWidth(Math.round(newWidth));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      try {
        localStorage.setItem('bob_sidebar_width', String(sidebarWidth));
      } catch {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.classList.add('resizing-sidebar');

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('resizing-sidebar');
    };
  }, [isResizing, sidebarWidth]);

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem('bob_sidebar_collapsed', JSON.stringify(updated));
      } catch {}
      return updated;
    });
  };

  const isCollapsed = (key: string) => activeTab === 'all' && !!collapsedSections[key];

  return (
    <aside
      className={`sidebar ${isOpen ? 'open' : ''}`}
      id="workspace-sidebar"
      aria-label={t("Workspace sidebar")}
      style={{ '--sidebar-width': `${sidebarWidth}px`, width: `${sidebarWidth}px` } as React.CSSProperties}
    >
      {/* Draggable Resize Handle */}
      <div
        className={`sidebar-resize-handle ${isResizing ? 'is-active' : ''}`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleResetWidth}
 title={t("Drag to resize sidebar width · Double-click to reset (300px)")} aria-label={t("Resize sidebar width")} />{/* Brand Header */}
      <button className="brand brand-home" type="button" onClick={onNewChat}
        aria-label={brandText(`${t("Buddy")} — ${t("New conversation")}`)} title={t("New conversation")}>
        <div className="brand-mark" aria-hidden="true"><img src={brandLogoUrl()} width="40" height="40" alt="" /></div>
        <div>
          <div className="brand-name">{brandName()}</div>
          <div className="brand-subtitle">{t("AI workspace")}</div>
        </div>
      </button>

      {/* Account Info */}
      <div className="account-row">
        <span>{user ? user.display_name || user.username : t("Not signed in")}</span>
        {user && <button type="button" onClick={onSignOut}>{t("Sign out")}</button>}
      </div>

      {/* New Conversation Button */}
      <button className="new-chat" type="button" onClick={onNewChat}>
        <span aria-hidden="true">＋</span> {t("New conversation")}</button>

      <nav className="sidebar-nav" aria-label={t("Workspace navigation")}>
        <div className="sidebar-group-label">{t("Workspace")}</div>
        <button className={`tasks-nav ${activeView === 'tasks' ? 'active' : ''}`} type="button" onClick={onOpenTasks} aria-current={activeView === 'tasks' ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 6 2 2 3-3M12 6h8M4 12l2 2 3-3M12 12h8M4 18l2 2 3-3M12 18h8" /></svg>
          <span className="sidebar-nav-label">{t("Tasks")}</span>
          {taskCount > 0 && <span className="sidebar-nav-badge">{taskCount} {t("active")}</span>}
        </button>
        <button data-notes-inbox-target className={`tasks-nav ${activeView === 'notes' ? 'active' : ''}`} type="button" onClick={onOpenNotes} aria-current={activeView === 'notes' ? 'page' : undefined}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 3h14v12l-6 6H5V3Z"/><path d="M13 21v-6h6M8 8h8M8 11h6"/></svg>
          <span>{t('Notes')}</span>
        </button>
        <button className={`tasks-nav ${activeView === 'knowledge' ? 'active' : ''}`} type="button" onClick={onOpenKnowledge} aria-current={activeView === 'knowledge' ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v15M12 5C9 3 5 3 3 4v14c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-1-9 1Z" /></svg>
          <span className="sidebar-nav-label">{t("Knowledge base")}</span>
        </button>
        <button className="tasks-nav" type="button" onClick={onOpenWorkflows}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="2" y="16" width="6" height="5" rx="1" /><rect x="16" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M5 16v-4h14v4" /></svg>
          <span className="sidebar-nav-label">{t("Workflows")}</span>
        </button>
      </nav>

      {onOpenTemplateStudio && <button type="button" className="sidebar-template-studio" onClick={onOpenTemplateStudio}>
        <span aria-hidden="true">◈</span> {t("Template Studio")}<small>{t("PowerPoint & HTML")}</small>
      </button>}
      <div className="sidebar-group-label sidebar-library-label">{t("Browse library")}</div>
      {/* Category Filter Pills (Ensures user can immediately isolate what they need on any screen) */}
      <div className="sidebar-filter-tabs" role="group" aria-label={t("Filter sidebar sections")}>
        <button
          type="button"
          className={`filter-tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
          aria-pressed={activeTab === 'all'}
          title={t("Show all sections")}
        >
          {t("All")}</button>
        <button
          type="button"
          className={`filter-tab ${activeTab === 'chats' ? 'active' : ''}`}
          onClick={() => setActiveTab('chats')}
          aria-pressed={activeTab === 'chats'}
          title={t("View only conversations")}
        >
          {t("Chats")}{sessions.length > 0 && <span className="tab-badge">{sessions.length}</span>}
        </button>
        <button
          type="button"
          className={`filter-tab ${activeTab === 'pages' ? 'active' : ''}`}
          onClick={() => setActiveTab('pages')}
          aria-pressed={activeTab === 'pages'}
          title={t("View generated presentations and HTML pages")}
        >
          {t("Pages")}{pages.length > 0 && <span className="tab-badge">{pages.length}</span>}
        </button>
        <button
          type="button"
          className={`filter-tab ${activeTab === 'skills' ? 'active' : ''}`}
          onClick={() => setActiveTab('skills')}
          aria-pressed={activeTab === 'skills'}
          title={t("View available agent skills")}
        >
          {t("Skills")}{skills.length > 0 && <span className="tab-badge">{skills.length}</span>}
        </button>
        <button
          type="button"
          className={`filter-tab ${activeTab === 'modes' ? 'active' : ''}`}
          onClick={() => setActiveTab('modes')}
          aria-pressed={activeTab === 'modes'}
          title={t("View agent modes")}
        >
          {t("Modes")}</button>
      </div>

      {/* Main Scrollable Sidebar Sections */}
      <div className="sidebar-sections">

        {/* ─── 1. PROJECTS ─── */}
        {(activeTab === 'all' || activeTab === 'chats' || activeTab === 'pages') && (
          <>
            <div
              className="section-heading"
              onClick={() => toggleSection('projects')}
              title={t("Click to expand/collapse Projects")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('projects') ? '+' : '−'}</span>
                <span>{t("PROJECTS")}</span>
              </span>
              {onOpenProjectModal && (
                <button
                  className="add-item"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenProjectModal();
                  }}
                  aria-label={t("Create or import project")}
                  title={t("Import repository from GitHub or upload ZIP archive")}
                >
                  ＋
                </button>
              )}
            </div>
            {!isCollapsed('projects') && (
              <div className="sidebar-project-container">
                <select
                  className="project-select"
                  value={selectedProjectId}
                  onChange={(e) => onSelectProject(e.target.value)}
                >
                  <option value="">{t("Personal conversations")}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {selectedProjectId && (
                  <div className="sidebar-project-actions" role="toolbar" aria-label={t("Project actions")}>
                    <button
                      type="button"
                      className="sidebar-project-btn sidebar-project-btn-github"
                      onClick={() => setPublishProjectId(selectedProjectId)}
                      title={t("Upload project to GitHub")}
                      aria-label={t("Upload project to GitHub")}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 19c-4 1-4-2-6-2m12 5v-4c0-1-1-2-1-2 4 0 6-2 6-6 0-2-1-3-2-4 0-1 0-2-1-3-2 0-3 1-4 1a12 12 0 0 0-6 0C6 3 5 3 3 3 2 4 2 5 3 6c-1 1-2 2-2 4 0 4 2 6 6 6-1 1-1 2-1 3v3" />
                      </svg>
                      <span className="sidebar-project-btn-label">{t("GitHub")}</span>
                    </button>
                    {publishProjectId && (
                      <ProjectPublishModal
                        key={publishProjectId}
                        projectId={publishProjectId}
                        onClose={() => setPublishProjectId('')}
                      />
                    )}
                    <a
                      href={`/projects/${selectedProjectId}/download`}
                      className="sidebar-project-btn sidebar-project-btn-download"
                      title={t("Download project files as ZIP archive")}
                      aria-label={t("Download project files as ZIP archive")}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      <span className="sidebar-project-btn-label">{t("Download ZIP")}</span>
                    </a>
                    <button
                      type="button"
                      className="sidebar-project-btn sidebar-project-btn-delete"
                      onClick={onDeleteProject}
                      title={t("Delete project and its conversations")}
                      aria-label={t("Delete selected project")}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {(activeTab === 'all' || activeTab === 'pages') && files.length > 0 && (
          <>
            <div className="section-heading sidebar-files-heading">
              <span className="section-heading-title">{t("FILES")}</span>
              <span className="skill-count">{files.length}</span>
            </div>
            <div className="mode-list">
              {files.map(file => <div className="conversation-row" key={file.name} data-user-content>
                {onOpenFile && (/\.(pdf|docx|md|txt)$/i.test(file.name) || file.name.endsWith('.diagram.json')) ? <button type="button" className="mode-item" style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis'}}
                  title={t("Preview {0}", [file.name])} onClick={() => onOpenFile(file.name)}>{file.name}</button> : <a className="mode-item" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  href={`/sessions/${encodeURIComponent(selectedSessionId || 'legacy')}/file?path=${encodeURIComponent(file.name)}`}
                  target="_blank" rel="noreferrer" title={t("Open {0}", [file.name])}>{file.name}</a>}
                <button type="button" className="conversation-delete" onClick={() => onDeleteFile(file.name)}
                  aria-label={t("Delete {0}", [file.name])} title={t("Delete file")}>✕</button>
              </div>)}
            </div>
          </>
        )}

        {/* ─── 2. CONVERSATIONS ─── */}
        {(activeTab === 'all' || activeTab === 'chats') && (
          <>
            <div
              className="section-heading"
              onClick={() => toggleSection('conversations')}
              title={t("Click to expand/collapse Conversations")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('conversations') ? '+' : '−'}</span>
                <span>{t("CONVERSATIONS")}</span>
              </span>
              <span className="heading-actions">
                <span className="skill-count">{sessions.length}</span>
              </span>
            </div>
            {!isCollapsed('conversations') && (
              <div className={`conversations-scroll ${activeTab === 'chats' ? 'full-height' : ''}`}>
                {sessions.length === 0 ? (
                  <div className="muted-small">{t("No conversations yet.")}</div>
                ) : (
                  sessions.map((s) => (
                    <div className="conversation-row" key={s.id}>
                      <button
                        type="button"
                        className={`mode-item ${s.id === selectedSessionId ? 'active' : ''}`}
                        data-user-content
                        onClick={() => onSelectSession(s.id)}
                        disabled={s.deletion_pending}
                        title={s.title || t("Untitled conversation")}
                      >
                        {s.title || t("Untitled conversation")}{s.deletion_pending ? t("deletion pending") : ''}
                      </button>
                      {s.id !== 'legacy' && (
                        <button
                          type="button"
                          className="conversation-delete"
                          aria-label={`${s.deletion_pending ? t("Retry deletion of") : t("Delete")} ${s.title || 'conversation'}`}
                          title={s.deletion_pending ? t("Retry deletion") : t("Delete conversation")}
                          onClick={() => onDeleteSession(s)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}

        {/* ─── 3. WORKSPACE PAGES (Elevated here so presentations are instantly visible) ─── */}
        {(activeTab === 'all' || activeTab === 'pages') && (
          <>
            <div
              className="section-heading mode-heading"
              onClick={() => toggleSection('pages')}
              title={t("Click to expand/collapse Workspace Pages & Presentations")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('pages') ? '+' : '−'}</span>
                <span>{t("WORKSPACE PAGES")}</span>
              </span>
              <span className="heading-actions">
                <span className="skill-count">{pages.length}</span>
                <button
                  className="add-item"
                  type="button"
                  aria-label={t("Refresh pages")}
                  title={t("Refresh generated pages")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRefreshPages();
                  }}
                >
                  ↻
                </button>
              </span>
            </div>
            {!isCollapsed('pages') && (
              <div className="mode-list">
                {pages.length === 0 ? (
                  <div className="muted-small">{t("No pages generated yet.")}</div>
                ) : (
                  pages.map((p) => {
                    const isHtml = p.name.toLowerCase().endsWith('.html') || p.name.toLowerCase().endsWith('.htm');
                    const isEditable = isHtml || p.name.toLowerCase().endsWith('.bobdeck');
                    const isDeck = p.name.toLowerCase().endsWith('.bobdeck') || p.name.toLowerCase().endsWith('.pptx');
                    return (
                      <div key={p.path} className="agent-row" style={{ display: 'flex', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="mode-item"
                          style={{ flex: 1, textAlign: 'left', cursor: 'pointer', background: 'transparent' }}
                          onClick={() => {
                            if (isEditable && onOpenPage) {
                              onOpenPage(p);
                            } else {
                              window.open(`/sessions/${encodeURIComponent(selectedSessionId || 'legacy')}/file?path=${encodeURIComponent(p.path)}`, '_blank');
                            }
                          }}
                          title={isEditable ? `Open ${p.is_presentation ? t("presentation studio") : t("artifact editor")}: ${p.name}` : `Open or download ${p.name}`}
                        >
                          <span>{isHtml ? '📊 ' : isDeck ? '📑 ' : '📄 '}{p.name}</span>
                          <small>{isEditable ? (p.is_presentation ? t("Click to open slide editor") : t("Click to open artifact editor")) : t("Click to open / download")}</small>
                        </button>
                        <a
                          href={`/sessions/${encodeURIComponent(selectedSessionId || 'legacy')}/file?path=${encodeURIComponent(p.path)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="agent-action-btn"
                          title={t("Open standalone page in new browser tab")}
                          style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          ↗
                        </a>
                        <button type="button" className="conversation-delete" onClick={() => onDeleteFile(p.path)}
                          title={t("Delete file")} aria-label={t("Delete {0}", [p.name])}>✕</button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}

        {/* ─── 4. AVAILABLE SKILLS ─── */}
        {(activeTab === 'all' || activeTab === 'skills') && (
          <>
            <div
              className="section-heading"
              onClick={() => toggleSection('skills')}
              title={t("Click to expand/collapse Skills")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('skills') ? '+' : '−'}</span>
                <span>{t("AVAILABLE SKILLS")}</span>
              </span>
              <span className="heading-actions">
                <span className="skill-count">{skills.length}</span>
                <button
                  className="add-item"
                  type="button"
                  aria-label={t("Add skill")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenCreate('skill');
                  }}
                >
                  ＋
                </button>
              </span>
            </div>
            {!isCollapsed('skills') && (
              <div className="skill-list">
                {skills.length === 0 ? (
                  <div className="muted-small">{t("No skills available.")}</div>
                ) : (
                  skills.map((sk) => (
                    <div key={sk.name} className="skill-item">
                      <div className="skill-item-top">
                        <div className="skill-symbol">⚡</div>
                        <div className="skill-item-name">{skillDisplayName(sk.name)}</div>
                        <button type="button" className="skill-edit-button" onClick={() => onEditSkill(sk.name)}
                          aria-label={t("Edit skill {0}", [skillDisplayName(sk.name)])} title={t("Edit {0}", [skillDisplayName(sk.name)])}>{t("Edit")}</button>
                        <button type="button" className="skill-edit-button skill-delete-button" onClick={() => onDeleteSkill(sk.name)}
                          aria-label={t("Delete skill {0}", [skillDisplayName(sk.name)])} title={t("Delete {0}", [skillDisplayName(sk.name)])}>{t("Delete")}</button>
                      </div>
                      {sk.description && (
                        <small className="skill-description">{t(sk.description)}</small>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}

        {/* ─── 5. MODES ─── */}
        {(activeTab === 'all' || activeTab === 'modes') && (
          <>
            <div
              className="section-heading mode-heading"
              onClick={() => toggleSection('modes')}
              title={t("Click to expand/collapse Modes")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('modes') ? '+' : '−'}</span>
                <span>{t("MODES")}</span>
              </span>
              <span className="heading-actions">
                <span className="skill-count">{modes.length}</span>
                <button
                  className="add-item"
                  type="button"
                  aria-label={t("Add mode")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenCreate('mode');
                  }}
                >
                  ＋
                </button>
              </span>
            </div>
            {!isCollapsed('modes') && (
              <div className="mode-list">
                {modes.map((m) => (
                  <button
                    key={m.slug}
                    type="button"
                    className={`mode-item ${!selectedAgent && selectedMode === m.slug ? 'active' : ''}`}
                    onClick={() => onSelectMode(m.slug)}
                  >
                    {t(m.name)}
                    {m.description && <small>{t(m.description)}</small>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ─── 6. A2A AGENTS ─── */}
        {(activeTab === 'all' || activeTab === 'modes') && (
          <>
            <div
              className="section-heading mode-heading"
              onClick={() => toggleSection('agents')}
              title={t("Click to expand/collapse A2A Agents")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('agents') ? '+' : '−'}</span>
                <span>{t("A2A AGENTS")}</span>
              </span>
              <span className="heading-actions">
                <span className="skill-count">{agents.length}</span>
                <button
                  className="add-item"
                  type="button"
                  aria-label={t("Add A2A agent")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenCreate('agent');
                  }}
                >
                  ＋
                </button>
              </span>
            </div>
            {!isCollapsed('agents') && (
              <div className="mode-list">
                {agents.length === 0 ? (
                  <div className="muted-small">{t("No A2A agents yet.")}</div>
                ) : (
                  agents.map((ag) => (
                    <div key={ag.slug} className={`agent-row a2a-connection-card ${selectedAgent === ag.slug ? 'is-selected' : ''}`}>
                      <button
                        type="button"
                        className="a2a-card-select"
                        aria-pressed={selectedAgent === ag.slug}
                        onClick={() => onSelectAgent(ag.slug)}
                      >
                        <strong>{ag.name}</strong>
                        <small title={ag.description || ag.endpoint}>{ag.description || ag.endpoint}</small>
                      </button>
                      <button
                        type="button"
                        className="a2a-card-configure"
                        aria-label={t("Configure {0}", [ag.name])}
                        title={t("Configure agent")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditAgent(ag);
                        }}
                      >
                        {t("Configure")}</button>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}

        {/* ─── 7. MICROSOFT 365 ─── */}
        {activeTab === 'all' && (
          <>
            <div
              className="section-heading mode-heading"
              onClick={() => toggleSection('microsoft')}
              title={t("Click to expand/collapse Microsoft 365")}
            >
              <span className="section-heading-title">
                <span className="section-chevron" aria-hidden="true">{isCollapsed('microsoft') ? '+' : '−'}</span>
                <span>{t("MICROSOFT 365")}</span>
              </span>
            </div>
            {!isCollapsed('microsoft') && (
              <div className="mode-list">
                {msStatus?.connected ? (
                  <div className="integration-item" style={{ borderLeft: '3px solid #00a4ef', padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <svg width="14" height="14" viewBox="0 0 21 21">
                          <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                          <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                          <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                          <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                        </svg>
                        <strong style={{ fontSize: '12px' }}>{msStatus.name || t("Connected")}</strong>
                      </div>
                      {onDisconnectMicrosoft && (
                        <button
                          type="button"
                          onClick={onDisconnectMicrosoft}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#f87171',
                            fontSize: '11px',
                            cursor: 'pointer',
                            padding: '2px 4px',
                          }}
                          title={t("Disconnect Microsoft account")}
                        >
                          {t("Disconnect")}</button>
                      )}
                    </div>
                    <small style={{ color: themeCssValue('#c4b5fd'), display: 'block', marginTop: '2px', wordBreak: 'break-all' }}>
                      {msStatus.account || t("Active session")}
                    </small>
                    <small style={{ color: '#94a3b8', fontSize: '10px', display: 'block', marginTop: '2px' }}>
                      {t("Microsoft account connected")}</small>
                    <small style={{ display: 'block', marginTop: '6px', fontSize: '11px' }}>
                      {t("SharePoint:")}{msStatus.scopes?.includes('Sites.Read.All') ? t('Connected') : t("additional permission needed")}<br />
                      {t("Teams:")}{["Chat.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"].every(scope => msStatus.scopes?.includes(scope)) ? t('Connected') : t("additional permissions needed")}
                    </small>
                    {!!msStatus.missing_scopes?.length && (
                      <a
                        href="/auth/microsoft/login?business=true"
                        className="connector-reconnect"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("Reconnect to enable SharePoint & Teams")}</a>
                    )}
                  </div>
                ) : (
                  <div style={{ padding: '2px 0' }}>
                    <a
                      href="/auth/microsoft/login?business=true"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mode-item"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        textDecoration: 'none',
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        padding: '8px 10px',
                        cursor: 'pointer',
                      }}
                      title={msStatus?.configured ? t("Click to connect Microsoft 365") : t("Set AZURE_CLIENT_ID to connect")}
                    >
                      <svg width="14" height="14" viewBox="0 0 21 21" style={{ flexShrink: 0 }}>
                        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                        <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                        <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                      </svg>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '12px', fontWeight: 500, color: '#f1f5f9' }}>
                          {t("Connect Microsoft 365")}</div>
                        <small style={{ color: '#94a3b8', fontSize: '10px', display: 'block' }}>
                          {msStatus?.configured ? t("Sign in for Mail, Calendar & Files") : t("Requires AZURE_CLIENT_ID")}
                        </small>
                      </div>
                    </a>
                  </div>
                )}
              </div>
            )}
          </>
        )}


      </div>

      {/* Buddy Mods Trigger */}
      {onOpenMods && (
        <div className="sidebar-mod-entry" style={{ padding: '0 12px 6px' }}>
          <button
            className="sidebar-mod-button"
            type="button"
            onClick={onOpenMods}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '8px 12px',
              background: 'var(--sidebar-card-background, var(--cds-layer))',
              border: '1px solid var(--sidebar-border, var(--brand-line))',
              borderRadius: 0,
              color: 'var(--sidebar-text, var(--brand-ink))',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title={t("Open Buddy Mods Registry & Settings")}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span>🧩</span>
              <span>{t("Buddy Mods")}</span>
            </span>
            <span
              style={{
                background: 'var(--brand-accent, #735e83)',
                color: '#ffffff',
                fontSize: '10px',
                fontWeight: 800,
                padding: '2px 7px',
                borderRadius: '99px',
              }}
            >
              {activeModCount ?? 1} {t("Active")}</span>
          </button>
        </div>
      )}

      {/* Sidebar Width Presets */}
      <div className="sidebar-width-controls" title={t("Adjust sidebar width")}>
        <span className="sidebar-width-label">{t("Width:")}</span>
        <div className="sidebar-width-btns">
          <button
            type="button"
            className={`sidebar-width-btn ${sidebarWidth === 300 ? 'active' : ''}`}
            onClick={() => setSidebarWidthAndPersist(300)}
 title={t("Standard width (300px)")} > {t("Std")}</button>
          <button
            type="button"
            className={`sidebar-width-btn ${sidebarWidth === 460 ? 'active' : ''}`}
            onClick={() => setSidebarWidthAndPersist(460)}
 title={t("Wide width (460px)")} > {t("Wide")}</button>
          <button
            type="button"
            className={`sidebar-width-btn ${sidebarWidth === 580 ? 'active' : ''}`}
            onClick={() => setSidebarWidthAndPersist(580)}
 title={t("Maximum width (580px)")} > {t("Max")}</button>
        </div>
      </div>

      {/* Footer Status */}
      <div className="sidebar-bottom">
        <span className="status-dot ready" />
        <span>{t("Connected to Buddy ACP")}</span>
      </div>
    </aside>
  );
};
