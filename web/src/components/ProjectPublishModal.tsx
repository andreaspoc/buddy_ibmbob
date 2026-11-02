import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { useState } from 'react';
import { publishProject } from '../api';

export function ProjectPublishModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("Upload project to GitHub")}>
    <div className="create-dialog buddy-surface" style={{ display: 'block', maxWidth: 540, margin: 'auto' }}>
      <WorkspaceSectionHeader compact title={t("Upload to GitHub")} actions={<button type="button" className="dialog-close" disabled={busy} onClick={onClose} aria-label={t("Close")}>×</button>} />
      <p>{t("Create an empty repository on GitHub first, or choose a new branch in an existing repository. This uploads your current project files. Existing branch history is protected.")}</p>
      <form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError(''); setResult('');
        try { const published = await publishProject(projectId, url.trim(), branch.trim(), token.trim()); setResult(published.url); setToken(''); }
        catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); }
        finally { setBusy(false); }
      }}>
        <label>{t("GitHub repository HTTPS URL")}<input type="url" required value={url} disabled={busy} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repository" /></label>
        <label>{t("Destination branch")}<input required maxLength={200} value={branch} disabled={busy} onChange={e => setBranch(e.target.value)} /></label>
        <label>{t("GitHub access token")}<input type="password" required autoComplete="new-password" value={token} disabled={busy} onChange={e => setToken(e.target.value)} /></label>
        <p className="muted-small">{t("The token needs repository contents write access and is used only for this upload.")}</p>
        {error && <p role="alert" className="form-error">{t(error)}</p>}
        {result && <p role="status">{t("Uploaded successfully.")}<a href={result} target="_blank" rel="noreferrer">{t("Open repository")}</a></p>}
        <div className="dialog-actions"><button type="button" className="cancel-button" disabled={busy} onClick={onClose}>{t("Close")}</button><button type="submit" className="save-button" disabled={busy}>{busy ? t("Uploading…") : t("Upload to GitHub")}</button></div>
      </form>
    </div>
  </div>;
}
