import { Toolbar } from './Toolbar';
import { useEffect, useState } from 'react';
import { t, getLocale } from '../lib/i18n';
import './ArtifactVersionCompare.css';

type Revision = { id: string; created: string };
export function ArtifactVersionCompare({ base, path, revision, current, dirty, disabled, onRestore, onClose }: {
  base: string; path: string; revision: Revision; current: string; dirty: boolean; disabled: boolean;
  onRestore: () => void; onClose: () => void;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null); setError('');
    void fetch(`${base}/revision?path=${encodeURIComponent(path)}&revision=${encodeURIComponent(revision.id)}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || 'Unable to load version');
        if (!controller.signal.aborted) setSaved(result.content);
      }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); });
    return () => controller.abort();
  }, [base, path, revision.id]);
  const before = (saved ?? '').split('\n');
  const after = current.split('\n');
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const identical = saved === current;
  const limit = 2500;
  return <section className="artifact-comparison" aria-label={t('Version comparison')}>
    <Toolbar as="header"><div><strong>{t('Compare before restoring')}</strong><p>{new Date(revision.created).toLocaleString(getLocale())}</p></div><button type="button" onClick={onClose} aria-label={t('Close version comparison')}>×</button></Toolbar>
    {error && <p role="alert">{t(error)}</p>}
    {saved === null && !error && <p role="status">{t('Loading version…')}</p>}
    {saved !== null && <>
      <p className="artifact-comparison-summary">{identical ? t('This version matches your current source.') : t('Highlighted lines show the changed section in each version.')}</p>
      <div className="artifact-comparison-columns">{[{ label: t('Selected version'), lines: before, tone: 'before' }, { label: dirty ? t('Current source · unsaved changes') : t('Current source'), lines: after, tone: 'after' }].map(column => <div key={column.tone} className="artifact-comparison-column"><h4>{column.label}</h4><pre tabIndex={0} aria-label={column.label}>{column.lines.slice(0, limit).map((line, index) => <span key={index} className={!identical && index >= prefix && index < column.lines.length - suffix ? `changed-${column.tone}` : ''}><i aria-hidden="true">{index + 1}</i>{line || ' '}</span>)}{column.lines.length > limit && <span>{t('Preview limited to 2,500 lines. Download the current source to inspect the complete file.')}</span>}</pre></div>)}</div>
      {dirty && <p>{t('Restoring will replace your unsaved changes.')}</p>}
      <footer><button type="button" onClick={onClose}>{t('Keep current version')}</button><button type="button" disabled={disabled || identical} onClick={onRestore}>{t('Restore selected version')}</button></footer>
    </>}
  </section>;
}
