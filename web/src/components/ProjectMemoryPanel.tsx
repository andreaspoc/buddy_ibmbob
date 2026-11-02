import { brandText } from '../lib/brand';
import { useEffect, useState } from 'react';

interface Memory { brief: string; revision: number; expires_at?: string; needs_renewal?: boolean; expired?: boolean }

export function ProjectMemoryPanel({ projectId }: { projectId: string }) {
  const [memory, setMemory] = useState<Memory>({ brief: '', revision: 0 });
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/memory`, { signal });
      if (!response.ok) throw new Error('Could not load project memory');
      const result: Memory = await response.json();
      if (!signal?.aborted) { setMemory(result); setSaved(result.brief); }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Could not load project memory');
    } finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [projectId]);
  const save = async () => {
    setSaving(true); setError('');
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/memory`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: memory.brief, revision: memory.revision, expires_in_days: 30 }),
      });
      if (!response.ok) { const body = await response.json(); throw new Error(body.detail || 'Could not save project memory'); }
      const result: Memory = await response.json(); setMemory(result); setSaved(result.brief);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save project memory'); }
    finally { setSaving(false); }
  };
  return <section className="buddy-surface" style={{ padding: '16px 0' }} aria-label="Project memory">
    <h3>Project memory</h3>
    <p className="dialog-intro">Save project goals, terminology, decisions, requirements, and open questions. {brandText("Buddy")} uses this brief in every conversation in this project. Clearing it removes that context.</p>
    <p className="dialog-intro">Briefs expire 30 days after saving. Common credentials, email addresses and sensitive identifiers are removed before storage. Avoid entering confidential personal data.</p>
    {memory.needs_renewal && memory.brief && <p role="status">Review and save this brief to renew it before {brandText("Buddy")} uses it again.</p>}
    {memory.expired && <p role="status">This brief expired and its content was removed. Save a new brief to add project context.</p>}
    {memory.expires_at && !memory.expired && memory.brief && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Expires: {new Date(memory.expires_at).toLocaleDateString()}</p>}
    <textarea aria-label="Project brief" style={{ width: '100%', boxSizing: 'border-box', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'inherit', padding: 12, font: 'inherit', resize: 'vertical' }} rows={10} maxLength={20000} disabled={loading || saving} value={memory.brief} onChange={event => setMemory({ ...memory, brief: event.target.value })} placeholder="Goals:\nDecisions:\nRequirements:\nOpen questions:" />
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="dialog-actions" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
      <button className="feature-primary" disabled={loading || saving || (saved === memory.brief && !memory.brief)} onClick={() => void save()}>{saving ? 'Saving…' : saved === memory.brief && memory.brief ? 'Renew brief' : 'Save brief'}</button>
      <button disabled={saving} onClick={() => void load()}>Reload</button>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{memory.brief.length}/20,000 {saved !== memory.brief ? '· Unsaved changes' : ''}</span>
    </div>
  </section>;
}
