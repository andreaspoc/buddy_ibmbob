import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import React, { useState } from 'react';
import * as api from '../api';
import type { Project } from '../types';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (project: Project) => void;
}

export const ProjectModal: React.FC<ProjectModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [source, setSource] = useState<'git' | 'zip' | 'folder' | 'empty'>('git');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Please provide a project name');
      return;
    }

    setLoading(true);
    try {
      let created: Project;
      if (source === 'git') {
        const cleanUrl = gitUrl.trim();
        if (!cleanUrl) {
          setError('Please provide a repository URL');
          setLoading(false);
          return;
        }
        created = await api.createProjectGit(cleanName, cleanUrl, branch.trim(), token.trim());
      } else if (source === 'empty') {
        created = await api.createProjectGit(cleanName, '');
      } else if (source === 'folder') {
        created = await api.uploadProjectFolder(cleanName, folderFiles);
      } else {
        if (!zipFile) {
          setError('Please select a ZIP file to upload');
          setLoading(false);
          return;
        }
        if (zipFile.size > 50 * 1024 * 1024) {
          setError('ZIP archive must not exceed 50 MB');
          setLoading(false);
          return;
        }
        created = await api.uploadProjectZip(cleanName, zipFile);
      }
      setToken('');
      setFolderFiles([]);
      setZipFile(null);
      onSuccess(created);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => { if (!loading) onClose(); }} role="dialog" aria-modal="true">
      <div
        className="create-dialog buddy-surface"
        style={{ display: 'block', maxWidth: '540px', margin: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <WorkspaceSectionHeader compact title={t("Create or Import Project")} eyebrow={t("WORKSPACE")} actions={<button
            type="button"
            className="dialog-close"
            onClick={onClose}
            disabled={loading}
            aria-label={t("Close modal")}
          >
            ×
          </button>} />

        <p className="dialog-intro">
          {t("Import a codebase into your private workspace. Buddy can explore, search, edit, and run tasks across all files in every conversation linked to this project.")}</p>

        {error && <div className="form-error" style={{ margin: '8px 0', color: '#dc2626', fontWeight: 600 }}>{t(error)}</div>}

        <form onSubmit={handleSubmit} style={{ marginTop: '14px' }}>
          <label>
            {t("Project Name")}<input
              type="text"
              required
              maxLength={100}
 placeholder={t("e.g. buddy-portal, payment-gateway")} value={name}
 onChange={(e) => setName(e.target.value)}
 disabled={loading}
            />
          </label>

          <label>
            {t("Import Source")}<select
              value={source}
              onChange={(e) => setSource(e.target.value as 'git' | 'zip' | 'folder' | 'empty')}
              disabled={loading}
            >
              <option value="git">{t("🐙 Git Repository (Public or Private with Token)")}</option>
              <option value="empty">{t("Create an empty project")}</option>
              <option value="folder">{t("Upload local folder")}</option>
              <option value="zip">{t("📦 Upload ZIP Archive (extracted automatically)")}</option>
            </select>
          </label>

          {source === 'git' ? (
            <>
              <label>
                {t("Repository HTTPS URL")}<input
                  type="url"
                  required
                  placeholder="https://github.com/owner/repository"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  disabled={loading}
                />
                <span className="muted-small" style={{ fontSize: '11px', color: '#6b7280' }}>
                  {t("HTTPS clone URL (GitHub, GitLab, Bitbucket). For private repos, provide an access token below.")}</span>
              </label>

              <label>
                {t("Personal Access Token (optional, for private repositories)")}<div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <input
                    type={showToken ? 'text' : 'password'}
                    placeholder={t("e.g. ghp_…, github_pat_…, or glpat-…")}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    disabled={loading}
                    style={{ paddingRight: '60px' }}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    style={{
                      position: 'absolute',
                      right: '8px',
                      background: 'none',
                      border: 'none',
                      fontSize: '11px',
                      color: '#6b7280',
                      cursor: 'pointer',
                      fontWeight: 600,
                      padding: '4px',
                    }}
                  >
                    {showToken ? t("Hide") : t("Show")}
                  </button>
                </div>
                <span className="muted-small" style={{ fontSize: '11px', color: '#6b7280' }}>
                  {t("Required for private repositories. Tokens are only used for the clone operation and are never stored on disk.")}</span>
              </label>

              <label>
                {t("Branch (optional)")}<input
                  type="text"
                  placeholder={t("e.g. main, master, staging")}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={loading}
                />
              </label>
            </>
          ) : source === 'folder' ? (
            <label>{t("Choose Local Folder")}<input type="file" {...({ webkitdirectory: '', directory: '' } as any)} multiple required disabled={loading}
                onChange={e => { const files = Array.from(e.target.files || []); setFolderFiles(files); if (!name && files[0]) setName(files[0].webkitRelativePath.split('/')[0]); }} />
              <span className="muted-small">{folderFiles.length} {t("files selected. Git metadata, dependencies, and environment folders are excluded. Up to 10,000 files and 200 MB.")}</span>
            </label>
          ) : source === 'empty' ? (
            <p>{t("Start with an empty workspace and ask Buddy to create your code. Download it or upload it to GitHub when ready.")}</p>
          ) : (
            <label>
              {t("Choose ZIP Archive")}<input
                type="file"
                accept=".zip,application/zip"
                required
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setZipFile(file);
                  if (file && !name) {
                    setName(file.name.replace(/\.zip$/i, ''));
                  }
                }}
                disabled={loading}
              />
              <span className="muted-small" style={{ fontSize: '11px', color: '#6b7280' }}>
                {t("ZIP archives up to 50 MB (extracted up to 200 MB). Top-level folders are automatically unpacked.")}</span>
            </label>
          )}

          <div className="dialog-actions" style={{ marginTop: '12px' }}>
            <button
              type="button"
              className="cancel-button"
              onClick={onClose}
              disabled={loading}
            >
              {t("Cancel")}</button>
            <button
              type="submit"
              className="save-button"
              disabled={loading}
            >
              {loading
                ? source === 'git'
                  ? t("Cloning Repository…")
                  : source === 'empty' ? t("Creating…") : t("Uploading & Extracting…")
                : t("Create Project")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
